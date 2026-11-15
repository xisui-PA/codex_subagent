// Lossless JSON persistence and strict metadata parsing regressions.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { promises: fs } = require('node:fs');
const path = require('node:path');

// Loader: CODEX_TEST_BUILD env first, otherwise the shared .test-build. The
// index module and WorkerError must come from the SAME compiled build so the
// instanceof checks never mix classes.
function loadBuildDir() {
  // cmd.exe `set VAR=value` may append a trailing space to the exported value; trim it.
  const dir = String(process.env.CODEX_TEST_BUILD || '.test-build').trim();
  return path.join(__dirname, '..', dir);
}
const buildDir = loadBuildDir();
const {
  IsolatedIndex, indexLimits, validateIndex,
  parseStoredSnapshot, parseOverlayRecord, parseSealedSubmission
} = require(path.join(buildDir, 'isolated-index'));
const { WorkerError } = require(path.join(buildDir, 'types'));

const TEAM = 'a'.repeat(32);
const WORKER = 'b'.repeat(32);
const OWNER = 'owner-a';
const DATE = '2026-11-13T00:00:00.000Z';
const ROOT = path.join(__dirname, 'root');
// IDs are 64 lowercase hex; seeds must be hex digits.
const h = seed => (seed + 'f'.repeat(64)).slice(0, 64);
const SNAP = h('1');
const OVER = h('4');
const SUB = h('5');

const fixtures = [];
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.tmp-isolated-index-json-'));
  fixtures.push(directory);
  return new IsolatedIndex(directory, ROOT, options);
}
async function readDisk(index) {
  return JSON.parse(await fs.readFile(index.file, 'utf8'));
}
async function writeDisk(index, text) {
  await fs.rm(index.file, { force: true });
  await fs.writeFile(index.file, text, { mode: 0o600 });
}
const snapshot = (id, teamId = TEAM, ownerId = OWNER) =>
  ({ id, teamId, ownerId, manifestHash: h('a0' + id.slice(0, 6)), backing: { kind: 'cas' }, createdAt: DATE });
const git = (id, over = {}) => ({
  kind: 'git', commonDir: 'C:\\git', objectFormat: 'sha1', namespace: h('d1'),
  ref: `refs/codex-subagent/${h('d1')}/${id}`, tree: 'c'.repeat(40), blobs: { [h('b1')]: 'd'.repeat(40) }, ...over
});
/**
 * Install `key` as an OWN enumerable data property (via defineProperty, never
 * the __proto__ setter) so JSON.stringify writes it as a literal key. This is
 * how a hostile `__proto__` key reaches the disk/index document.
 */
function withOwnKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}
const wrap = result => ({
  schema: 1, root: ROOT, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {},
  receipts: { [h('a9')]: { fingerprint: h('a9'), result } }, pendingCaptures: {}
});
const rejectsCorrupt = (fn, label) => assert.throws(fn,
  error => error instanceof WorkerError && error.code === 'isolation_corrupt', label);

test('receipt.result preserves an own nested __proto__ through memory, disk and reopen', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  const result = JSON.parse('{"__proto__":{"keep":true},"constructor":{"proto":1},"prototype":{"z":[1]},"n":5}');
  const key = h('71');
  await index.update(draft => {
    draft.snapshots[SNAP] = snapshot(SNAP);
    draft.receipts[key] = { fingerprint: key, result };
  });
  assert.deepEqual(index.read().receipts[key].result, result, 'memory keeps the own __proto__');
  assert.deepEqual((await readDisk(index)).receipts[key].result, result, 'disk keeps the own __proto__');
  const second = new IsolatedIndex(index.directory, ROOT);
  t.after(() => { second.close(); });
  await second.open();
  assert.deepEqual(second.read().receipts[key].result, result, 'reopen keeps the own __proto__');
  // A null-prototype JSON result is JSON-normalized to the same plain object.
  const nullProto = Object.create(null);
  nullProto.a = 1;
  await index.update(draft => { draft.receipts[h('72')] = { fingerprint: h('72'), result: nullProto }; });
  assert.deepEqual(index.read().receipts[h('72')].result, { a: 1 }, 'null-prototype result JSON-normalizes');
  assert.deepEqual((await readDisk(index)).receipts[h('72')].result, { a: 1 }, 'null-prototype result on disk');
});

test('a receipt missing result is rejected as corrupt before publication', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  const key = h('81');
  await assert.rejects(() => index.update(draft => { draft.receipts[key] = { fingerprint: key }; }),
    error => error instanceof WorkerError && error.code === 'isolation_corrupt');
  assert.equal(index.read().receipts[key], undefined);
  rejectsCorrupt(() => {
    const doc = wrap({});
    delete doc.receipts[h('a9')].result;
    validateIndex(doc, ROOT);
  }, 'pure validateIndex rejects a missing result');
});

