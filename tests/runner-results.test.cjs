// Focused runner-results tests: versioned durable attempts, immutable final
// results, deterministic identity, idempotency/conflict behavior, owner scope,
// pending recovery without replay, crash-window recovery, corruption and
// explicit capacity. Real temp directories only; nothing is executed.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const buildDir = path.join(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const {
  RunnerResults,
  runnerResultsNamespace,
  runnerResultUri,
  RUNNER_RESULTS_MAX_RECORDS,
  RUNNER_RESULTS_MAX_TOTAL_BYTES,
  RUNNER_RESULTS_MAX_RESULT_BYTES
} = require(path.join(buildDir, 'runner-results'));

const TEAM = 'a'.repeat(32);
const ISO = '2024-01-01T00:00:00.000Z';
const hex = (label, width = 64) => crypto.createHash('sha256').update(`runner-results:${label}`).digest('hex').slice(0, width);
const owner = label => ({ ownerId: `owner-${label}`, teamId: TEAM, workerId: hex(label, 32), workerCreatedAt: ISO });
const scopeOf = label => ({ ownerId: `owner-${label}`, teamId: TEAM });
const version = (label, revision = 0) => ({
  snapshotId: hex(`snapshot:${label}`),
  overlayId: hex(`overlay:${label}`),
  revision
});
const setup = label => ({
  identityHash: hex(`identity:${label}`), platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0',
  shell: 'cmd.exe', environmentHash: hex(`environment:${label}`), caches: ['npm']
});
const exists = async target => fs.lstat(target).then(() => true, () => false);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function makeStore(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-results-'));
  const project = path.join(base, 'project');
  const directory = path.join(base, 'store', 'results');
  await fs.mkdir(project, { recursive: true });
  const store = new RunnerResults(directory, project, options);
  await store.open();
  t.after(async () => {
    await store.close().catch(() => undefined);
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, project, directory, store };
}

function attemptFor(store, label, overrides = {}) {
  const id = hex(`attempt:${label}`, 32);
  const logicalRoot = store.logicalRoot ?? store.project;
  return {
    id,
    owner: owner(label),
    leaseId: id,
    logicalRoot,
    executionDirectory: path.join(logicalRoot, 'work'),
    command: 'node --version',
    timeoutMs: 5000,
    inputVersion: version(label, 0),
    setup: setup(label),
    startedAt: ISO,
    ...overrides
  };
}

/** A valid imported success: one atomic delta on the attempt's own binding. */
function importedDetails(attempt, extra = {}) {
  return {
    outcome: 'succeeded',
    afterVersion: { ...attempt.inputVersion, revision: attempt.inputVersion.revision + 1 },
    import: 'imported',
    exitCode: 0,
    drained: true,
    output: 'ok',
    ...extra
  };
}

test('versioned results carry a deterministic namespace, URI and unchanged input version', async t => {
  const { project, directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'a');
  const started = await store.start(attempt);
  assert.equal(started.replayed, false);
  assert.equal(started.state, 'pending');
  assert.equal(started.result, null);
  const pendingFile = path.join(directory, 'pending', `${attempt.id}.json`);
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  assert.equal(await exists(pendingFile), true, 'the pending attempt is durable before any effect');
  assert.equal(await exists(resultFile), false);

  const details = importedDetails(attempt);
  const result = await store.finish(attempt.id, details);
  assert.equal(result.schema, 1);
  assert.equal(result.version, 1);
  assert.equal(result.id, attempt.id);
  assert.equal(result.namespace, runnerResultsNamespace(directory, project));
  assert.equal(result.uri, runnerResultUri(result.namespace, attempt.id));
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.drained, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.attempt.inputVersion, attempt.inputVersion, 'the command input version is never rewritten');
  assert.deepEqual(result.afterVersion, version('a', 1));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.attempt), true);
  assert.equal(Object.isFrozen(result.attempt.setup.caches), true);
  assert.equal(Object.isFrozen(result.afterVersion), true);

  const durable = await readJson(resultFile);
  assert.equal(durable.schema, 1);
  assert.equal(durable.version, 1);
  assert.equal(durable.namespace, result.namespace);
  assert.equal(durable.uri, result.uri);
  assert.equal(durable.attempt.inputVersion.revision, 0, 'the unchanged input revision is on disk');
  assert.equal(durable.afterVersion.revision, 1);
  assert.equal(await exists(pendingFile), false, 'the pending record is removed only after the final is durable');
  assert.deepEqual(store.get(attempt.id, scopeOf('a')), result);
  assert.deepEqual(await store.finish(attempt.id, details), result, 'an exact repeat is idempotent');
});

test('older results stay tied to their original input revision after newer imports', async t => {
  const { store } = await makeStore(t);
  const older = attemptFor(store, 'older', { inputVersion: version('older', 0) });
  await store.start(older);
  const olderResult = await store.finish(older.id, importedDetails(older));

  const newer = attemptFor(store, 'newer', { inputVersion: version('newer', 3) });
  await store.start(newer);
  const newerResult = await store.finish(newer.id, importedDetails(newer));

  assert.equal(olderResult.attempt.inputVersion.revision, 0);
  assert.equal(olderResult.afterVersion.revision, 1);
  assert.equal(newerResult.attempt.inputVersion.revision, 3);
  assert.equal(newerResult.afterVersion.revision, 4);
  assert.equal(store.get(older.id, scopeOf('older')).attempt.inputVersion.revision, 0);
  assert.equal(store.get(newer.id, scopeOf('newer')).attempt.inputVersion.revision, 3);
  const page = store.list(scopeOf('newer'));
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, newer.id);
});

