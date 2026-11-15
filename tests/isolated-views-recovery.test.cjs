const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { IsolatedViews } = require(path.join(build, 'isolated-views'));
const { captureProject, readProjectContent } = require(path.join(build, 'project-snapshot'));
const { IsolatedWorkspaceTools } = require(path.join(build, 'isolated-workspace-tools'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const date = '2026-11-14T00:00:00.000Z';
const scope = { ownerId: 'owner-a', teamId: 'a'.repeat(32) };

function git(root, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) { if (key.toUpperCase().startsWith('GIT_')) { delete env[key]; } }
  env.GIT_TERMINAL_PROMPT = '0';
  return spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', env });
}
function gitOk(root, ...args) {
  const result = git(root, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, useGit = false) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'view-recovery-')));
  const root = path.join(base, 'repo'), directory = path.join(base, 'views');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'base');
  let views;
  t.after(async () => {
    await views?.close();
    assert.match(path.basename(base), /^view-recovery-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  if (useGit) {
    const version = git(root, '--version').stdout?.match(/(\d+)\.(\d+)/);
    if (!version || +version[1] < 2 || (+version[1] === 2 && +version[2] < 46)) {
      t.skip('Git 2.46 or newer is required for immutable Git object retention.');
      return;
    }
    gitOk(root, 'init', '-q', '--template=', '--object-format=sha1', '.');
    gitOk(root, 'config', 'core.autocrlf', 'false');
    gitOk(root, 'add', 'a.txt');
  }
  views = new IsolatedViews(directory, root);
  await views.open();
  const create = (requestId, actor = scope, before) => views.createSnapshot({ ...actor, requestId, selectionKey: 'all' },
    (snapshotId, journal) => captureProject(root, views.content, { snapshotId, namespace: views.namespace, beforePublish: async candidate => {
      await journal(candidate);
      await before?.(candidate, journal);
    } }));
  return { base, root, directory, create, views: () => views,
    reopen: async () => { await views.close(); views = new IsolatedViews(directory, root, { expectExisting: true }); await views.open(); } };
}

function binding(snapshot, workerId = '1'.repeat(32), actor = scope) {
  return { ...actor, snapshotId: snapshot.id, workerId, workerCreatedAt: date, requestId: 'bind' };
}
const identity = input => ({ ownerId: input.ownerId, workerId: input.workerId, workerCreatedAt: input.workerCreatedAt });

test('pending Git candidate recovers without recapture, survives real GC, then releases exact objects', async t => {
  const f = await fixture(t, true);
  if (!f) { return; }
  let candidate;
  await assert.rejects(f.create('capture', scope, value => { candidate = value; throw Error('crash before ref'); }), /crash before ref/);
  assert.equal(git(f.root, 'rev-parse', '--verify', candidate.backing.ref).status, 128);
  const index = JSON.parse(await fs.readFile(path.join(f.directory, 'index.json'), 'utf8'));
  assert.equal(Object.keys(index.pendingCaptures).length, 1);
  assert.equal(await f.views().content.has(hash('base')), false, 'clean Git bytes are never copied into CAS');
  await fs.writeFile(path.join(f.root, 'a.txt'), 'new live file');
  gitOk(f.root, 'read-tree', '--empty');
  await f.reopen();
  const snapshot = await f.views().createSnapshot({ ...scope, requestId: 'capture', selectionKey: 'all' }, () => { throw Error('must not recapture'); });
  assert.equal(gitOk(f.root, 'rev-parse', snapshot.backing.ref), candidate.backing.tree);
  const input = binding(snapshot);
  const overlay = await f.views().bind(input, async () => {});
  gitOk(f.root, 'gc', '--prune=now');
  assert.equal(await f.views().withView(overlay, identity(input), async view => (await view.read('a.txt')).bytes.toString()), 'base');
  await f.views().release({ ...scope, requestId: 'release-view', kind: 'overlay', id: overlay.overlayId });
  await f.views().release({ ...scope, requestId: 'release-base', kind: 'snapshot', id: snapshot.id });
  const cleanup = await f.views().cleanup({ ...scope, requestId: 'cleanup' });
  assert.deepEqual(cleanup.deletedSnapshots, [snapshot.id]);
  assert.equal(git(f.root, 'rev-parse', '--verify', snapshot.backing.ref).status, 128);
  gitOk(f.root, 'gc', '--prune=now');
  await assert.rejects(readProjectContent(snapshot.backing, f.views().content, hash('base')), { code: 'snapshot_content_missing' });
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'new live file');
});

test('a second different candidate cannot replace the first durable Git intent', async t => {
  const f = await fixture(t, true);
  if (!f) { return; }
  let first;
  await assert.rejects(f.create('immutable', scope, async (candidate, journal) => {
    first = candidate;
    await journal({ manifest: candidate.manifest, backing: { kind: 'cas' } });
  }), { code: 'isolation_conflict' });
  const data = JSON.parse(await fs.readFile(path.join(f.directory, 'index.json'), 'utf8'));
  assert.deepEqual(Object.values(data.pendingCaptures)[0].snapshot.backing, first.backing);
  const snapshot = await f.views().createSnapshot({ ...scope, requestId: 'immutable', selectionKey: 'all' }, () => { throw Error('recapture'); });
  assert.deepEqual(snapshot.backing, first.backing);
});

test('marker committed before a crash is reconciled from the durable binding intent on reload', async t => {
  const f = await fixture(t);
  const snapshot = await f.create('capture');
  const input = binding(snapshot);
  let marker, allowed = true;
  await assert.rejects(f.views().bind(input, async value => { marker = value; allowed = false; }, () => {
    if (!allowed) { throw Error('stopped after Session marker'); }
  }), /stopped after Session marker/);
  await f.reopen();
  const cleanup = await f.views().cleanup({ ...scope, requestId: 'recover' }, async () => ({ state: 'present', workerCreatedAt: date, binding: marker }));
  assert.equal(cleanup.recoveredBindings, 1);
  let called = false;
  const overlay = await f.views().bind(input, async () => { called = true; });
  assert.equal(called, false, 'recovery reserved the original bind acknowledgment');
  assert.equal(overlay.overlayId, marker.overlayId);
  assert.equal(await f.views().withView(marker, identity(input), async view => (await view.read('a.txt')).bytes.toString()), 'base');
  assert.equal((await f.views().inspect(scope.ownerId, scope.teamId)).pins.some(pin => pin.binding), false);
});

test('cleanup is scope-aware, conservatively retains unknown Sessions and preserves unknown storage', async t => {
  const f = await fixture(t);
  const a = await f.create('capture-a');
  const inputA = binding(a);
  await f.views().bind(inputA, async () => {});
  await f.views().release({ ...scope, requestId: 'release-a', kind: 'snapshot', id: a.id });
  const other = { ownerId: 'owner-b', teamId: 'b'.repeat(32) };
  await fs.writeFile(path.join(f.root, 'a.txt'), 'other owner bytes');
  const b = await f.create('capture-b', other);
  await f.views().release({ ...other, requestId: 'release-b', kind: 'snapshot', id: b.id });
  const unknown = path.join(f.views().content.directory, 'blobs', 'unknown-file');
  await fs.writeFile(unknown, 'preserve unknown');
  const retained = await f.views().cleanup({ ...scope, requestId: 'unknown' }, async () => ({ state: 'unknown' }));
  assert.equal(retained.complete, false);
  assert.deepEqual(retained.deletedSnapshots, []);
  assert.equal(retained.preservedUnknown, 1);
  const removed = await f.views().cleanup({ ...scope, requestId: 'missing' }, async () => ({ state: 'missing' }));
  assert.deepEqual(removed.deletedSnapshots, [a.id]);
  assert.equal(removed.releasedOverlays.length, 1);
  assert.equal((await f.views().content.read(hash('other owner bytes'))).toString(), 'other owner bytes', 'other owner metadata retains its CAS even without an active pin');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'preserve unknown');
  const orphan = await f.views().content.put(Buffer.from('new orphan after ACK'));
  assert.deepEqual(await f.views().cleanup({ ...scope, requestId: 'missing' }, async () => ({ state: 'missing' })), removed);
  assert.equal(await f.views().content.has(orphan), true, 'ACK replay cannot perform another sweep');
});

