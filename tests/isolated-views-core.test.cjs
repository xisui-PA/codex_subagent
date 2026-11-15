// Task 24: durable lifecycle tests for the REAL isolated views core
// (IsolatedViews + captureProject + ContentStore/LayeredTree + CAS cleanup).
// Non-Git fixtures only; store and workspace root are SIBLINGS under a temp base.
// No fake lifecycle success: every assertion observes real disk/index state.
// NOTE: inspect() collections are ARRAYS; index records are looked up by id.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Loader: CODEX_TEST_BUILD env first (trimmed; cmd.exe may leave a trailing
// space), otherwise the shared .test-build. Same build for Core and WorkerError.
function loadBuildDir() {
  const dir = String(process.env.CODEX_TEST_BUILD || '.test-build').trim();
  return path.join(__dirname, '..', dir);
}
const buildDir = loadBuildDir();
const { IsolatedViews } = require(path.join(buildDir, 'isolated-views'));
const { captureProject } = require(path.join(buildDir, 'project-snapshot'));

// Mirrors the Core helper: arrays are canonicalized with JSON.stringify.
const sha256 = value => crypto.createHash('sha256').update(Array.isArray(value) ? JSON.stringify(value) : value).digest('hex');
const id64 = label => sha256(`id64:${label}`);
const id32 = label => sha256(`id32:${label}`).slice(0, 32);
const TEAM = id32('team');
const OWNER = 'owner-a';
const DATE = '2026-11-13T00:00:00.000Z';
const MIB = 1024 * 1024;

const MIbText = label => {
  const chunk = Buffer.alloc(1024);
  for (let i = 0; i < 1024; i += 1) { chunk[i] = (i + label.charCodeAt(i % label.length)) & 0x7f; }
  return Buffer.concat(Array.from({ length: 1024 }, () => chunk));
};

async function dirBytes(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
    } else {
      total += (await fs.stat(full)).size;
    }
  }
  return total;
}

