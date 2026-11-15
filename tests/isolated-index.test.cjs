// Durable isolated index regression tests.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { promises: fs } = require('node:fs');
const path = require('node:path');

// Loader: CODEX_TEST_BUILD env first, otherwise the shared .test-build. Index,
// storage and types must come from the SAME compiled build so WorkerError
// instances never mix classes.
function loadBuildDir() {
  // cmd.exe `set VAR=value` may append a trailing space to the exported value; trim it.
  const dir = String(process.env.CODEX_TEST_BUILD || '.test-build').trim();
  return path.join(__dirname, '..', dir);
}
const buildDir = loadBuildDir();
const { IsolatedIndex, indexLimits } = require(path.join(buildDir, 'isolated-index'));
const storageModule = require(path.join(buildDir, 'storage'));
const { WorkerError } = require(path.join(buildDir, 'types'));

const TEAM = 'a'.repeat(32);
const WORKER = 'b'.repeat(32);
const OWNER = 'owner-a';
const DATE = '2026-11-13T00:00:00.000Z';
const ROOT = path.join(__dirname, 'root');
// IDs are 64 lowercase hex; seeds must be hex digits.
const h = seed => (seed + 'f'.repeat(64)).slice(0, 64);
const SNAP = h('1'), SNAP2 = h('2'), PEND = h('8'), OVER = h('4'), SUB = h('5'), PIN = h('6');

const fixtures = [];
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.tmp-isolated-index-'));
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
/** Run fn while IsolatedIndex's atomicWrite is replaced; always restored. */
async function withPatchedWrite(next, fn) {
  const original = storageModule.atomicWrite;
  storageModule.atomicWrite = next;
  try {
    return await fn();
  } finally {
    storageModule.atomicWrite = original;
  }
}
const snapshot = (id, teamId = TEAM, ownerId = OWNER) =>
  ({ id, teamId, ownerId, manifestHash: h('a0' + id.slice(0, 6)), backing: { kind: 'cas' }, createdAt: DATE });
const git = (snapshotId, over = {}) => ({
  kind: 'git', commonDir: 'C:\\git', objectFormat: 'sha1', namespace: h('d1'),
  ref: `refs/codex-subagent/${h('d1')}/${snapshotId}`, tree: 'c'.repeat(40), blobs: { [h('b1')]: 'd'.repeat(40) }, ...over
});
const pending = (snapshotId, backing) =>
  ({ [snapshotId]: { snapshot: { ...snapshot(snapshotId), backing }, receiptKey: h('f1'), fingerprint: h('f2') } });

test('missing file opens empty in memory only; real commit reopens with original receipt JSON', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  await assert.rejects(() => fs.access(index.file), error => error.code === 'ENOENT');
  const empty = index.read();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.snapshots, {});
  empty.revision = 99;
  empty.snapshots[SNAP] = { forged: true };
  const receiptResult = { ok: true, seq: 7, nested: { a: [1, 2] } };
  let retained;
  await index.update(draft => {
    retained = draft;
    draft.snapshots[SNAP] = snapshot(SNAP);
    draft.receipts[h('71')] = { fingerprint: h('71'), result: receiptResult };
  });
  retained.revision = 99;
  retained.snapshots[SNAP] = { forged: true };
  assert.equal(index.read().revision, 1, 'a retained mutator draft must not alias committed state');
  assert.equal(index.read().snapshots[SNAP].id, SNAP);
  const read = index.read();
  assert.equal(read.revision, 1, 'mutating a returned read must not alias internal state');
  const second = new IsolatedIndex(index.directory, ROOT);
  t.after(() => { second.close(); });
  await second.open();
  const reloaded = second.read();
  assert.equal(reloaded.revision, 1);
  assert.equal(reloaded.snapshots[SNAP].id, SNAP);
  assert.deepEqual(reloaded.receipts[h('71')].result, receiptResult, 'receipt keeps original JSON result');
});