test('finish is idempotent, rejects conflicting final data and never fakes success', async t => {
  const { directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'a');
  await store.start(attempt);
  const details = { outcome: 'failed', import: 'not_started', exitCode: 2, signal: 'SIGTERM', drained: true, output: 'boom' };
  const first = await store.finish(attempt.id, details);
  assert.deepEqual(await store.finish(attempt.id, details), first);

  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  const durable = await fs.readFile(resultFile, 'utf8');
  await assert.rejects(store.finish(attempt.id, { ...details, exitCode: 3 }), { code: 'runner_results_conflict' });
  await assert.rejects(store.finish(attempt.id, { ...details, completedAt: '2025-01-01T00:00:00.000Z' }), { code: 'runner_results_conflict' });
  assert.equal(await fs.readFile(resultFile, 'utf8'), durable, 'a conflict never overwrites the final result');

  const invalid = attemptFor(store, 'invalid');
  await store.start(invalid);
  await assert.rejects(store.finish(invalid.id, { outcome: 'succeeded', import: 'not_started', exitCode: 0, drained: true }),
    { code: 'invalid_runner_finish' }, 'success needs a completed supported import');
  await assert.rejects(store.finish(invalid.id, { outcome: 'succeeded', import: 'unchanged', afterVersion: invalid.inputVersion, exitCode: 1, drained: true }),
    { code: 'invalid_runner_finish' }, 'success needs exit code 0');
  await assert.rejects(store.finish(invalid.id, { outcome: 'succeeded', import: 'unchanged', afterVersion: invalid.inputVersion, exitCode: 0, drained: false }),
    { code: 'invalid_runner_finish' }, 'success needs a drained command');
  await assert.rejects(store.finish(invalid.id, { outcome: 'setup_failed', import: 'imported', afterVersion: version('invalid', 1), drained: true }),
    { code: 'invalid_runner_finish' }, 'a failed setup cannot claim an imported revision');
  assert.equal(await exists(path.join(directory, 'results', `${invalid.id}.json`)), false);
  assert.equal(await exists(path.join(directory, 'pending', `${invalid.id}.json`)), true, 'rejected details leave the pending attempt intact');

  const setupFailure = await store.finish(invalid.id, { outcome: 'setup_failed', import: 'not_started', drained: false, diagnostic: 'no shell' });
  assert.equal(setupFailure.outcome, 'setup_failed');
  assert.equal(setupFailure.afterVersion, null);
  assert.equal(setupFailure.exitCode, null);

  const external = attemptFor(store, 'external');
  await store.start(external);
  const externalFile = path.join(directory, 'results', `${external.id}.json`);
  await fs.writeFile(externalFile, '{"external":true}', 'utf8');
  await assert.rejects(store.finish(external.id, { outcome: 'failed', import: 'not_started', drained: true }),
    { code: 'runner_results_conflict' }, 'an existing result file is never overwritten');
  assert.equal(await fs.readFile(externalFile, 'utf8'), '{"external":true}');
});

test('owner scope denies reads and lists without revealing another owner record', async t => {
  const { store } = await makeStore(t);
  const attempt = attemptFor(store, 'a');
  await store.start(attempt);
  await store.finish(attempt.id, importedDetails(attempt));

  assert.throws(() => store.get(attempt.id, scopeOf('b')), { code: 'runner_results_denied' });
  assert.throws(() => store.get(attempt.id, { ownerId: 'owner-a', teamId: 'b'.repeat(32) }), { code: 'runner_results_denied' });
  assert.throws(() => store.get(hex('missing', 32), scopeOf('a')), { code: 'runner_results_not_found' });
  assert.throws(() => store.get(attempt.id, { ...scopeOf('a'), extra: true }), { code: 'invalid_runner_scope' });
  assert.deepEqual(store.list(scopeOf('b')), { results: [], offset: 0, limit: 20, total: 0, nextOffset: null });
  assert.deepEqual(store.list(scopeOf('a')).results.map(result => result.id), [attempt.id]);
  await assert.rejects(store.start({ ...attempt, owner: owner('b') }), { code: 'runner_results_conflict' });
});

test('a pending attempt recovers as uncertain after reload and is never replayed', async t => {
  const { project, directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'pending', { inputVersion: version('pending', 7) });
  await store.start(attempt);
  const pendingFile = path.join(directory, 'pending', `${attempt.id}.json`);
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  assert.equal(await exists(pendingFile), true);

  const reopened = new RunnerResults(directory, project);
  await reopened.open();
  t.after(() => reopened.close());
  const recovered = reopened.get(attempt.id, scopeOf('pending'));
  assert.equal(recovered.outcome, 'uncertain');
  assert.equal(recovered.import, 'uncertain');
  assert.equal(recovered.afterVersion, null);
  assert.equal(recovered.drained, false);
  assert.equal(recovered.exitCode, null);
  assert.equal(recovered.signal, null);
  assert.equal(recovered.output, '');
  assert.match(recovered.diagnostic, /uncertain|restart/i);
  assert.equal(recovered.attempt.command, attempt.command);
  assert.deepEqual(recovered.attempt.inputVersion, attempt.inputVersion, 'recovery preserves the original input version');
  assert.equal(await exists(pendingFile), false);
  assert.equal(await exists(resultFile), true);

  const replay = await reopened.start(attempt);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, 'finished');
  assert.equal(replay.result.outcome, 'uncertain');
  assert.equal(await exists(pendingFile), false, 'a replay never creates a new pending attempt');
});

test('a durable final wins over a leftover pending file after the crash window', async t => {
  const { project, directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'crash');
  await store.start(attempt);
  const pendingFile = path.join(directory, 'pending', `${attempt.id}.json`);
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  const pendingText = await fs.readFile(pendingFile, 'utf8');
  const final = await store.finish(attempt.id, { outcome: 'failed', import: 'not_started', exitCode: 9, drained: true });
  const finalText = await fs.readFile(resultFile, 'utf8');
  await fs.writeFile(pendingFile, pendingText, 'utf8');

  const reopened = new RunnerResults(directory, project);
  await reopened.open();
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(attempt.id, scopeOf('crash')), final);
  assert.equal(await exists(pendingFile), false);
  assert.equal(await fs.readFile(resultFile, 'utf8'), finalText, 'the original final result is never rewritten');
  assert.equal(reopened.status().results, 1);
  assert.equal(reopened.status().pending, 0);
});

