const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const Module = require('node:module');

class TextPart { constructor(value) { this.value = value; } }
class CallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class ThinkingPart { constructor(value) { this.value = value; } }
class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class Message {
  constructor(role, content) { Object.assign(this, { role, content }); }
  static User(text) { return new Message(1, [new TextPart(text)]); }
}
class CancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
let calls;
let access;
let selected;
let model;
let config;
const vscode = {
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: CallPart, LanguageModelToolResultPart: ResultPart,
  LanguageModelThinkingPart: ThinkingPart, LanguageModelDataPart: DataPart, LanguageModelChatMessage: Message,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, CancellationTokenSource,
  ProgressLocation: { Notification: 1 },
  ConfigurationTarget: { Global: 1 },
  lm: { async selectChatModels(selector) { return !selector || selector.id === model.id ? [model] : []; } },
  workspace: { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => config.get(key) ?? fallback, update: async (key, value) => config.set(key, value) }) },
  window: {
    showQuickPick: async choices => selected ? choices[0] : undefined,
    withProgress: async (_options, action) => action({}, { onCancellationRequested: () => ({ dispose() {} }) }),
    showInformationMessage() {},
  },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest); };
const { VscodeProvider, metadata } = require('../.test-build/vscode-provider');
Module._load = originalLoad;

function context(enabled = []) {
  const state = new Map([['enabledModels', enabled]]);
  return {
    globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) },
    languageModelAccessInformation: { canSendRequest: () => access },
    get secrets() { throw new Error('Credential extraction is forbidden'); },
  };
}
beforeEach(() => {
  calls = []; access = true; selected = true;
  vscode.LanguageModelThinkingPart = ThinkingPart;
  vscode.LanguageModelDataPart = DataPart;
  config = new Map();
  vscode.workspace.isTrusted = true;
  model = {
    id: 'configured/byok', name: 'Qwen', vendor: 'customendpoint', family: 'qwen', version: '1', maxInputTokens: 262144,
    countTokens: async text => text.length,
    async sendRequest(messages, options, token) {
      calls.push({ messages, options, token });
      const probe = options.tools?.[0]?.name === 'worker_probe';
      return { stream: (async function* () {
        yield new ThinkingPart('internal');
        if (!options.tools?.length) { yield new TextPart('WORKER_READY'); }
        else {
          yield new TextPart('answer');
          yield new CallPart('c', probe ? 'worker_probe' : 'read_file', probe ? { value: 'WORKER_READY' } : { path: 'a' });
        }
        yield new DataPart(Buffer.from('model\\continuation-id'), 'stateful_marker');
        yield new DataPart(Buffer.from('{"prompt_tokens":10,"completion_tokens":3}'), 'usage');
      })() };
    },
  };
});

test('model enable performs user-initiated API access without extracting credentials', async () => {
  const ctx = context();
  const provider = new VscodeProvider(ctx);
  assert.deepEqual(await provider.models(), []);
  await provider.enable();
  assert.equal(calls.length, 2);
  assert.deepEqual(provider.enabled(), [model.id]);
  assert.equal(ctx.globalState.get('defaultModel'), model.id);
  assert.equal((await provider.models())[0].id, model.id);
  assert.equal(calls[0].options.modelOptions.apiKey, undefined);
  assert.ok(calls[1].messages.some(m => m.content.some(p => p instanceof ResultPart)));
});

test('background inference requires enabled model and affirmative VS Code access', async () => {
  const provider = new VscodeProvider(context([model.id]));
  access = undefined;
  await assert.rejects(async () => { for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; } }, { code: 'model_permission' });
  assert.equal(calls.length, 0);
  access = false;
  assert.deepEqual(await provider.models(), []);
});

test('adapter preserves tool calls/results, ignores reasoning parts and passes tools', async () => {
  const provider = new VscodeProvider(context([model.id]));
  const history = [{ role: 'assistant', parts: [{ type: 'call', id: 'prior', name: 'read_file', input: { path: 'a' } }] }, { role: 'user', parts: [{ type: 'result', id: 'prior', text: 'file contents' }] }];
  const tools = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }];
  const parts = [];
  for await (const part of provider.stream(metadata(model), history, tools, new AbortController().signal)) { parts.push(part); }
  assert.deepEqual(parts, [{ type: 'text', text: 'answer' }, { type: 'call', id: 'c', name: 'read_file', input: { path: 'a' } }]);
  assert.ok(calls[0].messages[0].content[0] instanceof CallPart);
  assert.ok(calls[0].messages[1].content[0] instanceof ResultPart);
  assert.deepEqual(calls[0].options.tools, tools);
  assert.equal(calls[0].token.isCancellationRequested, true);
});

