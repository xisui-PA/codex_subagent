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
let commitTail = Promise.resolve();
let updateGate = null;
let progressCancel = null;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const vscode = {
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: CallPart, LanguageModelToolResultPart: ResultPart,
  LanguageModelThinkingPart: ThinkingPart, LanguageModelDataPart: DataPart, LanguageModelChatMessage: Message,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, CancellationTokenSource,
  ProgressLocation: { Notification: 1 },
  ConfigurationTarget: { Global: 1 },
  lm: { async selectChatModels(selector) { return !selector || selector.id === model.id ? [model] : []; } },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (key, fallback) => config.get(key) ?? fallback,
      inspect: key => ({ key, globalValue: config.get(key), workspaceValue: config.get(`workspace:${key}`) }),
      // Faithful to the real extension host: update() is an RPC whose effect on
      // the locally mirrored inspect().globalValue is published asynchronously,
      // in call order, only before the returned promise resolves. Tests can hold
      // publication with `updateGate` to expose read-modify-write races.
      update: async (key, value) => {
        const record = { key, value };
        commitTail = commitTail.then(async () => {
          if (updateGate) { await updateGate; }
          config.set(record.key, record.value);
        }).catch(() => undefined);
        return commitTail;
      }
    })
  },
  window: {
    showQuickPick: async choices => selected ? choices[0] : undefined,
    withProgress: async (_options, action) => {
      // Capture the cancellation handler so tests can cancel the notification
      // deterministically, like pressing the progress notification's X.
      return action({}, { onCancellationRequested: handler => { progressCancel = handler; return { dispose() { if (progressCancel === handler) { progressCancel = null; } } }; } });
    },
    showInformationMessage() {},
  },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest); };
const { VscodeProvider, metadata } = require('../.test-build/vscode-provider');
Module._load = originalLoad;

// The context intentionally has NO globalState: enable/disable live only in
// the user models setting, so hidden enabled-model/default-model state cannot
// be read or written.
function context() {
  return {
    languageModelAccessInformation: { canSendRequest: () => access },
    get secrets() { throw new Error('Credential extraction is forbidden'); },
  };
}
const enabledIds = () => new VscodeProvider(context()).enabled();
const poolValue = () => config.get('models') || {};
const probeSend = () => async (messages, options, token) => {
  calls.push({ messages, options, token });
  const probe = options.tools?.[0]?.name === 'worker_probe';
  return { stream: (async function* () {
    if (probe) { yield new CallPart('c', 'worker_probe', { value: 'WORKER_READY' }); }
    else { yield new TextPart('WORKER_READY'); }
  })() };
};
beforeEach(() => {
  calls = []; access = true; selected = true;
  vscode.LanguageModelThinkingPart = ThinkingPart;
  vscode.LanguageModelDataPart = DataPart;
  config = new Map();
  commitTail = Promise.resolve();
  updateGate = null;
  progressCancel = null;
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

test('enable performs the user-initiated API access then adds the exact ID to the user models setting', async () => {
  const provider = new VscodeProvider(context());
  assert.deepEqual(await provider.models(), []);
  await provider.enable();
  assert.equal(calls.length, 2);
  assert.deepEqual(provider.enabled(), [model.id]);
  assert.deepEqual(poolValue(), { [model.id]: {} });
  assert.equal(config.get('defaultModel'), undefined);
  assert.equal('globalState' in context(), false, 'enable must not rely on hidden extension state');
  assert.equal((await provider.models())[0].id, model.id);
  assert.equal(calls[0].options.modelOptions.apiKey, undefined);
  assert.ok(calls[1].messages.some(m => m.content.some(p => p instanceof ResultPart)));
});

test('re-enabling preserves existing pool values/order and settings edits made during the probe', async () => {
  config.set('models', { 'first/model': { numSessions: 2, allowWrite: false }, [model.id]: { numSessions: 4 } });
  const provider = new VscodeProvider(context());
  const originalSend = model.sendRequest;
  model.sendRequest = async (...args) => {
    if (calls.length === 1) {
      // An unrelated manual settings edit performed while the probe awaited.
      config.set('models', { ...config.get('models'), 'late/model': { allowWrite: false } });
    }
    return originalSend(...args);
  };
  await provider.enable();
  const pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['first/model', model.id, 'late/model']);
  assert.deepEqual(pool['first/model'], { numSessions: 2, allowWrite: false });
  assert.deepEqual(pool[model.id], { numSessions: 4 }, 're-enable must not reset an existing policy');
});

test('failed, cancelled, unsupported or unconsented enable attempts never mutate the models setting', async () => {
  // Cancelled quick pick.
  selected = false;
  await new VscodeProvider(context()).enable();
  assert.equal(config.get('models'), undefined);
  selected = true;

  // Denied API access.
  model.sendRequest = async () => { const error = new Error('access denied'); error.code = 'NoPermissions'; throw error; };
  await assert.rejects(new VscodeProvider(context()).enable(), /access denied/);
  assert.equal(config.get('models'), undefined);

  // Missing affirmative consent after an otherwise successful probe.
  model.sendRequest = probeSend();
  access = undefined;
  await assert.rejects(new VscodeProvider(context()).enable(), { code: 'model_permission' });
  assert.equal(config.get('models'), undefined);
  assert.deepEqual(enabledIds(), []);
});

test('manual user settings additions/removals take effect immediately and workspace scope never enables', async () => {
  const provider = new VscodeProvider(context());
  assert.deepEqual(provider.enabled(), []);
  assert.deepEqual(await provider.models(), []);
  await assert.rejects(async () => { for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; } }, { code: 'model_permission' });
  assert.equal(calls.length, 0);

  // A workspace-scoped models value must never enable or expand the pool.
  config.set('workspace:models', { [model.id]: {} });
  assert.deepEqual(provider.enabled(), []);

  // Only the user (global) value enables models, live.
  config.set('models', { [model.id]: {} });
  assert.deepEqual(provider.enabled(), [model.id]);
  assert.deepEqual((await provider.models()).map(m => m.id), [model.id]);
  for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; }
  assert.equal(calls.length, 1);

  // Removal is immediate too.
  config.set('models', {});
  assert.deepEqual(provider.enabled(), []);
  assert.deepEqual(await provider.models(), []);
  await assert.rejects(async () => { for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; } }, { code: 'model_permission' });
  assert.equal(calls.length, 1);
});