test('concurrent updates both publish; throwing and async mutators publish nothing', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  const [first, second] = await Promise.all([
    index.update(draft => { draft.snapshots[SNAP] = snapshot(SNAP); }),
    index.update(draft => { draft.receipts[h('73')] = { fingerprint: h('73'), result: { n: 2 } }; }),
  ]);
  assert.ok(first.revision >= 1 && second.revision >= 1);
  const read = index.read();
  assert.equal(read.revision, 2);
  assert.equal(read.snapshots[SNAP].id, SNAP);
  assert.equal(read.receipts[h('73')].result.n, 2);
  assert.deepEqual(read, await readDisk(index));

  await assert.rejects(() => index.update(() => { throw new Error('boom'); }), error => error.message === 'boom');
  assert.equal(index.read().revision, 2);

  // A rejection created inside the mutator must be declined and never unhandled.
  await assert.rejects(() => index.update(() => Promise.reject(new Error('late rejection'))), error => error.code === 'invalid_update');
  assert.equal(index.read().revision, 2);
  // A plain thenable whose `then` rejects is also declined without publication.
  const thenable = { then: (_r, reject) => reject(new Error('thenable rejected')) };
  await assert.rejects(() => index.update(() => thenable), error => error.code === 'invalid_update');
  const callableThenable = Object.assign(() => undefined, { then: (_r, reject) => reject(new Error('callable rejected')) });
  await assert.rejects(() => index.update(() => callableThenable), error => error.code === 'invalid_update');
  assert.equal(index.read().revision, 2);
  assert.deepEqual(index.read(), await readDisk(index), 'no publication after failed mutators');
});

test('invalid documents are refused byte-for-byte without reset or repair', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  await index.update(draft => {
    draft.snapshots[SNAP2] = snapshot(SNAP2);
    draft.overlays[OVER] = { teamId: TEAM, snapshotId: SNAP2, overlayId: OVER, workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: false };
    draft.submissions[SUB] = { id: SUB, teamId: TEAM, snapshotId: SNAP2, overlayId: OVER, version: 1, uri: 'cas://delta', workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: h('a1'), revision: 1, released: true, createdAt: DATE };
    draft.pins[PIN] = { id: PIN, ownerId: OWNER, teamId: TEAM, name: 'keep', resource: { kind: 'submission', id: SUB } };
    draft.pendingCaptures[PEND] = pending(PEND, git(PEND))[PEND];
  });
  const committed = await readDisk(index);
  const cases = [
    ['not json', '{ no', 'reject'],
    ['unknown field', JSON.stringify({ ...committed, extra: 1 }), 'reject'],
    ['foreign root', JSON.stringify({ ...committed, root: 'C:\\elsewhere' }), 'reject'],
    ['snapshot key mismatch', JSON.stringify({ ...committed, snapshots: { ...committed.snapshots, [h('e0')]: committed.snapshots[SNAP2] } }), 'reject'],
    ['overlay key mismatch', JSON.stringify({ ...committed, overlays: { [h('e1')]: committed.overlays[OVER] } }), 'reject'],
    ['submission key mismatch', JSON.stringify({ ...committed, submissions: { [h('e2')]: committed.submissions[SUB] } }), 'reject'],
    ['pin key mismatch', JSON.stringify({ ...committed, pins: { [h('e3')]: committed.pins[PIN] } }), 'reject'],
    ['active overlay lost base', JSON.stringify({ ...committed, snapshots: {} }), 'reject'],
    ['active overlay foreign team', JSON.stringify({ ...committed, snapshots: { ...committed.snapshots, [SNAP2]: snapshot(SNAP2, 'c'.repeat(32)) } }), 'reject'],
    ['active overlay foreign owner', JSON.stringify({ ...committed, snapshots: { ...committed.snapshots, [SNAP2]: snapshot(SNAP2, undefined, 'owner-b') } }), 'reject'],
    ['pin lost submission', JSON.stringify({ ...committed, submissions: {} }), 'reject'],
    ['pinned submission lost snapshot', JSON.stringify({ ...committed, snapshots: {} }), 'reject'],
    ['pin foreign team vs submission', JSON.stringify({ ...committed, pins: { [PIN]: { ...committed.pins[PIN], teamId: 'c'.repeat(32) } } }), 'reject'],
    ['pending key mismatch', JSON.stringify({ ...committed, pendingCaptures: { [h('e4')]: committed.pendingCaptures[PEND] } }), 'reject'],
    ['pending without git backing', JSON.stringify({ ...committed, pendingCaptures: pending(PEND, { kind: 'cas' }) }), 'reject'],
    ['git namespace not 64 hex', JSON.stringify({ ...committed, pendingCaptures: pending(PEND, git(PEND, { namespace: 'd'.repeat(63), ref: `refs/codex-subagent/${'d'.repeat(63)}/${PEND}` })) }), 'reject'],
    ['git tree wrong object format', JSON.stringify({ ...committed, pendingCaptures: pending(PEND, git(PEND, { objectFormat: 'sha256' })) }), 'reject'],
    ['sealed submission outlives released overlay tombstone', JSON.stringify({ ...committed, overlays: {} }), 'accept'],
    ['released tombstones may reference collected base', JSON.stringify({ ...committed, snapshots: {}, overlays: { [OVER]: { ...committed.overlays[OVER], released: true } }, pins: {}, pendingCaptures: {} }), 'accept'],
    ['active submission lost base', JSON.stringify({ ...committed, snapshots: {}, submissions: { [SUB]: { ...committed.submissions[SUB], released: false } }, pendingCaptures: {} }), 'reject'],
  ];
  for (const [label, text, expected] of cases) {
    await writeDisk(index, text);
    const next = new IsolatedIndex(index.directory, ROOT);
    if (expected === 'accept') {
      await next.open();
      next.close();
    } else {
      await assert.rejects(() => next.open(), WorkerError, label);
    }
    assert.equal(await fs.readFile(index.file, 'utf8'), text, `bytes unchanged for ${label}`);
  }
  // Never reset: the previously valid state still opens after the last rewrite.
  await writeDisk(index, JSON.stringify(committed));
  const revived = new IsolatedIndex(index.directory, ROOT);
  t.after(() => { revived.close(); });
  await revived.open();
  assert.equal(revived.read().revision, committed.revision);
});