function blobFiles(storeDir) {
  return path.join(storeDir, 'content', 'blobs');
}
async function blobCount(storeDir) {
  const blobs = blobFiles(storeDir);
  let count = 0;
  for (const prefix of await fs.readdir(blobs).catch(() => [])) {
    count += (await fs.readdir(path.join(blobs, prefix))).length;
  }
  return count;
}
// Counts only 1 MiB payload blobs: head-revision and manifest blobs are tiny,
// so this isolates real per-worker base/payload copies from metadata.
async function countMiBlobs(storeDir) {
  const blobs = blobFiles(storeDir);
  let count = 0;
  for (const prefix of await fs.readdir(blobs).catch(() => [])) {
    for (const suffix of await fs.readdir(path.join(blobs, prefix))) {
      if ((await fs.stat(path.join(blobs, prefix, suffix))).size === MIB) {
        count += 1;
      }
    }
  }
  return count;
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-views-core-'));
  const root = path.join(base, 'root');
  const storeDir = path.join(base, 'store');
  await fs.mkdir(root);
  const views = new IsolatedViews(storeDir, root);
  await views.open();
  const markers = [];
  let documents = () => [];
  t.after(async () => {
    await views.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return {
    base, root, storeDir, views, markers,
    setDocuments: fn => { documents = fn; },
    openDocuments: () => documents(),
  };
}

function binderOf(fx, workerLabel, snapshotId, date = DATE) {
  const workerId = id32(workerLabel);
  const workerCreatedAt = date;
  const identity = { ownerId: OWNER, workerId, workerCreatedAt };
  const input = requestId => ({ ownerId: OWNER, teamId: TEAM, snapshotId, workerId, workerCreatedAt, requestId });
  return { workerId, workerCreatedAt, identity, input };
}

function createCasSnapshot(fx, request, openDocuments) {
  return fx.views.createSnapshot(request, (id, recordCandidate) =>
    captureProject(fx.root, fx.views.content, {
      snapshotId: id,
      namespace: fx.views.namespace,
      openDocuments,
      beforePublish: recordCandidate
    }));
}

test('1) shared non-Git snapshot: one capture, ACK replay, stable bytes, editor docs, sibling store', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base original\n');
  await fs.writeFile(path.join(fx.root, 'notes.txt'), 'notes original\n');
  const editorText = 'unsaved draft text\n';
  fx.setDocuments(() => [{ path: path.join(fx.root, 'draft.txt'), text: editorText, version: 1 }]);
  let captures = 0;
  const capture = (id, recordCandidate) => {
    captures += 1;
    return captureProject(fx.root, fx.views.content, {
      snapshotId: id,
      namespace: fx.views.namespace,
      openDocuments: fx.openDocuments,
      beforePublish: recordCandidate
    });
  };
  const request = { ownerId: OWNER, teamId: TEAM, requestId: id64('create-1'), selectionKey: 'explicit-selection-key' };
  const snap = await fx.views.createSnapshot(request, capture);
  assert.equal(snap.backing.kind, 'cas', 'non-Git root is CAS-backed');
  assert.equal(captures, 1);
  const manifest = JSON.parse((await fx.views.content.read(snap.manifestHash)).toString('utf8'));
  assert.equal(manifest.fileCount, 3, 'two disk files plus the unsaved editor document');
  assert.equal(manifest.entries['draft.txt'].hash, sha256(editorText), 'mutable editor text captured once');
  assert.equal(manifest.entries['base.txt'].hash, sha256('base original\n'));
  const createdAt = snap.createdAt;
  // The capture itself never touched the main tree: the unsaved doc is not on disk.
  await assert.rejects(fs.access(path.join(fx.root, 'draft.txt')), error => error.code === 'ENOENT');

  // Original ACK replay: same request, fresh callback state, no re-capture.
  const replay = await fx.views.createSnapshot(request, capture);
  assert.equal(captures, 1, 'the replay must not re-run the capture driver');
  assert.equal(replay.id, snap.id);
  assert.equal(replay.manifestHash, snap.manifestHash);
  assert.equal(replay.createdAt, createdAt, 'the durable ACK is the ORIGINAL acknowledgment');
  // A different selectionKey with the same requestId is a hard conflict.
  await assert.rejects(
    fx.views.createSnapshot({ ...request, selectionKey: 'other' }, capture),
    error => error.code === 'isolation_conflict'
  );

  // Main-tree and editor mutations after the snapshot do not move the bytes.
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base mutated\n');
  await fs.writeFile(path.join(fx.root, 'notes.txt'), 'notes mutated\n');
  fx.setDocuments(() => [{ path: path.join(fx.root, 'draft.txt'), text: 'unsaved draft v2\n', version: 2 }]);
  const binder = binderOf(fx, 'probe', snap.id);
  const probeRecord = await fx.views.bind(binder.input(id64('bind-probe')), marker => {
    fx.markers.push(marker);
    return Promise.resolve();
  });
  const binding = { teamId: probeRecord.teamId, snapshotId: probeRecord.snapshotId, overlayId: probeRecord.overlayId };
  const readBase = await fx.views.withView(binding, binder.identity, async view => view.read('base.txt'));
  assert.deepEqual(readBase.bytes, Buffer.from('base original\n'), 'main changes never alter snapshot bytes');
  const readDraft = await fx.views.withView(binding, binder.identity, async view => view.read('draft.txt'));
  assert.deepEqual(readDraft.bytes, Buffer.from(editorText), 'the editor document keeps its captured text');
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: id64('rel-probe'), kind: 'overlay', id: probeRecord.overlayId });
});

