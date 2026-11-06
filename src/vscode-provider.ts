import * as vscode from 'vscode';
import { Message, Model, ModelPolicy, Part, Provider, WorkerError } from './types';
import { abortable } from './async';
import { Mutex } from './storage';
import { parseModelSettings } from './model-settings';

export function metadata(model: vscode.LanguageModelChat): Model {
  return { id: model.id, name: model.name, vendor: model.vendor, family: model.family, version: model.version, maxInputTokens: model.maxInputTokens };
}
function messages(input: Message[]): vscode.LanguageModelChatMessage[] {
  return input.map(message => new vscode.LanguageModelChatMessage(
    message.role === 'user' ? vscode.LanguageModelChatMessageRole.User : vscode.LanguageModelChatMessageRole.Assistant,
    message.parts.map(part => {
      switch (part.type) {
        case 'text': return new vscode.LanguageModelTextPart(part.text);
        case 'call': return new vscode.LanguageModelToolCallPart(part.id, part.name, part.input);
        case 'result': return new vscode.LanguageModelToolResultPart(part.id, [new vscode.LanguageModelTextPart(part.text)]);
      }
    })
  ));
}
function providerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }
  const e = error as { code?: string; message?: string; name?: string };
  const code = String(e?.code || e?.name || 'provider_error');
  if (/nopermissions|no_permissions|permission|unauthorized|authentication/i.test(code)) {
    return new WorkerError('model_permission', 'VS Code denied model access. Run Codex Subagent: Enable Model and accept the model access prompt.');
  }
  if (/notfound|not_found/i.test(code)) {
    return new WorkerError('model_unavailable', 'Model disappeared from VS Code. Enable it again or explicitly resume using another model.');
  }
  if (/blocked|quota|rate.?limit/i.test(code)) {
    return new WorkerError('model_blocked', 'Model access is blocked or its quota is exhausted. Check the model provider before resuming.');
  }
  return new WorkerError('provider_error', e?.message || String(error), /network|timeout|timed out|fetch failed|econn|503|502|504|socket/i.test(`${code} ${e?.message || ''}`));
}

