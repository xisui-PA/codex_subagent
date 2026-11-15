// Git snapshot object retention tests.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { GitSnapshotObjects } = require('../.test-build/git-snapshot-objects');

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const gitOk = (root, ...args) => {
  const result = git(root, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

async function makeRepo(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  gitOk(root, 'init', '-q', '-b', 'main', '.');
  gitOk(root, 'config', 'user.email', 'test@example.com');
  gitOk(root, 'config', 'user.name', 'Test User');
  gitOk(root, 'config', 'core.autocrlf', 'false');
  return root;
}

async function makeObjects(root, ns) {
  const objects = await GitSnapshotObjects.open(root, ns);
  assert.ok(objects, 'expected a Git root');
  return objects;
}

async function write(root, rel, data) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

test('open discovers the common git dir, canonical paths, and worktrees; non-Git is undefined', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gso-parent-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const main = path.join(parent, 'main');
  await fs.mkdir(main, { recursive: true });
  gitOk(main, 'init', '-q', '-b', 'main', '.');
  gitOk(main, 'config', 'user.email', 'a@b');
  gitOk(main, 'config', 'user.name', 'A');
  await fs.writeFile(path.join(main, 'a.txt'), 'a');
  gitOk(main, 'add', '.');
  gitOk(main, 'commit', '-q', '-m', 'one');
  const wt = path.join(parent, 'wt');
  gitOk(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  const ns = sha256('store');
  const mainOb = await GitSnapshotObjects.open(main, ns);
  assert.ok(mainOb);
  assert.equal(mainOb.objectFormat, 'sha1');
  assert.equal(mainOb.gitDir, path.join(main, '.git'));
  assert.equal(mainOb.root, path.resolve(main));
  const wtOb = await GitSnapshotObjects.open(wt, ns);
  assert.ok(wtOb);
  assert.ok(wtOb.gitDir.startsWith(mainOb.gitDir + path.sep + 'worktrees'), 'worktree git dir lives under the common dir');
  assert.equal(wtOb.root, path.resolve(wt));
  // Both views operate on the shared object store.
  const blob = Buffer.from('a');
  assert.equal(wtOb.matches(gitOk(main, 'hash-object', '-w', 'a.txt').trim(), blob), true);
  const plain = path.join(parent, 'plain');
  await fs.mkdir(plain);
  assert.equal(await GitSnapshotObjects.open(plain, ns), undefined, 'non-Git root must be undefined');
  await assert.rejects(GitSnapshotObjects.open(main, 'nope'), { code: 'git_selection_path' });
});

test('selection covers staged, dirty, untracked, ignored and deleted paths without mutating index', async t => {
  const root = await makeRepo('gso-sel-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, 'staged.txt', 'staged');
  gitOk(root, 'add', 'staged.txt');
  await write(root, 'dirty.txt', 'dirty on disk');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await write(root, 'ignored.txt', 'ignored');
  await write(root, 'space name.txt', 'with space');
  await write(root, 'inner/nested.txt', 'nested');
  const objects = await makeObjects(root, sha256('store-a'));
  const firstIndex = await fs.readFile(path.join(root, '.git', 'index'));
  const firstHead = await fs.readFile(path.join(root, '.git', 'HEAD'));
  const first = await objects.selection();
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), firstIndex, 'selection must not touch the index');
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'HEAD')), firstHead);
  assert.equal(first.head, null, 'unborn HEAD allowed');
  const staged = first.tracked.find(e => e.path === 'staged.txt');
  assert.ok(staged);
  assert.equal(staged.stage, 0);
  assert.equal(staged.mode, '100644');
  assert.ok(objects.matches(staged.oid, Buffer.from('staged')), 'raw LF content must match without filters');
  const names = first.untracked;
  assert.ok(names.includes('dirty.txt'));
  assert.ok(names.includes('space name.txt'));
  assert.ok(names.includes('inner/nested.txt'));
  assert.ok(!names.includes('ignored.txt'), 'ignored files stay out by default');
  assert.ok(!names.includes('staged.txt'));
  const fingerprint = first.fingerprint;
  gitOk(root, 'commit', '-q', '-m', 'first');
  const secondIndex = await fs.readFile(path.join(root, '.git', 'index'));
  const secondHead = await fs.readFile(path.join(root, '.git', 'HEAD'));
  const second = await objects.selection();
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), secondIndex, 'selection must not touch the index');
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'HEAD')), secondHead);
  assert.notEqual(second.head, null);
  assert.notEqual(second.fingerprint, fingerprint, 'fingerprint tracks HEAD and index entries');
  // Working tree churn without staging must not change the fingerprint.
  await write(root, 'dirty.txt', 'changed');
  const third = await objects.selection();
  assert.equal(third.fingerprint, second.fingerprint, 'workspace content is out of scope');
  // Selected untracked may include ignored files, deduped, validated, and the
  // selection is what the returned untracked list actually contains.
  const withIgnored = await objects.selection(['ignored.txt', './ignored.txt', path.join('ignored.txt')]);
  assert.deepEqual([...withIgnored.untracked], ['ignored.txt'], 'the selected ignored file is returned');
  assert.ok(withIgnored.fingerprint !== second.fingerprint, 'selected list is part of the fingerprint');
  const sameSelection = await objects.selection(['ignored.txt']);
  assert.equal(sameSelection.fingerprint, withIgnored.fingerprint, 'dedupe keeps one entry');
  // [] explicitly selects nothing, even though untracked files exist.
  const noneSelected = await objects.selection([]);
  assert.deepEqual([...noneSelected.untracked], []);
  assert.notEqual(noneSelected.fingerprint, second.fingerprint, 'explicit empty selection is fingerprinted');
  // Adding one more untracked name changes the fingerprint.
  await write(root, 'untracked-two.txt', 'two');
  const extended = await objects.selection(['ignored.txt', 'untracked-two.txt']);
  assert.deepEqual([...extended.untracked], ['ignored.txt', 'untracked-two.txt']);
  assert.notEqual(extended.fingerprint, withIgnored.fingerprint, 'a new untracked name changes the fingerprint');
  // Tracked names are excluded from a selection.
  const trackedSelection = await objects.selection(['staged.txt', 'ignored.txt']);
  assert.deepEqual([...trackedSelection.untracked], ['ignored.txt'], 'tracked paths are excluded from the selection');
  await assert.rejects(objects.selection(['../escape.txt']), { code: 'git_selection_path' });
  await assert.rejects(objects.selection(['missing.txt']), { code: 'git_selection_path' });
  await assert.rejects(objects.selection(['ignored.txt', 'a'.repeat(4100)]), { code: 'git_selection_path' });
});

