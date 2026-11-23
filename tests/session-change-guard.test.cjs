const assert = require('node:assert/strict');
const { test } = require('node:test');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../.test-build/storage');
const { WorkerError } = require('../.test-build/types');

const FIXTURE_ID = 'f'.repeat(32);
const SESSION_FILE = `${FIXTURE_ID}.json`;

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Minimal current (schema 3, explicit standalone mode) session; the store
// creates it with the wx open flag, not atomicWrite.
const fakeSession = () => ({
  schema: 3,
  mode: 'standalone',
  id: FIXTURE_ID,
  title: 'original',
  model: { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 10_000 },
  instructions: '',
  permission: 'read-only',
  state: 'completed',
  messages: [],
  turns: [{ id: 't1', input: 'task', state: 'completed', started: true, attempts: 1, output: 'done', tools: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  operations: {},
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

async function openStore(t) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'codex-session-guard-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  await store.open();
  t.after(async () => {
    await store.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

// Patched fs.promises paths match this fixture's temporary checkpoints only, so
// the unrelated owner.lock creation and the directory fsync open stay untouched.
let activeRoot;
function tempPattern() {
  const escaped = path.join(activeRoot, 'sessions', SESSION_FILE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`);
}

test('pre-rename authorization failure leaves disk and memory unchanged', async t => {
  const { root, store } = await openStore(t);
  activeRoot = root;
  const target = path.join(activeRoot, 'sessions', SESSION_FILE);
  await store.create(fakeSession());
  const before = await fsPromises.readFile(target, 'utf8');
  const open = fsPromises.open;
  let guardCalls = 0;
  let mutatorCalls = 0;
  let authorized = true;
  fsPromises.open = async (file, flags, mode) => {
    if (!tempPattern().test(file)) {
      return open(file, flags, mode);
    }
    const handle = await open(file, flags, mode);
    return {
      writeFile: (...args) => handle.writeFile(...args),
      sync: async () => {
        await handle.sync();
        authorized = false;
      },
      close: () => handle.close(),
    };
  };
  const change = store.change(FIXTURE_ID, draft => { mutatorCalls++; draft.title = 'replaced'; }, () => {
    guardCalls++;
    if (!authorized) {
      throw new WorkerError('permission_denied', 'write authorization was revoked before the rename');
    }
  });
  const rejected = assert.rejects(change, { code: 'permission_denied' });
  try {
    await rejected;
  } finally {
    fsPromises.open = open;
  }
  assert.equal(await fsPromises.readFile(target, 'utf8'), before, 'The rejected checkpoint must leave the previous disk bytes in place');
  assert.deepEqual((await fsPromises.readdir(path.join(activeRoot, 'sessions'))).filter(f => f.endsWith('.tmp')), [], 'The temporary checkpoint must be cleaned up');
  const current = store.get(FIXTURE_ID);
  assert.equal(current.title, 'original');
  assert.equal(current.revision, 1);
  assert.equal(guardCalls, 2, 'The guard is checked before the mutator and again immediately before the rename');
  assert.equal(mutatorCalls, 1, 'The mutator ran against the in-memory draft only');
  assert.equal(current.title, 'original', 'The abandoned draft must never be adopted into memory');
});

test('authorization revoked while queued blocks the second change before its mutator', async t => {
  const { root, store } = await openStore(t);
  activeRoot = root;
  const target = path.join(activeRoot, 'sessions', SESSION_FILE);
  await store.create(fakeSession());
  const rename = fsPromises.rename;
  const gate = deferred();
  let gated = false;
  fsPromises.rename = async (from, to) => {
    if (to === target && !gated) {
      gated = true;
      const result = await rename(from, to);
      gate.resolve();
      return result;
    }
    return rename(from, to);
  };
  let secondAuthorized = true;
  let mutatorCalls = 0;
  const firstChange = store.change(FIXTURE_ID, draft => { draft.title = 'first'; });
  const secondChange = store.change(FIXTURE_ID, draft => { mutatorCalls++; draft.title = 'never'; }, () => {
    if (!secondAuthorized) {
      throw new WorkerError('permission_denied', 'write authorization was revoked while queued');
    }
  });
  const rejected = assert.rejects(secondChange, { code: 'permission_denied' });
  // Reaching the commit gate is awaited, not polled, so the queue order is deterministic.
  await gate.promise;
  secondAuthorized = false;
  const committed = await firstChange;
  try {
    await rejected;
  } finally {
    fsPromises.rename = rename;
  }
  assert.equal(mutatorCalls, 0, 'The queued mutator must never run once its guard fails');
  assert.equal(committed.title, 'first');
  assert.equal(committed.revision, 2);
  const onDisk = JSON.parse(await fsPromises.readFile(target, 'utf8'));
  assert.equal(onDisk.title, 'first');
  assert.equal(onDisk.revision, 2);
  assert.equal(store.get(FIXTURE_ID).revision, 2);
});

test('revocation after the committed rename does not roll back the checkpoint', async t => {
  const { root, store } = await openStore(t);
  activeRoot = root;
  const target = path.join(activeRoot, 'sessions', SESSION_FILE);
  await store.create(fakeSession());
  const rename = fsPromises.rename;
  let authorized = true;
  fsPromises.rename = async (from, to) => {
    const result = await rename(from, to);
    if (to === target) {
      authorized = false;
    }
    return result;
  };
  const change = store.change(FIXTURE_ID, draft => { draft.title = 'committed'; }, () => {
    if (!authorized) {
      throw new WorkerError('permission_denied', 'authorization was revoked after the rename');
    }
  });
  try {
    const result = await change;
    assert.equal(result.title, 'committed');
    assert.equal(result.revision, 2, 'A committed rename is final; no post-commit guard failure is expected');
    assert.equal(store.get(FIXTURE_ID).title, 'committed');
    const onDisk = JSON.parse(await fsPromises.readFile(target, 'utf8'));
    assert.equal(onDisk.title, 'committed');
    assert.equal(onDisk.revision, 2);
  } finally {
    fsPromises.rename = rename;
  }
  // The existing two-argument form stays unaffected by the guard regression.
  const legacy = await store.change(FIXTURE_ID, draft => { draft.title = 'legacy'; });
  assert.equal(legacy.title, 'legacy');
  assert.equal(legacy.revision, 3);
  assert.equal(store.get(FIXTURE_ID).revision, 3);
});