export class VscodeProvider implements Provider {
  constructor(private readonly context: vscode.ExtensionContext) {}
  /**
   * The user-level codexSubagent.models object is the sole enabled-model source:
   * each key is an exact enabled model ID, in pool priority order. Workspace
   * settings can never enable or expand models, so only the global (user) value
   * is read. Malformed settings fail loudly rather than silently enabling models.
   */
  enabled(): string[] {
    return Object.keys(parseModelSettings(vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue));
  }
  /**
   * VS Code's inspect().globalValue is a locally mirrored snapshot: it can keep
   * exposing the OLD pool while configuration.update() is still in flight (the
   * mirror is only replaced when the host publishes the change), so a
   * read-modify-write of the whole pool is only safe when the read AND the
   * awaited write are serialized. This process-wide lock covers every pool
   * mutator (the setting is shared across provider instances in one extension
   * host); the latest pool is always read inside the critical section, never
   * captured beforehand.
   */
  private static readonly settingsLock = new Mutex();
  /** Latest user pool with its exact keys and values, for safe read-modify-write. */
  private pool(): Record<string, ModelPolicy> {
    return parseModelSettings(vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue);
  }
  private static ownKeys(pool: Record<string, ModelPolicy>): [string, ModelPolicy][] {
    // Object.fromEntries/entries keep an exact ID such as '__proto__' as an own
    // property, so prototype pollution cannot make a model look enabled.
    return Object.entries(pool);
  }
  /** Queued read-modify-write of the whole user pool; caller-visible failures propagate. */
  private mutatePool(mutate: (pool: Record<string, ModelPolicy>) => Record<string, ModelPolicy> | undefined): Promise<void> {
    return VscodeProvider.settingsLock.run(async () => {
      const next = mutate(this.pool());
      if (next === undefined) {
        return;
      }
      // Await the write so the next queued mutation reads the committed pool.
      await vscode.workspace.getConfiguration('codexSubagent').update('models', Object.fromEntries(VscodeProvider.ownKeys(next)), vscode.ConfigurationTarget.Global);
    });
  }
  async models(): Promise<Model[]> {
    const enabled = this.enabled();
    const available = await vscode.lm.selectChatModels();
    const models: Model[] = [];
    for (const id of enabled) {
      const found = available.filter(model => model.id === id);
      if (found.length === 1 && this.context.languageModelAccessInformation.canSendRequest(found[0]!) === true) {
        models.push(metadata(found[0]!));
      }
    }
    return models;
  }
  /**
   * Provider request options come ONLY from the selected model's nested
   * models.<id>.modelOptions in the user (global) pool. The old top-level
   * modelProfiles/modelOptions settings were removed without fallback, so
   * stale values there are simply ignored. Unconfigured/absent options yield {}.
   */
  options(modelId: string): Record<string, unknown> {
    const pool = this.pool();
    // Own-property lookup so an exact ID such as '__proto__' cannot inherit
    // Object.prototype members as "options".
    if (!Object.prototype.hasOwnProperty.call(pool, modelId)) {
      return {};
    }
    return pool[modelId]?.modelOptions || {};
  }
  /**
   * Update only one configured model's nested modelOptions. The latest user
   * pool is read inside the serialized critical section, so settings changed
   * meanwhile are preserved and a model disabled meanwhile is not resurrected;
   * every other policy field, entry and pool order stays intact.
   */
  async setModelOptions(id: string, options: Record<string, unknown>): Promise<void> {
    await this.mutatePool(pool => {
      // Own-property lookup so an exact ID such as '__proto__' is checked exactly.
      if (!Object.prototype.hasOwnProperty.call(pool, id)) {
        throw new WorkerError('model_not_configured', `${id} is no longer configured in codexSubagent.models. Re-enable it before setting its model options.`);
      }
      return { ...pool, [id]: { ...pool[id], modelOptions: options } };
    });
  }
  /** Remove exactly one configured model key, preserving every other entry, value and order. */
  async disable(id: string): Promise<void> {
    await this.mutatePool(pool => {
      const entries = VscodeProvider.ownKeys(pool).filter(([candidate]) => candidate !== id);
      return Object.fromEntries(entries);
    });
  }
  private async resolve(model: Model): Promise<vscode.LanguageModelChat> {
    if (!vscode.workspace.isTrusted) {
      throw new WorkerError('workspace_untrusted', 'Trust the workspace before running workers.');
    }
    if (!this.enabled().includes(model.id)) {
      throw new WorkerError('model_permission', 'Run Codex Subagent: Enable Model before using this model.');
    }
    const selected = (await vscode.lm.selectChatModels({ id: model.id }))[0];
    if (!selected || selected.vendor !== model.vendor || selected.version !== model.version) {
      throw new WorkerError('model_unavailable', 'The configured model changed. Re-enable it and explicitly resume the worker.');
    }
    // Recheck the enabled setting AFTER the async selection: the user may have
    // removed the model (or the whole pool) while selectChatModels was pending.
    // This runs synchronously before sendRequest/countTokens in every caller.
    if (!this.enabled().includes(model.id)) {
      throw new WorkerError('model_permission', 'This model was removed from codexSubagent.models while its request was preparing. Re-enable it or resume with another model.');
    }
    if (this.context.languageModelAccessInformation.canSendRequest(selected) !== true) {
      throw new WorkerError('model_permission', 'Model consent is missing or unknown. Run Codex Subagent: Enable Model in this window.');
    }
    return selected;
  }
  async countTokens(model: Model, message: Message): Promise<number> {
    try {
      const selected = await this.resolve(model);
      // Count serialized tool arguments/results too, including schemas and overhead.
      return await selected.countTokens(JSON.stringify(message));
    } catch (error) {
      throw providerError(error);
    }
  }
  async *stream(model: Model, input: Message[], tools: import('./types').Tool[], signal: AbortSignal): AsyncIterable<Part> {
    const source = new vscode.CancellationTokenSource();
    const cancel = (): void => source.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
    try {
      const selected = await abortable(this.resolve(model), signal);
      const options = this.options(model.id);
      const response = await abortable(selected.sendRequest(messages(input), { tools, modelOptions: options, justification: 'Run a worker task delegated by Codex.' }, source.token), signal);
      const iterator = response.stream[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await abortable(iterator.next(), signal);
          if (next.done) {
            break;
          }
          const part = responsePart(next.value);
          if (part) {
            yield part;
          }
        }
      } finally {
        void iterator.return?.().catch(() => undefined);
      }
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw providerError(error);
    } finally {
      source.cancel(); source.dispose(); signal.removeEventListener('abort', cancel);
    }
  }
  async enable(): Promise<void> {
    const available = await vscode.lm.selectChatModels();
    if (!available.length) {
      throw new WorkerError('no_models', 'VS Code exposes no models. Configure BYOK through Chat: Manage Language Models, then try again.');
    }
    const choice = await vscode.window.showQuickPick(available.map(model => ({ label: model.name, description: `${model.vendor} · ${model.family}`, detail: model.id, model })), { title: 'Enable a model for Codex workers', matchOnDetail: true });
    if (!choice) {
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${choice.model.name}`, cancellable: true }, async (_progress, cancellation) => {
      const source = new vscode.CancellationTokenSource();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new WorkerError('timeout', 'Model access test timed out after 60 seconds.')), 60_000);
      const subscription = cancellation.onCancellationRequested(() => controller.abort(new WorkerError('cancelled', 'Model access test cancelled.')));
      controller.signal.addEventListener('abort', () => source.cancel(), { once: true });
      try {
        const initial = [vscode.LanguageModelChatMessage.User('Call worker_probe with value WORKER_READY. This is an inert capability test; no files or commands will be accessed.')];
        const response = await abortable(choice.model.sendRequest(initial, { justification: 'Test tool calling for persistent Codex workers.', tools: [{ name: 'worker_probe', description: 'Inert test; return readiness.', inputSchema: { type: 'object', properties: { value: { type: 'string', enum: ['WORKER_READY'] } }, required: ['value'], additionalProperties: false } }], toolMode: vscode.LanguageModelChatToolMode?.Auto, modelOptions: this.options(choice.model.id) }, source.token), controller.signal);
        const calls: vscode.LanguageModelToolCallPart[] = [];
        const iterator = response.stream[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await abortable(iterator.next(), controller.signal);
            if (next.done) {
              break;
            }
            const part = responsePart(next.value);
            if (part?.type === 'call') {
              calls.push(new vscode.LanguageModelToolCallPart(part.id, part.name, part.input));
            }
            if (calls.length > 4) {
              throw new WorkerError('model_tools', 'Model emitted too many probe calls.');
            }
          }
        } finally {
          void iterator.return?.().catch(() => undefined);
        }
        if (!calls.length || calls.some(call => call.name !== 'worker_probe' || (call.input as { value?: unknown }).value !== 'WORKER_READY')) {
          throw new WorkerError('model_tools', 'Model did not perform the requested tool call. Check tool-calling support in its VS Code configuration.');
        }
        const history = [...initial, new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, calls), new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, calls.map(call => new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('WORKER_READY')]))), vscode.LanguageModelChatMessage.User('The tool test succeeded. Reply with exactly WORKER_READY and no tool calls.')];
        const followup = await abortable(choice.model.sendRequest(history, { modelOptions: this.options(choice.model.id), justification: 'Verify worker tool-result replay.' }, source.token), controller.signal);
        let text = '';
        // Consume the same heterogeneous stream as workers. The text-only view
        // hides unsupported parts and used to allow a false-positive probe.
        const final = followup.stream[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await abortable(final.next(), controller.signal); if (next.done) {
              break;
            }
            const part = responsePart(next.value);
            if (part?.type === 'call') {
              throw new WorkerError('model_tools', 'Model requested another tool instead of confirming the probe result. It has not been enabled.');
            }
            if (part?.type === 'text') {
              text += part.text;
            }
            if (text.length > 10_000) {
              throw new WorkerError('output_limit', 'Model probe output exceeded the limit.');
            }
          }
        } finally {
          void final.return?.().catch(() => undefined);
        }
        if (!text.includes('WORKER_READY')) {
          throw new WorkerError('model_tools', 'Model did not confirm the tool result. It has not been enabled.');
        }
        if (this.context.languageModelAccessInformation.canSendRequest(choice.model) !== true) {
          throw new WorkerError('model_permission', 'The provider answered, but VS Code did not report persistent model access. Check language model access permissions for this extension.');
        }
        // Persist only after every check passed. The probe/consent above stays
        // outside the settings lock; only the commit is queued, and it re-reads
        // the latest pool inside the critical section so unrelated settings
        // edits made while the probe ran are preserved, existing keys/values/
        // order are untouched, and the new exact ID is appended with an empty
        // policy (built-in defaults) only when absent. The queued commit is
        // re-checked against cancellation, so cancelling the progress
        // notification while it waits behind another settings write never
        // persists the model.
        let added = false;
        await this.mutatePool(pool => {
          controller.signal.throwIfAborted();
          if (Object.prototype.hasOwnProperty.call(pool, choice.model.id)) {
            return undefined;
          }
          added = true;
          return { ...pool, [choice.model.id]: {} };
        });
        void vscode.window.showInformationMessage(added
          ? `${choice.model.name} passed tool calling and tool-result replay. Added to codexSubagent.models in User Settings.`
          : `${choice.model.name} passed tool calling and tool-result replay. It is already configured in codexSubagent.models; its policy was left unchanged.`);
      } finally {
        clearTimeout(timer); subscription.dispose(); source.cancel(); source.dispose();
      }
    });
  }
}

function isThinkingPart(part: unknown): boolean {
  const optional = vscode as unknown as { LanguageModelThinkingPart?: new (...args: never[]) => object };
  return typeof optional.LanguageModelThinkingPart === 'function' && part instanceof optional.LanguageModelThinkingPart;
}

/** Decode both setup probes and worker responses with the same compatibility rules. */
function responsePart(part: unknown): Part | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', text: part.value };
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'call', id: part.callId, name: part.name, input: part.input as Record<string, unknown> };
  }
  if (isThinkingPart(part)) {
    // Reasoning is not task output and is not persisted or replayed.
    return;
  }
  const data = typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart;
  if (data && (part.mimeType === 'usage' || part.mimeType === 'stateful_marker')) {
    // VS Code's built-in BYOK providers emit usage footers, including after
    // tool calls. Continuation markers are optional: we send complete durable
    // message history on every request rather than referencing server state.
    // Neither is assistant output. Do not parse, persist or replay the payload.
    return;
  }
  // Identify future incompatibilities without logging model content or binary
  // payloads. Unknown data/modalities must still fail instead of losing output.
  const kind = data ? 'LanguageModelDataPart' : part === null ? 'null' : typeof part === 'object' ? part.constructor?.name || 'object' : typeof part;
  const mime = data ? `, mimeType=${JSON.stringify(part.mimeType.slice(0, 100))}` : '';
  throw new WorkerError('unsupported_response', `Provider emitted an unsupported response part (${kind}${mime}). Workers support text, tool calls, and known reasoning/usage/continuation metadata.`);
}