test('2) failed bind leaves a durable pin; close/reopen retry succeeds; new request records the ACK; identity mismatch rejected', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base original\n');
  const snap = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-2'), selectionKey: 'key-2' }, fx.openDocuments);
  // A second base the same worker instance may never switch to.
  await fs.writeFile(path.join(fx.root, 'other.txt'), 'other base\n');
  const snap2 = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-2b'), selectionKey: 'key-2b' }, fx.openDocuments);
  const binder = binderOf(fx, 'w2', snap.id);
  // The marker persistence (Session marker write) fails AFTER the durable
  // binding pin was already published: the retry must be possible.
  let markerAttempts = 0;
  await assert.rejects(fx.views.bind(binder.input('req-crash'), () => {
    markerAttempts += 1;
    throw new Error('session marker write failed');
  }), /session marker write failed/);
  assert.equal(markerAttempts, 1);
  let state = await fx.views.inspect(OWNER, TEAM);
  assert.equal(state.overlays.length, 0, 'no overlay was published');
  const leftoverPin = state.pins.find(pin => pin.name.startsWith('binding:') && pin.binding?.workerId === binder.workerId);
  assert.ok(leftoverPin, 'the durable binding pin keeps the base reachable');
  assert.equal(leftoverPin.resource.kind, 'snapshot');
  assert.equal(leftoverPin.resource.id, snap.id);
  assert.equal(fx.markers.length, 0, 'the failed attempt never persisted a Session marker');

  // Close and reopen: the pin must survive, and retrying the SAME bind request
  // (same requestId) must finalize from the leftover pin, not start a new resource.
  await fx.views.close();
  const views2 = new IsolatedViews(fx.storeDir, fx.root);
  t.after(async () => { await views2.close(); });
  await views2.open();
  state = await views2.inspect(OWNER, TEAM);
  assert.ok(state.pins.some(pin => pin.id === leftoverPin.id), 'the pin survived close/reopen');
  const record = await views2.bind(binder.input('req-crash'), marker => {
    fx.markers.push(marker);
    return Promise.resolve();
  });
  assert.equal(record.overlayId, leftoverPin.binding.overlayId, 'the retry reuses the durable overlay identity');
  assert.equal(record.head, null);
  assert.equal(record.revision, 0);
  assert.equal(fx.markers.length, 1, 'the marker was persisted exactly once, on the successful attempt');
  state = await views2.inspect(OWNER, TEAM);
  assert.equal(state.pins.filter(pin => pin.name.startsWith('binding:')).length, 0, 'the internal binding pin is consumed');
  const binding = { teamId: record.teamId, snapshotId: record.snapshotId, overlayId: record.overlayId };
  await views2.edit(binding, binder.identity, async (view, put) =>
    view.tree.write('w2.txt', await put(Buffer.from('w2 edit\n')), 8, 'new'));
  const currentHead = (await views2.status(binding, binder.identity)).head;

  // A NEW request for the same (already active) binding records the original
  // ACK: the overlay is returned unchanged, head and revision are never reset.
  const rebind = await views2.bind(binder.input('req-new'), marker => {
    fx.markers.push(marker);
    return Promise.resolve();
  });
  assert.equal(rebind.head, currentHead, 'rebind keeps the current head');
  assert.equal(rebind.revision, 1, 'rebind never resets the revision');
  assert.equal(fx.markers.length, 2, 'the marker was re-persisted for the new request');

  // Owner mismatch: replaying the recorded request with a different owner is a conflict.
  await assert.rejects(
    views2.bind({ ownerId: 'owner-b', teamId: TEAM, snapshotId: snap.id, workerId: binder.workerId, workerCreatedAt: binder.workerCreatedAt, requestId: 'req-new' }, async () => {}),
    error => error.code === 'isolation_conflict', 'a recorded binding request cannot be replayed under a different owner'
  );
  // The same (workerId, workerCreatedAt) instance cannot switch to another base.
  await assert.rejects(
    views2.bind({ ownerId: OWNER, teamId: TEAM, snapshotId: snap2.id, workerId: binder.workerId, workerCreatedAt: binder.workerCreatedAt, requestId: 'req-switch-base' }, async () => {}),
    error => error.code === 'isolation_conflict', 'the permanent session marker blocks a base/owner switch for the instance'
  );
});