test('missing, corrupt and orphaned metadata fails closed without resetting data', async t => {
  const { base, project, directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'a');
  await store.start(attempt);
  const final = await store.finish(attempt.id, importedDetails(attempt));
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  const resultText = await fs.readFile(resultFile, 'utf8');
  const namespaceFile = path.join(directory, 'namespace.json');
  const namespaceText = await fs.readFile(namespaceFile, 'utf8');
  await store.close();

  await fs.rm(namespaceFile);
  const missing = new RunnerResults(directory, project);
  await assert.rejects(missing.open(), { code: 'runner_results_corrupt' });
  await assert.rejects(missing.start(attempt), { code: 'runner_results_unavailable' }, 'a failed handle stays unusable');
  assert.throws(() => missing.status(), { code: 'runner_results_unavailable' });
  assert.equal(await fs.readFile(resultFile, 'utf8'), resultText, 'no record was reset');
  assert.equal(await exists(namespaceFile), false, 'no namespace metadata was fabricated over records');

  await fs.writeFile(namespaceFile, namespaceText, 'utf8');
  await fs.writeFile(resultFile, '{"broken":', 'utf8');
  const corrupt = new RunnerResults(directory, project);
  await assert.rejects(corrupt.open(), { code: 'runner_results_corrupt' });
  await assert.rejects(corrupt.open(), { code: 'runner_results_unavailable' });
  assert.equal(await fs.readFile(resultFile, 'utf8'), '{"broken":', 'the corrupt record is preserved');

  await fs.writeFile(resultFile, resultText, 'utf8');
  const recovered = new RunnerResults(directory, project);
  await recovered.open();
  t.after(() => recovered.close());
  assert.deepEqual(recovered.get(attempt.id, scopeOf('a')), final);
  await fs.writeFile(path.join(directory, 'notes.txt'), 'keep', 'utf8');
  await fs.writeFile(path.join(directory, 'pending', 'leftover.tmp'), 'keep', 'utf8');
  await recovered.close();
  const reported = new RunnerResults(directory, project);
  await reported.open();
  t.after(() => reported.close());
  const unknown = reported.status().unknownEntries;
  assert.ok(unknown.includes('notes.txt'));
  assert.ok(unknown.some(entry => entry.includes('leftover.tmp')));
  assert.equal(await fs.readFile(path.join(directory, 'notes.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(directory, 'pending', 'leftover.tmp'), 'utf8'), 'keep');

  const rootFile = path.join(base, 'not-a-directory');
  await fs.writeFile(rootFile, 'file');
  const invalid = new RunnerResults(rootFile, project);
  await assert.rejects(invalid.open(), { code: 'invalid_path' });

  const orphan = path.join(base, 'orphan');
  await fs.mkdir(path.join(orphan, 'results'), { recursive: true });
  const orphanRecord = path.join(orphan, 'results', `${hex('orphan', 32)}.json`);
  await fs.writeFile(orphanRecord, resultText, 'utf8');
  const blind = new RunnerResults(orphan, project);
  await assert.rejects(blind.open(), { code: 'runner_results_corrupt' });
  assert.equal(await fs.readFile(orphanRecord, 'utf8'), resultText);
});

test('capacity is explicit, bounded and checked before any effect', async t => {
  assert.equal(RUNNER_RESULTS_MAX_RECORDS, 1024);
  assert.equal(RUNNER_RESULTS_MAX_TOTAL_BYTES, 128 * 1024 * 1024);
  assert.equal(RUNNER_RESULTS_MAX_RESULT_BYTES, 1024 * 1024);

  const { directory, store } = await makeStore(t, { maxRecords: 1, maxTotalBytes: 8192, maxResultBytes: 4096 });
  const first = attemptFor(store, 'first');
  await store.start(first);
  const second = attemptFor(store, 'second');
  await assert.rejects(store.start(second), { code: 'runner_results_capacity' });
  assert.equal(await exists(path.join(directory, 'pending', `${second.id}.json`)), false, 'a refused start writes nothing');
  assert.equal(store.status().pending, 1);

  await assert.rejects(store.finish(first.id, { outcome: 'failed', import: 'not_started', exitCode: 1, drained: true, output: 'x'.repeat(5000) }),
    { code: 'runner_results_capacity' });
  assert.equal(await exists(path.join(directory, 'results', `${first.id}.json`)), false, 'an oversized result writes nothing');
  assert.equal(await exists(path.join(directory, 'pending', `${first.id}.json`)), true);

  await store.finish(first.id, { outcome: 'failed', import: 'not_started', exitCode: 1, drained: true });
  await assert.rejects(store.start(second), { code: 'runner_results_capacity' }, 'a final result still consumes the single record slot');

  const tight = await makeStore(t, { maxRecords: 10, maxTotalBytes: 1900, maxResultBytes: 1800 });
  const tightFirst = attemptFor(tight, 'tight-first');
  await tight.store.start(tightFirst);
  await assert.rejects(tight.store.start(attemptFor(tight, 'tight-second', { command: 'x'.repeat(500) })),
    { code: 'runner_results_capacity' });
  assert.equal(tight.store.status().pending, 1);
});

test('start replays exactly, rejects different arguments and validates the attempt', async t => {
  const { directory, project, store } = await makeStore(t);
  const attempt = attemptFor(store, 'a');
  const first = await store.start(attempt);
  assert.equal(first.replayed, false);
  const replay = await store.start({ ...attempt, inputVersion: version('a', 0) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, 'pending');
  assert.equal(replay.result, null);
  assert.equal(store.status().pending, 1, 'an exact replay does not duplicate the pending record');

  const pendingFile = path.join(directory, 'pending', `${attempt.id}.json`);
  const pendingText = await fs.readFile(pendingFile, 'utf8');
  await assert.rejects(store.start({ ...attempt, command: 'echo different' }), { code: 'runner_results_conflict' });
  assert.equal(await fs.readFile(pendingFile, 'utf8'), pendingText, 'a conflicting start never overwrites the pending attempt');

  const finished = await store.finish(attempt.id, importedDetails(attempt));
  const finishedReplay = await store.start(attempt);
  assert.equal(finishedReplay.replayed, true);
  assert.equal(finishedReplay.state, 'finished');
  assert.deepEqual(finishedReplay.result, finished);
  await assert.rejects(store.start({ ...attempt, timeoutMs: 6000 }), { code: 'runner_results_conflict' });

  await assert.rejects(store.start({ ...attemptFor(store, 'long'), command: 'x'.repeat(4001) }), { code: 'invalid_runner_attempt' });
  await assert.rejects(store.start({ ...attemptFor(store, 'extra'), extra: true }), { code: 'invalid_runner_attempt' });
  await assert.rejects(store.start({ ...attemptFor(store, 'root'), logicalRoot: path.join(project, 'other') }), { code: 'invalid_runner_attempt' });
  await assert.rejects(store.finish(hex('never', 32), { outcome: 'failed', import: 'not_started', drained: true }), { code: 'runner_results_not_found' });
  assert.equal(store.status().pending, 0, 'invalid starts never write pending records');
  assert.equal(store.status().results, 1);
});

test('list pages are bounded, newest first and owner scoped', async t => {
  const { store } = await makeStore(t);
  const labels = ['one', 'two', 'three'];
  const completed = [];
  for (const [index, label] of labels.entries()) {
    const attempt = attemptFor(store, label, { owner: owner('shared') });
    await store.start(attempt);
    completed.push(await store.finish(attempt.id, {
      outcome: 'failed', import: 'not_started', exitCode: 1, drained: true,
      completedAt: `2024-01-0${index + 1}T00:00:00.000Z`
    }));
  }
  const other = attemptFor(store, 'other', { owner: owner('other') });
  await store.start(other);
  await store.finish(other.id, { outcome: 'failed', import: 'not_started', exitCode: 1, drained: true });

  const firstPage = store.list(scopeOf('shared'), 0, 2);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextOffset, 2);
  assert.deepEqual(firstPage.results.map(result => result.id), [completed[2].id, completed[1].id]);
  const secondPage = store.list(scopeOf('shared'), 2, 2);
  assert.equal(secondPage.nextOffset, null);
  assert.deepEqual(secondPage.results.map(result => result.id), [completed[0].id]);
  assert.equal(store.list(scopeOf('other')).total, 1);
  assert.throws(() => store.list(scopeOf('shared'), 0, 21), { code: 'invalid_runner_page' });
  assert.throws(() => store.list(scopeOf('shared'), -1, 1), { code: 'invalid_runner_page' });
  assert.throws(() => store.list(scopeOf('shared'), 0.5, 1), { code: 'invalid_runner_page' });
});

test('managed record links are refused instead of followed', async t => {
  const { base, project, directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'link');
  await store.start(attempt);
  await store.finish(attempt.id, importedDetails(attempt));
  await store.close();
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  const outside = path.join(base, 'outside-result.json');
  await fs.copyFile(resultFile, outside);
  await fs.rm(resultFile);
  let linked = true;
  try {
    await fs.symlink(outside, resultFile, 'file');
  } catch {
    linked = false;
  }
  if (!linked) {
    await fs.rename(outside, resultFile);
    const outsideDirectory = path.join(base, 'outside-root');
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, 'marker.txt'), 'external', 'utf8');
    const moved = path.join(base, 'moved-results');
    await fs.rename(directory, moved);
    try {
      await fs.symlink(outsideDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.rename(moved, directory);
      t.diagnostic('symlink/junction creation is unavailable; the managed-link case was not exercised');
      return;
    }
    const aliased = new RunnerResults(directory, project);
    await assert.rejects(aliased.open(), { code: 'invalid_path' }, 'a linked store root is refused');
    assert.equal(await fs.readFile(path.join(outsideDirectory, 'marker.txt'), 'utf8'), 'external', 'the link target was not modified');
    return;
  }
  const reopened = new RunnerResults(directory, project);
  await assert.rejects(reopened.open(), { code: 'runner_results_corrupt' });
  assert.equal(await fs.readFile(outside, 'utf8').then(text => text.length > 0), true, 'the link target was not modified');
});

test('the namespace hashes an unambiguous tuple, so concatenation aliases differ', async t => {
  const { project, directory, store } = await makeStore(t);
  // Historical ambiguity: ('/x/ab', '/c') and ('/x/a', '/bc') concatenate to
  // the same plain string, so a separator-free hash would alias these pairs.
  assert.notEqual(runnerResultsNamespace('/x/ab', '/c'), runnerResultsNamespace('/x/a', '/bc'));
  // The encoding is pinned exactly: SHA-256 over a JSON tuple, never a concat.
  const root = path.resolve(project);
  const expected = crypto.createHash('sha256').update(JSON.stringify(['runner-results', directory, root])).digest('hex');
  assert.equal(runnerResultsNamespace(directory, project), expected);
  assert.notEqual(runnerResultsNamespace(directory, project),
    crypto.createHash('sha256').update(directory + root).digest('hex'), 'a plain concatenation is not the namespace');
  assert.match(runnerResultsNamespace(directory, project), /^[a-f0-9]{64}$/);
  // Deterministic for the same pair, distinct when the roles are swapped.
  assert.equal(runnerResultsNamespace(directory, project), runnerResultsNamespace(directory, `${project}${path.sep}.`));
  assert.notEqual(runnerResultsNamespace(directory, project), runnerResultsNamespace(project, directory));
  assert.equal(store.namespace, runnerResultsNamespace(directory, project));

  // A different logical root cannot reopen this store through an alias.
  const shifted = new RunnerResults(directory, path.join(project, 'shifted-root'));
  await assert.rejects(shifted.open(), { code: 'runner_results_corrupt' });
});

test('afterVersion is exactly one atomic delta on the attempt binding', async t => {
  const { directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'delta', { inputVersion: version('delta', 4) });
  await store.start(attempt);
  const base = { outcome: 'succeeded', exitCode: 0, drained: true };
  const delta = revision => ({ ...attempt.inputVersion, revision });
  const resultsFile = path.join(directory, 'results', `${attempt.id}.json`);

  // A foreign snapshot or overlay binding is never accepted under imported.
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: { ...delta(5), snapshotId: hex('foreign') } }),
    { code: 'invalid_runner_finish' });
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: { ...delta(5), overlayId: hex('foreign') } }),
    { code: 'invalid_runner_finish' });
  // Stale, repeated and skipped revisions are refused too.
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: delta(3) }),
    { code: 'invalid_runner_finish' }, 'an older revision is not an import');
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: delta(4) }),
    { code: 'invalid_runner_finish' }, 'the input revision itself is not an import');
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: delta(6) }),
    { code: 'invalid_runner_finish' }, 'a skipped revision is not one atomic delta');
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'imported', afterVersion: null }),
    { code: 'invalid_runner_finish' });
  // An unchanged import must repeat its input version explicitly.
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'unchanged', afterVersion: null }),
    { code: 'invalid_runner_finish' }, 'unchanged must not fall back to null');
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'unchanged', afterVersion: delta(5) }),
    { code: 'invalid_runner_finish' }, 'unchanged cannot claim a delta');
  await assert.rejects(store.finish(attempt.id, { ...base, import: 'unchanged', afterVersion: { ...delta(4), overlayId: hex('foreign') } }),
    { code: 'invalid_runner_finish' }, 'unchanged keeps the attempt binding');
  // Every non-imported status stays null.
  await assert.rejects(store.finish(attempt.id, { outcome: 'failed', exitCode: 1, drained: true, import: 'failed', afterVersion: delta(5) }),
    { code: 'invalid_runner_finish' });
  await assert.rejects(store.finish(attempt.id, { outcome: 'timed_out', drained: true, import: 'uncertain', afterVersion: delta(5) }),
    { code: 'invalid_runner_finish' });
  await assert.rejects(store.finish(attempt.id, { outcome: 'cancelled', drained: false, import: 'not_started', afterVersion: delta(5) }),
    { code: 'invalid_runner_finish' });
  assert.equal(await exists(resultsFile), false, 'no rejected detail wrote a final result');
  assert.deepEqual(store.status().pending, 1);

  const imported = await store.finish(attempt.id, { ...base, import: 'imported', afterVersion: delta(5) });
  assert.deepEqual(imported.afterVersion, delta(5));
  assert.deepEqual(imported.attempt.inputVersion, attempt.inputVersion, 'the input version never moves');

  const unchangedAttempt = attemptFor(store, 'unchanged', { inputVersion: version('unchanged', 2) });
  await store.start(unchangedAttempt);
  const unchanged = await store.finish(unchangedAttempt.id, { ...base, import: 'unchanged', afterVersion: unchangedAttempt.inputVersion });
  assert.deepEqual(unchanged.afterVersion, unchangedAttempt.inputVersion);
  assert.equal(unchanged.attempt.inputVersion.revision, 2);

  // The last representable delta is accepted; revision 1025 is unrepresentable.
  const edge = attemptFor(store, 'edge', { inputVersion: version('edge', 1023) });
  await store.start(edge);
  const lastDelta = await store.finish(edge.id, { ...base, import: 'imported', afterVersion: { ...version('edge', 1024) } });
  assert.equal(lastDelta.afterVersion.revision, 1024);
  assert.equal(lastDelta.attempt.inputVersion.revision, 1023);
  const ceiling = attemptFor(store, 'ceiling', { inputVersion: version('ceiling', 1024) });
  await store.start(ceiling);
  await assert.rejects(store.finish(ceiling.id, { ...base, import: 'imported', afterVersion: { ...version('ceiling', 1024), revision: 1025 } }),
    { code: 'invalid_runner_finish' });
});

