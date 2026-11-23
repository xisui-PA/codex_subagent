const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { SessionStore } = require(path.join(build, 'storage'));
const { WorkerEngine, defaults } = require(path.join(build, 'engine'));

const model = { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 100_000 };
const ISO = '2026-01-01T00:00:00.000Z';
const teamId = 'a'.repeat(32);
const taskId = 'b'.repeat(32);
const snapshotId = 'c'.repeat(64);
const startup = { teamId, taskId, snapshotId, teamRevision: 0, taskRevision: 0, lane: 'work', phase: 'created', requestId: 'governed' };
const view = { teamId, snapshotId, overlayId: 'd'.repeat(64) };

const turn = () => ({ id: 'turn-1', input: 'task', state: 'completed', started: true, attempts: 1, output: 'done', tools: [], createdAt: ISO, updatedAt: ISO });
/** ONE current record; tests then mutate exactly one invariant to prove refusal. */
const record = (id, mode, extra = {}) => ({
  schema: 3, mode, id, title: 'record', model, instructions: '', permission: 'read-only', state: 'completed',
  messages: [], turns: [turn()], operations: {}, revision: 1, createdAt: ISO, updatedAt: ISO, ...extra
});
const without = (value, key) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

test('older, mode-less and mode-inconsistent session records are refused untouched and keep their identity fenced', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-format-'));
  const directory = path.join(root, 'sessions');
  await fs.mkdir(directory, { recursive: true });
  const isolatedFields = { ownerId: 'parent', workspaceRoot: root, isolatedView: view };
  const records = [
    ['schema 1', { ...without(record('1'.repeat(32), 'standalone'), 'mode'), schema: 1 }],
    ['schema 2', { ...record('2'.repeat(32), 'isolated', isolatedFields), schema: 2 }],
    ['schema 3 without a mode', without(record('3'.repeat(32), 'standalone'), 'mode')],
    ['schema 3 with an unknown mode', record('4'.repeat(32), 'legacy')],
    ['standalone carrying startup', record('5'.repeat(32), 'standalone', { startup })],
    ['standalone carrying a private view', record('6'.repeat(32), 'standalone', { isolatedView: view })],
    ['isolated without its permanent view', record('7'.repeat(32), 'isolated', { ownerId: 'parent', workspaceRoot: root })],
    ['governed without startup', record('8'.repeat(32), 'governed', { ownerId: 'parent', workspaceRoot: root })],
    ['governed without a bounded owner/root', record('9'.repeat(32), 'governed', { startup })]
  ];
  const before = new Map();
  for (const [, value] of records) {
    const file = path.join(directory, `${value.id}.json`);
    const text = JSON.stringify(value);
    await fs.writeFile(file, text);
    before.set(file, Buffer.from(text));
  }
  const store = new SessionStore(directory);
  await store.open();
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(store.list(), [], 'no unsupported or inconsistent record is loaded, inferred or mapped');
  assert.equal((await SessionStore.saved(directory)).length, 0, 'the read-only browser has no old-format reader either');
  for (const [label, value] of records) {
    const file = path.join(directory, `${value.id}.json`);
    assert.deepEqual(await fs.readFile(file), before.get(file), `${label} stays byte-identical on disk`);
    assert.ok(store.diagnostics.some(line => line.startsWith(`${value.id}.json: `)), `${label} is reported as a diagnostic`);
    assert.equal(await fs.readFile(path.join(directory, 'quarantine', `${value.id}.json`), 'utf8').catch(() => undefined), before.get(file).toString(), `${label} keeps a diagnostic copy`);
  }
  // An unsupported file keeps fencing its exact ID: the old request ID can
  // neither overwrite it through the wx create nor re-run its effects.
  const fenced = path.join(directory, `${'1'.repeat(32)}.json`);
  await assert.rejects(store.create(record('1'.repeat(32), 'standalone')), { code: 'session_unreadable' });
  assert.deepEqual(await fs.readFile(fenced), before.get(fenced), 'the refused create left the unsupported file untouched');
  assert.deepEqual(store.list(), []);
});

test('current schema-3 modes are host-derived, persisted and still required across reload', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-modes-')));
  const directory = path.join(root, 'sessions');
  const store = new SessionStore(directory);
  await store.open();
  const requests = [];
  const engine = new WorkerEngine(store, {
    models: async () => [model], countTokens: async () => 10,
    async *stream() { requests.push(1); yield { type: 'text', text: 'done' }; }
  }, { definitions: () => [], execute: async () => 'ok' },
  () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 2 } } }));
  t.after(async () => {
    await engine.shutdown();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const standalone = await engine.spawn({ requestId: 'plain', task: 'plain task', permission: 'read-only', ownerId: 'parent' });
  assert.equal(standalone.schema, 3);
  assert.equal(standalone.mode, 'standalone', 'a plain spawn is host-derived standalone');
  assert.equal(standalone.isolatedView, undefined);
  assert.equal(standalone.startup, undefined);
  const governed = await engine.spawn({ requestId: 'governed', task: 'governed task', permission: 'read-only', ownerId: 'parent', workspaceRoot: root }, startup);
  assert.equal(governed.schema, 3);
  assert.equal(governed.mode, 'governed', 'startup setup is host-derived governed; no input can choose a mode');
  assert.equal(governed.startup.phase, 'created');
  const deadline = Date.now() + 5000;
  while (['queued', 'running'].includes(store.get(standalone.id).state)) {
    if (Date.now() > deadline) {
      throw new Error('the standalone turn did not settle');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await engine.shutdown();
  for (const [label, value] of [['standalone', standalone], ['governed', governed]]) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, `${value.id}.json`), 'utf8'));
    assert.equal(parsed.schema, 3, `${label} persists schema 3`);
    assert.equal(parsed.mode, value.mode, `${label} persists its exact mode`);
  }
  await store.close();
  const reopened = new SessionStore(directory);
  await reopened.open();
  try {
    assert.equal(reopened.list().length, 2);
    assert.equal(reopened.get(standalone.id).mode, 'standalone');
    assert.equal(reopened.get(standalone.id).isolatedView, undefined);
    assert.equal(reopened.get(governed.id).mode, 'governed');
    assert.equal(reopened.get(governed.id).startup.phase, 'created');
    // Binding promotes the SAME current record in place: the mode becomes
    // isolated and the schema literal never changes.
    await reopened.change(standalone.id, draft => {
      draft.mode = 'isolated';
      draft.ownerId = 'parent';
      draft.workspaceRoot = root;
      draft.isolatedView = view;
    });
    assert.equal(reopened.get(standalone.id).schema, 3);
    assert.equal(reopened.get(standalone.id).mode, 'isolated');
  } finally {
    await reopened.close();
  }
  const final = new SessionStore(directory);
  await final.open();
  try {
    const bound = final.get(standalone.id);
    assert.equal(bound.schema, 3);
    assert.equal(bound.mode, 'isolated');
    assert.equal(bound.isolatedView.overlayId, view.overlayId);
    assert.equal(final.get(governed.id).mode, 'governed');
  } finally {
    await final.close();
  }
  assert.ok(requests.length >= 1, 'the standalone worker still runs its ordinary turn');
});
