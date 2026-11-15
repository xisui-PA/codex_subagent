const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { GitSnapshotObjects } = require(path.join(build, 'git-snapshot-objects'));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-retention-fixes-')));
  t.after(async () => {
    assert.match(path.basename(root), /^git-retention-fixes-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) { if (key.toUpperCase().startsWith('GIT_')) { delete env[key]; } }
  const raw = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
  const git = (...args) => {
    const result = raw(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '--template=', '.');
  const objects = await GitSnapshotObjects.open(root, 'a'.repeat(64));
  return { root, raw, git, objects };
}

test('explicit empty and named untracked selections ignore an oversized excluded vendor tree', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'tracked.txt'), 'tracked');
  f.git('add', 'tracked.txt');
  await fs.writeFile(path.join(f.root, 'wanted.txt'), 'selected');
  const vendor = path.join(f.root, 'vendor');
  await fs.mkdir(vendor);
  for (let at = 0; at < 50_001; at += 256) {
    await Promise.all(Array.from({ length: Math.min(256, 50_001 - at) }, (_, i) => fs.writeFile(path.join(vendor, `f${at + i}`), '')));
  }
  const empty = await f.objects.selection([]);
  assert.deepEqual(empty.tracked.map(entry => entry.path), ['tracked.txt']);
  assert.deepEqual(empty.untracked, []);
  const named = await f.objects.selection(['wanted.txt']);
  assert.deepEqual(named.untracked, ['wanted.txt']);
  await assert.rejects(f.objects.selection(), { code: 'git_capacity' }, 'the default discovery metadata cap is still enforced');
});

test('a direct snapshot ref changed to a same-OID symbolic ref before prepare is preserved', async t => {
  const f = await fixture(t);
  const record = await f.objects.retain('b'.repeat(64), []);
  const target = 'refs/review/foreign-target';
  f.git('update-ref', target, record.tree);
  const lookup = f.objects.lookupRefExact.bind(f.objects);
  let injected = false;
  f.objects.lookupRefExact = async ref => {
    const found = await lookup(ref);
    if (!injected) {
      injected = true;
      f.git('symbolic-ref', ref, target);
    }
    return found;
  };
  await assert.rejects(f.objects.release(record.ref, record.tree), { code: 'idempotency_conflict' });
  assert.equal(injected, true);
  assert.equal(f.git('symbolic-ref', record.ref), target, 'the replacement alias must survive');
  assert.equal(f.git('rev-parse', target), record.tree, 'the foreign target must survive');
  // A completed abort must have released the lock before returning.
  f.git('symbolic-ref', record.ref, target);
});

test('a prepared deletion blocks symbolic replacement while verifying the direct ref', async t => {
  const f = await fixture(t);
  const record = await f.objects.retain('c'.repeat(64), []);
  const target = 'refs/review/foreign-target';
  f.git('update-ref', target, record.tree);
  const lookup = f.objects.lookupRefExact.bind(f.objects);
  let reads = 0, blocked = false;
  f.objects.lookupRefExact = async ref => {
    const found = await lookup(ref);
    if (++reads === 2) {
      const raced = f.raw('symbolic-ref', ref, target);
      assert.notEqual(raced.status, 0, 'Git must hold the ref lock during the second lookup');
      blocked = true;
    }
    return found;
  };
  await f.objects.release(record.ref, record.tree);
  assert.equal(blocked, true, 'the locked verification must run');
  assert.notEqual(f.raw('rev-parse', '--verify', '--quiet', record.ref).status, 0);
  assert.equal(f.git('rev-parse', target), record.tree);
});

test('revocation after prepare aborts without deleting the ref or leaving a lock', async t => {
  const f = await fixture(t);
  const record = await f.objects.retain('d'.repeat(64), []);
  const lookup = f.objects.lookupRefExact.bind(f.objects);
  let reads = 0, allowed = true;
  f.objects.lookupRefExact = async ref => {
    const found = await lookup(ref);
    if (++reads === 2) { allowed = false; }
    return found;
  };
  const guard = () => { if (!allowed) { throw Error('permission revoked after prepare'); } };
  await assert.rejects(f.objects.release(record.ref, record.tree, guard), /permission revoked after prepare/);
  assert.equal(reads, 2);
  assert.equal(f.git('rev-parse', record.ref), record.tree);
  f.objects.lookupRefExact = lookup;
  allowed = true;
  await f.objects.release(record.ref, record.tree, guard);
  assert.notEqual(f.raw('rev-parse', '--verify', '--quiet', record.ref).status, 0);
});

test('revocation queued after locked verification is checked before sending commit', async t => {
  const f = await fixture(t);
  const record = await f.objects.retain('e'.repeat(64), []);
  const lookup = f.objects.lookupRefExact.bind(f.objects);
  let reads = 0, allowed = true;
  f.objects.lookupRefExact = async ref => {
    const found = await lookup(ref);
    if (++reads === 2) {
      // The first microtask precedes the verifier's continuation; the
      // second revokes permission after that continuation but before the
      // transaction helper resumes to send commit.
      queueMicrotask(() => queueMicrotask(() => { allowed = false; }));
    }
    return found;
  };
  const guard = () => { if (!allowed) { throw Error('permission revoked before commit'); } };
  await assert.rejects(f.objects.release(record.ref, record.tree, guard), /permission revoked before commit/);
  assert.equal(reads, 2);
  assert.equal(f.git('rev-parse', record.ref), record.tree, 'the rejected commit must preserve the ref');
  f.objects.lookupRefExact = lookup;
  allowed = true;
  await f.objects.release(record.ref, record.tree, guard);
  assert.notEqual(f.raw('rev-parse', '--verify', '--quiet', record.ref).status, 0);
});