test('a close queued before a mutation stops it from writing after the store closed', async t => {
  const { directory, store } = await makeStore(t);
  const attempt = attemptFor(store, 'race');
  // close() is queued first, so its serialized mutation runs before start()'s;
  // start() must re-check readiness inside its own mutation and write nothing.
  const closing = store.close();
  const starting = store.start(attempt);
  await closing;
  await assert.rejects(starting, { code: 'runner_results_closed' });
  assert.equal(await exists(path.join(directory, 'pending', `${attempt.id}.json`)), false, 'no pending record was written after close');
  assert.equal(await exists(path.join(directory, 'results', `${attempt.id}.json`)), false);
  assert.equal(await exists(path.join(directory, 'pending')), true);
  assert.equal(store.status().closed, true);
  assert.equal(store.status().pending, 0);

  // The same race for finish(): the pending record survives, no final is written.
  const second = await makeStore(t);
  const late = attemptFor(second.store, 'late');
  await second.store.start(late);
  const closingSecond = second.store.close();
  const finishing = second.store.finish(late.id, { outcome: 'failed', import: 'not_started', exitCode: 1, drained: true });
  await closingSecond;
  await assert.rejects(finishing, { code: 'runner_results_closed' });
  assert.equal(await exists(path.join(second.directory, 'results', `${late.id}.json`)), false, 'no final record was written after close');
  assert.equal(await exists(path.join(second.directory, 'pending', `${late.id}.json`)), true, 'the pending attempt is preserved');
  assert.deepEqual(await fs.readdir(path.join(second.directory, 'results')), [], 'no final record was written after close');
  // A fresh handle recovers the pending attempt as uncertain, never replayed.
  const reopened = new RunnerResults(second.directory, second.project);
  await reopened.open();
  t.after(() => reopened.close());
  assert.equal(reopened.get(late.id, scopeOf('late')).outcome, 'uncertain');
  await store.close();
});