test('disable removes only the selected key from the user pool and preserves other values and order', async () => {
  config.set('models', { first: { numSessions: 3 }, gone: { allowWrite: false }, last: {} });
  const provider = new VscodeProvider(context());
  // Removing an ID that VS Code no longer exposes is still supported.
  await provider.disable('gone');
  const pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['first', 'last']);
  assert.deepEqual(pool.first, { numSessions: 3 });
  assert.deepEqual(pool.last, {});
  assert.equal(config.get('defaultModel'), undefined);
});

test('own-property-safe membership handles exact IDs such as __proto__', async () => {
  // JSON.parse produces an OWN "__proto__" key, exactly like a saved settings value.
  config.set('models', JSON.parse('{"__proto__":{},"second":{}}'));
  const provider = new VscodeProvider(context());
  // parseModelSettings keeps '__proto__' as an own key; inherited Object.prototype
  // members must never appear as enabled models.
  assert.deepEqual(provider.enabled(), ['__proto__', 'second']);
  assert.ok(!provider.enabled().includes('toString'));
  await provider.disable('__proto__');
  const pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['second']);
  assert.deepEqual(pool.second, {});
});

test('models() follows configured pool order over provider availability order', async () => {
  const available = [
    { id: 'second/id', name: 'Second', vendor: 'v', family: 'f', version: '1', maxInputTokens: 1000 },
    { id: 'first/id', name: 'First', vendor: 'v', family: 'f', version: '1', maxInputTokens: 1000 },
  ];
  const originalSelect = vscode.lm.selectChatModels;
  vscode.lm.selectChatModels = async () => available;
  try {
    config.set('models', { 'first/id': {}, 'second/id': {}, 'absent/id': {} });
    const provider = new VscodeProvider(context());
    assert.deepEqual(provider.enabled(), ['first/id', 'second/id', 'absent/id']);
    assert.deepEqual((await provider.models()).map(m => m.id), ['first/id', 'second/id']);
  } finally {
    vscode.lm.selectChatModels = originalSelect;
  }
});