test('a hostile own __proto__ key in a record map or backing.blobs fails closed on open and update', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  await index.update(draft => {
    draft.snapshots[SNAP] = snapshot(SNAP);
    draft.snapshots[h('1a')] = { ...snapshot(h('1a')), backing: git(h('1a')) };
  });
  const committed = await readDisk(index);
  assert.equal(committed.revision, 1);

  // Own __proto__ as a key in the snapshots hex map, on the disk document.
  const doc = { ...committed, snapshots: withOwnKey({}, '__proto__', committed.snapshots[SNAP]) };
  const text = JSON.stringify(doc);
  await writeDisk(index, text);
  await assert.rejects(async () => {
    const next = new IsolatedIndex(index.directory, ROOT);
    await next.open();
  }, WorkerError);
  assert.equal(await fs.readFile(index.file, 'utf8'), text, 'disk unchanged after failed open');

  // Restore, then force the same key through the update path.
  await writeDisk(index, JSON.stringify(committed));
  await index.open();
  await assert.rejects(() => index.update(draft => {
    draft.snapshots = withOwnKey({ ...draft.snapshots }, '__proto__', snapshot(SNAP));
  }), WorkerError);
  assert.deepEqual(await readDisk(index), committed, 'update refused, disk unchanged');
  assert.equal(index.read().revision, 1, 'memory revision unchanged');

  // Own __proto__ key inside a git backing blobs hex map.
  const blobs = withOwnKey({ [h('b1')]: 'd'.repeat(40) }, '__proto__', 'd'.repeat(40));
  await assert.rejects(() => index.update(draft => {
    draft.snapshots[h('1a')] = { ...snapshot(h('1a')), backing: git(h('1a'), { blobs }) };
  }), WorkerError);
  assert.deepEqual(await readDisk(index), committed, 'hostile blobs refused, disk unchanged');
  assert.equal(index.read().revision, 1, 'memory revision unchanged after blobs rejection');
  const hostileBacking = structuredClone(committed);
  hostileBacking.snapshots[h('1a')].backing.blobs = blobs;
  await writeDisk(index, JSON.stringify(hostileBacking));
  const reopened = new IsolatedIndex(index.directory, ROOT);
  await assert.rejects(() => reopened.open(), error => error.code === 'isolation_corrupt');
  assert.equal(await fs.readFile(index.file, 'utf8'), JSON.stringify(hostileBacking));
});

test('non-JSON values anywhere in the index are rejected as isolation_corrupt before publication', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  await index.update(draft => { draft.snapshots[SNAP] = snapshot(SNAP); });
  const committed = await readDisk(index);

  const cycle = {};
  cycle.self = cycle;
  const deep = (() => { let rootObj = {}; let cur = rootObj; for (let i = 0; i < 130; i++) { cur.nested = {}; cur = cur.nested; } return rootObj; })();
  const bad = [
    ['NaN', { bad: NaN }],
    ['Infinity', { bad: Infinity }],
    ['BigInt', { bad: 1n }],
    ['undefined', { bad: undefined }],
    ['function', { bad: () => undefined }],
    ['symbol value', { bad: Symbol('s') }],
    ['Date', { bad: new Date() }],
    ['Map', { bad: new Map() }],
    ['Set', { bad: new Set() }],
    ['cycle', cycle],
    ['depth over 128', deep]
  ];
  for (const [label, result] of bad) {
    await assert.rejects(() => index.update(draft => {
      draft.receipts[h('9' + label.length)] = { fingerprint: h('9' + label.length), result };
    }), error => error instanceof WorkerError && error.code === 'isolation_corrupt', label);
  }
  assert.deepEqual(await readDisk(index), committed, 'no publication for any non-JSON value');
  assert.equal(index.read().revision, 1, 'memory unchanged');
});

test('dense arrays, shared non-cyclic references, and null-prototype results are accepted', () => {
  const shared = { v: 1 };
  assert.doesNotThrow(() => validateIndex(wrap({ a: [1, 2, shared, shared], b: shared }), ROOT),
    'dense arrays and shared non-cyclic references are valid JSON');
  const nullProto = Object.create(null);
  nullProto.k = [1, 2];
  assert.doesNotThrow(() => validateIndex(wrap(nullProto), ROOT), 'null-prototype object accepted');
  // A valid git-backed snapshot with a real blobs map round-trips exactly.
  const gitSnap = { ...snapshot(h('1b')), backing: git(h('1b')) };
  assert.deepEqual(parseStoredSnapshot(gitSnap), gitSnap, 'valid git snapshot preserved');
});

