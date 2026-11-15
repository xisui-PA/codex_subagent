// Core project-capture behavior tests (Task 20): real Git and non-Git fixtures,
// exercising captureProject / readProjectContent / ensureProjectRetention /
// releaseProjectRetention against the SAME freshly built .test-build modules.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  captureProject, readProjectContent, ensureProjectRetention, releaseProjectRetention
} = require('../.test-build/project-snapshot');
const { ContentStore } = require('../.test-build/snapshot-content');
const { GitSnapshotObjects } = require('../.test-build/git-snapshot-objects');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const id = label => crypto.createHash('sha256').update(`id:${label}`).digest('hex');
const git = (root, ...args) => spawnSync(
  'git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const gitOk = (root, ...args) => {
  const result = git(root, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

async function makeRepo(name, objectFormat) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), name));
  const root = path.join(base, 'repo');
  const store = path.join(base, 'store');
  await fs.mkdir(root);
  const fmtArgs = objectFormat ? ['--object-format', objectFormat] : [];
  const init = git(root, 'init', '-q', '-b', 'main', ...fmtArgs, '.');
  if (init.status !== 0) { return null; }
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  return { base, root, store };
}

async function write(root, rel, data) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

test('mixed Git capture maps clean blobs to native OIDs and keeps the rest in CAS', async t => {
  const made = await makeRepo('ps-mixed-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  await write(root, 'clean.txt', 'clean original\n');
  await write(root, 'dirty.txt', 'dirty original\n');
  await write(root, 'gone.txt', 'gone original\n');
  await write(root, '.gitignore', 'ignored.txt\n');
  gitOk(root, 'add', '.');
  await fs.writeFile(path.join(root, 'dirty.txt'), 'dirty disk\n');
  await fs.unlink(path.join(root, 'gone.txt'));
  await write(root, 'untracked.txt', 'untracked\n');
  await write(root, 'ignored.txt', 'ignored content\n');
  const cleanHash = sha256('clean original\n');
  const dirtyHash = sha256('dirty editor text\n');
  const ns = id('ns-mixed');
  const storeObj = new ContentStore(store);
  const docs = [
    { path: path.join(root, 'dirty.txt'), text: 'dirty editor text\n', version: 1 },
    { path: path.join(root, 'draft', 'new.txt'), text: 'new draft\n', version: 1 }
  ];
  const openDocs = () => docs;
  const project = await captureProject(root, storeObj, { snapshotId: id('snap-mixed'), namespace: ns, openDocuments: openDocs });
  const e = project.manifest.entries;
  assert.equal(e['clean.txt'].hash, cleanHash);
  assert.ok(Object.hasOwn(project.backing.blobs, cleanHash), 'clean byte-identical maps to native OID');
  assert.equal(await storeObj.has(cleanHash), false, 'clean bytes are not stored in the CAS');
  assert.equal(e['dirty.txt'].hash, dirtyHash);
  assert.ok(!Object.hasOwn(project.backing.blobs, dirtyHash), 'dirty/editor bytes fall to CAS');
  assert.equal(await storeObj.has(dirtyHash), true);
  assert.deepEqual(await storeObj.read(dirtyHash), Buffer.from('dirty editor text\n'));
  const newHash = sha256('new draft\n');
  assert.equal(e['draft/new.txt'].hash, newHash);
  assert.equal(e['draft'].type, 'directory', 'new doc carries its virtual parent directory');
  assert.equal(await storeObj.has(sha256('untracked\n')), true, 'untracked file is CAS-backed');
  assert.ok(!('gone.txt' in e), 'tracked deletion is absent');
  assert.ok(!('ignored.txt' in e), 'ignored file absent under default untracked');
  assert.deepEqual(await readProjectContent(project.backing, storeObj, cleanHash), Buffer.from('clean original\n'));
  // The capture must not have touched the main working tree: the dirty file
  // still holds its ORIGINAL dirty bytes, and the new editor document was
  // never written to the main tree.
  assert.equal(await fs.readFile(path.join(root, 'dirty.txt'), 'utf8'), 'dirty disk\n', 'capture leaves the main dirty file untouched');
  await assert.rejects(fs.access(path.join(root, 'draft', 'new.txt')), { code: 'ENOENT' }, 'capture does not create a new main-tree file');
  // Mutate the main files and the (mutable) editor documents AFTER the capture.
  docs[0].text = 'dirty editor text v2\n';
  docs[0].version = 2;
  docs[1].text = 'new draft v2\n';
  docs[1].version = 2;
  await fs.writeFile(path.join(root, 'clean.txt'), 'clean mutated\n');
  await fs.writeFile(path.join(root, 'dirty.txt'), 'dirty mutated\n');
  assert.deepEqual(await readProjectContent(project.backing, storeObj, cleanHash), Buffer.from('clean original\n'), 'old clean bytes retained');
  assert.deepEqual(await readProjectContent(project.backing, storeObj, dirtyHash), Buffer.from('dirty editor text\n'), 'old editor bytes retained');
});

test('explicit untracked selection includes only the named (possibly ignored) files', async t => {
  const made = await makeRepo('ps-sel-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  await write(root, 'base.txt', 'base\n');
  await write(root, '.gitignore', 'ignored.txt\n');
  gitOk(root, 'add', 'base.txt', '.gitignore');
  await write(root, 'extra.txt', 'extra untracked\n');
  await write(root, 'ignored.txt', 'ignored data\n');
  const ns = id('ns-sel');
  const storeObj = new ContentStore(store);
  const openDocs = () => [{ path: path.join(root, 'newdoc.txt'), text: 'unsaved doc\n', version: 1 }];
  const p1 = await captureProject(root, storeObj, { snapshotId: id('s1'), namespace: ns, selectedUntracked: [], openDocuments: openDocs });
  assert.equal(p1.manifest.entries['base.txt'].type, 'file', 'staged base always included');
  assert.ok(!('extra.txt' in p1.manifest.entries), 'unselected untracked excluded with []');
  assert.ok(!('ignored.txt' in p1.manifest.entries), 'ignored excluded with []');
  assert.equal(p1.manifest.entries['newdoc.txt'].type, 'file', 'eligible unsaved doc included despite []');
  const p2 = await captureProject(root, storeObj, { snapshotId: id('s2'), namespace: ns, selectedUntracked: ['ignored.txt'], openDocuments: openDocs });
  assert.equal(p2.manifest.entries['ignored.txt'].type, 'file', 'named ignored file included');
  assert.ok(!('extra.txt' in p2.manifest.entries), 'ordinary untracked still excluded');
});

test('RAW CRLF bytes are captured byte-exactly with no newline conversion', async t => {
  for (const objectFormat of ['sha1', 'sha256']) {
    const made = await makeRepo(`ps-crlf-${objectFormat}-`, objectFormat);
    if (!made) { t.diagnostic(`git --object-format=${objectFormat} unsupported; skipping`); continue; }
    t.after(() => fs.rm(made.base, { recursive: true, force: true }));
    const { root, store } = made;
    await write(root, 'crlf.txt', 'one\ntwo\n');
    await write(root, 'lf.txt', 'alpha\nbeta\n');
    gitOk(root, 'add', 'crlf.txt', 'lf.txt');
    await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n');
    const crlfHash = sha256('one\r\ntwo\r\n');
    const lfHash = sha256('alpha\nbeta\n');
    const ns = id(`ns-crlf-${objectFormat}`);
    const storeObj = new ContentStore(store);
    const project = await captureProject(root, storeObj, { snapshotId: id('snap-crlf'), namespace: ns });
    assert.equal(project.backing.objectFormat, objectFormat);
    assert.equal(project.manifest.entries['crlf.txt'].hash, crlfHash, 'manifest hash is the raw CRLF SHA-256');
    assert.ok(!Object.hasOwn(project.backing.blobs, crlfHash), 'CRLF differs from the index blob, so it is not git-mapped');
    assert.equal(await storeObj.has(crlfHash), true, 'raw CRLF bytes live in the CAS');
    assert.deepEqual(await readProjectContent(project.backing, storeObj, crlfHash), Buffer.from('one\r\ntwo\r\n'));
    assert.ok(Object.hasOwn(project.backing.blobs, lfHash), 'unchanged LF file is git-mapped');
    assert.equal(await storeObj.has(lfHash), false, 'unchanged LF bytes are not duplicated in the CAS');
    assert.deepEqual(await readProjectContent(project.backing, storeObj, lfHash), Buffer.from('alpha\nbeta\n'));
  }
});

test('beforePublish sees the full candidate before the ref, and rejection leaves it absent', async t => {
  const made = await makeRepo('ps-hook-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  await write(root, 'clean.txt', 'hook clean\n');
  await write(root, 'extra.txt', 'hook extra\n');
  gitOk(root, 'add', 'clean.txt', 'extra.txt');
  const ns = id('ns-hook');
  const snapA = id('snap-hook-a');
  const storeObj = new ContentStore(store);
  const objects = await GitSnapshotObjects.open(root, ns);
  assert.ok(objects);
  const refA = `refs/codex-subagent/${ns}/${snapA}`;
  let savedCandidate = null;
  const beforeA = async candidate => {
    assert.equal(candidate.manifest.schema, 1);
    assert.equal(candidate.backing.kind, 'git');
    assert.equal(candidate.backing.ref, refA);
    assert.ok(candidate.backing.tree.length > 0, 'full backing carries the raw tree OID');
    assert.ok(Object.values(candidate.backing.blobs).length >= 1, 'full backing carries native blobs');
    assert.ok(!(await objects.retained()).some(r => r.ref === refA), 'ref not yet retained inside the hook');
    savedCandidate = JSON.parse(JSON.stringify(candidate));
  };
  await captureProject(root, storeObj, { snapshotId: snapA, namespace: ns, beforePublish: beforeA });
  assert.ok(savedCandidate, 'hook recorded a full candidate');
  assert.ok((await objects.retained()).some(r => r.ref === refA), 'ref created after the hook resolves');
  const snapB = id('snap-hook-b');
  const refB = `refs/codex-subagent/${ns}/${snapB}`;
  let savedB = null;
  // The journal hook must record the FULL candidate (including the exact
  // tree the ref WOULD hold) BEFORE it rejects: this is what real journal
  // recovery persists even though the ref effect never ran.
  const beforeB = async candidate => {
    savedB = JSON.parse(JSON.stringify(candidate));
    throw new Error('journal rejected');
  };
  await assert.rejects(captureProject(root, storeObj, { snapshotId: snapB, namespace: ns, beforePublish: beforeB }), /journal rejected/);
  assert.ok(savedB, 'rejected hook still persisted the full candidate');
  assert.ok(!(await objects.retained()).some(r => r.ref === refB), 'rejected hook leaves its ref absent');
  // Mutate the main files, then re-pin the exact old tree.
  await fs.writeFile(path.join(root, 'clean.txt'), 'hook clean mutated\n');
  await ensureProjectRetention(snapA, savedCandidate.backing);
  assert.deepEqual(await readProjectContent(savedCandidate.backing, storeObj, sha256('hook clean\n')), Buffer.from('hook clean\n'), 'old bytes retained after re-pin');
  // Journal recovery for B proves the REAL missing-ref case, not a replay of
  // an existing A ref: the persisted candidate's ref is still absent, so
  // ensureProjectRetention must CREATE it holding the exact journaled tree.
  assert.ok(!(await objects.retained()).some(r => r.ref === refB), 'B ref is still absent before recovery');
  await ensureProjectRetention(snapB, savedB.backing);
  assert.ok((await objects.retained()).some(r => r.ref === refB && r.tree === savedB.backing.tree), 'recovery created B at the exact journaled tree');
  assert.deepEqual(await readProjectContent(savedB.backing, storeObj, sha256('hook clean\n')), Buffer.from('hook clean\n'), 'B old bytes readable after recovery');
  await releaseProjectRetention(savedB.backing);
  await releaseProjectRetention(savedCandidate.backing);
  const wrongTree = savedCandidate.backing.tree.replace(/^[0-9a-f]/, c => (c === '0' ? '1' : '0'));
  await assert.rejects(ensureProjectRetention(snapA, { ...savedCandidate.backing, tree: wrongTree }), { code: 'idempotency_conflict' });
  assert.ok(!(await objects.retained()).some(r => r.ref === refA), 'tree conflict fired before any ref effect');
});

test('non-Git capture works without git on PATH and fails closed when a CAS blob is removed', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-cas-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  const store = path.join(base, 'store');
  const empty = path.join(base, 'empty');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(empty, { recursive: true });
  await fs.writeFile(path.join(root, 'raw.txt'), 'plain cas\n');
  const storeObj = new ContentStore(store);
  const rawHash = sha256('plain cas\n');
  let sawCasProject = false;
  const openDocs = () => [{ path: path.join(root, 'fresh.txt'), text: 'fresh unsaved\n', version: 1 }];
  const beforePublish = async candidate => { sawCasProject = candidate.backing.kind === 'cas' && candidate.manifest.schema === 1; };
  const originalPath = process.env.PATH;
  process.env.PATH = empty;
  let project;
  try {
    project = await captureProject(root, storeObj, { snapshotId: id('snap-cas'), namespace: id('ns-cas'), openDocuments: openDocs, beforePublish });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(sawCasProject, true, 'beforePublish received a full CAS project');
  assert.equal(project.backing.kind, 'cas');
  assert.equal(project.manifest.entries['raw.txt'].hash, rawHash);
  assert.equal(await storeObj.has(rawHash), true);
  assert.deepEqual(await readProjectContent(project.backing, storeObj, rawHash), Buffer.from('plain cas\n'));
  await fs.writeFile(path.join(root, 'raw.txt'), 'plain cas mutated\n');
  assert.deepEqual(await readProjectContent(project.backing, storeObj, rawHash), Buffer.from('plain cas\n'), 'stable after a live change');
  const blob = path.join(storeObj.directory, 'blobs', rawHash.slice(0, 2), rawHash.slice(2));
  await fs.rm(blob);
  await assert.rejects(readProjectContent(project.backing, storeObj, rawHash), { code: 'snapshot_content_missing' });
  await fs.stat(path.join(root, 'raw.txt'));
});

test('a missing retained Git object fails closed even when the same bytes exist in the CAS', async t => {
  const made = await makeRepo('ps-missing-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  const bytes = 'missing target\n';
  await write(root, 'f.txt', bytes);
  gitOk(root, 'add', 'f.txt');
  const ns = id('ns-missing');
  const storeObj = new ContentStore(store);
  const project = await captureProject(root, storeObj, { snapshotId: id('snap-missing'), namespace: ns });
  const hash = sha256(bytes);
  const oid = project.backing.blobs[hash];
  assert.ok(oid, 'byte-identical file is git-mapped to a native OID');
  await storeObj.put(Buffer.from(bytes));
  assert.equal(await storeObj.has(hash), true, 'the same bytes are also present in the CAS');
  const loose = path.join(project.backing.commonDir, 'objects', oid.slice(0, 2), oid.slice(2));
  assert.equal((await fs.stat(loose)).isFile(), true, 'retained loose object present before removal');
  await fs.rm(loose);
  await assert.rejects(readProjectContent(project.backing, storeObj, hash), { code: 'snapshot_content_missing' }, 'git-mapped read fails closed; no CAS/main fallback');
  await assert.rejects(readProjectContent(project.backing, storeObj, '__proto__'), { code: 'snapshot_content_missing' });
  await assert.rejects(readProjectContent(project.backing, storeObj, 'toString'), { code: 'snapshot_content_missing' });
});

// ---------------------------------------------------------------------------
// Task 21: layout isolation, object borrowing, linked worktrees, real GC
// retention, Windows case collision, and capture-churn consistency.
// ---------------------------------------------------------------------------

/** Run a capture attempt that is expected to fail with a specific WorkerError code. */
async function expectUnsupported(root, store, ns, tag, code = 'isolation_unsupported') {
  const snapId = id(`snap-${tag}`);
  await assert.rejects(
    captureProject(root, store, { snapshotId: snapId, namespace: ns }),
    { code },
    `expected ${code} for ${tag}`
  );
  const objects = await GitSnapshotObjects.open(root, ns);
  assert.ok(objects, 'repo still opens after a rejected capture');
  assert.ok(
    !(await objects.retained()).some(r => r.ref === `refs/codex-subagent/${ns}/${snapId}`),
    'no ref is created for a rejected capture'
  );
  return objects;
}

test('unsupported Git layouts are rejected before publish (restored between cases)', async t => {
  const made = await makeRepo('ps-layout-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  await write(root, 'f.txt', 'layout file\n');
  gitOk(root, 'add', 'f.txt');
  const ns = id('ns-layout');
  const storeObj = new ContentStore(store);
  // Baseline: an ordinary layout captures fine.
  const baseline = await captureProject(root, storeObj, { snapshotId: id('snap-layout-base'), namespace: ns });
  assert.equal(baseline.manifest.entries['f.txt'].type, 'file', 'baseline layout captures');
  const mutations = [
    { tag: 'sparse-checkout-config', apply: async () => gitOk(root, 'config', 'core.sparseCheckout', 'true'),
      revert: async () => gitOk(root, 'config', '--unset', 'core.sparseCheckout') },
    { tag: 'sparse-checkout-bool', apply: async () => {
        const cfg = path.join(root, '.git', 'config');
        await fs.appendFile(cfg, '\n[core]\n\tsparseCheckout = true\n');
      }, revert: async () => gitOk(root, 'config', '--unset', 'core.sparseCheckout') },
    { tag: 'index-skip-worktree', apply: async () => gitOk(root, 'update-index', '--skip-worktree', 'f.txt'),
      revert: async () => gitOk(root, 'update-index', '--no-skip-worktree', 'f.txt') },
    { tag: 'index-assume-skip', apply: async () => {
        gitOk(root, 'update-index', '--assume-unchanged', 'f.txt');
        gitOk(root, 'update-index', '--skip-worktree', 'f.txt');
      }, revert: async () => {
        gitOk(root, 'update-index', '--no-assume-unchanged', 'f.txt');
        gitOk(root, 'update-index', '--no-skip-worktree', 'f.txt');
      } },
    { tag: 'partial-clone', apply: async () => gitOk(root, 'config', 'extensions.partialClone', 'origin'),
      revert: async () => gitOk(root, 'config', '--unset', 'extensions.partialClone') },
    { tag: 'promisor-remote', apply: async () => gitOk(root, 'config', 'remote.origin.promisor', 'true'),
      revert: async () => gitOk(root, 'config', '--unset', 'remote.origin.promisor') },
    { tag: 'promisor-pack', apply: async () => {
        await fs.mkdir(path.join(root, '.git', 'objects', 'pack'), { recursive: true });
        await fs.writeFile(path.join(root, '.git', 'objects', 'pack', 'pack-fake-0.pack.promisor'), '');
      }, revert: async () => fs.rm(path.join(root, '.git', 'objects', 'pack', 'pack-fake-0.pack.promisor')) },
    { tag: 'alternates', apply: async () => {
        await fs.mkdir(path.join(root, '.git', 'objects', 'info'), { recursive: true });
        await fs.writeFile(path.join(root, '.git', 'objects', 'info', 'alternates'), '');
      }, revert: async () => fs.rm(path.join(root, '.git', 'objects', 'info', 'alternates')) },
    { tag: 'sparse-checkout-file', apply: async () => {
        await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
        await fs.writeFile(path.join(root, '.git', 'info', 'sparse-checkout'), '*\n');
      }, revert: async () => fs.rm(path.join(root, '.git', 'info', 'sparse-checkout')) }
  ];
  for (const m of mutations) {
    await m.apply();
    try {
      await expectUnsupported(root, storeObj, ns, m.tag);
    } finally {
      await m.revert();
    }
  }
  // The ordinary assume-unchanged flag alone must still capture (h, not S/s).
  gitOk(root, 'update-index', '--assume-unchanged', 'f.txt');
  try {
    const positive = await captureProject(root, storeObj, { snapshotId: id('snap-layout-h'), namespace: ns });
    assert.equal(positive.manifest.entries['f.txt'].type, 'file', 'assume-unchanged (h) still captures');
  } finally {
    gitOk(root, 'update-index', '--no-assume-unchanged', 'f.txt');
  }
});

test('borrowed objects directory (symlink/junction) is rejected; own refs cannot protect a foreign owner', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-borrow-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const store = path.join(base, 'store');
  await fs.mkdir(root);
  gitOk(root, 'init', '-q', '-b', 'main', '.');
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  await write(root, 'f.txt', 'borrowed test\n');
  gitOk(root, 'add', 'f.txt');
  const ns = id('ns-borrow');
  const storeObj = new ContentStore(store);
  const objectsHome = path.join(root, '.git', 'objects');
  const borrowedHome = path.join(base, 'borrowed-objects');
  await fs.rename(objectsHome, borrowedHome);
  const original = path.join(root, '.git', 'objects');
  let linked = false;
  try {
    await fs.symlink(borrowedHome, original, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    // Some environments cannot create a junction/dir symlink here.
    await fs.rename(borrowedHome, objectsHome);
  }
  const restoreObjects = async () => {
    try {
      await fs.lstat(borrowedHome);
      await fs.rename(borrowedHome, objectsHome);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') { throw error; }
    }
  };
  try {
    if (!linked) {
      t.skip('This host cannot create an objects-directory symlink/junction.');
      return;
    }
    const info = await fs.lstat(original);
    assert.ok(info.isSymbolicLink() || info.isDirectory(), 'objects path replaced');
    await expectUnsupported(root, storeObj, ns, 'borrowed-objects');
  } finally {
    // Restore the real directory so the fixture is cleaned up cleanly.
    if (linked) {
      await fs.unlink(original);
    }
    await restoreObjects();
  }
});

test('linked worktree capture uses the linked index; the common dir survives worktree removal', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-wt-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  const store = path.join(base, 'store');
  await fs.mkdir(root);
  gitOk(root, 'init', '-q', '-b', 'main', '.');
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  await write(root, 'seed.txt', 'seed\n');
  gitOk(root, 'add', 'seed.txt');
  gitOk(root, 'commit', '-q', '-m', 'seed');
  gitOk(root, 'worktree', 'add', '-q', linked, '-b', 'side');
  // Stage distinct files in each worktree index (each index is independent).
  await write(root, 'mainOnly.txt', 'main only\n');
  gitOk(root, 'add', 'mainOnly.txt');
  await write(linked, 'linkedOnly.txt', 'linked only\n');
  gitOk(linked, 'add', 'linkedOnly.txt');
  const ns = id('ns-wt');
  const storeObj = new ContentStore(store);
  const project = await captureProject(linked, storeObj, { snapshotId: id('snap-wt'), namespace: ns, selectedUntracked: [] });
  const e = project.manifest.entries;
  assert.equal(e['linkedOnly.txt'].type, 'file', 'linked index file is present');
  assert.ok(Object.hasOwn(project.backing.blobs, e['linkedOnly.txt'].hash), 'linked file is git-mapped, not CAS');
  assert.ok(!('mainOnly.txt' in e), 'main index file is absent from the linked capture');
  const commonDir = project.backing.commonDir;
  const backing = JSON.parse(JSON.stringify(project.backing));
  // Remove the linked worktree: object and ref operations must still work.
  gitOk(root, 'worktree', 'remove', '--force', linked);
  assert.deepEqual(
    await readProjectContent(backing, storeObj, e['linkedOnly.txt'].hash),
    Buffer.from('linked only\n'),
    'read works through the common dir after worktree removal'
  );
  await ensureProjectRetention(id('snap-wt'), backing);
  await releaseProjectRetention(backing);
  // GitSnapshotObjects.reopen is object-only: selection() must refuse.
  const reopened = await GitSnapshotObjects.reopen(commonDir, backing.objectFormat, ns);
  await assert.rejects(reopened.selection(), { code: 'isolation_unsupported' });
});

test('real gc: pinned blobs survive prune, release then prune makes them snapshot_content_missing', async t => {
  const made = await makeRepo('ps-gc-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  const bytes = 'gc pinned payload\n';
  await write(root, 'pinned.txt', bytes);
  gitOk(root, 'add', 'pinned.txt');
  const ns = id('ns-gc');
  const storeObj = new ContentStore(store);
  const project = await captureProject(root, storeObj, { snapshotId: id('snap-gc'), namespace: ns });
  const hash = sha256(bytes);
  const oid = project.backing.blobs[hash];
  assert.ok(oid, 'byte-identical file is git-mapped');
  const backing = JSON.parse(JSON.stringify(project.backing));
  // Clear the index so nothing else references the blob; expire reflogs.
  gitOk(root, 'read-tree', '--empty');
  gitOk(root, 'reflog', 'expire', '--expire=now', '--all');
  // The snapshot ref still pins the blob, so gc must not prune it.
  gitOk(root, 'gc', '--prune=now');
  assert.deepEqual(
    await readProjectContent(backing, storeObj, hash),
    Buffer.from(bytes),
    'pinned blob survives gc while the ref exists'
  );
  await releaseProjectRetention(backing);
  gitOk(root, 'reflog', 'expire', '--expire=now', '--all');
  gitOk(root, 'gc', '--prune=now');
  await assert.rejects(
    readProjectContent(backing, storeObj, hash),
    { code: 'snapshot_content_missing' },
    'after release+gc the blob is pruned; read fails closed with no fallback'
  );
  assert.equal(await fs.stat(path.join(root, 'pinned.txt')).then(s => s.isFile()), true, 'main file still exists on disk');
});

test('Windows index case collision: two index names mapping to the same file are rejected', async t => {
  if (process.platform !== 'win32') {
    t.diagnostic('case collision test is Windows-only; skipped on POSIX');
    return;
  }
  const made = await makeRepo('ps-case-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  const name = 'Name.txt';
  const nameLower = name.toLowerCase();
  await write(root, name, 'case file\n');
  gitOk(root, 'add', name);
  const ns = id('ns-case');
  const storeObj = new ContentStore(store);
  // With core.ignorecase=false, git permits adding a second index entry that
  // differs only by case and points at the same OID.
  gitOk(root, 'config', 'core.ignorecase', 'false');
  const oid = gitOk(root, 'ls-files', '--stage', name).trim().split(/\s+/)[1];
  gitOk(root, 'update-index', '--add', '--cacheinfo', `100644,${oid},${nameLower}`);
  const both = gitOk(root, 'ls-files').split('\n');
  assert.ok(both.some(line => line === name), 'Name.txt is in the index');
  assert.ok(both.some(line => line === nameLower), 'name.txt (lower) is in the index');
  await assert.rejects(
    captureProject(root, storeObj, { snapshotId: id('snap-case'), namespace: ns }),
    { code: 'snapshot_case_conflict' },
    'case collision must be rejected, never silently folded'
  );
  const objects = await GitSnapshotObjects.open(root, ns);
  assert.ok(objects);
  assert.ok(!(await objects.retained()).length, 'no ref is created for a case-conflict capture');
});

test('capture churn: a staged OID toggle or a layout flip between scans is inconsistent_capture', async t => {
  const made = await makeRepo('ps-churn-');
  t.after(() => fs.rm(made.base, { recursive: true, force: true }));
  const { root, store } = made;
  await write(root, 'f.txt', 'churn file\n');
  gitOk(root, 'add', 'f.txt');
  const ns = id('ns-churn');
  const storeObj = new ContentStore(store);
  // Two distinct blobs: alternating the staged OID in afterScan() makes the
  // index fingerprint differ between the two selection re-queries of every
  // attempt, so the capture can never settle. The working-tree bytes are left
  // untouched throughout (only the index entry changes).
  const hashBlob = text => spawnSync(
    'git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: text, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).stdout.trim();
  const oidA = hashBlob('churn A\n');
  const oidB = hashBlob('churn B\n');
  assert.notEqual(oidA, oidB, 'two distinct staged OIDs are available');
  let attempts = 0;
  const flipAfterScan = async () => {
    attempts += 1;
    const oid = attempts % 2 ? oidA : oidB;
    gitOk(root, 'update-index', '--add', '--cacheinfo', `100644,${oid},f.txt`);
  };
  await assert.rejects(
    captureProject(root, storeObj, { snapshotId: id('snap-churn-a'), namespace: ns, afterScan: flipAfterScan }),
    { code: 'inconsistent_capture' },
    'a perpetually changing index is inconsistent, not a fresh layout'
  );
  assert.equal(attempts, 3, 'churn is retried maxAttempts (3) times');
  assert.equal(await fs.readFile(path.join(root, 'f.txt'), 'utf8'), 'churn file\n', 'working-tree bytes are unchanged by the index churn');
  const objects = await GitSnapshotObjects.open(root, ns);
  assert.ok(objects);
  assert.ok(!(await objects.retained()).length, 'no ref is created for a churned capture');
  // Layout flip: a supported layout toggled to unsupported between the two
  // selection boundaries inside a single attempt. afterScan() runs between
  // selection boundary 2 and boundary 3, so flipping here makes the re-query
  // at boundary 3 hit the unsupported layout and report inconsistent_capture
  // rather than a fresh isolation_unsupported (and it is not retried).
  gitOk(root, 'update-index', '--chmod=-x', 'f.txt');
  const flipLayout = async () => {
    gitOk(root, 'config', 'core.sparseCheckout', 'true');
  };
  try {
    await assert.rejects(
      captureProject(root, storeObj, { snapshotId: id('snap-churn-b'), namespace: ns, afterScan: flipLayout }),
      { code: 'inconsistent_capture' },
      'a layout flip during capture is inconsistent_capture, not isolation_unsupported'
    );
  } finally {
    gitOk(root, 'config', '--unset', 'core.sparseCheckout');
  }
  assert.equal((await (await GitSnapshotObjects.open(root, ns)).retained()).length, 0, 'still no ref after the layout flip');
});