test('3) two bound workers share one base; private changes stay isolated and never touch main; conflicts publish nothing', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base original\n');
  await fs.writeFile(path.join(fx.root, 'notes.txt'), 'notes original\n');
  const snap = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-3'), selectionKey: 'key-3' }, fx.openDocuments);
  const a = binderOf(fx, 'wa', snap.id);
  const b = binderOf(fx, 'wb', snap.id);
  const persist = marker => { fx.markers.push(marker); return Promise.resolve(); };
  const recordA = await fx.views.bind(a.input(id64('bind-a')), persist);
  const recordB = await fx.views.bind(b.input(id64('bind-b')), persist);
  const bindingA = { teamId: recordA.teamId, snapshotId: recordA.snapshotId, overlayId: recordA.overlayId };
  const bindingB = { teamId: recordB.teamId, snapshotId: recordB.snapshotId, overlayId: recordB.overlayId };
  assert.notEqual(recordA.overlayId, recordB.overlayId, 'different workers get distinct overlays');

  // A: private mkdir + overwrite + new file.
  await fx.views.edit(bindingA, a.identity, view => view.tree.mkdir('a'));
  await fx.views.edit(bindingA, a.identity, async (view, put) => {
    const baseDelta = view.tree.write('base.txt', await put(Buffer.from('wa version\n')), 11, (await view.read('base.txt')).hash);
    const draftDelta = view.tree.write('a/draft.txt', await put(Buffer.from('wa new\n')), 7, 'new');
    return { ...baseDelta, ...draftDelta };
  });
  // B: private mkdir + rename + delete + new file.
  await fx.views.edit(bindingB, b.identity, view => view.tree.mkdir('b'));
  await fx.views.edit(bindingB, b.identity, async (view, put) => {
    const renamed = view.tree.rename('notes.txt', 'b/renamed.txt', (await view.read('notes.txt')).hash);
    const removed = view.tree.delete('base.txt', (await view.read('base.txt')).hash);
    const fresh = view.tree.write('b/fresh.txt', await put(Buffer.from('wb new\n')), 7, 'new');
    return { ...renamed, ...removed, ...fresh };
  });

  const viewOf = async (binding, identity) => fx.views.withView(binding, identity, async view => ({
    keys: Object.keys(view.tree.entries).sort(),
    base: view.tree.stat('base.txt'),
    notes: view.tree.stat('notes.txt'),
    draft: view.tree.stat('a/draft.txt'),
    renamed: view.tree.stat('b/renamed.txt')
  }));
  const aView = await viewOf(bindingA, a.identity);
  assert.equal(aView.keys.includes('a/draft.txt'), true, 'A sees its own new file');
  assert.equal(aView.base?.hash, sha256('wa version\n'), 'A sees its own overwrite');
  assert.equal(aView.notes?.hash, sha256('notes original\n'), 'A still sees the shared base notes');
  assert.equal(aView.draft?.type, 'file');
  assert.equal(aView.renamed, undefined, 'B rename invisible to A');
  const bView = await viewOf(bindingB, b.identity);
  assert.equal(bView.renamed?.hash, sha256('notes original\n'), 'B sees its own rename');
  assert.equal(bView.base, undefined, 'B deletes base for itself only');
  assert.equal(bView.notes, undefined, 'B renamed notes away for itself only');
  assert.equal(bView.draft, undefined, 'A new file invisible to B');
  assert.equal(bView.keys.includes('b/fresh.txt'), true, 'B sees its own new file');

  // Conflicts publish no head and create no extra content.
  const blobsBefore = await blobCount(fx.storeDir);
  const revBefore = (await fx.views.status(bindingB, b.identity)).revision;
  await assert.rejects(
    fx.views.edit(bindingB, b.identity, async view => view.tree.write('base.txt', sha256('stale\n'), 6, 'deadbeef'.repeat(8))),
    error => error.code === 'stale_hash'
  );
  await assert.rejects(
    fx.views.edit(bindingB, b.identity, async view => view.tree.write('b/fresh.txt', sha256('x\n'), 2, 'new')),
    error => error.code === 'path_conflict'
  );
  assert.equal((await fx.views.status(bindingB, b.identity)).revision, revBefore, 'failed edits do not advance the revision');
  assert.equal(await blobCount(fx.storeDir), blobsBefore, 'rejected edits leave no content behind');

  // The main tree is untouched by any private activity.
  assert.equal(await fs.readFile(path.join(fx.root, 'base.txt'), 'utf8'), 'base original\n');
  assert.equal(await fs.readFile(path.join(fx.root, 'notes.txt'), 'utf8'), 'notes original\n');
  assert.deepEqual((await fs.readdir(fx.root)).sort(), ['base.txt', 'notes.txt']);
});