test('injected caps may tighten but never relax the exported hard caps', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-results-caps-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const directory = path.join(base, 'results');
  await fs.mkdir(project, { recursive: true });

  for (const options of [
    { maxRecords: RUNNER_RESULTS_MAX_RECORDS + 1 },
    { maxRecords: 100_000 },
    { maxTotalBytes: RUNNER_RESULTS_MAX_TOTAL_BYTES + 1 },
    { maxTotalBytes: 1024 * 1024 * 1024 },
    { maxResultBytes: RUNNER_RESULTS_MAX_RESULT_BYTES + 1 },
    { maxResultBytes: RUNNER_RESULTS_MAX_RESULT_BYTES + 1, maxTotalBytes: RUNNER_RESULTS_MAX_TOTAL_BYTES },
    { maxRecords: 0 },
    { maxTotalBytes: 1023 },
    { maxResultBytes: 127 }
  ]) {
    assert.throws(() => new RunnerResults(directory, project, options), { code: 'invalid_runner_results_config' }, JSON.stringify(options));
  }

  const defaults = new RunnerResults(directory, project);
  assert.equal(defaults.maxRecords, RUNNER_RESULTS_MAX_RECORDS);
  assert.equal(defaults.maxTotalBytes, RUNNER_RESULTS_MAX_TOTAL_BYTES);
  assert.equal(defaults.maxResultBytes, RUNNER_RESULTS_MAX_RESULT_BYTES);
  const tight = new RunnerResults(directory, project, { maxRecords: 4, maxTotalBytes: 4096, maxResultBytes: 2048 });
  assert.equal(tight.maxRecords, 4);
  assert.equal(tight.maxTotalBytes, 4096);
  assert.equal(tight.maxResultBytes, 2048);
  await tight.open();
  await tight.close();
  assert.equal(await exists(directory), true);
});