test('holes, extra properties, symbol keys, and accessor slots are rejected', () => {
  const hole = Array(3);
  hole[0] = 1;
  hole[2] = 3;
  rejectsCorrupt(() => validateIndex(wrap(hole), ROOT), 'sparse array hole');

  for (const key of ['extra', '00', '', '-0', '0.0', '0e0']) {
    const balanced = Array(1);
    Object.defineProperty(balanced, key, { value: 1, enumerable: true });
    rejectsCorrupt(() => validateIndex(wrap(balanced), ROOT), `hole balanced by extra key ${JSON.stringify(key)}`);
  }

  const extra = [1, 2];
  Object.defineProperty(extra, 'extra', { value: 9, enumerable: true });
  rejectsCorrupt(() => validateIndex(wrap(extra), ROOT), 'extra array property');

  const symArray = [1, 2];
  Object.defineProperty(symArray, Symbol('s'), { value: 0, enumerable: true });
  rejectsCorrupt(() => validateIndex(wrap(symArray), ROOT), 'symbol array key');

  const nonEnum = [1, 2];
  Object.defineProperty(nonEnum, '1', { value: 2, enumerable: false, writable: true, configurable: true });
  rejectsCorrupt(() => validateIndex(wrap(nonEnum), ROOT), 'non-enumerable array slot');

  const accessor = {};
  Object.defineProperty(accessor, 'val', { get: () => 1, enumerable: true });
  rejectsCorrupt(() => validateIndex(wrap(accessor), ROOT), 'accessor property');

  const symObj = { a: 1 };
  Object.defineProperty(symObj, Symbol('k'), { value: 1, enumerable: true });
  rejectsCorrupt(() => validateIndex(wrap(symObj), ROOT), 'symbol object key');
});

test('pure validateIndex enforces caps, byte cap, and graph without side effects', () => {
  const empty = () => ({ schema: 1, root: ROOT, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {}, receipts: {}, pendingCaptures: {} });
  const big = empty();
  big.receipts[h('b1')] = { fingerprint: h('b1'), result: 'x'.repeat(2048) };
  assert.doesNotThrow(() => validateIndex(big, ROOT), 'default byte cap accepts');
  assert.throws(() => validateIndex(big, ROOT, { ...indexLimits, bytes: 50 }),
    error => error.code === 'isolation_capacity', 'byte cap');

  const over = empty();
  for (let i = 0; i < indexLimits.snapshots + 1; i++) {
    const id = h('2' + i);
    over.snapshots[id] = { id, teamId: TEAM, ownerId: OWNER, manifestHash: h('a' + i), backing: { kind: 'cas' }, createdAt: DATE };
  }
  assert.throws(() => validateIndex(over, ROOT), error => error.code === 'isolation_capacity', 'over count');

  assert.throws(() => validateIndex(empty(), 'C:\\elsewhere'),
    error => error.code === 'isolation_corrupt', 'foreign root');

  const broken = empty();
  broken.pins[h('d')] = { id: h('d'), ownerId: OWNER, teamId: TEAM, name: 'n', resource: { kind: 'submission', id: h('d') } };
  assert.throws(() => validateIndex(broken, ROOT), WorkerError, 'missing pin target');
});

test('typed record parsers preserve exact records and reject bad shape or hostile own keys', () => {
  const snap = snapshot(SNAP);
  assert.deepEqual(parseStoredSnapshot(snap), snap, 'valid snapshot preserved');
  const over = { teamId: TEAM, snapshotId: SNAP, overlayId: OVER, workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: false };
  assert.deepEqual(parseOverlayRecord(over), over, 'valid overlay preserved');
  const sub = { id: SUB, teamId: TEAM, snapshotId: SNAP, overlayId: OVER, version: 1, uri: 'cas://x', workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: true, createdAt: DATE };
  assert.deepEqual(parseSealedSubmission(sub), sub, 'valid submission preserved');

  assert.throws(() => parseStoredSnapshot({ ...snap, extra: 1 }), WorkerError, 'unknown snapshot field');
  assert.throws(() => parseStoredSnapshot({ ...snap, id: 'x' }), WorkerError, 'bad snapshot id');

  const blobs = withOwnKey({ [h('b1')]: 'd'.repeat(40) }, '__proto__', 'd'.repeat(40));
  assert.throws(() => parseStoredSnapshot({ ...snapshot(h('1c')), backing: git(h('1c'), { blobs }) }),
    WorkerError, 'hostile blobs __proto__');

  assert.throws(() => parseOverlayRecord({ ...over, head: new Date() }), WorkerError, 'non-JSON overlay value');
});

test.after(async () => {
  for (const directory of fixtures.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