test('full overlay capacity is rejected before any Session marker effect', async t => {
  const f = await fixture(t);
  const snapshot = await f.create('capture');
  await f.views().close();
  const file = path.join(f.directory, 'index.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  for (let i = 0; i < 256; i++) {
    const overlayId = hash(`occupied-${i}`);
    data.overlays[overlayId] = { ...scope, snapshotId: snapshot.id, overlayId, workerId: i.toString(16).padStart(32, '0'),
      workerCreatedAt: date, head: null, revision: 0, released: true };
  }
  await fs.writeFile(file, JSON.stringify(data));
  await f.reopen();
  let markerCalls = 0;
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(f.views().bind(binding(snapshot, '9'.repeat(32)), async () => { markerCalls += 1; }), { code: 'isolation_capacity' });
  assert.equal(markerCalls, 0);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('stores inside the project and missing established indexes fail closed before writes', async t => {
  const f = await fixture(t);
  assert.throws(() => new IsolatedViews(path.join(f.root, '..notes'), f.root), { code: 'isolation_corrupt' });
  assert.throws(() => new IsolatedViews(f.root, f.root), { code: 'isolation_corrupt' });
  await assert.rejects(fs.access(path.join(f.root, '..notes')), { code: 'ENOENT' });
  await f.create('capture');
  await f.views().close();
  const index = path.join(f.directory, 'index.json');
  await fs.unlink(index);
  const lost = new IsolatedViews(f.directory, f.root);
  await assert.rejects(lost.open(), { code: 'isolation_corrupt' });
  await lost.close();
  await assert.rejects(fs.access(index), { code: 'ENOENT' });
  const absent = path.join(f.base, 'missing-store');
  const marked = new IsolatedViews(absent, f.root, { expectExisting: true });
  await assert.rejects(marked.open(), { code: 'isolation_corrupt' });
  await marked.close();
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
});

test('cleanup never overwrites or deletes a conflicting Git ref and reports incomplete retention', async t => {
  const f = await fixture(t, true);
  if (!f) { return; }
  const snapshot = await f.create('capture');
  const emptyTree = gitOk(f.root, 'hash-object', '-w', '-t', 'tree', '--stdin');
  gitOk(f.root, 'update-ref', snapshot.backing.ref, emptyTree);
  gitOk(f.root, 'update-ref', 'refs/user/kept', emptyTree);
  await f.views().release({ ...scope, requestId: 'release', kind: 'snapshot', id: snapshot.id });
  const result = await f.views().cleanup({ ...scope, requestId: 'cleanup' });
  assert.equal(result.complete, false);
  assert.equal(result.diagnosticCount, 1);
  assert.deepEqual(result.deletedSnapshots, []);
  assert.equal(gitOk(f.root, 'rev-parse', snapshot.backing.ref), emptyTree);
  assert.equal(gitOk(f.root, 'rev-parse', 'refs/user/kept'), emptyTree);
  assert.equal((await f.views().inspect(scope.ownerId, scope.teamId)).snapshots.length, 1);
});

test('cleanup restores a pending Git retention ref; explicit discard makes its original request terminal', async t => {
  const f = await fixture(t, true);
  if (!f) { return; }
  let candidate;
  await assert.rejects(f.create('pending', scope, value => { candidate = value; throw Error('before ref'); }), /before ref/);
  assert.notEqual(git(f.root, 'rev-parse', '--verify', candidate.backing.ref).status, 0);
  const retained = await f.views().cleanup({ ...scope, requestId: 'retain-pending' });
  assert.equal(retained.complete, true);
  assert.equal(gitOk(f.root, 'rev-parse', candidate.backing.ref), candidate.backing.tree);
  let inspection = await f.views().inspect(scope.ownerId, scope.teamId);
  assert.equal(inspection.snapshots.length, 0, 'retaining a candidate must not pretend its capture was acknowledged');
  assert.equal(inspection.pendingCaptures.length, 1);
  const snapshotId = inspection.pendingCaptures[0].snapshotId;
  await f.views().release({ ...scope, requestId: 'discard', kind: 'pending', id: snapshotId });
  assert.notEqual(git(f.root, 'rev-parse', '--verify', candidate.backing.ref).status, 0);
  let recaptures = 0;
  await assert.rejects(f.views().createSnapshot({ ...scope, requestId: 'pending', selectionKey: 'all' }, () => { recaptures += 1; throw Error('must not recapture'); }), { code: 'isolation_released' });
  assert.equal(recaptures, 0);
  inspection = await f.views().inspect(scope.ownerId, scope.teamId);
  assert.equal(inspection.pendingCaptures.length, 0);
  assert.ok((await f.views().cleanup({ ...scope, requestId: 'collect-discarded' })).deletedBlobs > 0);
});

test('a failed open cannot reuse cached empty state after the original index is restored', async t => {
  const f = await fixture(t);
  const snapshot = await f.create('capture');
  await f.views().close();
  const file = path.join(f.directory, 'index.json');
  const bytes = await fs.readFile(file);
  await fs.unlink(file);
  const lost = new IsolatedViews(f.directory, f.root);
  await assert.rejects(lost.open(), { code: 'isolation_corrupt' });
  await fs.writeFile(file, bytes);
  await assert.rejects(lost.open(), { code: 'isolation_corrupt' });
  assert.deepEqual(await fs.readFile(file), bytes, 'failed handle must never overwrite restored metadata');
  await lost.close();
  const fresh = new IsolatedViews(f.directory, f.root, { expectExisting: true });
  try {
    await fresh.open();
    const replay = await fresh.createSnapshot({ ...scope, requestId: 'capture', selectionKey: 'all' }, () => { throw Error('must not recapture'); });
    assert.deepEqual(replay, snapshot);
  } finally {
    await fresh.close();
  }
});

test('unchanged writes and patches reuse retained Git bytes without creating private payloads', async t => {
  const f = await fixture(t, true);
  if (!f) { return; }
  const snapshot = await f.create('capture');
  const input = binding(snapshot);
  const overlay = await f.views().bind(input, async () => {});
  const tools = new IsolatedWorkspaceTools(f.root, f.views(), overlay, identity(input), 'workspace-write', { canWrite: () => true });
  const signal = new AbortController().signal;
  const write = JSON.parse(await tools.execute('write_file', { path: 'a.txt', content: 'base', expectedHash: hash('base') }, 'workspace-write', signal));
  assert.equal(write.revision, 0);
  const patch = JSON.parse(await tools.execute('patch_file', { path: 'a.txt', oldText: 'base', newText: 'base', expectedHash: hash('base') }, 'workspace-write', signal));
  assert.equal(patch.revision, 0);
  assert.equal(await f.views().content.has(hash('base')), false);
  assert.equal((await f.views().status(overlay, identity(input))).head, null);
});