test('a model removed from the setting while selectChatModels is pending cannot authorize inference', async () => {
  const provider = new VscodeProvider(context());
  config.set('models', { [model.id]: {} });
  const originalSelect = vscode.lm.selectChatModels;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  vscode.lm.selectChatModels = async () => { await gate; return [model]; };
  try {
    const running = provider.countTokens(metadata(model), { role: 'user', parts: [{ type: 'text', text: 'x' }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    // The user removes the model (or the whole pool) mid-preparation.
    config.set('models', {});
    release();
    await assert.rejects(running, { code: 'model_permission' });
    assert.equal(calls.length, 0);
  } finally {
    vscode.lm.selectChatModels = originalSelect;
  }
});

test('background inference requires the configured model and affirmative VS Code access', async () => {
  config.set('models', { [model.id]: {} });
  const provider = new VscodeProvider(context());
  access = undefined;
  await assert.rejects(async () => { for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; } }, { code: 'model_permission' });
  assert.equal(calls.length, 0);
  access = false;
  assert.deepEqual(await provider.models(), []);
});

test('adapter preserves tool calls/results, ignores reasoning parts and passes tools', async () => {
  config.set('models', { [model.id]: {} });
  const provider = new VscodeProvider(context());
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
  config.set('models', { [model.id]: {} });
  const provider = new VscodeProvider(context());
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
  config.set('models', { [model.id]: {} });
  model.sendRequest = async () => ({ stream: (async function* () {
    yield new DataPart(Buffer.from('PRIVATE PAYLOAD'), 'image/png');
  })() });
  const provider = new VscodeProvider(context());
  await assert.rejects(async () => {
    for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { void part; }
  }, error => error.code === 'unsupported_response' && /LanguageModelDataPart.*image\/png/.test(error.message) && !error.message.includes('PRIVATE PAYLOAD'));
});

test('setup rejects unsupported parts in both the tool-call and replay responses', async () => {
  for (const failingRound of [0, 1]) {
    let round = 0;
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
    const provider = new VscodeProvider(context());
    await assert.rejects(provider.enable(), { code: 'unsupported_response' });
    assert.deepEqual(provider.enabled(), []);
    assert.equal(config.get('models'), undefined);
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
  assert.equal(config.get('models'), undefined);
});

test('plain text works on older hosts without optional response constructors', async () => {
  vscode.LanguageModelThinkingPart = undefined;
  vscode.LanguageModelDataPart = undefined;
  config.set('models', { [model.id]: {} });
  model.sendRequest = async () => ({ stream: (async function* () { yield new TextPart('answer'); })() });
  const provider = new VscodeProvider(context());
  const parts = [];
  for await (const part of provider.stream(metadata(model), [], [], new AbortController().signal)) { parts.push(part); }
  assert.deepEqual(parts, [{ type: 'text', text: 'answer' }]);
});

test('changed model identity or untrusted workspace fails before inference', async () => {
  config.set('models', { [model.id]: {} });
  const provider = new VscodeProvider(context());
  const original = metadata(model);
  model.version = '2';
  await assert.rejects(provider.countTokens(original, { role: 'user', parts: [] }), { code: 'model_unavailable' });
  vscode.workspace.isTrusted = false;
  await assert.rejects(provider.countTokens(metadata(model), { role: 'user', parts: [] }), { code: 'workspace_untrusted' });
  assert.equal(calls.length, 0);
});

test('enable applies configured nested modelOptions in BOTH probe rounds without introducing any default model', async () => {
  // Re-enabling a configured model still probes it using its existing options.
  config.set('models', { 'other/model': { allowWrite: false }, [model.id]: { numSessions: 2, modelOptions: { temperature: 0, reasoningEffort: 'low', nested: { deep: true } } } });
  const provider = new VscodeProvider(context());
  await provider.enable();
  assert.equal(config.get('defaultModel'), undefined);
  assert.equal(calls.length, 2);
  const expected = { temperature: 0, reasoningEffort: 'low', nested: { deep: true } };
  assert.deepEqual(calls[0].options.modelOptions, expected);
  assert.deepEqual(calls[1].options.modelOptions, expected);
  // Re-enable kept the existing entry (policy and options) and its position.
  assert.deepEqual(Object.keys(poolValue()), ['other/model', model.id]);
  assert.deepEqual(poolValue()[model.id], { numSessions: 2, modelOptions: expected });
});

test('options come only from the selected model entry; absent, unconfigured and stale globals yield {}', async () => {
  // Stale removed top-level settings must be ignored completely.
  config.set('modelOptions', { shared: true, temperature: 1 });
  config.set('modelProfiles', { [model.id]: { temperature: 0 }, 'other/model': { bogus: true } });
  // A workspace-scoped entry can never expand or override user options.
  config.set('workspace:models', { [model.id]: { modelOptions: { fromWorkspace: true } } });
  config.set('models', { [model.id]: { allowWrite: false }, 'plain/model': {} });
  const provider = new VscodeProvider(context());
  assert.deepEqual(provider.options(model.id), {});
  assert.deepEqual(provider.options('plain/model'), {}, 'omitted nested options default to {}');
  assert.deepEqual(provider.options('never/configured'), {}, 'unknown IDs get {} and enable probes of not-yet-enabled models work');
  // Only the user pool entry's own nested object is used for requests.
  config.set('models', { [model.id]: { modelOptions: { temperature: 0.5, providerSpecific: { x: [1, 2] } } } });
  assert.deepEqual(provider.options(model.id), { temperature: 0.5, providerSpecific: { x: [1, 2] } });
  for await (const part of provider.stream({ id: model.id, name: model.name, vendor: model.vendor, family: model.family, version: model.version, maxInputTokens: model.maxInputTokens }, [], [], new AbortController().signal)) { void part; }
  assert.deepEqual(calls[0].options.modelOptions, { temperature: 0.5, providerSpecific: { x: [1, 2] } });
});

test('setModelOptions preserves policies/order/latest edits and never resurrects a removed model', async () => {
  config.set('models', { first: { numSessions: 3, modelOptions: { temperature: 1 } }, target: { allowWrite: false }, last: {} });
  const provider = new VscodeProvider(context());
  await provider.setModelOptions('target', { reasoningEffort: 'high', nested: { ok: true } });
  let pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['first', 'target', 'last'], 'pool order is preserved');
  assert.deepEqual(pool.first, { numSessions: 3, modelOptions: { temperature: 1 } }, 'other entries untouched');
  assert.deepEqual(pool.target, { allowWrite: false, modelOptions: { reasoningEffort: 'high', nested: { ok: true } } }, 'only modelOptions changed');
  assert.deepEqual(pool.last, {});
  await provider.setModelOptions('target', { temperature: 0 });
  assert.deepEqual(poolValue().target, { allowWrite: false, modelOptions: { temperature: 0 } }, 'replacement, not merge');

  // The model was disabled while the UI dialog awaited: do not recreate it.
  config.set('models', { first: {}, last: {} });
  await assert.rejects(provider.setModelOptions('target', { temperature: 0 }), { code: 'model_not_configured' });
  pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['first', 'last'], 'removed model stays removed');
  assert.deepEqual(provider.options('target'), {}, 'unconfigured target still just yields {} for reads');
});

test('concurrent pool mutations serialize: no model is resurrected by a lost update', async () => {
  // The real host publishes update() into inspect().globalValue asynchronously.
  // Gate publication so both mutations observe the pre-write pool snapshot,
  // which is exactly the window a non-serialized read-modify-write loses.
  config.set('models', { 'model/a': { numSessions: 2 }, 'model/b': { allowWrite: false }, 'model/c': {} });
  const gate = deferred();
  updateGate = gate.promise;
  const first = new VscodeProvider(context()).disable('model/a');
  const second = new VscodeProvider(context()).disable('model/b');
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, second]);
  const pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['model/c'], 'both removals must survive; neither write may resurrect a disabled model');
  // The lock must not be poisoned: a later mutation still sees the committed pool.
  await new VscodeProvider(context()).setModelOptions('model/c', { temperature: 0 });
  assert.deepEqual(poolValue(), { 'model/c': { modelOptions: { temperature: 0 } } });
});