// ---------------------------------------------------------------------------
// Record caps count DISTINCT attempts, not map entries.
//
// A crash between the final write and the pending removal leaves a durable
// final AND its leftover pending for the SAME attempt id. That is one attempt,
// so it must not consume two record slots: the reload has to prove capacity on
// distinct ids, then recover (drop the leftover pending) instead of refusing to
// open a store that really is within its cap.
// ---------------------------------------------------------------------------

/** Byte snapshot of every managed record file, keyed by kind/name. */
async function recordSnapshot(directory) {
  const snapshot = new Map();
  for (const kind of ['results', 'pending']) {
    const directoryPath = path.join(directory, kind);
    for (const name of (await fs.readdir(directoryPath)).sort()) {
      snapshot.set(`${kind}/${name}`, await fs.readFile(path.join(directoryPath, name)));
    }
  }
  return snapshot;
}

test('a one-record store reopens when a durable final still has its leftover pending', async t => {
  const options = { maxRecords: 1, maxTotalBytes: 8192, maxResultBytes: 4096 };
  const { project, directory, store } = await makeStore(t, options);
  const attempt = attemptFor(store, 'window');
  await store.start(attempt);
  const pendingFile = path.join(directory, 'pending', `${attempt.id}.json`);
  const resultFile = path.join(directory, 'results', `${attempt.id}.json`);
  const pendingText = await fs.readFile(pendingFile, 'utf8');
  const final = await store.finish(attempt.id, { outcome: 'failed', import: 'not_started', exitCode: 7, drained: true });
  const finalText = await fs.readFile(resultFile, 'utf8');
  // Recreate the crash window exactly: the final is durable and the precise
  // pre-crash pending bytes are back for that same attempt id.
  await fs.writeFile(pendingFile, pendingText, 'utf8');
  assert.equal(await fs.readFile(pendingFile, 'utf8'), pendingText, 'the leftover pending is byte-identical');
  await store.close();

  const reopened = new RunnerResults(directory, project, options);
  await reopened.open();
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(attempt.id, scopeOf('window')), final, 'the immutable final is retained exactly');
  assert.equal(await fs.readFile(resultFile, 'utf8'), finalText, 'the durable final result is never rewritten');
  assert.equal(await exists(pendingFile), false, 'the leftover pending of the durable id is dropped');
  assert.equal(reopened.status().results, 1);
  assert.equal(reopened.status().pending, 0);
  assert.ok(reopened.status().diagnostics.some(text => text.includes(attempt.id) && /already durable/.test(text)),
    'the drop is reported');
  assert.equal(reopened.list(scopeOf('window')).total, 1, 'reads still work after the recovery');
  // Recovery removed nothing but the duplicate: the slot is still a real cap.
  await assert.rejects(reopened.start(attemptFor(reopened, 'window-second')), { code: 'runner_results_capacity' },
    'one distinct attempt still fills a one-record store');
  const replay = await reopened.start(attempt);
  assert.equal(replay.state, 'finished', 'the recovered attempt still replays as finished');
  assert.deepEqual(replay.result, final);
});