test('matches is raw-byte only: LF and CRLF never alias, wrong oid rejected', async t => {
  const root = await makeRepo('gso-matches-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lf = Buffer.from('line one\nline two\n');
  const crlf = Buffer.from('line one\r\nline two\r\n');
  const objects = await makeObjects(root, sha256('store-b'));
  await fs.writeFile(path.join(root, 'lf.txt'), lf);
  const lfOid = gitOk(root, 'hash-object', '-w', 'lf.txt').trim();
  await fs.writeFile(path.join(root, 'crlf.txt'), crlf);
  const crlfOid = gitOk(root, 'hash-object', '-w', 'crlf.txt').trim();
  assert.notEqual(lfOid, crlfOid);
  assert.equal(objects.matches(lfOid, lf), true);
  assert.equal(objects.matches(lfOid, crlf), false, 'CRLF bytes are not reusable for the LF oid');
  assert.equal(objects.matches(crlfOid, crlf), true);
  assert.equal(objects.matches(crlfOid, lf), false);
  assert.equal(objects.matches(lfOid, Buffer.from('line one\nline two\nx')), false);
  assert.equal(objects.matches('nope', lf), false);
  assert.equal(objects.matches(lfOid.toUpperCase(), lf), false);
});

test('read verifies raw SHA-256, rejects missing/corrupt/short blobs, never falls back', async t => {
  const root = await makeRepo('gso-read-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = await makeObjects(root, sha256('store-c'));
  const body = Buffer.from('blob body \0 binary \xff');
  await fs.writeFile(path.join(root, 'blob.bin'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'blob.bin').trim();
  assert.deepEqual(await objects.read(oid, sha256(body)), body);
  await assert.rejects(objects.read(oid, sha256('wrong')), { code: 'snapshot_content_missing', message: /hash verification/ });
  const missing = 'a'.repeat(40);
  await assert.rejects(objects.read(missing, sha256('x')), { code: 'snapshot_content_missing' });
  await assert.rejects(objects.read('xyz', sha256('x')), { code: 'git_selection_path' });
  await assert.rejects(objects.read(oid, 'short'), { code: 'git_selection_path' });
});

test('retain pins blobs that survive gc, is idempotent, conflicts, and refuses foreign refs', async t => {
  const root = await makeRepo('gso-retain-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-d');
  const objects = await makeObjects(root, ns);
  const a = Buffer.from('alpha payload');
  const b = Buffer.from('beta payload');
  await fs.writeFile(path.join(root, 'a.txt'), a);
  await fs.writeFile(path.join(root, 'b.txt'), b);
  const oidA = gitOk(root, 'hash-object', '-w', 'a.txt').trim();
  const oidB = gitOk(root, 'hash-object', '-w', 'b.txt').trim();
  const id = sha256('snapshot-1');
  const record = await objects.retain(id, [oidA, oidB, oidA]);
  assert.equal(record.ref, `refs/codex-subagent/${ns}/${id}`);
  assert.match(record.tree, /^[0-9a-f]{40}$/, 'sha1 repository reports the native 40-hex tree oid');
  assert.equal(gitOk(root, 'rev-parse', record.ref).trim(), record.tree, 'tree must equal the actual git rev-parse of the ref');
  // The blobs are unreferenced by any user ref; gc must not prune them.
  gitOk(root, 'gc', '--prune=now');
  assert.deepEqual(await objects.read(oidA, sha256(a)), a);
  assert.deepEqual(await objects.read(oidB, sha256(b)), b);
  // Same id + same tree replays.
  assert.deepEqual(await objects.retain(id, [oidB, oidA]), record);
  // Conflicting tree for the same id.
  await assert.rejects(objects.retain(id, [oidA]), { code: 'idempotency_conflict' });
  // A different snapshot id pins its own tree.
  const id2 = sha256('snapshot-2');
  const record2 = await objects.retain(id2, [oidA]);
  assert.notEqual(record2.tree, record.tree);
  // Empty blob set pins an empty tree.
  const empty = await objects.retain(sha256('empty'), []);
  assert.match(empty.tree, /^[0-9a-f]{40}$/);
  assert.equal(gitOk(root, 'rev-parse', empty.ref).trim(), empty.tree);
  // Invalid inputs.
  await assert.rejects(objects.retain('short', [oidA]), { code: 'git_selection_path' });
  await assert.rejects(objects.retain(sha256('x'), ['nope']), { code: 'git_selection_path' });
  await assert.rejects(objects.retain(sha256('x'), [sha256('not-a-blob')]), { code: 'git_selection_path' });
  // Guard aborts before the ref is created.
  const deadId = sha256('guard-dead');
  const guard = () => { throw new Error('host closing'); };
  await assert.rejects(objects.retain(deadId, [oidA], guard), { message: /host closing/ });
  assert.equal((await objects.retained()).some(r => r.ref.endsWith(deadId)), false);
  // Retained list, then reopen discovers it (recovery).
  const listing = await objects.retained();
  assert.deepEqual(listing.map(r => [r.ref, r.tree]).sort(), [[record.ref, record.tree], [record2.ref, record2.tree], [empty.ref, empty.tree]].sort());
  const reopened = await makeObjects(root, ns);
  assert.deepEqual((await reopened.retained()).length, 3);
  assert.deepEqual(await reopened.read(oidA, sha256(a)), a);
  // A foreign ref under our prefix must never be overwritten or released.
  const foreignId = sha256('foreign');
  const foreignRef = `refs/codex-subagent/${ns}/${foreignId}`;
  // Empty mktree input is plain EOF on stdin.
  const foreignTreeOid = gitOk(root, 'mktree').trim();
  gitOk(root, 'update-ref', foreignRef, foreignTreeOid);
  await assert.rejects(objects.retain(foreignId, [oidA]), { code: 'idempotency_conflict' });
  assert.equal(gitOk(root, 'rev-parse', foreignRef).trim(), foreignTreeOid, 'foreign ref must be untouched');
  await assert.rejects(objects.release(foreignRef, record.tree), { code: 'idempotency_conflict' });
  assert.equal(gitOk(root, 'rev-parse', foreignRef).trim(), foreignTreeOid, 'foreign ref must survive release refusal');
  // Release exact match is idempotent; release after release is a no-op.
  const gid = sha256('guard-ok');
  const gRecord = await objects.retain(gid, [oidB]);
  await objects.release(gRecord.ref, gRecord.tree, () => {});
  await objects.release(gRecord.ref, gRecord.tree, () => {});
  await assert.rejects(objects.release(gRecord.ref, 'b'.repeat(64)), { code: 'idempotency_conflict' });
  await assert.rejects(objects.release('refs/heads/main', record.tree), { code: 'idempotency_conflict' });
  await assert.rejects(objects.release(`refs/codex-subagent/${ns}/000000000000000000000000000000000000000000000000000000000000000g`), { code: 'idempotency_conflict' });
});

test('release then gc prunes the blob and read fails with snapshot_content_missing', async t => {
  const root = await makeRepo('gso-release-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-e');
  const objects = await makeObjects(root, ns);
  const body = Buffer.from('dying blob');
  await fs.writeFile(path.join(root, 'dying.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'dying.txt').trim();
  const id = sha256('snapshot-dying');
  const record = await objects.retain(id, [oid]);
  assert.deepEqual(await objects.read(oid, sha256(body)), body);
  await objects.release(record.ref, record.tree);
  assert.equal((await objects.retained()).length, 0);
  gitOk(root, 'gc', '--prune=now');
  await assert.rejects(objects.read(oid, sha256(body)), { code: 'snapshot_content_missing' });
});

test('worktree selection uses the worktree index and shares the common dir', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gso-wt-sel-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const main = path.join(parent, 'main');
  await fs.mkdir(main, { recursive: true });
  gitOk(main, 'init', '-q', '-b', 'main', '.');
  gitOk(main, 'config', 'user.email', 'a@b');
  gitOk(main, 'config', 'user.name', 'A');
  await fs.writeFile(path.join(main, 'a.txt'), 'a');
  gitOk(main, 'add', '.');
  gitOk(main, 'commit', '-q', '-m', 'one');
  const wt = path.join(parent, 'wt');
  gitOk(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  // Distinct staged content in the worktree index only (no commit).
  await fs.writeFile(path.join(wt, 'side-only.txt'), 'worktree staged content');
  gitOk(wt, 'add', 'side-only.txt');
  const ns = sha256('store-wt');
  const mainOb = await GitSnapshotObjects.open(main, ns);
  const wtOb = await GitSnapshotObjects.open(wt, ns);
  assert.ok(mainOb && wtOb);
  assert.equal(wtOb.commonDir, mainOb.commonDir, 'linked worktree shares the common dir');
  const wtIndexBefore = await fs.readFile(path.join(wtOb.gitDir, 'index'));
  const wtSelection = await wtOb.selection();
  assert.deepEqual(await fs.readFile(path.join(wtOb.gitDir, 'index')), wtIndexBefore, 'worktree index untouched');
  const staged = wtSelection.tracked.find(e => e.path === 'side-only.txt');
  assert.ok(staged, 'worktree staged entry is visible from the worktree view');
  assert.ok(wtOb.matches(staged.oid, Buffer.from('worktree staged content')));
  assert.equal(wtSelection.head, gitOk(wt, 'rev-parse', 'HEAD').trim(), 'HEAD is the worktree branch tip');
  // The main worktree index does not contain the worktree-only staged file.
  const mainSelection = await mainOb.selection();
  assert.equal(mainSelection.tracked.some(e => e.path === 'side-only.txt'), false, 'main index is distinct from the worktree index');
});

test('ambient GIT env vars cannot redirect selection', async t => {
  const decoy = await makeRepo('gso-decoy-');
  const root = await makeRepo('gso-ambient-');
  t.after(() => fs.rm(decoy, { recursive: true, force: true }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(decoy, 'decoy.txt'), 'decoy');
  gitOk(decoy, 'add', 'decoy.txt');
  gitOk(decoy, 'commit', '-q', '-m', 'decoy commit');
  await write(root, 'real.txt', 'real');
  gitOk(root, 'add', 'real.txt');
  gitOk(root, 'commit', '-q', '-m', 'real commit');
  const expectedHead = gitOk(root, 'rev-parse', 'HEAD').trim();
  const objects = await makeObjects(root, sha256('store-amb'));
  const saved = {};
  const ambient = {
    GIT_DIR: path.join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
    GIT_NAMESPACE: 'ambience'
  };
  try {
    for (const [key, value] of Object.entries(ambient)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    const selection = await objects.selection();
    assert.equal(selection.tracked.some(e => e.path === 'decoy.txt'), false, 'decoy repo must not leak in');
    assert.ok(selection.tracked.some(e => e.path === 'real.txt'), 'requested repo index is used');
    assert.equal(selection.head, expectedHead, 'requested repo HEAD is used');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
  }
});

test('subdirectory root is isolation_unsupported; unsafe and symlinked selected paths are rejected', async t => {
  const root = await makeRepo('gso-sub-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sub'));
  await assert.rejects(GitSnapshotObjects.open(path.join(root, 'sub'), sha256('store-sub')), { code: 'isolation_unsupported' });
  const objects = await makeObjects(root, sha256('store-sub'));
  await write(root, 'real.txt', 'real');
  // Unsafe portable forms.
  for (const bad of ['real.txt:stream', 'C:evil.txt', 'back\\slash.txt', 'trailing .txt', 'n u l', '../up.txt', 'dir/./real.txt']) {
    await assert.rejects(objects.selection([bad]), { code: 'git_selection_path' }, `rejects ${bad}`);
  }
  // Existing but unsafe: symlink to a file and through a symlinked directory.
  let realSymlink = false;
  try {
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
    realSymlink = true;
    await assert.rejects(objects.selection(['link.txt']), { code: 'git_selection_path' }, 'symlinked file is rejected');
    const other = path.join(root, 'realdir');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'f.txt'), 'f');
    const linkName = path.join(root, 'linkdir');
    try {
      if (process.platform === 'win32') {
        await fs.symlink(other, linkName, 'junction');
      } else {
        await fs.symlink(other, linkName, 'dir');
      }
    } catch {
      realSymlink = false; // symlink creation unsupported in this environment
    }
    if (realSymlink) {
      await assert.rejects(objects.selection(['linkdir/f.txt']), { code: 'git_selection_path' }, 'symlinked parent directory is rejected');
    }
  } catch (error) {
    if (error.code !== 'ENOSYS' && error.code !== 'EPERM' && error.code !== 'EACCES') { throw error; }
    t.diagnostic('symlink creation unsupported; symlink rejection not exercised');
  }
  // A plain existing file is accepted and returned.
  const ok = await objects.selection(['real.txt']);
  assert.deepEqual([...ok.untracked], ['real.txt']);
});

test('sha256 object-format repository opens and matches when supported', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gso-sha256-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root, { recursive: true });
  const init = spawnSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', '.'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (init.status !== 0) {
    t.diagnostic('git does not support --object-format=sha256; skipping');
    return;
  }
  gitOk(root, 'config', 'user.email', 'a@b');
  gitOk(root, 'config', 'user.name', 'A');
  const objects = await GitSnapshotObjects.open(root, sha256('store-sha256'));
  assert.ok(objects, 'expected a Git root');
  assert.equal(objects.objectFormat, 'sha256');
  assert.equal(gitOk(root, 'rev-parse', '--show-object-format').trim(), 'sha256');
  const body = Buffer.from('sha256 payload');
  await fs.writeFile(path.join(root, 's.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 's.txt').trim();
  assert.match(oid, /^[0-9a-f]{64}$/);
  assert.equal(objects.matches(oid, body), true, 'sha256 raw-byte match');
  assert.equal(objects.matches(oid, Buffer.from('x')), false);
  // retain reports the RAW native sha256 tree oid, equal to rev-parse.
  const record = await objects.retain(sha256('snapshot-256'), [oid]);
  assert.match(record.tree, /^[0-9a-f]{64}$/);
  assert.equal(gitOk(root, 'rev-parse', record.ref).trim(), record.tree);
  assert.notEqual(record.tree, sha256(`sha256:${record.tree}`), 'never a SHA-256 over format:oid');
});

test('release refuses symbolic snapshot refs; foreign target and dangling symrefs are never touched', async t => {
  const root = await makeRepo('gso-symref-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-sym');
  const objects = await makeObjects(root, ns);
  const body = Buffer.from('symbol payload');
  await fs.writeFile(path.join(root, 'sym.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'sym.txt').trim();
  // A foreign tag that happens to hold the same tree we would expect.
  const foreign = await objects.retain(sha256('foreign-holder'), [oid]);
  const tagRef = 'refs/tags/foreign';
  gitOk(root, 'update-ref', tagRef, foreign.tree);
  // 1) Snapshot ref is a symref to the FOREIGN tag at the exact expected tree.
  const symId = sha256('symref-holder');
  const symRef = `refs/codex-subagent/${sha256('store-sym')}/${symId}`;
  gitOk(root, 'symbolic-ref', symRef, tagRef);
  await assert.rejects(objects.release(symRef, foreign.tree), { code: 'idempotency_conflict', message: /symbolic/ });
  assert.equal(gitOk(root, 'symbolic-ref', '-q', symRef).trim(), tagRef, 'symref itself survives');
  assert.equal(gitOk(root, 'rev-parse', tagRef).trim(), foreign.tree, 'foreign target must be untouched');
  // retain onto the same symref name also refuses (even with a matching tree).
  await assert.rejects(objects.retain(symId, [oid]), { code: 'idempotency_conflict' });
  assert.equal(gitOk(root, 'symbolic-ref', '-q', symRef).trim(), tagRef);
  // 2) Dangling symref: its target does not exist, so for-each-ref may miss it.
  const dangId = sha256('dangling');
  const dangRef = `refs/codex-subagent/${sha256('store-sym')}/${dangId}`;
  gitOk(root, 'symbolic-ref', dangRef, 'refs/tags/nowhere');
  await assert.rejects(objects.release(dangRef, foreign.tree), { code: 'idempotency_conflict', message: /symbolic/ });
  assert.equal(gitOk(root, 'symbolic-ref', '-q', dangRef).trim(), 'refs/tags/nowhere', 'dangling symref survives');
  // 3) A direct tree ref still releases normally afterwards.
  await objects.release(foreign.ref, foreign.tree);
  assert.equal(git(root, 'rev-parse', '--verify', '--quiet', foreign.ref).status, 1, 'direct ref released');
  // The two symrefs still occupy exact leaves; retained() fails closed on
  // them (correct), so clean them up and confirm the namespace is empty.
  await assert.rejects(objects.retained(), { code: 'idempotency_conflict', message: /symbolic/ });
  gitOk(root, 'update-ref', '-d', symRef);
  gitOk(root, 'update-ref', '-d', dangRef);
  assert.deepEqual(await objects.retained(), []);
});

test('exact-name lookup never mistakes a descendant ref for the ref itself', async t => {
  const root = await makeRepo('gso-desc-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-desc');
  const objects = await makeObjects(root, ns);
  const body = Buffer.from('desc payload');
  await fs.writeFile(path.join(root, 'd.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'd.txt').trim();
  const baseId = sha256('desc-base');
  const baseRef = `refs/codex-subagent/${ns}/${baseId}`;
  const childRef = `${baseRef}/child`;
  const otherTree = gitOk(root, 'mktree', []).trim();
  gitOk(root, 'update-ref', childRef, otherTree);
  // The base name is ABSENT while a descendant exists: release by exact name
  // is a no-op and the descendant survives (a prefix lookup would have hit it).
  await objects.release(baseRef, otherTree);
  assert.equal(gitOk(root, 'rev-parse', childRef).trim(), otherTree, 'descendant must not be deleted by prefix lookup');
  // retained() ignores the non-leaf descendant.
  assert.deepEqual(await objects.retained(), []);
  // An exact leaf sibling is listed without being confused with the branch.
  const record = await objects.retain(sha256('desc-leaf'), [oid]);
  assert.equal(gitOk(root, 'rev-parse', record.ref).trim(), record.tree);
  assert.deepEqual((await objects.retained()).map(r => [r.ref, r.tree]), [[record.ref, record.tree]]);
  await objects.release(record.ref, record.tree);
  assert.equal(gitOk(root, 'rev-parse', childRef).trim(), otherTree, 'release of the leaf leaves the descendant');
  // And release of the absent base with the descendant's OWN tree still
  // refuses only for the missing ref (idempotent no-op), never the child.
  await objects.release(baseRef, otherTree);
  assert.equal(gitOk(root, 'rev-parse', childRef).trim(), otherTree);
});

test('a ref moved between lookup and delete cannot be deleted; the new value survives', async t => {
  const root = await makeRepo('gso-moved-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-moved');
  const objects = await makeObjects(root, ns);
  const body = Buffer.from('moved payload');
  await fs.writeFile(path.join(root, 'm.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'm.txt').trim();
  const record = await objects.retain(sha256('moved-snap'), [oid]);
  const otherTree = gitOk(root, 'mktree', []).trim();
  assert.notEqual(otherTree, record.tree);
  // Wrap the private lookup: report the OLD value, then move the ref before
  // the guarded delete runs - a deterministic lookup/delete race.
  const originalLookup = objects.lookupRefExact.bind(objects);
  objects.lookupRefExact = async ref => {
    const found = await originalLookup(ref);
    gitOk(root, 'update-ref', '--no-deref', ref, otherTree);
    return found;
  };
  try {
    await assert.rejects(objects.release(record.ref, record.tree), { code: 'idempotency_conflict', message: /moved/ });
  } finally {
    delete objects.lookupRefExact;
  }
  assert.equal(gitOk(root, 'rev-parse', record.ref).trim(), otherTree, 'the moved value must survive the refused delete');
  assert.deepEqual((await objects.retained()).map(r => [r.ref, r.tree]), [[record.ref, otherTree]]);
  // A matching release of the new value now succeeds normally.
  await objects.release(record.ref, otherTree);
  assert.deepEqual(await objects.retained(), []);
});

test('guard revocation before the ref effect leaves no ref; replay with a live guard returns the record', async t => {
  const root = await makeRepo('gso-guard-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ns = sha256('store-guard');
  const objects = await makeObjects(root, ns);
  const body = Buffer.from('guard payload');
  await fs.writeFile(path.join(root, 'g.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'g.txt').trim();
  const deadId = sha256('guard-dead');
  let calls = 0;
  // Call sequence for an absent ref: validate(1), before pre-lookup(2),
  // post-lookup/before update(3 -> the effect guard; fires here). The catch
  // path only re-reads (no guard) and rethrows.
  const revokeBeforeEffect = () => { if (++calls === 3) { throw new Error('host closing'); } };
  await assert.rejects(objects.retain(deadId, [oid], revokeBeforeEffect), { message: /host closing/ });
  const deadRef = `refs/codex-subagent/${ns}/${deadId}`;
  const probe = git(root, 'rev-parse', '--verify', '--quiet', deadRef);
  assert.notEqual(probe.status, 0, 'no ref must be created when the guard fires before the effect');
  // Replay path: the same guard contract succeeds and returns the existing record.
  const liveId = sha256('guard-live');
  const first = await objects.retain(liveId, [oid]);
  const liveCalls = { n: 0 };
  const okGuard = () => { liveCalls.n += 1; };
  assert.deepEqual(await objects.retain(liveId, [oid], okGuard), first);
  assert.ok(liveCalls.n >= 1, 'replay must still re-check the guard');
});

test('repo hooks and fsmonitor cannot run through the helper', async t => {
  const root = await makeRepo('gso-hooks-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hookFile = path.join(root, '.git', 'hooks', 'reference-transaction');
  await fs.writeFile(hookFile, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  gitOk(root, 'config', 'core.hooksPath', path.dirname(hookFile));
  const tree = gitOk(root, 'mktree').trim();
  // Positive control: an ordinary update-ref IS blocked by the hook.
  const plain = git(root, 'update-ref', '--no-deref', 'refs/test/hook-probe', tree, '0'.repeat(40));
  assert.notEqual(plain.status, 0, 'plain git must trip the reference-transaction hook');
  assert.match(plain.stderr, /hook/i, 'the hook must cause the failure, rather than an invalid ref object type');
  // The helper disables hooks (core.hooksPath=/dev/null) and succeeds.
  const objects = await makeObjects(root, sha256('store-hooks'));
  const body = Buffer.from('hook payload');
  await fs.writeFile(path.join(root, 'h.txt'), body);
  const oid = gitOk(root, 'hash-object', '-w', 'h.txt').trim();
  const record = await objects.retain(sha256('hook-snap'), [oid]);
  assert.equal(gitOk(root, 'rev-parse', record.ref).trim(), record.tree);
  await objects.release(record.ref, record.tree);
  assert.deepEqual(await objects.retained(), []);
  // fsmonitor: a marker-writing fsmonitor configured in the repo must never
  // run through selection, while plain git proves the marker CAN be written.
  const marker = path.join(root, 'fsm-ran');
  gitOk(root, '-c', 'core.hooksPath=/dev/null', 'add', 'h.txt');
  await fs.writeFile(path.join(root, 'fsm.sh'), '#!/bin/sh\ntouch "fsm-ran"\n', { mode: 0o755 });
  gitOk(root, 'config', 'core.fsmonitor', path.join(root, 'fsm.sh').split(path.sep).join('/'));
  const triggered = git(root, 'status', '--porcelain');
  assert.equal(triggered.status, 0);
  const wroteMarker = await fs.access(marker).then(() => true, () => false);
  assert.equal(wroteMarker, true, `plain git must exercise the configured fsmonitor: ${triggered.stderr}`);
  await fs.rm(marker);
  await objects.selection();
  assert.equal(await fs.access(marker).then(() => true, () => false), false, 'helper selection must never run the repo fsmonitor');
});

test('object and ref operations keep working after the linked worktree is removed', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gso-wt-gone-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const main = path.join(parent, 'main');
  await fs.mkdir(main, { recursive: true });
  gitOk(main, 'init', '-q', '-b', 'main', '.');
  gitOk(main, 'config', 'user.email', 'a@b');
  gitOk(main, 'config', 'user.name', 'A');
  await fs.writeFile(path.join(main, 'a.txt'), 'a');
  gitOk(main, 'add', '.');
  gitOk(main, 'commit', '-q', '-m', 'one');
  const wt = path.join(parent, 'wt');
  gitOk(main, 'worktree', 'add', '-q', wt, '-b', 'side');
  const ns = sha256('store-wt-gone');
  const mainOb = await GitSnapshotObjects.open(main, ns);
  const wtOb = await GitSnapshotObjects.open(wt, ns);
  assert.ok(mainOb && wtOb);
  // Create the snapshot through the LINKED worktree view.
  const body = Buffer.from('wt payload');
  await fs.writeFile(path.join(wt, 'w.txt'), body);
  const oid = gitOk(wt, 'hash-object', '-w', 'w.txt').trim();
  const record = await wtOb.retain(sha256('wt-snap'), [oid]);
  assert.equal(gitOk(main, 'rev-parse', record.ref).trim(), record.tree, 'ref lives in the common store');
  // Remove the linked worktree (its .git file and worktrees entry disappear).
  gitOk(main, 'worktree', 'remove', '--force', wt);
  assert.equal(await fs.access(path.join(wt, '.git')).then(() => true, () => false), false);
  // The SAME opened views still do object/ref work off the common dir.
  assert.deepEqual(await wtOb.retained(), [record]);
  assert.deepEqual(await wtOb.read(oid, sha256(body)), body);
  const secondBody = Buffer.from('second wt payload');
  await fs.writeFile(path.join(main, 's.txt'), secondBody);
  const oid2 = gitOk(main, 'hash-object', '-w', 's.txt').trim();
  const second = await wtOb.retain(sha256('wt-snap-2'), [oid2]);
  assert.equal(gitOk(main, 'rev-parse', second.ref).trim(), second.tree);
  await wtOb.release(record.ref, record.tree);
  await mainOb.release(second.ref, second.tree);
  assert.deepEqual(await mainOb.retained(), []);
  assert.deepEqual(await wtOb.retained(), []);
});

test('icon folder paths are legal; device names with an extension stay forbidden', async t => {
  const root = await makeRepo('gso-icon-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = await makeObjects(root, sha256('store-icon'));
  await write(root, 'icon/inner.txt', 'inside icon folder');
  const ok = await objects.selection(['icon/inner.txt']);
  assert.deepEqual([...ok.untracked], ['icon/inner.txt'], 'icon/ is a legal path segment');
  for (const bad of ['CON.txt', 'nul.log', 'Com1.dat', 'icon/CON.txt']) {
    await assert.rejects(objects.selection([bad]), { code: 'git_selection_path' }, `rejects ${bad}`);
  }
});
