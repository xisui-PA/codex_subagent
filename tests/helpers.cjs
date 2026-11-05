const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkerEngine, defaults } = require('../.test-build/engine');
const { SessionStore } = require('../.test-build/storage');

const model = { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 100_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) { throw new Error('Condition timed out'); } await sleep(5); }
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-worker-test-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  await store.open();
  const requests = [];
  const provider = {
    models: async () => [model, { ...model, id: 'other', name: 'Other' }],
    countTokens: async () => 10,
    async *stream(selected, messages, tools, signal) {
      requests.push({ model: selected, messages, tools });
      if (options.stream) { yield* options.stream(selected, messages, tools, signal, requests.length); }
      else { yield { type: 'text', text: 'done' }; }
    },
    ...options.provider,
  };
  const tools = options.tools || { definitions: () => [], execute: async () => 'ok' };
  const engine = new WorkerEngine(store, provider, tools, () => ({ ...defaults, autoCompact: false, retries: 0, ...options.settings }), () => model.id);
  t.after(async () => { await engine.shutdown(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, engine, provider, requests };
}
async function finished(engine, id) { await until(() => !['running', 'queued'].includes(engine.store.get(id).state)); return engine.store.get(id); }
module.exports = { model, sleep, deferred, until, fixture, finished };