test('options save racing a disable preserves the removal and rejects the queued update', async () => {
  config.set('models', { keep: { numSessions: 3, modelOptions: { temperature: 1 } }, target: { allowWrite: false } });
  const provider = new VscodeProvider(context());
  const gate = deferred();
  updateGate = gate.promise;
  // Simulates Configure Model Options submitted while a Disable command is in flight.
  const disabling = provider.disable('target');
  const saving = provider.setModelOptions('target', { reasoningEffort: 'high' });
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await disabling;
  await assert.rejects(saving, { code: 'model_not_configured' }, 'a removed model must not be re-created by an options save');
  const pool = poolValue();
  assert.deepEqual(Object.keys(pool), ['keep']);
  assert.deepEqual(pool.keep, { numSessions: 3, modelOptions: { temperature: 1 } }, 'other policies survive');
  assert.deepEqual(provider.options('target'), {});
  // The rejection must not poison the settings lock: a later successful
  // mutation of a surviving entry still goes through.
  await new VscodeProvider(context()).setModelOptions('keep', { temperature: 0 });
  assert.deepEqual(poolValue(), { keep: { numSessions: 3, modelOptions: { temperature: 0 } } });
});

test('enable commit is serialized with a concurrent disable and does not resurrect it', async () => {
  // Actual competing mutators on one pool: a Disable command in flight while
  // Enable Model's successful probe commits its append. Uses the standard
  // beforeEach probe mock (no manual settings writes).
  config.set('models', { 'other/model': { allowWrite: false, numSessions: 4 } });
  const provider = new VscodeProvider(context());
  const gate = deferred();
  updateGate = gate.promise;
  try {
    const disabling = provider.disable('other/model');
    const enabling = provider.enable();
    await new Promise(resolve => setImmediate(resolve));
    const probeCalls = calls.length;
    gate.resolve();
    await Promise.all([disabling, enabling]);
    // The probe ran outside the settings lock: both provider rounds were issued
    // while the gated commit was still pending.
    assert.equal(probeCalls, 2, 'probe/consent must not wait behind the settings lock');
    // Enable appended to the pool read inside the critical section, so the
    // concurrently disabled entry stays removed instead of being resurrected.
    assert.deepEqual(poolValue(), { [model.id]: {} }, 'the disabled model must not be resurrected by the enable append');
  } finally {
    gate.resolve();
    updateGate = null;
  }
});

