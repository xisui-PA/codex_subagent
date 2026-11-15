const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { captureContent, ContentStore } = require(path.join(build, 'snapshot-content'));
const { captureProject } = require(path.join(build, 'project-snapshot'));
const { IsolatedViews } = require(path.join(build, 'isolated-views'));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const scope = { ownerId: 'review-fixes', teamId: 'a'.repeat(32) };
const workerId = 'b'.repeat(32), workerCreatedAt = '2026-11-14T00:00:00.000Z';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-review-fixes-')));
  const root = path.join(base, 'project'), source = path.join(root, 'src');
  const parked = path.join(base, 'parked'), outside = path.join(base, 'outside');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(outside);
  const file = path.join(source, 'a.txt');
  await fs.writeFile(file, 'SAFE');
  await fs.writeFile(path.join(outside, 'a.txt'), 'LEAK');
  const views = new IsolatedViews(path.join(base, 'views'), root);
  await views.open();
  t.after(async () => {
    await views.close();
    assert.match(path.basename(base), /^isolated-review-fixes-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const store = new ContentStore(path.join(base, 'content'));
  const swap = async action => {
    await fs.rename(source, parked);
    let linked = false;
    try {
      await fs.symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
      return await action();
    } finally {
      if (linked) { await fs.unlink(source); }
      await fs.rename(parked, source);
    }
  };
  const capture = requestId => views.createSnapshot({ ...scope, requestId, selectionKey: 'all' },
    (snapshotId, beforePublish) => captureProject(root, views.content, { snapshotId, namespace: views.namespace, beforePublish }));
  return { base, root, file, outside, store, views, swap, capture };
}

test('a parent-junction swap before open rejects the wrong handle before reading and closes it', async t => {
  const f = await fixture(t);
  const open = fs.open, readFile = fs.readFile;
  let swaps = 0, outsideReads = 0, closes = 0;
  fs.open = async function(target, ...args) {
    if (String(target) !== f.file) { return open.call(this, target, ...args); }
    swaps++;
    const handle = await f.swap(() => open.call(this, target, ...args));
    const read = handle.readFile.bind(handle), close = handle.close.bind(handle);
    handle.readFile = async (...readArgs) => { outsideReads++; return read(...readArgs); };
    handle.close = async () => { closes++; return close(); };
    return handle;
  };
  // Exercise the vulnerable path too when this test runs against the old build.
  fs.readFile = async function(target, ...args) {
    if (String(target) !== f.file) { return readFile.call(this, target, ...args); }
    swaps++;
    return f.swap(() => { outsideReads++; return readFile.call(this, target, ...args); });
  };
  try {
    await assert.rejects(captureContent(f.root, f.store), { code: 'inconsistent_capture' });
    assert.equal(swaps, 3);
    assert.equal(closes, swaps, 'every rejected handle must close');
    assert.equal(outsideReads, 0, 'outside bytes must never be consumed');
    assert.equal(await f.store.has(hash('LEAK')), false);
  } finally {
    fs.open = open;
    fs.readFile = readFile;
  }
  assert.equal(await fs.readFile(f.file, 'utf8'), 'SAFE');
});

test('a parent-junction swap during a verified handle read cannot substitute outside bytes', async t => {
  const f = await fixture(t);
  const open = fs.open, readFile = fs.readFile;
  let swaps = 0, blocked = 0;
  fs.open = async function(target, ...args) {
    const handle = await open.call(this, target, ...args);
    if (String(target) === f.file) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs) => {
        swaps++;
        return f.swap(() => read(...readArgs)).catch(error => {
          if (process.platform !== 'win32' || error.code !== 'EPERM' || error.syscall !== 'rename' || error.path !== path.dirname(f.file)) { throw error; }
          // Windows can prevent renaming a directory containing an open
          // handle. That stronger protection must still yield safe bytes.
          blocked++;
          return read(...readArgs);
        });
      };
    }
    return handle;
  };
  fs.readFile = async function(target, ...args) {
    if (String(target) !== f.file) { return readFile.call(this, target, ...args); }
    swaps++;
    return f.swap(() => readFile.call(this, target, ...args));
  };
  try {
    const manifest = await captureContent(f.root, f.store);
    assert.equal(swaps, 2, 'both full scans must exercise the race');
    assert.equal((await f.store.read(manifest.entries['src/a.txt'].hash)).toString(), 'SAFE');
    assert.equal(await f.store.has(hash('LEAK')), false);
    if (blocked) { t.diagnostic(`Windows blocked ${blocked} directory swaps while a verified handle was open.`); }
  } finally {
    fs.open = open;
    fs.readFile = readFile;
  }
  assert.equal(await fs.readFile(f.file, 'utf8'), 'SAFE');
});