test('distinct attempts above the configured cap still fail closed without touching records', async t => {
  // Three DISTINCT attempts built under the default cap: two finals and one
  // pending. Reopening with a genuinely smaller cap must fail closed.
  const { project, directory, store } = await makeStore(t);
  const first = attemptFor(store, 'distinct-first');
  const second = attemptFor(store, 'distinct-second');
  const third = attemptFor(store, 'distinct-third');
  await store.start(first);
  await store.finish(first.id, { outcome: 'failed', import: 'not_started', exitCode: 1, drained: true });
  await store.start(second);
  await store.finish(second.id, { outcome: 'failed', import: 'not_started', exitCode: 2, drained: true });
  await store.start(third);
  await store.close();
  const before = await recordSnapshot(directory);
  assert.equal(before.size, 3, 'two finals and one pending are on disk');

  for (const maxRecords of [1, 2]) {
    const capped = new RunnerResults(directory, project, { maxRecords });
    await assert.rejects(capped.open(), (error) => {
      assert.equal(error.code, 'runner_results_capacity');
      assert.match(error.message, /holds 3 records/, 'three distinct attempts are counted, not four map entries');
      return true;
    });
    await assert.rejects(capped.start(first), { code: 'runner_results_unavailable' }, 'a failed handle stays unusable');
    assert.throws(() => capped.status(), { code: 'runner_results_unavailable' });
  }

  const after = await recordSnapshot(directory);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no record was created or deleted');
  for (const [name, bytes] of before) {
    assert.deepEqual(after.get(name), bytes, `${name} was not rewritten`);
  }
});

test('the default 1024-record store reopens with one leftover pending at its limit', async t => {
  const { project, directory, store } = await makeStore(t);
  // One real start/finish, then schema-valid clones of that exact record: the
  // only practical way to reach the default limit without a slow fixture.
  const seed = attemptFor(store, 'limit-seed');
  await store.start(seed);
  const pendingFile = path.join(directory, 'pending', `${seed.id}.json`);
  const seedPendingText = await fs.readFile(pendingFile, 'utf8');
  await store.finish(seed.id, { outcome: 'failed', import: 'not_started', exitCode: 5, drained: true });
  const namespace = runnerResultsNamespace(directory, project);
  const seedText = await fs.readFile(path.join(directory, 'results', `${seed.id}.json`), 'utf8');
  assert.equal(JSON.parse(seedText).namespace, namespace, 'the seed carries this store namespace');
  const ids = [seed.id];
  for (let index = 0; index < RUNNER_RESULTS_MAX_RECORDS - 1; index += 1) {
    const id = hex(`limit-clone:${index}`, 32);
    const clone = JSON.parse(seedText);
    clone.id = id;
    clone.uri = runnerResultUri(namespace, id);
    clone.attempt.id = id;
    clone.attempt.leaseId = id;
    await fs.writeFile(path.join(directory, 'results', `${id}.json`), JSON.stringify(clone), 'utf8');
    ids.push(id);
  }
  assert.equal(ids.length, RUNNER_RESULTS_MAX_RECORDS, 'the store is exactly at the default record limit');
  // The realistic crash window: the seed's exact pending bytes are back.
  await fs.writeFile(pendingFile, seedPendingText, 'utf8');
  await store.close();
  assert.equal((await recordSnapshot(directory)).size, RUNNER_RESULTS_MAX_RECORDS + 1,
    'the limit holds 1024 finals plus one leftover pending file');

  const reopened = new RunnerResults(directory, project);
  await reopened.open();
  t.after(() => reopened.close());
  assert.equal(reopened.status().results, RUNNER_RESULTS_MAX_RECORDS, 'every distinct attempt is retained');
  assert.equal(reopened.status().pending, 0, 'the leftover pending is dropped');
  assert.equal(await exists(pendingFile), false);
  assert.equal(await fs.readFile(path.join(directory, 'results', `${seed.id}.json`), 'utf8'), seedText,
    'the seed final is byte-identical after the reload');
  const lastClone = ids[ids.length - 1];
  const lastText = await fs.readFile(path.join(directory, 'results', `${lastClone}.json`), 'utf8');
  assert.equal(JSON.parse(lastText).id, lastClone, 'a cloned final survived untouched');
  assert.equal(reopened.get(seed.id, scopeOf('limit-seed')).outcome, 'failed');
  assert.equal(reopened.get(seed.id, scopeOf('limit-seed')).exitCode, 5);
  // At the limit, one more DISTINCT attempt is still refused.
  await assert.rejects(reopened.start(attemptFor(reopened, 'limit-extra')), { code: 'runner_results_capacity' });
});