test('4) sealed submissions are immutable across edits and reopens; seal ACK replays; corrupt content fails closed', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base original\n');
  const snap = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-4'), selectionKey: 'key-4' }, fx.openDocuments);
  const w = binderOf(fx, 'w4', snap.id);
  const record = await fx.views.bind(w.input(id64('bind-w4')), marker => { fx.markers.push(marker); return Promise.resolve(); });
  const binding = { teamId: record.teamId, snapshotId: record.snapshotId, overlayId: record.overlayId };
  await fx.views.edit(binding, w.identity, async (view, put) =>
    view.tree.write('w4.txt', await put(Buffer.from('seal me\n')), 8, 'new'));
  const submission = await fx.views.seal(binding, w.identity, { requestId: id64('seal-1'), expectedRevision: 1 });
  assert.equal(submission.revision, 1);
  assert.equal(submission.version, 2);
  assert.equal(submission.uri, `codex-subagent://submission/${fx.views.namespace}/${submission.id}/2`);
  await fx.views.edit(binding, w.identity, async (view, put) => {
    const existing = (await view.read('w4.txt')).hash;
    return view.tree.write('w4.txt', await put(Buffer.from('second edit\n')), 12, existing);
  });
  assert.equal((await fx.views.status(binding, w.identity)).revision, 2, 'the overlay moved on after the seal');

  const readSubmission = async () => fx.views.withSubmission(OWNER, TEAM, submission.id, async (_view, sealed) => {
    const file = await _view.read('w4.txt');
    return { version: sealed.version, bytes: file.bytes };
  });
  const firstRead = await readSubmission();
  assert.equal(firstRead.version, 2);
  assert.deepEqual(firstRead.bytes, Buffer.from('seal me\n'), 'the submission keeps revision 1 bytes after later edits');
  const live = await fx.views.withView(binding, w.identity, async view => view.read('w4.txt'));
  assert.deepEqual(live.bytes, Buffer.from('second edit\n'), 'the live overlay shows the newer revision');

  // Close and reopen: the old submission STILL reads rev1.
  await fx.views.close();
  const views2 = new IsolatedViews(fx.storeDir, fx.root);
  t.after(async () => { await views2.close(); });
  await views2.open();
  const reopened = await views2.withSubmission(OWNER, TEAM, submission.id, async view => view.read('w4.txt'));
  assert.deepEqual(reopened.bytes, Buffer.from('seal me\n'), 'durable submission survives reopen');

  // Seal ACK replay after later edits returns the original sealed record.
  const replay = await views2.seal(binding, w.identity, { requestId: id64('seal-1'), expectedRevision: 1 });
  assert.equal(replay.id, submission.id, 'the ACK replays the original submission');
  assert.equal(replay.revision, 1);
  assert.equal(replay.uri, submission.uri);
  await assert.rejects(
    views2.seal(binding, w.identity, { requestId: id64('seal-1'), expectedRevision: 2 }),
    error => error.code === 'isolation_conflict', 'the same seal requestId with a different revision is a conflict'
  );

  // Missing/corrupt stored content fails closed with NO live workspace fallback.
  const baseHash = sha256('base original\n');
  const blob = path.join(fx.storeDir, 'content', 'blobs', baseHash.slice(0, 2), baseHash.slice(2));
  await fs.writeFile(blob, 'corrupt');
  await assert.rejects(
    views2.withSubmission(OWNER, TEAM, submission.id, async view => view.read('base.txt')),
    error => error.code === 'snapshot_content_missing', 'corrupt stored bytes fail closed, no live fallback'
  );
  await assert.rejects(
    views2.withView(binding, w.identity, async view => view.read('base.txt')),
    error => error.code === 'snapshot_content_missing'
  );
  assert.equal(await fs.readFile(path.join(fx.root, 'base.txt'), 'utf8'), 'base original\n', 'the live file is intact; reads never fall back to it');
});