test('outside, excluded and unsupported editor churn does not invalidate relevant stable editor content', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '.vscode'));
  await fs.writeFile(path.join(f.root, '.vscode', 'settings.json'), '{}');
  let queries = 0, scans = 0;
  const manifest = await captureContent(f.root, f.store, {
    openDocuments: () => {
      queries++;
      const ignored = target => ({ path: target, text: `typing ${queries}`, version: queries });
      return [
        { path: f.file, text: 'stable unsaved editor', version: 1 },
        ignored(path.join(f.outside, 'a.txt')),
        ignored(path.join(f.root, '.vscode', 'settings.json')),
        ignored(path.join(f.root, 'node_modules', 'new.txt')),
        ignored(path.join(f.file, 'child.txt')),
        ignored(path.join(f.root, 'src')),
        ignored('relative.txt')
      ];
    },
    afterScan: () => { scans++; }
  });
  assert.equal(queries, 4);
  assert.equal(scans, 1, 'no retry is needed for ignored editor changes');
  assert.equal((await f.store.read(manifest.entries['src/a.txt'].hash)).toString(), 'stable unsaved editor');
  assert.equal(manifest.entries['node_modules/new.txt'], undefined);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'SAFE');
});

test('a claimed binding intent cannot be released; cleanup still recovers it', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  const input = { ...scope, workerId, workerCreatedAt, snapshotId: snapshot.id, requestId: 'bind' };
  let marker;
  await assert.rejects(f.views.bind(input, async value => { marker = value; throw Error('marker persisted'); }), /marker persisted/);
  const intent = (await f.views.inspect(scope.ownerId, scope.teamId)).pins.find(pin => pin.binding);
  const request = { ...scope, kind: 'pin', id: intent.id, requestId: 'release-intent' };
  const before = await fs.readFile(path.join(f.base, 'views', 'index.json'));
  await assert.rejects(f.views.release(request), { code: 'isolation_conflict' });
  await assert.rejects(f.views.release(request, undefined, async () => ({ state: 'unknown' })), { code: 'isolation_conflict' });
  const present = async () => ({ state: 'present', workerCreatedAt, binding: marker });
  await assert.rejects(f.views.release(request, undefined, present), { code: 'isolation_conflict' });
  assert.deepEqual(await fs.readFile(path.join(f.base, 'views', 'index.json')), before);
  await f.views.release({ ...scope, kind: 'snapshot', id: snapshot.id, requestId: 'release-creation-pin' });
  const recovered = await f.views.cleanup({ ...scope, requestId: 'recover' }, present);
  assert.equal(recovered.recoveredBindings, 1);
  assert.deepEqual(recovered.deletedSnapshots, []);
  assert.equal(await f.views.withView(marker, { ownerId: scope.ownerId, workerId, workerCreatedAt }, async view => (await view.read('src/a.txt')).bytes.toString()), 'SAFE');
});

test('confirmed missing, replaced or unbound workers allow explicit binding-intent release', async t => {
  for (const presence of [{ state: 'missing' }, { state: 'present', workerCreatedAt },
    { state: 'present', workerCreatedAt: '2026-11-15T00:00:00.000Z', binding: { overlayId: 'f'.repeat(64) } }]) {
    const f = await fixture(t);
    const snapshot = await f.capture('capture');
    await assert.rejects(f.views.bind({ ...scope, workerId, workerCreatedAt, snapshotId: snapshot.id, requestId: 'bind' }, async () => { throw Error('no marker'); }), /no marker/);
    const intent = (await f.views.inspect(scope.ownerId, scope.teamId)).pins.find(pin => pin.binding);
    const result = await f.views.release({ ...scope, kind: 'pin', id: intent.id, requestId: 'release-intent' }, undefined, async () => presence);
    assert.equal(result.released, true);
    assert.equal((await f.views.inspect(scope.ownerId, scope.teamId)).pins.some(pin => pin.binding), false);
    await f.views.release({ ...scope, kind: 'snapshot', id: snapshot.id, requestId: 'release-creation-pin' });
    const collected = await f.views.cleanup({ ...scope, requestId: 'cleanup' });
    assert.deepEqual(collected.deletedSnapshots, [snapshot.id]);
  }
});

test('binding-intent release reauthorizes after worker resolution and preserves the retry key on failure', async t => {
  const f = await fixture(t);
  const snapshot = await f.capture('capture');
  await assert.rejects(f.views.bind({ ...scope, workerId, workerCreatedAt, snapshotId: snapshot.id, requestId: 'bind' }, async () => { throw Error('no marker'); }), /no marker/);
  const intent = (await f.views.inspect(scope.ownerId, scope.teamId)).pins.find(pin => pin.binding);
  const request = { ...scope, kind: 'pin', id: intent.id, requestId: 'same-retry-key' };
  const before = await fs.readFile(path.join(f.base, 'views', 'index.json'));
  let allowed = true;
  const guard = () => { if (!allowed) { throw Error('permission revoked'); } };
  await assert.rejects(f.views.release(request, guard, async () => { allowed = false; return { state: 'missing' }; }), /permission revoked/);
  assert.deepEqual(await fs.readFile(path.join(f.base, 'views', 'index.json')), before);
  allowed = true;
  assert.equal((await f.views.release(request, guard, async () => ({ state: 'missing' }))).released, true);
  assert.deepEqual(await f.views.release(request, guard, async () => { throw Error('ACK replay must not resolve again'); }), { released: true, kind: 'pin', id: intent.id });
});

