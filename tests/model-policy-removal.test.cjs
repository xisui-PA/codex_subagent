const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { defaults } = require('../.test-build/engine');
const { effectiveSettings, parseModelSettings, poolAllows } = require('../.test-build/model-settings');
const { WorkerEngine } = require('../.test-build/engine');
const { SessionStore } = require('../.test-build/storage');
const { FileTools } = require('../.test-build/workspace-tools');

const model = { id: 'byok/sole', name: 'Sole', vendor: 'byok', family: 'sole', version: '1', maxInputTokens: 100_000 };

test('manifest removes superseded global settings while retaining models and notifications', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = Object.keys(manifest.contributes.configuration.properties);
  for (const removed of ['allowWrites', 'allowShell', 'maxConcurrentWorkers', 'maxToolRounds', 'turnTimeoutSeconds', 'autoCompact', 'defaultModel', 'modelOptions', 'modelProfiles']) {
    assert.equal(contributed.includes(`codexSubagent.${removed}`), false, removed);
  }
  for (const retained of ['models', 'notifyOnCompletion']) {
    assert.ok(contributed.includes(`codexSubagent.${retained}`), retained);
  }
  const commands = manifest.contributes.commands.map(command => command.command);
  assert.equal(commands.includes('codexSubagent.setDefaultModel'), false);
  const policy = manifest.contributes.configuration.properties['codexSubagent.models'].additionalProperties.properties;
  assert.equal(policy.allowWrite.default, true);
  assert.equal(policy.allowShell.default, true);
  assert.equal(policy.numSessions.default, 1);
  assert.match(policy.maxToolRounds.description, /default when omitted: 40/);
  assert.match(policy.turnTimeoutSeconds.description, /default when omitted: 600/);
  assert.match(policy.autoCompact.description, /default when omitted: true/);
  // Provider request options moved into the models entry itself.
  assert.equal(policy.modelOptions.type, 'object');
  assert.deepEqual(policy.modelOptions.default, {});
  assert.equal(policy.modelOptions.additionalProperties, true);
  assert.match(policy.modelOptions.description, /never put credentials/i);
});

test('omitted model tuning uses engine built-ins and pool aggregation requires an explicit writable policy', () => {
  assert.deepEqual(parseModelSettings({ 'byok/sole': {} }), { 'byok/sole': {} });
  const configured = effectiveSettings({ ...defaults, models: parseModelSettings({ 'byok/sole': {} }) }, 'byok/sole');
  assert.equal('maxConcurrent' in configured, false, 'global capacity scheduling was removed; numSessions is pool capacity');
  assert.equal(configured.maxToolRounds, 40);
  assert.equal(configured.turnTimeoutMs, 600_000);
  assert.equal(configured.autoCompact, true);

  assert.equal(poolAllows({}, 'allowWrite'), false);
  assert.equal(poolAllows({}, 'allowShell'), false);
  assert.equal(poolAllows({ a: {}, b: { allowShell: false } }, 'allowWrite'), true);
  assert.equal(poolAllows({ a: { allowWrite: false }, b: {} }, 'allowWrite'), true);
  assert.equal(poolAllows({ a: { allowWrite: false }, b: { allowWrite: false } }, 'allowWrite'), false);
  // Shell must come from one policy that allows both writes and shell.
  assert.equal(poolAllows({ a: { allowWrite: false, allowShell: true } }, 'allowShell'), false);
  assert.equal(poolAllows({ a: { allowWrite: true, allowShell: false }, b: { allowWrite: false, allowShell: true } }, 'allowShell'), false);
  assert.equal(poolAllows({ a: { allowWrite: true, allowShell: true } }, 'allowShell'), true);
});

test('empty model pool offers no candidate for any permission and cannot gain writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-pool-write-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  await store.open();
  const files = await FileTools.create([root], { canWrite: () => false, allowShell: () => false });
  const provider = { models: async () => [model], countTokens: async () => 1, async *stream() { yield { type: 'text', text: 'read done' }; } };
  const engine = new WorkerEngine(store, provider, files, () => ({ ...defaults, autoCompact: false, retries: 0, models: {} }));
  t.after(async () => { await engine.shutdown(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });

  // An empty models setting means NOTHING is enabled: even read-only spawns
  // fail with actionable Enable Model guidance instead of a default fallback.
  await assert.rejects(engine.spawn({ requestId: 'legacy-reader', task: 'Read only', permission: 'read-only' }), error => error.code === 'model_unavailable' && /Enable Model/.test(error.message));
  await assert.rejects(engine.spawn({ requestId: 'legacy-writer', task: 'No writer policy', permission: 'workspace-write' }), error => error.code === 'model_unavailable' && /Enable Model/.test(error.message));
  // An explicit exact-ID selection is also rejected when the pool is empty.
  await assert.rejects(engine.spawn({ requestId: 'explicit', task: 'Pinned', permission: 'read-only', model: model.id }), { code: 'model_unavailable' });
});

test('per-model write and shell availability live revoke when the entire pool is removed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-removal-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  await store.open();
  const models = parseModelSettings({ 'byok/sole': { allowWrite: true, allowShell: true } });
  const settings = () => ({ ...defaults, autoCompact: false, retries: 0, models });
  const files = await FileTools.create([root], {
    canWrite: () => poolAllows(models, 'allowWrite'),
    allowShell: () => poolAllows(models, 'allowShell'),
    approveCommand: async () => true
  });
  const provider = { models: async () => [model], countTokens: async () => 1, async *stream() { yield { type: 'text', text: 'unused' }; } };
  const engine = new WorkerEngine(store, provider, files, settings);
  t.after(async () => { await engine.shutdown(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });

  const session = { id: 'sole', model, permission: 'workspace-write' };
  const tools = engine.toolsFor(session);
  const names = permission => tools.definitions(permission).map(tool => tool.name);
  assert.ok(names('workspace-write').includes('write_file'));
  assert.ok(names('workspace-write').includes('run_command'));
  await tools.execute('write_file', { path: 'allowed.txt', content: 'allowed', expectedHash: 'new' }, 'workspace-write', new AbortController().signal, session);

  // Removing the last policy withdraws the tool definitions and prevents an
  // already emitted call from reaching FileTools. With the pool empty the live
  // membership check fails first (no enabled model at all), so calls are
  // rejected before any side effect.
  delete models['byok/sole'];
  assert.deepEqual(models, {});
  assert.ok(!names('workspace-write').includes('write_file'));
  assert.ok(!names('workspace-write').includes('run_command'));
  const signal = new AbortController().signal;
  await assert.rejects(async () => tools.execute('write_file', { path: 'blocked.txt', content: 'blocked', expectedHash: 'new' }, 'workspace-write', signal, session), { code: 'model_unavailable' });
  await assert.rejects(async () => tools.execute('run_command', { command: 'printf blocked > blocked.txt', path: '.' }, 'workspace-write', signal, session), { code: 'model_unavailable' });
  assert.equal(await fs.stat(path.join(root, 'blocked.txt')).then(() => true, () => false), false);
});