test('capacity: exact count accepted, over-limit refused with no change or trim', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  const records = {
    snapshots: i => ({ id: h('1' + i), teamId: TEAM, ownerId: OWNER, manifestHash: h('a0' + i), backing: { kind: 'cas' }, createdAt: DATE }),
    overlays: i => ({ teamId: TEAM, snapshotId: h('2' + i), overlayId: h('2' + i), workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: true }),
    submissions: i => ({ id: h('3' + i), teamId: TEAM, snapshotId: SNAP, overlayId: h('3' + i), version: 1, uri: 'cas://x', workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: true, createdAt: DATE }),
    pins: i => ({ id: h('4' + i), ownerId: OWNER, teamId: TEAM, name: 'p', resource: { kind: 'submission', id: SUB } }),
    receipts: i => ({ fingerprint: h('5' + i), result: {} }),
    pendingCaptures: i => ({ snapshot: { ...snapshot(h('6' + i)), backing: git(h('6' + i)) }, receiptKey: h('f1'), fingerprint: h('f2') })
  };
  const recordKey = (collection, record) =>
    collection === 'snapshots' ? record.id
      : collection === 'overlays' ? record.overlayId
        : collection === 'submissions' ? record.id
          : collection === 'pins' ? record.id
            : collection === 'receipts' ? record.fingerprint
              : record.snapshot.id;
  // Pins to a submission require that submission and its snapshot to exist, so
  // the pins case seeds one shared released submission SUB backed by SNAP.
  const baseSubmission = () => ({ id: SUB, teamId: TEAM, snapshotId: SNAP, overlayId: h('30'), version: 1, uri: 'cas://x', workerId: WORKER, workerCreatedAt: DATE, ownerId: OWNER, head: null, revision: 0, released: true, createdAt: DATE });
  const doc = (collection, n) => {
    const data = { schema: 1, root: ROOT, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {}, receipts: {}, pendingCaptures: {} };
    if (collection === 'pins') {
      data.snapshots[SNAP] = snapshot(SNAP);
      data.submissions[SUB] = baseSubmission();
    }
    for (let i = 1; i <= n; i++) {
      data[collection][recordKey(collection, records[collection](i))] = records[collection](i);
    }
    return data;
  };
  for (const collection of Object.keys(indexLimits)) {
    if (collection === 'bytes') {
      continue;
    }
    const limit = indexLimits[collection];
    await writeDisk(index, JSON.stringify(doc(collection, limit - 1)));
    const idx = new IsolatedIndex(index.directory, ROOT);
    await idx.open();
    assert.equal(Object.keys(idx.read()[collection]).length, limit - 1, collection);
    const extra = records[collection](limit);
    await idx.update(draft => { draft[collection][recordKey(collection, extra)] = extra; });
    const atLimit = await readDisk(idx);
    assert.equal(Object.keys(atLimit[collection]).length, limit, `${collection} exact limit`);
    const more = records[collection](limit + 1);
    await assert.rejects(() => idx.update(draft => { draft[collection][recordKey(collection, more)] = more; }), WorkerError, collection);
    assert.deepEqual(await readDisk(idx), atLimit, `${collection} unchanged over limit`);
    const reopened = new IsolatedIndex(index.directory, ROOT);
    await reopened.open();
    assert.equal(Object.keys(reopened.read()[collection]).length, limit, `${collection} reopens at limit`);
    reopened.close();
    await writeDisk(idx, JSON.stringify(doc(collection, limit + 1)));
    const over = new IsolatedIndex(index.directory, ROOT);
    await assert.rejects(() => over.open(), WorkerError, `${collection} over-limit open refused`);
    idx.close();
  }
});