test('cancelling Enable while its commit queues behind a Disable never writes the pool', async () => {
  // A Disable holds the settings lock on a gated configuration.update. The
  // Enable probe (outside the lock) finishes and its commit queues; the user
  // then cancels the progress notification. The queued commit must abort
  // without persisting, and the lock must stay usable.
  config.set('models', { 'other/model': { allowWrite: false, numSessions: 4 } });
  const provider = new VscodeProvider(context());
  const gate = deferred();
  updateGate = gate.promise;
  const disabling = provider.disable('other/model');
  const enabling = provider.enable().then(
    () => ({ status: 'fulfilled' }),
    error => ({ status: 'rejected', error })
  );
  try {
    // The probe's two provider rounds complete while its commit is blocked.
    for (let attempt = 0; calls.length < 2 && attempt < 100; attempt++) { await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(calls.length, 2);
    assert.ok(progressCancel, 'the progress notification registered a cancellation handler');
    progressCancel();
    gate.resolve();
    await disabling;
    const result = await enabling;
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'cancelled');
    assert.deepEqual(poolValue(), {}, 'the cancelled enable must not persist the model');
    // The settings lock recovers after the aborted commit.
    await provider.disable('ghost/model');
    assert.deepEqual(poolValue(), {});
  } finally {
    gate.resolve();
    updateGate = null;
    await Promise.allSettled([disabling, enabling]);
  }
});

test('text-only access success does not enable a model that cannot call tools', async () => {
  model.sendRequest = async () => ({ stream: (async function* () { yield new TextPart('WORKER_READY'); })() });
  const provider = new VscodeProvider(context());
  await assert.rejects(provider.enable(), { code: 'model_tools' });
  assert.deepEqual(provider.enabled(), []);
  assert.equal(config.get('models'), undefined);
});