test('5) release/pin/cleanup: sealed data outlives release; named pin retains; cleanup ACK replays exactly; final collection sweeps blobs', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, 'base.txt'), 'base original\n');
  const snap = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-5'), selectionKey: 'key-5' }, fx.openDocuments);
  const a = binderOf(fx, 'wa5', snap.id);
  const b = binderOf(fx, 'wb5', snap.id);
  const persist = marker => { fx.markers.push(marker); return Promise.resolve(); };
  const recordA = await fx.views.bind(a.input(id64('bind-a5')), persist);
  await fx.views.bind(b.input(id64('bind-b5')), persist);
  const bindingA = { teamId: recordA.teamId, snapshotId: recordA.snapshotId, overlayId: recordA.overlayId };
  await fx.views.edit(bindingA, a.identity, async (view, put) =>
    view.tree.write('a5.txt', await put(Buffer.from('sealed\n')), 7, 'new'));
  const submission = await fx.views.seal(bindingA, a.identity, { requestId: id64('seal-5'), expectedRevision: 1 });
  // manifest + base payload + sealed payload + head revision.
  const sealedBlobCount = await blobCount(fx.storeDir);
  assert.equal(sealedBlobCount, 4);

  // Release the overlay and the snapshot creation pin; the sealed submission
  // still roots its snapshot record.
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: id64('rel-overlay-5'), kind: 'overlay', id: recordA.overlayId });
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: id64('rel-snap-5'), kind: 'snapshot', id: snap.id });
  let state = await fx.views.inspect(OWNER, TEAM);
  assert.ok(state.snapshots.some(s => s.id === snap.id), 'the snapshot record is still referenced by the sealed submission');
  assert.ok(!state.pins.some(pin => pin.name === `snapshot:${snap.id}`), 'the creation pin is gone');
  assert.equal(state.overlays.find(o => o.overlayId === recordA.overlayId)?.released, true);
  await assert.rejects(fx.views.status(bindingA, a.identity), error => error.code === 'isolation_released', 'released overlay cannot use live tools');
  const sealedRead = await fx.views.withSubmission(OWNER, TEAM, submission.id, async view => view.read('a5.txt'));
  assert.deepEqual(sealedRead.bytes, Buffer.from('sealed\n'), 'the sealed submission still reads');

  // A named pin keeps a released submission alive.
  const named = await fx.views.pin({ ownerId: OWNER, teamId: TEAM, requestId: id64('pin-5'), name: 'archive-5', resource: { kind: 'submission', id: submission.id } });
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: id64('rel-sub-5'), kind: 'submission', id: submission.id });
  assert.equal(named.resource.id, submission.id);
  assert.equal(await fx.views.withSubmission(OWNER, TEAM, submission.id, async () => 'ok'), 'ok', 'pinned released submission is readable');

  // First cleanup: both worker sessions are gone; the pinned submission keeps everything alive.
  const resolveMissing = async () => ({ state: 'missing' });
  const firstCleanup = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: id64('cleanup-5') }, resolveMissing);
  assert.deepEqual(firstCleanup.deletedSnapshots, [], 'the pinned submission keeps the base alive');
  assert.equal(firstCleanup.deletedSubmissions, 0, 'the pinned submission is not collected');
  assert.equal(firstCleanup.releasedOverlays.length, 2, 'both worker overlays are gone with their sessions');
  assert.equal(firstCleanup.deletedBlobs, 0, 'no blobs collected while a pinned submission remains');
  assert.equal(firstCleanup.complete, true);

  // ACK replay after the release effects: same requestId returns the EXACT stored result.
  const replayCleanup = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: id64('cleanup-5') }, resolveMissing);
  assert.deepEqual(replayCleanup, firstCleanup, 'the cleanup acknowledgment is durable and byte-exact');

  // Release the pin; the next cleanup collects the base and sweeps every blob.
  await fx.views.release({ ownerId: OWNER, teamId: TEAM, requestId: id64('rel-pin-5'), kind: 'pin', id: named.id });
  const finalCleanup = await fx.views.cleanup({ ownerId: OWNER, teamId: TEAM, requestId: id64('cleanup-5b') }, resolveMissing);
  assert.deepEqual(finalCleanup.deletedSnapshots, [snap.id], 'the unreferenced base is collected');
  assert.equal(finalCleanup.deletedSubmissions, 1, 'the unreferenced released submission is dropped');
  assert.equal(finalCleanup.deletedBlobs, sealedBlobCount, 'all now-unreferenced blobs are swept');
  assert.equal(await blobCount(fx.storeDir), 0, 'the content store is empty');
  assert.equal(finalCleanup.complete, true);

  // The collected resources are really gone after a close/reopen.
  await fx.views.close();
  const views2 = new IsolatedViews(fx.storeDir, fx.root, { expectExisting: true });
  t.after(async () => { await views2.close(); });
  await views2.open();
  assert.equal((await views2.inspect(OWNER, TEAM)).snapshots.some(s => s.id === snap.id), false);
  await assert.rejects(views2.withSubmission(OWNER, TEAM, submission.id, async () => 'no'), error => error.code === 'not_found');
});