test('byte cap: oversized existing file and oversized serialized update refused; invalid limits rejected', async t => {
  const index = await fixture({ limits: { bytes: 80 * 1024 } });
  t.after(() => { index.close(); });
  await index.open();
  await index.update(draft => {
    draft.receipts[h('c1')] = { fingerprint: h('c1'), result: 'x'.repeat(4096) };
    draft.receipts[h('c2')] = { fingerprint: h('c2'), result: 'y'.repeat(4096) };
  });
  await assert.rejects(() => index.update(draft => {
    draft.receipts[h('c3')] = { fingerprint: h('c3'), result: 'x'.repeat(72 * 1024) };
  }), WorkerError);
  assert.equal(index.read().receipts[h('c3')], undefined, 'no silent trim of records');
  assert.equal(index.read().receipts[h('c1')].result.length, 4096, 'committed records survive the refused update');
  const oversized = await fs.mkdtemp(path.join(__dirname, '.tmp-isolated-index-'));
  fixtures.push(oversized);
  const bigFile = path.join(oversized, 'index.json');
  await fs.writeFile(bigFile, 'x'.repeat(33 * 1024 * 1024));
  const before = await fs.readFile(bigFile);
  await assert.rejects(async () => {
    const next = new IsolatedIndex(oversized, ROOT);
    await next.open();
  }, WorkerError);
  assert.deepEqual(await fs.readFile(bigFile), before, 'oversized file untouched');
  for (const value of [0, -1, 1.5, 2 ** 64, indexLimits.snapshots + 1]) {
    assert.throws(() => new IsolatedIndex(index.directory, ROOT, { limits: { snapshots: value } }), WorkerError);
  }
  assert.doesNotThrow(() => new IsolatedIndex(index.directory, ROOT, { limits: { snapshots: 1, bytes: indexLimits.bytes } }));
});

test('queued authorize revocation: first commit lands, second update never publishes', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  let firstCommitted = false;
  const originalAtomicWrite = storageModule.atomicWrite;
  await withPatchedWrite(async (file, text, mode, beforeRename) => {
    await originalAtomicWrite(file, text, mode, beforeRename);
    firstCommitted = true;
  }, async () => {
    const first = index.update(draft => { draft.receipts[h('71')] = { fingerprint: h('71'), result: { n: 1 } }; });
    const second = index.update(draft => { draft.receipts[h('72')] = { fingerprint: h('72'), result: { n: 2 } }; }, () => {
      assert.ok(firstCommitted, 'queued update may only authorize after the first commit');
      throw new WorkerError('host_stopping', 'revoked');
    });
    // Attach the rejection handler immediately so a late settlement is always handled.
    const secondCheck = assert.rejects(second, error => error.code === 'host_stopping');
    const ack = await first;
    const afterFirst = await readDisk(index);
    assert.equal(ack.revision, 1);
    assert.equal(afterFirst.receipts[h('72')], undefined);
    await secondCheck;
    assert.deepEqual(await readDisk(index), afterFirst, 'no second publication');
    assert.equal(index.read().revision, 1);
  });
});