test('an abandoned intent is releasable and collectable when the same worker permanently binds elsewhere', async t => {
  for (const explicitRelease of [true, false]) {
    const f = await fixture(t);
    const a = await f.capture('snapshot-a');
    const input = { ...scope, workerId, workerCreatedAt, snapshotId: a.id, requestId: 'bind-a' };
    await assert.rejects(f.views.bind(input, async () => { throw Error('marker write failed'); }), /marker write failed/);
    const intent = (await f.views.inspect(scope.ownerId, scope.teamId)).pins.find(pin => pin.binding);
    await fs.writeFile(f.file, 'worker B base');
    const b = await f.capture('snapshot-b');
    let marker;
    const active = await f.views.bind({ ...input, snapshotId: b.id, requestId: 'bind-b' }, async value => { marker = value; });
    const present = async () => ({ state: 'present', workerCreatedAt, binding: marker });
    await f.views.release({ ...scope, kind: 'snapshot', id: a.id, requestId: 'release-a' });
    if (explicitRelease) {
      assert.equal((await f.views.release({ ...scope, kind: 'pin', id: intent.id, requestId: 'discard-a' }, undefined, present)).released, true);
    }
    const collected = await f.views.cleanup({ ...scope, requestId: 'cleanup' }, present);
    assert.equal(collected.complete, true);
    assert.deepEqual(collected.deletedSnapshots, [a.id]);
    const state = await f.views.inspect(scope.ownerId, scope.teamId);
    assert.equal(state.pins.some(pin => pin.id === intent.id), false);
    assert.equal(state.overlays.some(overlay => overlay.overlayId === active.overlayId && !overlay.released), true);
    assert.equal(await f.views.withView(marker, { ownerId: scope.ownerId, workerId, workerCreatedAt }, async view => (await view.read('src/a.txt')).bytes.toString()), 'worker B base');
  }
});

test('changes to editor documents rejected by the virtual namespace do not invalidate capture', async t => {
  for (const parentFirst of [true, false]) {
    const f = await fixture(t);
    let queries = 0;
    const manifest = await captureContent(f.root, f.store, {
      openDocuments: () => {
        queries++;
        const parent = { path: path.join(f.root, 'virtual'), text: parentFirst ? 'accepted parent' : `ignored ${queries}`, version: parentFirst ? 1 : queries };
        const child = { path: path.join(f.root, 'virtual', 'child.txt'), text: parentFirst ? `ignored ${queries}` : 'accepted child', version: parentFirst ? queries : 1 };
        return parentFirst ? [parent, child] : [child, parent];
      }
    });
    assert.equal(queries, 4, 'ignored editor churn must not cause retries');
    const key = parentFirst ? 'virtual' : 'virtual/child.txt';
    assert.equal((await f.store.read(manifest.entries[key].hash)).toString(), parentFirst ? 'accepted parent' : 'accepted child');
    if (parentFirst) { assert.equal(manifest.entries['virtual/child.txt'], undefined); }
    else { assert.equal(manifest.entries.virtual.type, 'directory'); }
  }
});

test('editor ordering that changes the accepted namespace is detected even when texts and versions match', async t => {
  const f = await fixture(t);
  let queries = 0;
  const parent = { path: path.join(f.root, 'virtual'), text: 'parent', version: 1 };
  const child = { path: path.join(f.root, 'virtual', 'child.txt'), text: 'child', version: 1 };
  await assert.rejects(captureContent(f.root, f.store, {
    openDocuments: () => ++queries % 2 ? [parent, child] : [child, parent]
  }), { code: 'inconsistent_capture' });
  assert.equal(queries, 6);
});

test('an ignored editor becomes captured after its conflicting document closes during capture', async t => {
  const f = await fixture(t);
  let queries = 0;
  const parent = { path: path.join(f.root, 'virtual'), text: 'closed parent', version: 1 };
  const child = { path: path.join(f.root, 'virtual', 'child.txt'), text: 'newly accepted child', version: 1 };
  const manifest = await captureContent(f.root, f.store, {
    openDocuments: () => ++queries === 1 ? [parent, child] : [child]
  });
  assert.equal(queries, 6, 'the changed accepted namespace must trigger one retry');
  assert.equal(manifest.entries.virtual.type, 'directory');
  assert.equal((await f.store.read(manifest.entries['virtual/child.txt'].hash)).toString(), child.text);
});
