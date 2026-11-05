import * as vscode from 'vscode';
import { Message, Model, Part, Provider, WorkerError } from './types';
import { abortable } from './async';

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
  enabled(): string[] {
    return this.context.globalState.get<string[]>('enabledModels', []);
  }
  async models(): Promise<Model[]> {
    const enabled = this.enabled();
    return (await vscode.lm.selectChatModels()).filter(m => enabled.includes(m.id) && this.context.languageModelAccessInformation.canSendRequest(m) === true).map(metadata);
  }
  options(modelId: string): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration('codexSubagent');
    const profiles = config.get<Record<string, Record<string, unknown>>>('modelProfiles', {});
    return { ...config.get<Record<string, unknown>>('modelOptions', {}), ...(profiles[modelId] || {}) };
  }
  defaultModel(): string {
    return vscode.workspace.getConfiguration('codexSubagent').get<string>('defaultModel') || this.context.globalState.get<string>('defaultModel', '');
  }
  async setDefault(id: string): Promise<void> {
    await vscode.workspace.getConfiguration('codexSubagent').update('defaultModel', id, vscode.ConfigurationTarget.Global);
    await this.context.globalState.update('defaultModel', id);
  }
  async disable(id: string): Promise<void> {
    const remaining = this.enabled().filter(candidate => candidate !== id);
    await this.context.globalState.update('enabledModels', remaining);
    if (this.defaultModel() === id) {
      await this.setDefault('');
    }
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
        await this.context.globalState.update('enabledModels', [...new Set([...this.enabled(), choice.model.id])]);
        if (!this.defaultModel()) {
          await this.setDefault(choice.model.id);
        }
        void vscode.window.showInformationMessage(`${choice.model.name} passed tool calling and tool-result replay. ${this.defaultModel() === choice.model.id ? 'It is the default worker model.' : 'Your existing default is unchanged.'}`);
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