test('BYOK usage footers do not abort tool calls or leak metadata into the next request', async () => {
  const ctx = context([model.id]);
  const provider = new VscodeProvider(ctx);
  let round = 0;
  model.sendRequest = async (messages) => {
    calls.push(messages);
    return { stream: (async function* () {
      if (round++ === 0) {
        yield new CallPart('read', 'read_file', { path: 'AGENTS.md' });
      } else {
        yield new TextPart('Verified AGENTS.md');
      }
      yield new DataPart(Buffer.from('private marker'), 'stateful_marker');
      yield new DataPart(Buffer.from('{"completion_tokens":42}'), 'usage');
    })() };
  };
  const input = [{ role: 'user', parts: [{ type: 'text', text: 'Read AGENTS.md' }] }];
  const collect = async () => {
    const output = [];
    for await (const part of provider.stream(metadata(model), input, [], new AbortController().signal)) { output.push(part); }
    return output;
  };
  const toolCall = await collect();
  assert.deepEqual(toolCall, [{ type: 'call', id: 'read', name: 'read_file', input: { path: 'AGENTS.md' } }]);
  input.push({ role: 'assistant', parts: toolCall }, { role: 'user', parts: [{ type: 'result', id: 'read', text: 'Lead policy' }] });
  assert.deepEqual(await collect(), [{ type: 'text', text: 'Verified AGENTS.md' }]);
  assert.ok(calls[1][1].content[0] instanceof CallPart);
  assert.ok(calls[1][2].content[0] instanceof ResultPart);
  assert.ok(!JSON.stringify(calls).includes('private marker'));
  assert.ok(!JSON.stringify(calls).includes('completion_tokens'));
});

test('unknown data parts fail with bounded type diagnostics and no payload', async () => {
  model.sendRequest = async () => ({ stream: (async function* () {
    yield new DataPart(Buffer.from('PRIVATE PAYLOAD'), 'image/png');
  })() });
  const provider = new VscodeProvider(context([model.id]));
  await assert.rejects(async () => {
    for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; }
  }, error => error.code === 'unsupported_response' && /LanguageModelDataPart.*image\/png/.test(error.message) && !error.message.includes('PRIVATE PAYLOAD'));
});

test('setup rejects unsupported parts in both the tool-call and replay responses', async () => {
  for (const failingRound of [0, 1]) {
    let round = 0;
    const ctx = context();
    model.sendRequest = async () => {
      const current = round++;
      return {
        stream: (async function* () {
          if (current === 0) { yield new CallPart('probe', 'worker_probe', { value: 'WORKER_READY' }); }
          else { yield new TextPart('WORKER_READY'); }
          if (current === failingRound) { yield new DataPart(Buffer.from('PRIVATE PAYLOAD'), 'application/unknown'); }
        })(),
        // The old follow-up probe used this view and missed unsupported parts.
        text: (async function* () { yield 'WORKER_READY'; })(),
      };
    };
    const provider = new VscodeProvider(ctx);
    await assert.rejects(provider.enable(), { code: 'unsupported_response' });
    assert.deepEqual(provider.enabled(), []);
  }
});

test('setup rejects another tool call during replay even when readiness text is present', async () => {
  let round = 0;
  model.sendRequest = async () => ({ stream: (async function* () {
    if (round++ === 0) { yield new CallPart('probe', 'worker_probe', { value: 'WORKER_READY' }); }
    else { yield new TextPart('WORKER_READY'); yield new CallPart('extra', 'worker_probe', { value: 'WORKER_READY' }); }
  })() });
  const provider = new VscodeProvider(context());
  await assert.rejects(provider.enable(), { code: 'model_tools' });
  assert.deepEqual(provider.enabled(), []);
});

test('plain text works on older hosts without optional response constructors', async () => {
  vscode.LanguageModelThinkingPart = undefined;
  vscode.LanguageModelDataPart = undefined;
  model.sendRequest = async () => ({ stream: (async function* () { yield new TextPart('answer'); })() });
  const provider = new VscodeProvider(context([model.id]));
  const parts = [];
  for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { parts.push(part); }
  assert.deepEqual(parts, [{ type: 'text', text: 'answer' }]);
});

test('changed model identity or untrusted workspace fails before inference', async () => {
  const provider = new VscodeProvider(context([model.id]));
  const original = metadata(model);
  model.version = '2';
  await assert.rejects(provider.countTokens(original, { role: 'user', parts: [] }), { code: 'model_unavailable' });
  vscode.workspace.isTrusted = false;
  await assert.rejects(provider.countTokens(metadata(model), { role: 'user', parts: [] }), { code: 'workspace_untrusted' });
  assert.equal(calls.length, 0);
});

test('denied access test never enables a model', async () => {
  const ctx = context();
  const provider = new VscodeProvider(ctx);
  model.sendRequest = async () => { const error = new Error('access denied'); error.code = 'NoPermissions'; throw error; };
  await assert.rejects(provider.enable(), /access denied/);
  assert.deepEqual(provider.enabled(), []);
});

test('enabling another model preserves explicit default and applies per-model options', async () => {
  config.set('defaultModel', 'existing-default');
  config.set('modelOptions', { shared: true, temperature: 1 });
  config.set('modelProfiles', { [model.id]: { temperature: 0, reasoningEffort: 'low' } });
  const provider = new VscodeProvider(context());
  await provider.enable();
  assert.equal(provider.defaultModel(), 'existing-default');
  assert.deepEqual(calls[0].options.modelOptions, { shared: true, temperature: 0, reasoningEffort: 'low' });
});

test('text-only access success does not enable a model that cannot call tools', async () => {
  model.sendRequest = async () => ({ stream: (async function* () { yield new TextPart('WORKER_READY'); })() });
  const provider = new VscodeProvider(context());
  await assert.rejects(provider.enable(), { code: 'model_tools' });
  assert.deepEqual(provider.enabled(), []);
});