test('an uncommitted namespace temp after a hard crash recovers, and nothing else is ever ignored', async t => {
  const TEAM_B = 'b'.repeat(32);
  const scopeB = { ownerId: 'owner-crash', teamId: TEAM_B };
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-results-crash-'));
  const project = path.join(base, 'project');
  const directory = path.join(base, 'store', 'results');
  await fs.mkdir(project, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }).catch(() => undefined));
  const attempt = label => ({
    id: hex(`crash:${label}`, 32),
    owner: { ownerId: 'owner-crash', teamId: TEAM_B, workerId: hex(label, 32), workerCreatedAt: ISO },
    leaseId: hex(`crash:${label}`, 32),
    logicalRoot: project,
    executionDirectory: path.join(project, 'work'),
    command: 'node --version',
    timeoutMs: 5000,
    inputVersion: version(label, 0),
    setup: setup(label),
    startedAt: ISO
  });
  const tempName = uuid => `namespace.json.${uuid}.tmp`;
  const UUIDS = [
    '01234567-89ab-cdef-0123-456789abcdef',
    'fedcba98-7654-3210-fedc-ba9876543210'
  ];
  const namespace = runnerResultsNamespace(directory, project);

  // ---- 1. The exact post-crash state: only our own temp, first write never
  // committed. An EMPTY temp and a TRUNCATED temp must both recover.
  for (const [index, contents] of [[0, ''], [1, '{"schema":1,"vers']]) {
    const name = tempName(UUIDS[index]);
    const temp = path.join(directory, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temp, contents, 'utf8');
    const tempBytes = await fs.readFile(temp, 'utf8');

    // The SAME handle a caller would retry on...
    const store = new RunnerResults(directory, project);
    await store.open();
    // ...and a genuinely fresh handle (what the next process does).
    const fresh = new RunnerResults(directory, project);
    await fresh.open();
    t.after(() => fresh.close().catch(() => undefined));
    t.after(() => store.close().catch(() => undefined));

    // The committed metadata is a real, validated namespace for this store.
    const record = await readJson(path.join(directory, 'namespace.json'));
    assert.equal(record.namespace, namespace, 'the created namespace is this store namespace');
    assert.equal(record.revision, 0);
    assert.equal(record.directory, directory);
    assert.equal(record.logicalRoot, project);
    for (const handle of [store, fresh]) {
      assert.equal(handle.namespace, namespace);
      assert.ok(handle.status().unknownEntries.includes(name),
        'the uncommitted temp is preserved AND reported as an unknown entry');
    }
    // Never adopted as metadata, never deleted, never overwritten.
    assert.equal(await fs.readFile(temp, 'utf8'), tempBytes);
    assert.equal(await exists(path.join(directory, 'pending')), true);
    assert.equal(await exists(path.join(directory, 'results')), true);

    // The store is fully usable: start, finish and read back one result.
    const one = attempt(`usable-${index}`);
    const started = await store.start(one);
    assert.equal(started.state, 'pending');
    const final = await store.finish(one.id, importedDetails(one));
    assert.equal(final.outcome, 'succeeded');
    assert.equal(store.get(one.id, scopeB).id, one.id);
    // A handle opened AFTER the write reads the committed result back, including
    // from disk, while the temp is still sitting beside the namespace.
    const reread = new RunnerResults(directory, project);
    await reread.open();
    t.after(() => reread.close().catch(() => undefined));
    assert.deepEqual(reread.get(one.id, scopeB), final);
    assert.equal(await fs.readFile(temp, 'utf8'), tempBytes, 'the temp is still untouched after recovery');
    await reread.close();

    // Leave the root with ONLY a temp again for the next variant.
    await store.close();
    await fresh.close();
    await fs.rm(path.join(directory, 'namespace.json'));
    await fs.rm(path.join(directory, 'results'), { recursive: true, force: true });
    await fs.rm(path.join(directory, 'pending'), { recursive: true, force: true });
    await fs.rm(temp);
  }

  // ---- 2. Anything else beside an absent namespace still fails closed.
  const hostile = [
    // a real managed directory
    { name: 'results', prep: dir => fs.mkdir(path.join(dir, 'results'), { recursive: true }) },
    // an arbitrary unknown file
    { name: 'notes.txt', prep: dir => fs.writeFile(path.join(dir, 'notes.txt'), 'keep', 'utf8') },
    // malformed temp names: bare .tmp, upper-case uuid, uuid without dashes, wrong base
    { name: 'namespace.json.tmp', prep: dir => fs.writeFile(path.join(dir, 'namespace.json.tmp'), '', 'utf8') },
    { name: tempName(UUIDS[0].toUpperCase()), prep: dir => fs.writeFile(path.join(dir, tempName(UUIDS[0].toUpperCase())), '', 'utf8') },
    { name: tempName('0123456789abcdef0123456789abcdef'), prep: dir => fs.writeFile(path.join(dir, tempName('0123456789abcdef0123456789abcdef')), '', 'utf8') },
    { name: 'other.json.' + UUIDS[1] + '.tmp', prep: dir => fs.writeFile(path.join(dir, `other.json.${UUIDS[1]}.tmp`), '', 'utf8') },
    // a DIRECTORY posing as one of our temps
    { name: tempName(UUIDS[1]), prep: dir => fs.mkdir(path.join(dir, tempName(UUIDS[1])), { recursive: true }) },
    // our temp beside an unrelated entry: still corruption
    { name: `${tempName(UUIDS[0])} + notes.txt`, prep: async dir => {
      await fs.writeFile(path.join(dir, tempName(UUIDS[0])), '', 'utf8');
      await fs.writeFile(path.join(dir, 'notes.txt'), 'keep', 'utf8');
    } }
  ];
  for (const [index, entry] of hostile.entries()) {
    const caseDirectory = path.join(base, 'hostile', String(index));
    await fs.mkdir(caseDirectory, { recursive: true });
    await entry.prep(caseDirectory);
    const before = (await fs.readdir(caseDirectory)).sort();
    const handle = new RunnerResults(caseDirectory, project);
    await assert.rejects(handle.open(), { code: 'runner_results_corrupt' },
      `${entry.name} beside an absent namespace must stay corruption`);
    await assert.rejects(handle.open(), { code: 'runner_results_unavailable' }, 'a failed handle stays unusable');
    assert.deepEqual((await fs.readdir(caseDirectory)).sort(), before, 'nothing was created, adopted or removed');
    assert.equal(await exists(path.join(caseDirectory, 'namespace.json')), false,
      'no namespace metadata was fabricated over it');
    await fs.rm(caseDirectory, { recursive: true, force: true });
  }

  // ---- 3. Symlink safety: a LINK at our temp name is never accepted, and no
  // write ever follows it. Skipped only when the platform refuses to link.
  const linkDirectory = path.join(base, 'hostile', 'link');
  await fs.mkdir(linkDirectory, { recursive: true });
  const outside = path.join(base, 'outside.json');
  await fs.writeFile(outside, '{"schema":1}', 'utf8');
  let linked = false;
  try {
    await fs.symlink(outside, path.join(linkDirectory, tempName(UUIDS[1])), 'file');
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    const before = await fs.readFile(outside, 'utf8');
    const handle = new RunnerResults(linkDirectory, project);
    await assert.rejects(handle.open(), { code: 'runner_results_corrupt' }, 'a symlinked temp name is corruption');
    assert.equal(await fs.readFile(outside, 'utf8'), before, 'the link target was never read or written');
    assert.equal(await exists(path.join(linkDirectory, 'namespace.json')), false);
  }
  await fs.rm(linkDirectory, { recursive: true, force: true });
});