test('6) disk growth: 16 unchanged workers add no base copies; changed payloads are stored once per distinct byte set', async t => {
  const fx = await fixture(t);
  const original = MIbText('base');
  await fs.writeFile(path.join(fx.root, 'large.bin'), original);
  const snap = await createCasSnapshot(fx, { ownerId: OWNER, teamId: TEAM, requestId: id64('create-6'), selectionKey: 'key-6' }, fx.openDocuments);
  assert.equal(await countMiBlobs(fx.storeDir), 1, 'exactly one 1 MiB payload (the shared base) after capture');
  const storeAfterCapture = await dirBytes(fx.storeDir);

  for (let i = 0; i < 16; i += 1) {
    const binder = binderOf(fx, `w${i}`, snap.id);
    const record = await fx.views.bind(binder.input(id64(`bind-w${i}`)), marker => { fx.markers.push(marker); return Promise.resolve(); });
    assert.equal(record.revision, 0, 'the unchanged worker never gained a head');
    assert.equal(record.head, null);
  }
  const totalGrowth = (await dirBytes(fx.storeDir)) - storeAfterCapture;
  assert.ok(totalGrowth < 200 * 1024, `16 unchanged bindings must add less than 200 KiB of view-store bytes, got ${totalGrowth}`);
  assert.equal(await countMiBlobs(fx.storeDir), 1, 'no per-worker base copies exist in the content store');

  const overlayOf = i => sha256(['overlay', fx.views.namespace, id32(`w${i}`), DATE, snap.id]);
  const bindingOfWorker = i => ({ teamId: TEAM, snapshotId: snap.id, overlayId: overlayOf(i) });
  const identityOf = i => ({ ownerId: OWNER, workerId: id32(`w${i}`), workerCreatedAt: DATE });
  const putChange = async (i, payload) => fx.views.edit(bindingOfWorker(i), identityOf(i), async (view, put) =>
    view.tree.write('large.bin', await put(payload), payload.length, (await view.read('large.bin')).hash));
  const readOf = async i => fx.views.withView(bindingOfWorker(i), identityOf(i), async view => view.read('large.bin').then(r => r.bytes));

  const changed1 = MIbText('changed-one');
  const changed2 = MIbText('changed-two');
  await putChange(1, changed1);
  assert.equal(await countMiBlobs(fx.storeDir), 2, 'one changed 1 MiB file adds exactly ONE payload blob');
  await putChange(2, changed1);
  assert.equal(await countMiBlobs(fx.storeDir), 2, 'identical bytes in another worker dedupe to the same blob');
  await putChange(3, changed2);
  assert.equal(await countMiBlobs(fx.storeDir), 3, 'a distinct change adds exactly one more payload blob');

  assert.deepEqual(await readOf(0), original, 'the untouched worker still reads the shared base bytes');
  assert.deepEqual(await readOf(1), changed1);
  assert.deepEqual(await readOf(2), changed1, 'worker 2 sees its own copy of the same bytes');
  assert.deepEqual(await readOf(3), changed2);
  assert.deepEqual(await readOf(5), original, 'other workers are unaffected');
});