test('preRename revocation or close aborts before rename without temp litter', async t => {
  const originalAtomicWrite = storageModule.atomicWrite;
  const cases = [
    ['guard revocation', { guard: true }],
    ['close before rename', { guard: false }],
  ];
  for (const [label, kind] of cases) {
    let closedPromise = null;
    let revoked = false;
    const index = await fixture(kind.guard ? { guard: () => { if (revoked) { throw new WorkerError('host_stopping', 'gone'); } } } : {});
    t.after(() => { index.close(); });
    await index.open();
    await index.update(draft => { draft.receipts[h('a2')] = { fingerprint: h('a2'), result: true }; });
    storageModule.atomicWrite = async (file, text, mode, origBeforeRename) => {
      // Revoke only at the preRename guard point, then run the original guard.
      return originalAtomicWrite(file, text, mode, () => {
        if (kind.guard) {
          revoked = true;
        } else {
          closedPromise = index.close();
        }
        origBeforeRename?.();
      });
    };
    try {
      await assert.rejects(() => index.update(draft => { draft.receipts[h('a3')] = { fingerprint: h('a3'), result: true }; }), WorkerError, label);
      if (closedPromise) {
        await closedPromise;
      }
      assert.deepEqual(await fs.readdir(index.directory), ['index.json'], `${label} temp cleaned`);
      assert.equal((await readDisk(index)).revision, 1, label);
      if (kind.guard) {
        revoked = false;
        const read = index.read();
        assert.equal(read.revision, 1);
        assert.equal(read.receipts[h('a3')], undefined);
        assert.equal(read.receipts[h('a2')].result, true);
      } else {
        assert.throws(() => index.read(), WorkerError, label);
      }
    } finally {
      storageModule.atomicWrite = originalAtomicWrite;
    }
  }
});

test('injected rename failure keeps old memory, disk and revision, and cleans the temp', async t => {
  const index = await fixture();
  t.after(() => { index.close(); });
  await index.open();
  await index.update(draft => { draft.receipts[h('a4')] = { fingerprint: h('a4'), result: 1 }; });
  const before = await readDisk(index);
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.resolve(to) === path.resolve(index.file)) {
      const error = new Error('refused');
      error.code = 'EBUSY';
      throw error;
    }
    return rename(from, to);
  };
  try {
    await assert.rejects(() => index.update(draft => { draft.receipts[h('a5')] = { fingerprint: h('a5'), result: 2 }; }));
    assert.deepEqual(await readDisk(index), before, 'disk unchanged');
    assert.equal(index.read().revision, 1, 'memory unchanged');
    assert.deepEqual(await fs.readdir(index.directory), ['index.json'], 'temp cleaned');
  } finally {
    fs.rename = rename;
  }
});

test('committed bytes are adopted into memory; closed index rejects follow-up and close is idempotent', async t => {
  let stopped = false;
  const index = await fixture({ guard: () => { if (stopped) { throw new WorkerError('host_stopping', 'gone'); } } });
  t.after(() => { index.close(); });
  await index.open();
  let committed = false;
  await withPatchedWrite(async (file, text, mode, beforeRename) => {
    const original = storageModuleBaseWrite;
    await original(file, text, mode, beforeRename);
    committed = true;
    stopped = true;
  }, async () => {
    const ack = await index.update(draft => { draft.snapshots[SNAP] = snapshot(SNAP); });
    assert.equal(committed, true, 'guard flag flips only after the disk commit');
    assert.equal(ack.revision, 1);
    assert.equal(ack.snapshots[SNAP].id, SNAP);
    assert.equal((await readDisk(index)).snapshots[SNAP].id, SNAP, 'ack matches disk');
    assert.equal((await readDisk(index)).revision, ack.revision);
  });
  stopped = false;
  assert.equal(index.read().snapshots[SNAP].id, SNAP, 'no stale memory after commit');
  await index.close();
  await index.close();
  assert.throws(() => index.read(), WorkerError);
  await assert.rejects(() => index.update(() => undefined), WorkerError);
  await assert.rejects(() => index.open(), WorkerError);
  assert.equal((await readDisk(index)).snapshots[SNAP].id, SNAP, 'committed state survives close');
});

const storageModuleBaseWrite = storageModule.atomicWrite;

test.after(async () => {
  for (const directory of fixtures.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
