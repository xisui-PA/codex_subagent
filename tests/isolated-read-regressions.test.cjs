const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { IsolatedViews } = require(path.join(build, 'isolated-views'));
const { captureProject, createProjectContentReader } = require(path.join(build, 'project-snapshot'));
const { GitSnapshotObjects } = require(path.join(build, 'git-snapshot-objects'));
const { executeViewRead } = require(path.join(build, 'isolated-workspace-tools'));
const { BridgeHost, forward } = require(path.join(build, 'bridge'));
const payload = 'immutable shared payload\n';
const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
const scope = { ownerId: 'sealed-read-regression', teamId: 'a'.repeat(32) };

async function fixture(t, count = 2) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-read-fixes-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) { if (key.toUpperCase().startsWith('GIT_')) { delete env[key]; } }
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '--template=', '--object-format=sha1', '.');
  git('config', 'core.autocrlf', 'false');
  const name = at => `f${String(at).padStart(4, '0')}.txt`;
  for (let at = 0; at < count; at += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - at) }, (_, i) => fs.writeFile(path.join(root, name(at + i)), payload)));
  }
  git('add', '.');
  const views = new IsolatedViews(path.join(base, 'views'), root);
  await views.open();
  t.after(async () => {
    await views.close();
    assert.match(path.basename(base), /^isolated-read-fixes-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const snapshot = await views.createSnapshot({ ...scope, requestId: 'capture', selectionKey: 'tracked' },
    (snapshotId, beforePublish) => captureProject(root, views.content, { snapshotId, namespace: views.namespace, selectedUntracked: [], beforePublish }));
  const identity = { ownerId: scope.ownerId, workerId: 'b'.repeat(32), workerCreatedAt: '2026-11-14T00:00:00.000Z' };
  let marker;
  await views.bind({ ...scope, snapshotId: snapshot.id, workerId: identity.workerId, workerCreatedAt: identity.workerCreatedAt, requestId: 'bind' }, async value => { marker = value; });
  const submission = await views.seal(marker, identity, { requestId: 'seal', expectedRevision: 0 });
  return { base, root, views, snapshot, submission, name };
}

test('sealed Git search uses the long bridge budget and constant object-store discovery across 600 files', async t => {
  const bridge = new BridgeHost();
  t.after(() => bridge.close());
  const f = await fixture(t, 600);
  const registry = path.join(f.base, 'registry');
  await bridge.start(registry, [f.root], async (_name, args, signal) => {
    const guard = () => signal.throwIfAborted();
    return { content: [{ type: 'text', text: await f.views.withSubmission(scope.ownerId, scope.teamId, f.submission.id,
      view => executeViewRead(args.operation, args.input, view, guard), guard) }] };
  });
  const request = http.request, reopen = GitSnapshotObjects.reopen;
  const budgets = [];
  let discoveries = 0;
  http.request = (...args) => {
    const pending = request(...args);
    const setTimeout = pending.setTimeout.bind(pending);
    pending.setTimeout = (milliseconds, ...rest) => { budgets.push(milliseconds); return setTimeout(milliseconds, ...rest); };
    return pending;
  };
  GitSnapshotObjects.reopen = (...args) => { discoveries++; return reopen.apply(GitSnapshotObjects, args); };
  const read = async (operation, input) => {
    const result = await forward(registry, f.root, 'subagent_submission_read', { ...scope, submissionId: f.submission.id, operation, input });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    await read('list_files', { limit: 1 });
    assert.equal(budgets.at(-1), 370_000, 'sealed inspection must have the same transport margin as other slow view tools');
    await fs.writeFile(path.join(f.root, f.name(0)), 'changed live query');
    discoveries = 0;
    const result = await read('search_files', { query: 'changed live query' });
    assert.deepEqual(result.results, []);
    assert.equal(result.visited, 601);
    assert.equal(result.truncated, false);
    assert.ok(discoveries <= 2, `discovery must be per operation, not per file; got ${discoveries}`);
    assert.equal((await read('read_file', { path: f.name(0) })).content, payload);
    assert.equal(await fs.readFile(path.join(f.root, f.name(0)), 'utf8'), 'changed live query');
  } finally {
    http.request = request;
    GitSnapshotObjects.reopen = reopen;
  }
});

test('a reused Git reader rechecks authorization and bytes and never substitutes a CAS mirror for a missing Git blob', async t => {
  const f = await fixture(t);
  const reopen = GitSnapshotObjects.reopen;
  let allowed = true, discoveries = 0, reads = 0;
  GitSnapshotObjects.reopen = async (...args) => {
    const repository = await reopen.apply(GitSnapshotObjects, args);
    discoveries++;
    allowed = false;
    const read = repository.read.bind(repository);
    repository.read = (...readArgs) => { reads++; return read(...readArgs); };
    return repository;
  };
  const guard = () => { if (!allowed) { throw Error('read permission revoked'); } };
  try {
    const read = createProjectContentReader(f.snapshot.backing, f.views.content, guard);
    await assert.rejects(read(payloadHash), /read permission revoked/);
    assert.equal(reads, 0, 'revocation during discovery must block the content read');
    allowed = true;
    assert.equal((await read(payloadHash)).toString(), payload);
    allowed = false;
    await assert.rejects(read(payloadHash), /read permission revoked/);
    assert.equal(reads, 1, 'cached discovery must not cache authorization');
    allowed = true;
    await f.views.content.put(Buffer.from(payload));
    const backing = f.snapshot.backing;
    assert.equal(backing.kind, 'git');
    const oid = backing.blobs[payloadHash];
    await fs.unlink(path.join(backing.commonDir, 'objects', oid.slice(0, 2), oid.slice(2)));
    await assert.rejects(read(payloadHash), { code: 'snapshot_content_missing' });
    assert.equal(discoveries, 1);
    assert.equal(reads, 2, 'payload bytes must be fetched and verified again');
  } finally {
    GitSnapshotObjects.reopen = reopen;
  }
});
