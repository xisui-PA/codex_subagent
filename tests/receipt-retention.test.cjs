// Focused regressions for receipt archive retention:
//  1. an epoch above the 32 MiB per-file cap is archived as deterministic
//     bounded parts, while the metadata-record cap and the physical directory
//     cap are enforced separately (never counted against each other);
//  2. a single-part archive keeps the legacy payload, in the caller's own key
//     order, so preexisting archive hashes/URIs stay valid;
//  3. archive collection publishes a durable deletion intent before unlinking,
//     and only an explicit scoped collection with the full retained set may
//     complete it - a restart must never delete a since-pinned archive.
// CODEX_TEST_BUILD selects the compile output so this file never reads the
// shared .test-build that the runner worker owns.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function loadBuildDir() {
  const dir = String(process.env.CODEX_TEST_BUILD || '.test-build').trim();
  return path.join(__dirname, '..', dir);
}
const buildDir = loadBuildDir();
const rules = require(path.join(buildDir, 'receipt-retention'));
const { TaskBoard } = require(path.join(buildDir, 'task-board'));
const { IsolatedViews } = require(path.join(buildDir, 'isolated-views'));
const { digest } = require(path.join(buildDir, 'storage'));

const MIB = 1024 ** 2;
const AT = '2026-01-01T00:00:00.000Z';
const TEAM = 'a'.repeat(32);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hex64 = index => index.toString(16).padStart(64, '0');
const legacyDocument = (namespace, ownerId, epoch, receipts) => Buffer.from(JSON.stringify({ schema: 1, namespace, ownerId, epoch, receipts }), 'utf8');
const archiveFile = (dir, archive) => path.join(dir, 'receipt-archives', `${archive.hash}.json.gz`);

async function tempBase(t, label) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `receipt-${label}-`));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

/** A schema-valid task record dense enough that many receipts exceed 32 MiB. */
function richTask(index) {
  return {
    id: hex64(index).slice(0, 32), teamId: TEAM, title: `rich-${index}`,
    description: 'd'.repeat(4000),
    acceptanceCriteria: Array.from({ length: 20 }, () => 'c'.repeat(500)),
    dependencies: [],
    assigneeWorkerId: null,
    progress: 'p'.repeat(4000),
    blockers: Array.from({ length: 16 }, () => 'b'.repeat(500)),
    state: 'accepted',
    candidates: Array.from({ length: 2 }, (_, i) => ({ id: `candidate-${i}`, version: 1, uri: `urn:candidate:${index}:${i}:` + 'u'.repeat(2000), label: 'l'.repeat(120) })),
    agreedContracts: Array.from({ length: 2 }, (_, i) => ({ id: `contract-${i}`, version: 1, uri: `urn:contract:${index}:${i}:` + 'u'.repeat(2000), label: 'l'.repeat(120) })),
    validations: Array.from({ length: 4 }, (_, i) => ({
      artifactId: 'candidate-0', candidateVersion: 1, outcome: 'passed', note: 'n'.repeat(500),
      resultRef: { id: `report-${i}`, version: 1, uri: `urn:report:${index}:${i}:` + 'u'.repeat(2000), label: 'r'.repeat(120) }, at: AT
    })),
    revision: 3, createdAt: AT, updatedAt: AT,
    history: {
      entries: Array.from({ length: 100 }, (_, i) => ({
        seq: i + 1, actor: { kind: 'coordinator', ownerId: 'parent' }, to: 'accepted', revision: i, reason: 'r'.repeat(300), at: AT
      })),
      lastSequence: 100, trimmed: 0
    }
  };
}

function richReceipts(count, teamId) {
  const receipts = {};
  for (let index = 0; index < count; index += 1) {
    const result = richTask(index); result.teamId = teamId;
    receipts[digest(['oversized', index])] = { fingerprint: digest(['fingerprint', index]), result, at: AT };
  }
  return receipts;
}

async function boardFixture(t, label) {
  const base = await tempBase(t, label);
  const root = path.join(base, 'root');
  const directory = path.join(base, 'storage');
  await fs.mkdir(root);
  const board = new TaskBoard(directory, root, () => undefined);
  await board.open();
  const team = await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'team', name: 'team', description: '' });
  const retentionDir = path.join(directory, 'board-retention');
  const archivesDir = path.join(retentionDir, 'receipt-archives');
  const reopen = async () => {
    await board.close();
    const next = new TaskBoard(directory, root, () => undefined);
    await next.open();
    return next;
  };
  return { base, root, directory, retentionDir, archivesDir, board, team, reopen };
}

const boardJson = async f => JSON.parse(await fs.readFile(path.join(f.directory, 'task-board.json'), 'utf8'));

test('an oversized board epoch archives as deterministic bounded parts and replays idempotently', { timeout: 180000 }, async t => {
  const f = await boardFixture(t, 'oversized');
  for (const [key, receipt] of Object.entries(richReceipts(512, f.team.id))) {
    f.board.data.requests[key] = receipt;
  }
  // The board's own team receipt is archived with the same epoch, so plan and
  // assert against the exact live map that rollover will select.
  const selected = { ...f.board.data.requests };
  const selectedBytes = Object.values(selected).reduce((total, receipt) => total + Buffer.byteLength(JSON.stringify(receipt), 'utf8'), 0);
  assert.ok(selectedBytes > 32 * MIB, `the fixture must exceed one 32 MiB archive (${selectedBytes} bytes)`);
  const planned = rules.planReceiptArchiveParts(digest(f.root), 'parent', 0, selected);
  assert.ok(planned.length >= 2, 'the oversized epoch needs more than one bounded part');
  for (const text of planned) {
    assert.ok(Buffer.byteLength(text, 'utf8') <= 32 * MIB, 'each planned part stays inside the byte cap');
  }

  const first = await f.board.rolloverReceipts('parent', 0);
  assert.equal(first.epoch, 1); assert.equal(first.prefix, 'e1:');
  assert.equal(first.archives.length, planned.length);
  assert.equal(first.archive, undefined, 'a multi-part epoch reports only its archive list');
  const archivedKeys = [];
  for (const archive of first.archives) {
    const bytes = await fs.readFile(archiveFile(f.retentionDir, archive));
    assert.ok(bytes.length <= 32 * MIB);
    const payload = JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
    assert.equal(payload.schema, 1); assert.equal(payload.ownerId, 'parent'); assert.equal(payload.epoch, 0);
    assert.equal(payload.part.count, first.archives.length);
    assert.ok(payload.part.index >= 1 && payload.part.index <= first.archives.length);
    archivedKeys.push(...Object.keys(payload.receipts));
    await rules.verifyArchive(f.retentionDir, archive);
  }
  assert.deepEqual(archivedKeys, Object.keys(selected).sort(), 'every receipt is archived exactly once');

  const durable = await boardJson(f);
  assert.equal(durable.schema, 2);
  assert.equal(Object.keys(durable.requests).length, 0, 'archived receipts left the live map');
  assert.deepEqual(durable.receiptArchives.map(archive => archive.hash), first.archives.map(archive => archive.hash));
  assert.deepEqual(durable.receiptEpochs, { [digest('parent')]: 1 });

  // The same epoch planned again reproduces the same identities, so a crash
  // before the commit can be retried without duplicate or renamed parts.
  const replayDir = path.join(f.base, 'replay');
  const replay = await rules.archiveReceipts(replayDir, digest(f.root), 'parent', 0, selected);
  assert.deepEqual(replay.map(archive => archive.hash), first.archives.map(archive => archive.hash));
  assert.equal((await fs.readdir(path.join(replayDir, 'receipt-archives'))).length, planned.length);

  const files = (await fs.readdir(f.archivesDir)).sort();
  assert.equal(files.length, planned.length);
  const retried = await f.board.rolloverReceipts('parent', 0);
  assert.equal(retried.replay, true); assert.equal(retried.epoch, 1);
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), files, 'replaying the epoch writes no further part');
});

test('archive records and directory files are bounded separately so the 64th archive still fits', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'capacity-split');
  await fs.mkdir(f.archivesDir, { recursive: true });
  const seeded = Array.from({ length: rules.MAX_RECEIPT_ARCHIVE_FILES - 1 }, (_, index) => {
    const hash = hex64(index);
    return { ownerId: 'parent', epoch: 0, hash, uri: `codex-subagent://receipts/seeded/${hash}/1` };
  });
  for (const archive of seeded) {
    await fs.writeFile(path.join(f.archivesDir, `${archive.hash}.json.gz`), 'retained bytes');
  }
  f.board.data.receiptArchives = seeded;

  // 63 recorded descriptors beside 63 files: the 64th archive is allowed, which
  // also proves the present files are not charged against the record capacity.
  const last = await f.board.rolloverReceipts('parent', 0);
  assert.equal(last.epoch, 1); assert.equal(last.archives.length, 1);
  assert.equal((await boardJson(f)).receiptArchives.length, 64);
  assert.equal((await fs.readdir(f.archivesDir)).length, 64);

  // The 65th has no record left and is rejected before publication.
  await assert.rejects(f.board.rolloverReceipts('parent', 1), error => error.code === 'receipt_capacity'
    && /receipt archives are retained/.test(error.message));
  assert.equal((await boardJson(f)).receiptArchives.length, 64);
  assert.equal((await fs.readdir(f.archivesDir)).length, 64, 'nothing was published for the rejected epoch');
  assert.equal(f.board.epoch('parent'), 1);

  // A file already unlinked before the final checkpoint still occupies a
  // metadata slot until the pending deletion is cleared.
  const pending = f.board.data.receiptArchives.pop();
  f.board.data.receiptArchiveDeletes = [pending];
  await fs.unlink(path.join(f.archivesDir, `${pending.hash}.json.gz`));
  await assert.rejects(f.board.rolloverReceipts('parent', 1), error => error.code === 'receipt_capacity');
  assert.equal((await fs.readdir(f.archivesDir)).length, 63);

  // The same split inside one call: 63 files present plus one remaining record
  // still fits, while zero remaining records is rejected actionably.
  const direct = path.join(f.base, 'direct');
  await fs.mkdir(path.join(direct, 'receipt-archives'), { recursive: true });
  for (const archive of seeded) {
    await fs.writeFile(path.join(direct, 'receipt-archives', `${archive.hash}.json.gz`), 'retained bytes');
  }
  const receipts = { [digest(['single', 0])]: { fingerprint: digest(['fingerprint']), result: { ok: true }, at: AT } };
  assert.equal((await rules.archiveReceipts(direct, digest('ns'), 'parent', 0, receipts, 1)).length, 1);
  assert.equal((await fs.readdir(path.join(direct, 'receipt-archives'))).length, 64);
  await assert.rejects(rules.archiveReceipts(direct, digest('ns'), 'parent', 1, receipts, 0), error => error.code === 'receipt_capacity'
    && /only 0 remain/.test(error.message) && /no archive part was published/.test(error.message));
  assert.equal((await fs.readdir(path.join(direct, 'receipt-archives'))).length, 64);
});

test('a full archive directory rejects an oversized epoch before any part is published', { timeout: 180000 }, async t => {
  const f = await boardFixture(t, 'capacity');
  for (const [key, receipt] of Object.entries(richReceipts(512, f.team.id))) {
    f.board.data.requests[key] = receipt;
  }
  const planned = rules.planReceiptArchiveParts(digest(f.root), 'parent', 0, f.board.data.requests);
  assert.ok(planned.length >= 2, 'the fixture must need more than one part');
  await fs.mkdir(f.archivesDir, { recursive: true });
  const preserved = Array.from({ length: rules.MAX_RECEIPT_ARCHIVE_FILES - 1 }, (_, index) => `unknown-${index}.bin`);
  for (const name of preserved) {
    await fs.writeFile(path.join(f.archivesDir, name), 'preserved foreign bytes');
  }

  await assert.rejects(f.board.rolloverReceipts('parent', 0), error => error.code === 'receipt_capacity'
    && /bounded to 64 files/.test(error.message) && /no archive part was published/.test(error.message));
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), preserved.sort(), 'unknown files are preserved and no partial part appears');
  const durable = await boardJson(f);
  assert.equal(durable.receiptEpochs, undefined, 'no requests were expired');
  assert.equal(durable.receiptArchives, undefined);
  assert.equal(f.board.epoch('parent'), 0);
});

test('an interrupted board archive collection resumes only on an explicit scoped collection', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'board-gc');
  await f.board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'second', name: 'second', description: '' });
  const first = await f.board.rolloverReceipts('parent', 0);
  const second = await f.board.rolloverReceipts('parent', 1);
  assert.equal(first.archives.length, 1); assert.equal(second.archives.length, 1);
  const unknown = path.join(f.archivesDir, 'unknown.bin');
  await fs.writeFile(unknown, 'foreign bytes are never unlinked');
  const before = (await boardJson(f)).receiptArchives;
  assert.equal(before.length, 2);

  // Crash after the durable intent and before the unlink.
  const original = rules.completeArchiveDeletions; let failures = 1;
  rules.completeArchiveDeletions = async (...args) => {
    if (failures) { failures -= 1; throw Error('simulated crash before unlink'); }
    return original(...args);
  };
  try {
    await assert.rejects(f.board.collectReceiptArchives('parent', new Set()), /simulated crash before unlink/);
  } finally { rules.completeArchiveDeletions = original; }
  const interrupted = await boardJson(f);
  assert.deepEqual(interrupted.receiptArchives, [], 'the reference removal is durable');
  assert.deepEqual(interrupted.receiptArchiveDeletes.map(archive => archive.hash), before.map(archive => archive.hash), 'the intent is durable');
  assert.equal(interrupted.schema, 2);
  for (const archive of before) {
    await assert.doesNotReject(fs.stat(archiveFile(f.retentionDir, archive)));
  }

  // Reopening keeps the intent and the files: open() holds no evidence/board
  // reference locks, so a since-pinned archive must not be deleted on restart.
  const reopened = await f.reopen();
  const afterOpen = await boardJson(f);
  assert.deepEqual(afterOpen.receiptArchiveDeletes.map(archive => archive.hash), before.map(archive => archive.hash));
  for (const archive of before) {
    await assert.doesNotReject(fs.stat(archiveFile(f.retentionDir, archive)));
  }

  // Protect the newer archive through one explicit collection.
  const pinned = second.archives[0].uri;
  assert.equal(await reopened.collectReceiptArchives('parent', new Set([pinned])), 1);
  const protecting = await boardJson(f);
  assert.deepEqual(protecting.receiptArchiveDeletes.map(archive => archive.uri), [pinned], 'the pinned identity stays pending');
  await assert.doesNotReject(fs.stat(archiveFile(f.retentionDir, second.archives[0])));
  await assert.rejects(fs.stat(archiveFile(f.retentionDir, first.archives[0])), error => error.code === 'ENOENT');

  // Releasing the pin lets the next collection finish it.
  assert.equal(await reopened.collectReceiptArchives('parent', new Set()), 1);
  const done = await boardJson(f);
  assert.equal(done.receiptArchiveDeletes, undefined, 'the completed intent is cleared');
  assert.deepEqual(done.receiptArchives, []);
  assert.equal(done.schema, 2, 'recovery never downgrades the board schema');
  assert.deepEqual(await fs.readdir(f.archivesDir), ['unknown.bin'], 'only verified scoped files were deleted');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'foreign bytes are never unlinked');
  assert.equal(await reopened.collectReceiptArchives('parent', new Set()), 0, 'a further retry is idempotent');
  await reopened.close();

  // Another owner's pending identity survives this owner's collection intact.
  const foreign = { ownerId: 'other', epoch: 0, hash: hex64(999), uri: 'codex-subagent://receipts/other/x/1' };
  const seeded = await boardJson(f);
  seeded.receiptArchiveDeletes = [foreign];
  await fs.writeFile(path.join(f.directory, 'task-board.json'), JSON.stringify(seeded));
  const third = new TaskBoard(f.directory, f.root, () => undefined);
  await third.open();
  try {
    assert.equal(await third.collectReceiptArchives('parent', new Set()), 0);
    assert.deepEqual((await boardJson(f)).receiptArchiveDeletes, [foreign]);
    assert.deepEqual(await fs.readdir(f.archivesDir), ['unknown.bin']);
  } finally { await third.close(); }
});

test('an interrupted view archive collection resumes only on an explicit scoped collection', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-gc');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root);
  const archivesDir = path.join(store, 'receipt-archives');
  const indexFile = path.join(store, 'index.json');
  const views = new IsolatedViews(store, root);
  await views.open();
  const first = await views.rolloverReceipts('parent', 0);
  const second = await views.rolloverReceipts('parent', 1);
  assert.equal(first.archives.length, 1); assert.equal(second.archives.length, 1);
  await fs.mkdir(archivesDir, { recursive: true });
  const unknown = path.join(archivesDir, 'unknown.bin');
  await fs.writeFile(unknown, 'foreign bytes are never unlinked');
  const pinned = second.archives[0].uri;

  const original = rules.completeArchiveDeletions; let failures = 1;
  rules.completeArchiveDeletions = async (...args) => {
    if (failures) { failures -= 1; throw Error('simulated crash before unlink'); }
    return original(...args);
  };
  try {
    await assert.rejects(views.collectReceiptArchives('parent', new Set()), /simulated crash before unlink/);
  } finally { rules.completeArchiveDeletions = original; }
  const interrupted = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.deepEqual(interrupted.receiptArchives, []);
  assert.deepEqual(interrupted.receiptArchiveDeletes.map(archive => archive.hash), [first.archives[0].hash, second.archives[0].hash]);
  assert.equal(interrupted.receiptArchiveDeletes[1].uri, pinned, 'the intent keeps the exact identity and scope');
  await views.close();

  // Reopening preserves the intent and both files.
  const reopened = new IsolatedViews(store, root);
  await reopened.open();
  try {
    const afterOpen = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.equal(afterOpen.receiptArchiveDeletes.length, 2);
    await assert.doesNotReject(fs.stat(path.join(archivesDir, `${second.archives[0].hash}.json.gz`)));

    assert.equal(await reopened.collectReceiptArchives('parent', new Set([pinned])), 1);
    const protecting = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.deepEqual(protecting.receiptArchiveDeletes.map(archive => archive.uri), [pinned]);
    await assert.doesNotReject(fs.stat(path.join(archivesDir, `${second.archives[0].hash}.json.gz`)));
    await assert.rejects(fs.stat(path.join(archivesDir, `${first.archives[0].hash}.json.gz`)), error => error.code === 'ENOENT');

    assert.equal(await reopened.collectReceiptArchives('parent', new Set()), 1);
    const done = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.equal(done.receiptArchiveDeletes, undefined);
    assert.deepEqual(done.receiptArchives, []);
    assert.deepEqual(await fs.readdir(archivesDir), ['unknown.bin']);
  } finally { await reopened.close(); }
});

test('a single-part epoch keeps the legacy payload, source key order and identity', async t => {
  const base = await tempBase(t, 'legacy');
  const namespace = digest(base);
  // Deliberately unsorted insertion order: the legacy document preserved it.
  const receipts = {};
  receipts[digest(['zeta'])] = { fingerprint: digest(['fz']), result: { sealed: 3 }, at: AT };
  receipts[digest(['alpha'])] = { fingerprint: digest(['fa']), result: { sealed: 1 }, at: AT };
  receipts[digest(['mu'])] = { fingerprint: digest(['fm']), result: { sealed: 2 }, at: AT };

  const archived = await rules.archiveReceipts(base, namespace, 'parent', 0, receipts);
  assert.equal(archived.length, 1);
  const file = archiveFile(base, archived[0]);
  assert.equal(archived[0].hash, sha256(zlib.gzipSync(legacyDocument(namespace, 'parent', 0, receipts))));

  const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(file)).toString('utf8'));
  assert.equal(payload.part, undefined, 'a single part adds no partition metadata');
  assert.deepEqual(Object.keys(payload.receipts), Object.keys(receipts), 'source key order is preserved');
  assert.deepEqual(payload.receipts, receipts);
  assert.equal((await rules.archiveReceipts(base, namespace, 'parent', 0, receipts))[0].hash, archived[0].hash);
  assert.deepEqual(await fs.readdir(path.join(base, 'receipt-archives')), [`${archived[0].hash}.json.gz`]);
  await rules.verifyArchive(base, archived[0]);

  // A changed scope or a tampered file fails closed instead of being deleted.
  await assert.rejects(rules.verifyArchive(base, { ...archived[0], ownerId: 'other' }), error => error.code === 'receipt_corrupt');
  await fs.writeFile(file, 'tampered');
  await assert.rejects(rules.completeArchiveDeletions(base, archived), error => error.code === 'receipt_corrupt');
  assert.equal(await fs.readFile(file, 'utf8'), 'tampered');
});

// --- Durable archive publication recovery ----------------------------------

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
/** A recorded receipt archive is a gzip part, never plain JSON. */
const readArchiveFile = async (dir, archive) => JSON.parse(zlib.gunzipSync(await fs.readFile(archiveFile(dir, archive))).toString('utf8'));

/** The exact part bytes a frozen publication intent expects to find or open. */
function plannedPartBytes(pending, receipts) {
  return rules.planReceiptArchiveParts(pending.namespace, pending.ownerId, pending.fromEpoch, receipts)
    .map(text => zlib.gzipSync(Buffer.from(text, 'utf8')));
}

/** Opens the first planned part, then fails: an interrupted publication. */
async function crashDuringPublication(directory, pending, receipts) {
  const parts = plannedPartBytes(pending, receipts);
  await fs.mkdir(path.join(directory, 'receipt-archives'), { recursive: true });
  await fs.writeFile(archiveFile(directory, pending.archives[0]), parts[0]);
  throw new Error('simulated crash during archive publication');
}

test('a board rollover publishes only after a durable intent and resumes it exactly', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'board-publication');
  const boardFile = path.join(f.directory, 'task-board.json');
  const frozenKeys = Object.keys(f.board.data.requests);
  assert.equal(frozenKeys.length, 1);
  const planned = rules.planArchivePublication(digest(f.root), 'parent', 0, f.board.data.requests);
  assert.equal(planned.archives.length, 1);
  assert.deepEqual(planned.receiptKeys, frozenKeys, 'the intent freezes the exact receipt selection');

  const original = rules.publishArchivePublication;
  rules.publishArchivePublication = crashDuringPublication;
  try {
    await assert.rejects(f.board.rolloverReceipts('parent', 0), /simulated crash during archive publication/);
  } finally { rules.publishArchivePublication = original; }

  // The intent, not the archive record, is durable: the opened part is named
  // by published metadata and the epoch never advanced.
  const interrupted = await readJson(boardFile);
  assert.equal(interrupted.schema, 2);
  assert.deepEqual(interrupted.receiptArchivePublications, [planned]);
  assert.equal(interrupted.receiptEpochs, undefined, 'no epoch was committed');
  assert.equal(interrupted.receiptArchives, undefined, 'no archive record was committed');
  assert.deepEqual(await fs.readdir(f.archivesDir), [`${planned.archives[0].hash}.json.gz`]);
  assert.equal(JSON.stringify(interrupted).includes(planned.archives[0].hash), true, 'the opened part is reachable');
  assert.equal(f.board.epoch('parent'), 0);

  // No other epoch may be published under this intent's authority.
  await assert.rejects(f.board.rolloverReceipts('parent', 4), error => error.code === 'revision_conflict'
    && /pending receipt archive publication for epoch 0/.test(error.message));
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [planned]);

  // A permissible receipt is still accepted in the current epoch. It is not part
  // of the frozen identity, and it must not be stranded by the retry.
  await f.board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'second', name: 'second', description: '' });
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [planned]);

  // Reload: the intent and its part survive, and collection leaves both alone.
  const reopened = await f.reopen();
  assert.equal(await reopened.collectReceiptArchives('parent', new Set()), 0, 'a pending publication is not collected as an orphan');
  assert.deepEqual(await fs.readdir(f.archivesDir), [`${planned.archives[0].hash}.json.gz`]);
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [planned]);

  // The exact retry completes the frozen publication: same hashes, same URIs.
  const resumed = await reopened.rolloverReceipts('parent', 0);
  assert.equal(resumed.epoch, 1);
  assert.equal(resumed.replay, true);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.archives, planned.archives);
  assert.equal(resumed.archive.hash, planned.archives[0].hash);
  assert.equal(resumed.retainedUnscopedLegacyReceipts, 1, 'the receipt accepted after the intent is reported as retained');
  await rules.verifyArchive(f.retentionDir, planned.archives[0]);
  const committed = await readJson(boardFile);
  assert.equal(committed.receiptArchivePublications, undefined, 'the completed intent is cleared');
  assert.deepEqual(committed.receiptArchives, planned.archives);
  assert.deepEqual(committed.receiptEpochs, { [digest('parent')]: 1 });
  assert.equal(Object.keys(committed.requests).length, 1, 'the receipt added during the interruption stays live');
  assert.deepEqual(await fs.readdir(f.archivesDir), [`${planned.archives[0].hash}.json.gz`], 'no part was opened twice');

  // The retained receipt keeps its exact replay after the epoch advance...
  const replayedTeam = await reopened.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'second', name: 'second', description: '' });
  assert.equal(replayedTeam.name, 'second');
  // ...while a new operation needs the new prefix and the archived ID stays retired.
  await assert.rejects(reopened.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'third', name: 'third', description: '' }), error => error.code === 'request_expired');
  await assert.rejects(reopened.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'team', name: 'different', description: '' }), error => error.code === 'request_expired');
  assert.equal((await reopened.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:third', name: 'third', description: '' })).name, 'third');

  // The next epoch archives the retained receipts; afterwards their IDs are gone.
  const next = await reopened.rolloverReceipts('parent', 1);
  assert.equal(next.epoch, 2);
  assert.equal(next.archives.length, 1);
  assert.notEqual(next.archives[0].hash, planned.archives[0].hash);
  assert.equal(next.retainedUnscopedLegacyReceipts, 0);
  await assert.rejects(reopened.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'second', name: 'second', description: '' }), error => error.code === 'request_expired');
  assert.equal((await fs.readdir(f.archivesDir)).length, 2);
  assert.equal(await reopened.collectReceiptArchives('parent', new Set()), 2);
  assert.deepEqual(await fs.readdir(f.archivesDir), []);
  const collected = await readJson(boardFile);
  assert.deepEqual(collected.receiptArchives, []);
  assert.equal(collected.receiptArchivePublications, undefined);
  await reopened.close();
});

test('a resumed board publication is bounded by the directory cap and stays reclaimable', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'board-publication-capacity');
  const boardFile = path.join(f.directory, 'task-board.json');
  const original = rules.publishArchivePublication;
  let attempts = 0;
  rules.publishArchivePublication = async () => { attempts += 1; throw new Error('simulated crash before any part'); };
  try {
    await assert.rejects(f.board.rolloverReceipts('parent', 0), /simulated crash before any part/);
  } finally { rules.publishArchivePublication = original; }
  assert.equal(attempts, 1, 'the intent is durable before publication is attempted');
  const pending = (await readJson(boardFile)).receiptArchivePublications[0];
  assert.equal(pending.archives.length, 1);
  assert.deepEqual(await fs.readdir(f.archivesDir).catch(() => []), [], 'nothing was opened yet');

  // A full directory rejects the retry before any part is opened, and the intent
  // survives for a later attempt instead of being dropped or orphaned.
  await fs.mkdir(f.archivesDir, { recursive: true });
  const foreign = Array.from({ length: rules.MAX_RECEIPT_ARCHIVE_FILES }, (_, index) => `foreign-${index}.bin`);
  for (const name of foreign) {
    await fs.writeFile(path.join(f.archivesDir, name), 'foreign bytes are never unlinked');
  }
  const before = (await fs.readdir(f.archivesDir)).sort();
  await assert.rejects(f.board.rolloverReceipts('parent', 0), error => error.code === 'receipt_capacity'
    && /bounded to 64 files/.test(error.message) && /no archive part was published/.test(error.message));
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), before, 'nothing was published while blocked');
  assert.equal(f.board.epoch('parent'), 0);
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [pending]);

  // Freeing exactly one directory slot lets the same intent complete unchanged.
  await fs.unlink(path.join(f.archivesDir, foreign[0]));
  const resumed = await f.board.rolloverReceipts('parent', 0);
  assert.deepEqual(resumed.archives, pending.archives);
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), [...foreign.slice(1), `${pending.archives[0].hash}.json.gz`].sort());
  assert.deepEqual((await readJson(boardFile)).receiptArchives, pending.archives);
  // The resumed part is a recorded archive, so collection can reclaim it.
  assert.equal(await f.board.collectReceiptArchives('parent', new Set()), 1);
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), foreign.slice(1).sort());
});

test('a pending board publication keeps its owner and reserves a shared archive record', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'board-publication-owner');
  const boardFile = path.join(f.directory, 'task-board.json');
  await fs.mkdir(f.archivesDir, { recursive: true });
  const seeded = Array.from({ length: rules.MAX_RECEIPT_ARCHIVE_FILES - 2 }, (_, index) => {
    const hash = hex64(index);
    return { ownerId: 'parent', epoch: 0, hash, uri: `codex-subagent://receipts/seeded/${hash}/1` };
  });
  for (const archive of seeded) {
    await fs.writeFile(path.join(f.archivesDir, `${archive.hash}.json.gz`), 'retained bytes');
  }
  f.board.data.receiptArchives = seeded;
  const foreignIntent = rules.planArchivePublication(digest(f.root), 'other', 0, { [hex64(999)]: { fingerprint: hex64(998), result: { ok: true }, at: AT } });
  f.board.data.receiptArchivePublications = [foreignIntent];

  // 62 retained records plus 1 reserved by another owner's intent leave exactly
  // one record, so this owner's single part still fits.
  const parent = await f.board.rolloverReceipts('parent', 0);
  assert.equal(parent.epoch, 1);
  assert.deepEqual(parent.archives.map(archive => archive.ownerId), ['parent']);
  assert.equal(parent.retainedUnscopedLegacyReceipts, 0);
  const durable = await readJson(boardFile);
  assert.deepEqual(durable.receiptArchivePublications, [foreignIntent], 'the other owner\'s intent is untouched, never resumed here');
  assert.deepEqual(durable.receiptEpochs, { [digest('parent')]: 1 }, 'only this owner\'s epoch advanced');
  assert.equal(durable.receiptArchives.length, rules.MAX_RECEIPT_ARCHIVE_FILES - 1);

  // The reserved record is still unavailable: this owner's next epoch is
  // rejected actionably and publishes nothing.
  const files = (await fs.readdir(f.archivesDir)).sort();
  await assert.rejects(f.board.rolloverReceipts('parent', 1), error => error.code === 'receipt_capacity'
    && /pending publication/.test(error.message));
  assert.deepEqual((await fs.readdir(f.archivesDir)).sort(), files, 'nothing was published for the rejected epoch');
  assert.equal(f.board.epoch('parent'), 1);
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [foreignIntent]);

  // A wrong-epoch request can never resume the foreign intent.
  await assert.rejects(f.board.rolloverReceipts('other', 3), error => error.code === 'revision_conflict'
    && /pending receipt archive publication for epoch 0/.test(error.message));
  assert.deepEqual((await readJson(boardFile)).receiptArchivePublications, [foreignIntent]);
  assert.equal(f.board.epoch('other'), 0);
});

test('a view rollover publishes only after a durable intent and resumes it across reloads', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-publication');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root); await fs.mkdir(store);
  const indexFile = path.join(store, 'index.json');
  const archivesDir = path.join(store, 'receipt-archives');
  const key = { other: hex64(21), parent: hex64(22) };
  const seeded = {
    schema: 1, root, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {}, pendingCaptures: {},
    receipts: {
      [key.other]: { fingerprint: hex64(31), result: { sealed: 'other' } },
      [key.parent]: { fingerprint: hex64(32), result: { sealed: 'parent' } }
    },
    receiptOwners: { [key.other]: 'other', [key.parent]: 'parent' }
  };
  await fs.writeFile(indexFile, JSON.stringify(seeded));
  const views = new IsolatedViews(store, root);
  await views.open();
  const otherSelected = { [key.other]: seeded.receipts[key.other] };
  const planned = rules.planArchivePublication(views.namespace, 'other', 0, otherSelected);
  assert.equal(planned.archives.length, 1);

  const original = rules.publishArchivePublication;
  rules.publishArchivePublication = crashDuringPublication;
  try {
    await assert.rejects(views.rolloverReceipts('other', 0), /simulated crash during archive publication/);
  } finally { rules.publishArchivePublication = original; }

  const interrupted = await readJson(indexFile);
  assert.deepEqual(interrupted.receiptArchivePublications, [planned]);
  assert.equal(interrupted.receiptEpochs, undefined);
  assert.equal(interrupted.receiptArchives, undefined);
  assert.equal(Object.keys(interrupted.receipts).length, 2, 'no receipt left the live map');
  assert.deepEqual(await fs.readdir(archivesDir), [`${planned.archives[0].hash}.json.gz`]);
  await views.close();

  // Reload keeps the intent and the opened part; another owner's rollover does
  // not resume it, so no epoch is published under a foreign authority.
  const reopened = new IsolatedViews(store, root);
  await reopened.open();
  assert.deepEqual((await readJson(indexFile)).receiptArchivePublications, [planned]);
  await assert.rejects(reopened.rolloverReceipts('other', 2), error => error.code === 'revision_conflict'
    && /pending receipt archive publication for epoch 0/.test(error.message));
  const parent = await reopened.rolloverReceipts('parent', 0);
  assert.equal(parent.epoch, 1);
  assert.equal(parent.retainedUnscopedLegacyReceipts, 1, 'the other owner\'s receipt stays live');
  const partial = await readJson(indexFile);
  assert.deepEqual(partial.receiptArchivePublications, [planned], 'the foreign intent survives');
  assert.deepEqual(partial.receiptEpochs, { [digest('parent')]: 1 });
  assert.deepEqual(partial.receiptArchives.map(archive => archive.ownerId), ['parent']);
  assert.equal(Object.keys(partial.receipts).length, 1);

  // Its own exact retry completes it, and each archive keeps its own owner scope.
  const resumed = await reopened.rolloverReceipts('other', 0);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.archives, planned.archives);
  const durable = await readJson(indexFile);
  assert.equal(durable.receiptArchivePublications, undefined);
  assert.deepEqual(durable.receiptEpochs, { [digest('other')]: 1, [digest('parent')]: 1 });
  assert.deepEqual(durable.receiptArchives.map(archive => archive.ownerId).sort(), ['other', 'parent']);
  assert.deepEqual(Object.keys(durable.receipts), []);
  const otherArchive = durable.receiptArchives.find(archive => archive.ownerId === 'other');
  const parentArchive = durable.receiptArchives.find(archive => archive.ownerId === 'parent');
  assert.equal(otherArchive.hash, planned.archives[0].hash);
  const otherPayload = JSON.parse(zlib.gunzipSync(await fs.readFile(archiveFile(store, otherArchive))).toString('utf8'));
  assert.deepEqual(Object.keys(otherPayload.receipts), [key.other]);
  const parentPayload = JSON.parse(zlib.gunzipSync(await fs.readFile(archiveFile(store, parentArchive))).toString('utf8'));
  assert.deepEqual(Object.keys(parentPayload.receipts), [key.parent]);
  assert.equal((await fs.readdir(archivesDir)).length, 2);
  // Replaying the completed epoch publishes nothing further.
  const replay = await reopened.rolloverReceipts('other', 0);
  assert.equal(replay.replay, true);
  assert.equal(replay.epoch, 1);
  assert.equal((await fs.readdir(archivesDir)).length, 2);
  await reopened.close();
});

// --- Legacy receipt compatibility ------------------------------------------
//
// Ordinary (ungoverned) workflows may use their own epoch-looking request IDs,
// and a scoped rollover must be able to reclaim legacy receipts that carry no
// ownership metadata without ever reaching another owner's receipt.

const viewSnapshot = (id, ownerId, manifestHash) =>
  ({ id, teamId: TEAM, ownerId, manifestHash, backing: { kind: 'cas' }, createdAt: AT });
/** The views' own multi-part digest: sha256 over the JSON of the argument list. */
const viewDigest = (...parts) => sha256(JSON.stringify(parts));
const viewDocument = (root, extra) => ({
  schema: 1, root, revision: 0, snapshots: {}, overlays: {}, submissions: {}, pins: {}, pendingCaptures: {}, receipts: {}, ...extra
});
async function seedIndex(store, root, extra) {
  await fs.mkdir(store, { recursive: true });
  const file = path.join(store, 'index.json');
  await fs.writeFile(file, JSON.stringify(viewDocument(root, extra)));
  return file;
}

test('an ungoverned board accepts fresh epoch-prefixed request IDs and retires them at rollover', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'ungoverned-board');
  const root = path.join(base, 'root'); const directory = path.join(base, 'storage');
  await fs.mkdir(root);
  const openBoard = async policy => {
    const board = new TaskBoard(directory, root, () => undefined, undefined, policy);
    await board.open();
    return board;
  };

  // A governed initial namespace still reserves a pre-used epoch identity: the
  // same ID would later name a different operation.
  const governed = await openBoard(undefined);
  try {
    await assert.rejects(governed.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'governed', description: '' }),
      error => error.code === 'invalid_arguments' && /reserved for rollover/.test(error.message));
    assert.equal(Object.keys(governed.data.requests).length, 0, 'a reserved identity creates no receipt');
  } finally { await governed.close(); }

  // The trusted live flag, not the request, decides: the same call is rejected
  // until the host reports an ungoverned namespace.
  let ordinary = false;
  const board = await openBoard({ ordinaryRequestIds: () => ordinary });
  try {
    await assert.rejects(board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'ordinary', description: '' }),
      error => error.code === 'invalid_arguments');
    ordinary = true;
    const team = await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'ordinary', description: '' });
    assert.equal(team.name, 'ordinary');
    assert.equal((await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'ordinary', description: '' })).id, team.id,
      'the ordinary identity keeps its exact replay');
    await assert.rejects(board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'changed', description: '' }),
      error => error.code === 'request_reuse_conflict');

    // Rollover retires the pre-used identity: it never becomes a fresh operation.
    const rolled = await board.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1); assert.equal(rolled.prefix, 'e1:');
    await assert.rejects(board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:team', name: 'ordinary', description: '' }),
      error => error.code === 'request_expired');
    // An existing epoch still rejects a foreign or stale prefix, ungoverned or not.
    await assert.rejects(board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e2:other', name: 'x', description: '' }),
      error => error.code === 'request_expired');
    // The first rollover froze the whole live map, so an owner still at epoch 0
    // cannot pre-use an epoch identity in this store any more.
    await assert.rejects(board.createTeam({ kind: 'coordinator', ownerId: 'other' }, { requestId: 'e9:team', name: 'x', description: '' }),
      error => error.code === 'invalid_arguments');
    assert.equal((await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:fresh', name: 'fresh', description: '' })).name, 'fresh');
    assert.equal((await board.createTeam({ kind: 'coordinator', ownerId: 'other' }, { requestId: 'plain', name: 'plain', description: '' })).name, 'plain');
  } finally { await board.close(); }
});

test('an ungoverned view namespace accepts fresh epoch-prefixed request IDs only before rollover', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'ungoverned-views');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root);
  const snapshot = viewSnapshot(hex64(5), 'parent', hex64(905));
  await seedIndex(store, root, { snapshots: { [snapshot.id]: snapshot } });
  const release = (views, ownerId, requestId) =>
    views.release({ ownerId, teamId: TEAM, requestId, kind: 'snapshot', id: snapshot.id });
  const ack = { released: true, kind: 'snapshot', id: snapshot.id };

  const governed = new IsolatedViews(store, root);
  await governed.open();
  try {
    await assert.rejects(release(governed, 'parent', 'e1:release'),
      error => error.code === 'invalid_arguments' && /reserved for rollover/.test(error.message));
  } finally { await governed.close(); }

  // Only the live host flag allows it: the request itself cannot widen anything.
  const views = new IsolatedViews(store, root, { governanceEnabled: () => false });
  await views.open();
  try { assert.deepEqual(await release(views, 'parent', 'e1:release'), ack); } finally { await views.close(); }

  // A reloaded handle replays the ordinary identity, then retires it.
  const reopened = new IsolatedViews(store, root, { governanceEnabled: () => false });
  await reopened.open();
  try {
    assert.deepEqual(await release(reopened, 'parent', 'e1:release'), ack);
    const rolled = await reopened.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1); assert.equal(rolled.prefix, 'e1:');
    await assert.rejects(release(reopened, 'parent', 'e1:release'), error => error.code === 'request_expired');
    await assert.rejects(release(reopened, 'parent', 'e2:stale'), error => error.code === 'request_expired');
    await assert.rejects(release(reopened, 'other', 'e7:late'), error => error.code === 'invalid_arguments');
    assert.deepEqual(await release(reopened, 'parent', 'e1:second'), ack);
  } finally { await reopened.close(); }
});

test('a scoped rollover reclaims only the legacy receipts it can prove it owns', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-mixed-proof');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root);
  const parentSnapshot = viewSnapshot(hex64(1), 'parent', hex64(901));
  const otherSnapshot = viewSnapshot(hex64(2), 'other', hex64(902));
  const keys = {
    parentRecord: hex64(11), otherRecord: hex64(12), otherRelease: hex64(13),
    parentRelease: hex64(14), ambiguous: hex64(15), ownerMap: hex64(16)
  };
  const snapshots = { [parentSnapshot.id]: parentSnapshot, [otherSnapshot.id]: otherSnapshot };
  const indexFile = await seedIndex(store, root, {
    snapshots,
    receipts: {
      [keys.parentRecord]: { fingerprint: hex64(31), result: parentSnapshot },
      [keys.otherRecord]: { fingerprint: hex64(32), result: otherSnapshot },
      [keys.otherRelease]: { fingerprint: hex64(33), result: { released: true, kind: 'snapshot', id: otherSnapshot.id } },
      [keys.parentRelease]: { fingerprint: hex64(34), result: { released: true, kind: 'snapshot', id: parentSnapshot.id } },
      [keys.ambiguous]: { fingerprint: hex64(35), result: { preserved: 0 } },
      [keys.ownerMap]: { fingerprint: hex64(36), result: { preserved: 1 } }
    },
    receiptOwners: { [keys.ownerMap]: 'parent' }
  });
  const views = new IsolatedViews(store, root);
  await views.open();
  const readPayload = async archive => JSON.parse(zlib.gunzipSync(await fs.readFile(archiveFile(store, archive))).toString('utf8'));
  try {
    const rolled = await views.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1);
    assert.equal(rolled.retainedUnscopedLegacyReceipts, 3, 'another owner and an unprovable receipt are never taken');
    assert.equal(rolled.archives.length, 1);
    assert.equal(rolled.archives[0].ownerId, 'parent');
    const payload = await readPayload(rolled.archives[0]);
    assert.deepEqual(Object.keys(payload.receipts), [keys.parentRecord, keys.parentRelease, keys.ownerMap],
      'a validated record, an exact artifact id and the ownership map are the only evidence');
    assert.deepEqual(payload.receipts[keys.parentRecord].result, parentSnapshot, 'immutable results are archived verbatim');
    await rules.verifyArchive(store, rolled.archives[0]);

    const durable = await readJson(indexFile);
    assert.deepEqual(Object.keys(durable.receipts), [keys.otherRecord, keys.otherRelease, keys.ambiguous], 'the other owner keeps its live receipts');
    assert.deepEqual(durable.receiptEpochs, { [digest('parent')]: 1 });
    assert.deepEqual(durable.receiptOwners ?? {}, {}, 'ownership records follow their receipts');
    assert.deepEqual(durable.snapshots, snapshots, 'rollover never touches shared records');

    // The other owner reclaims exactly its own receipts, never the ambiguity.
    const other = await views.rolloverReceipts('other', 0);
    assert.equal(other.epoch, 1);
    assert.equal(other.retainedUnscopedLegacyReceipts, 1);
    const otherPayload = await readPayload(other.archives[0]);
    assert.deepEqual(Object.keys(otherPayload.receipts), [keys.otherRecord, keys.otherRelease]);
    assert.deepEqual(otherPayload.receipts[keys.otherRecord].result, otherSnapshot);
    assert.deepEqual(Object.keys((await readJson(indexFile)).receipts), [keys.ambiguous],
      'an unprovable legacy receipt is never guessed into an archive');
    assert.equal((await fs.readdir(path.join(store, 'receipt-archives'))).length, 2);
  } finally { await views.close(); }
});

test('an exact authorized replay adopts a legacy receipt whose payload proves no owner', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-adopt');
  const root = path.join(base, 'root');
  await fs.mkdir(root);
  const releasedId = hex64(9);
  const foreignKey = hex64(41);
  const recordKey = hex64(42);
  const parentSnapshot = viewSnapshot(hex64(3), 'parent', hex64(903));
  const seed = async label => {
    const store = path.join(base, label);
    const namespace = sha256(path.resolve(store));
    const releaseKey = viewDigest('release', namespace, 'parent', TEAM, 'adopt-1');
    const indexFile = await seedIndex(store, root, {
      snapshots: { [parentSnapshot.id]: parentSnapshot },
      receipts: {
        [foreignKey]: { fingerprint: hex64(51), result: { note: 'other owner' } },
        [releaseKey]: { fingerprint: viewDigest('release', 'parent', TEAM, 'snapshot', releasedId), result: { released: true, kind: 'snapshot', id: releasedId } },
        [recordKey]: { fingerprint: hex64(52), result: parentSnapshot }
      },
      receiptOwners: { [foreignKey]: 'other' }
    });
    return { store, indexFile, namespace, releaseKey };
  };
  const replay = async (store, requestId) => {
    const views = new IsolatedViews(store, root);
    await views.open();
    try {
      return { views, result: await views.release({ ownerId: 'parent', teamId: TEAM, requestId, kind: 'snapshot', id: releasedId }) };
    } catch (error) {
      await views.close();
      throw error;
    }
  };

  // Nothing has proven an owner yet: the acknowledgement stays live for its own
  // owner, and the shape of the index is never used as a substitute for proof.
  const unproven = await seed('unproven');
  const held = new IsolatedViews(unproven.store, root);
  await held.open();
  try {
    const rolled = await held.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1);
    assert.equal(rolled.retainedUnscopedLegacyReceipts, 2, 'the unprovable acknowledgement is never archived');
    const payload = await readArchiveFile(unproven.store, rolled.archives[0]);
    assert.deepEqual(Object.keys(payload.receipts), [recordKey], 'only the record-proven receipt is archived');
    assert.deepEqual(Object.keys((await readJson(unproven.indexFile)).receipts), [foreignKey, unproven.releaseKey]);
  } finally { await held.close(); }

  // The same exact replay is durable ownership proof, published with the next
  // authorized update, so a reloaded handle can reclaim the receipt.
  const adopted = await seed('adopted');
  const proof = await replay(adopted.store, 'adopt-1');
  try {
    await proof.views.cleanup({ ownerId: 'parent', teamId: TEAM, requestId: 'flush' });
    const flushed = await readJson(adopted.indexFile);
    assert.equal(flushed.receiptOwners[adopted.releaseKey], 'parent', 'the replay is published as durable ownership');
    assert.equal(flushed.receiptOwners[foreignKey], 'other', 'another owner keeps its own record');
  } finally { await proof.views.close(); }

  const view = new IsolatedViews(adopted.store, root);
  await view.open();
  try {
    const rolled = await view.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1);
    const cleanupKey = viewDigest('cleanup', adopted.namespace, 'parent', TEAM, 'flush');
    // A receipt accepted by this handle carries its owner, so only the other
    // owner's receipt stays live; nothing unproven was reclaimed.
    assert.equal(rolled.retainedUnscopedLegacyReceipts, 1, 'only the other owner receipt stays live');
    const payload = await readArchiveFile(adopted.store, rolled.archives[0]);
    assert.equal(payload.receipts[adopted.releaseKey].result.id, releasedId, 'the adopted receipt is archived under its own owner');
    assert.deepEqual(Object.keys(payload.receipts).sort(), [adopted.releaseKey, recordKey, cleanupKey].sort());
    assert.equal(payload.receipts[foreignKey], undefined, 'another owner receipt is never archived');
    const durable = await readJson(adopted.indexFile);
    assert.deepEqual(Object.keys(durable.receipts), [foreignKey]);
    assert.equal(durable.receiptOwners?.[adopted.releaseKey], undefined, 'the archived identity keeps its proof in the archive owner');
    assert.deepEqual(durable.receiptEpochs, { [digest('parent')]: 1 });
  } finally { await view.close(); }
});

test('a scoped rollover reclaims proven legacy receipts at the full receipt cap', { timeout: 180000 }, async t => {
  const base = await tempBase(t, 'views-cap');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root);
  const parentSnapshot = viewSnapshot(hex64(1), 'parent', hex64(901));
  const otherSnapshot = viewSnapshot(hex64(2), 'other', hex64(902));
  const receipts = {}; const parentKeys = []; const otherKeys = [];
  // A full receipt map with NO ownership metadata at all: only the validated
  // record each acknowledgement returned can attribute a receipt.
  for (let index = 0; index < 2048; index += 1) {
    const parentKey = hex64(index + 1000); const otherKey = hex64(index + 5000);
    receipts[parentKey] = { fingerprint: hex64(index + 9000), result: parentSnapshot };
    receipts[otherKey] = { fingerprint: hex64(index + 12000), result: otherSnapshot };
    parentKeys.push(parentKey); otherKeys.push(otherKey);
  }
  const indexFile = await seedIndex(store, root, { snapshots: { [parentSnapshot.id]: parentSnapshot, [otherSnapshot.id]: otherSnapshot }, receipts });
  const views = new IsolatedViews(store, root);
  await views.open();
  try {
    assert.equal(Object.keys((await readJson(indexFile)).receipts).length, 4096);

    // At the cap no new receipt can be accepted, not even for the other owner.
    await assert.rejects(views.release({ ownerId: 'other', teamId: TEAM, requestId: 'release-1', kind: 'snapshot', id: otherSnapshot.id }),
      error => error.code === 'isolation_capacity');

    const rolled = await views.rolloverReceipts('parent', 0);
    assert.equal(rolled.epoch, 1);
    assert.equal(rolled.archives.length, 1);
    assert.equal(rolled.retainedUnscopedLegacyReceipts, 2048, 'the other owner receipts are retained');
    const payload = JSON.parse(zlib.gunzipSync(await fs.readFile(archiveFile(store, rolled.archives[0]))).toString('utf8'));
    assert.deepEqual(Object.keys(payload.receipts).sort(), [...parentKeys].sort(),
      'exactly this owner\'s proven legacy receipts are archived, never the other owner\'s');
    for (const key of otherKeys) {
      assert.equal(payload.receipts[key], undefined);
    }
    const durable = await readJson(indexFile);
    assert.deepEqual(Object.keys(durable.receipts).sort(), [...otherKeys].sort());
    assert.deepEqual(durable.receiptEpochs, { [digest('parent')]: 1 });
    assert.equal(durable.legacyRequestKeys.length, 4096, 'the frozen live map stays exactly inside its own bound');

    // The reclaimed capacity is usable again, and the archived identities stay retired.
    assert.deepEqual(await views.release({ ownerId: 'other', teamId: TEAM, requestId: 'release-2', kind: 'snapshot', id: otherSnapshot.id }),
      { released: true, kind: 'snapshot', id: otherSnapshot.id });
    assert.equal(Object.keys((await readJson(indexFile)).receipts).length, 2049);
  } finally { await views.close(); }

  // The reclaimed document still validates on a cold open.
  const reopened = new IsolatedViews(store, root);
  await reopened.open();
  try {
    assert.equal(Object.keys(JSON.parse(await fs.readFile(indexFile, 'utf8')).receipts).length, 2049);
    assert.equal((await reopened.rolloverReceipts('other', 0)).retainedUnscopedLegacyReceipts, 0);
  } finally { await reopened.close(); }
});

// --- Store write fence around receipt rollover ------------------------------
//
// The fence is the host's exclusive store write phase. It is NOT reentrant: a
// nested call would deadlock the real owner lock, so this stand-in fails fast
// instead, and `active` proves exactly which durable writes ran under it.

function exclusiveFence() {
  let tail = Promise.resolve();
  const state = { enters: 0, active: 0, maxConcurrency: 0, nested: 0, onExit: undefined };
  const run = action => {
    const next = tail.then(async () => {
      state.enters += 1;
      state.active += 1;
      if (state.active > 1) {
        state.nested += 1;
        state.active -= 1;
        throw new Error('the store write fence was entered recursively');
      }
      state.maxConcurrency = Math.max(state.maxConcurrency, state.active);
      try {
        return await action();
      } finally {
        try {
          if (state.onExit) {
            await state.onExit();
          }
        } finally {
          state.active -= 1;
        }
      }
    });
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  return { state, run };
}

test('a board rollover keeps its whole durable phase inside one store write fence', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'board-fence');
  const root = path.join(base, 'root');
  const directory = path.join(base, 'storage');
  const file = path.join(directory, 'task-board.json');
  await fs.mkdir(root);
  const fence = exclusiveFence();
  const board = new TaskBoard(directory, root, () => undefined, undefined, undefined, fence.run);
  await board.open();
  await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'team', name: 'team', description: '' });
  assert.equal(fence.state.enters, 0, 'an ordinary board mutation never takes the rollover fence');

  const observed = {};
  const originalPreflight = rules.preflightArchivePublication;
  const originalPublish = rules.publishArchivePublication;
  rules.preflightArchivePublication = async (...args) => {
    observed.preflightFenced = fence.state.active === 1;
    observed.intentAtPreflight = (await readJson(file)).receiptArchivePublications?.length;
    return originalPreflight(...args);
  };
  rules.publishArchivePublication = async (...args) => {
    const durable = await readJson(file);
    observed.publishFenced = fence.state.active === 1;
    observed.intentAtPublish = (durable.receiptArchivePublications ?? []).length;
    observed.epochAtPublish = durable.receiptEpochs;
    const archives = await originalPublish(...args);
    observed.afterPartsFenced = fence.state.active === 1;
    return archives;
  };
  const exits = [];
  let rolled;
  try {
    fence.state.onExit = async () => { exits.push(await readJson(file)); };
    rolled = await board.rolloverReceipts('parent', 0);
  } finally {
    fence.state.onExit = undefined;
    rules.preflightArchivePublication = originalPreflight;
    rules.publishArchivePublication = originalPublish;
  }

  assert.equal(rolled.epoch, 1);
  assert.equal(rolled.prefix, 'e1:');
  assert.equal(rolled.archives.length, 1);
  assert.equal(observed.preflightFenced, true, 'preflight runs inside the fence');
  assert.equal(observed.intentAtPreflight, undefined, 'nothing was durable when the fence opened');
  assert.equal(observed.publishFenced, true, 'archive parts are opened inside the fence');
  assert.equal(observed.intentAtPublish, 1, 'the publication intent is durable BEFORE any part is published');
  assert.equal(observed.epochAtPublish, undefined, 'the epoch is not committed before its parts exist');
  assert.equal(observed.afterPartsFenced, true, 'the epoch commit still runs inside the same fence');
  assert.equal(fence.state.enters, 1, 'one rollover takes exactly one fence');
  assert.equal(fence.state.maxConcurrency, 1, 'the fence is never re-entered or shared');
  assert.equal(fence.state.nested, 0);
  assert.equal(exits.length, 1, 'the fence is released only after the whole phase');
  assert.deepEqual(exits[0].receiptEpochs, { [digest('parent')]: 1 }, 'the epoch commit is durable before release');
  assert.equal(exits[0].receiptArchivePublications, undefined, 'the completed intent is already cleared');
  assert.deepEqual(exits[0].receiptArchives.map(archive => archive.hash), rolled.archives.map(archive => archive.hash));

  // A completed epoch replay writes nothing, so it must not take the fence.
  const replay = await board.rolloverReceipts('parent', 0);
  assert.equal(replay.replay, true);
  assert.equal(fence.state.enters, 1, 'a pure epoch replay is not fenced');
  await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'e1:later', name: 'later', description: '' });
  assert.equal(fence.state.enters, 1, 'a later board mutation is not fenced by the rollover');
  await board.close();
});

test('a reloaded board retries a fenced publication and still reclaims at exhaustion', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'board-fence-reload');
  const root = path.join(base, 'root');
  const directory = path.join(base, 'storage');
  const file = path.join(directory, 'task-board.json');
  const archivesDir = path.join(directory, 'board-retention', 'receipt-archives');
  await fs.mkdir(root);
  const first = exclusiveFence();
  let board = new TaskBoard(directory, root, () => undefined, undefined, undefined, first.run);
  await board.open();
  await board.createTeam({ kind: 'coordinator', ownerId: 'parent' }, { requestId: 'team', name: 'team', description: '' });

  // An interruption INSIDE the fenced phase leaves the intent durable and the
  // epoch untouched, and the fence is released even though the action threw.
  const original = rules.publishArchivePublication;
  rules.publishArchivePublication = async () => {
    assert.equal(first.state.active, 1, 'parts are opened only inside the fence');
    throw new Error('simulated interruption inside the fenced phase');
  };
  try {
    await assert.rejects(board.rolloverReceipts('parent', 0), /simulated interruption inside the fenced phase/);
  } finally { rules.publishArchivePublication = original; }
  assert.equal(first.state.enters, 1);
  assert.equal(first.state.active, 0, 'a failure inside the fence releases it');
  const interrupted = await readJson(file);
  assert.equal(interrupted.receiptArchivePublications.length, 1, 'the intent is durable and still pending');
  assert.equal(interrupted.receiptEpochs, undefined, 'no epoch was committed');
  const planned = interrupted.receiptArchivePublications[0];
  assert.deepEqual(await fs.readdir(archivesDir).catch(() => []), [], 'no part was published');
  await board.close();

  // Reload: the exact pending intent is retried under a FRESH fence.
  const second = exclusiveFence();
  board = new TaskBoard(directory, root, () => undefined, undefined, undefined, second.run);
  await board.open();
  const exits = [];
  let resumed;
  try {
    second.state.onExit = async () => { exits.push(await readJson(file)); };
    resumed = await board.rolloverReceipts('parent', 0);
  } finally { second.state.onExit = undefined; }
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.epoch, 1);
  assert.deepEqual(resumed.archives, planned.archives);
  assert.equal(second.state.enters, 1, 'the pending-intent retry takes the fence too');
  assert.equal(second.state.maxConcurrency, 1);
  assert.deepEqual(exits[0].receiptEpochs, { [digest('parent')]: 1 }, 'the resumed epoch is durable before release');

  // Exhaustion: a reclaiming rollover stays available at the capacity boundary,
  // while a rollover that can no longer fit is refused BEFORE the fence.
  // Valid, content-addressed parts: collection must be able to verify and
  // reclaim them, so they are produced by the real archiver. The epoch-0 part
  // this store just published stays recorded and on disk, so 63 records beside
  // 63 files leave exactly one free slot and one free record.
  const seeded = [...board.data.receiptArchives];
  for (let index = 0; seeded.length < rules.MAX_RECEIPT_ARCHIVE_FILES - 1; index += 1) {
    const [archive] = await rules.archiveReceipts(path.join(directory, 'board-retention'), digest(root), 'parent', index, {
      [digest(['seeded', index])]: { fingerprint: digest(['seeded-fingerprint', index]), result: { seeded: index }, at: AT }
    }, rules.MAX_RECEIPT_ARCHIVE_FILES - index);
    seeded.push(archive);
  }
  board.data.receiptArchives = seeded;
  const reclaiming = await board.rolloverReceipts('parent', 1);
  assert.equal(reclaiming.epoch, 2, 'the last record is still usable for reclamation');
  assert.equal(second.state.enters, 2);
  const fencedOnce = second.state.enters;
  await assert.rejects(board.rolloverReceipts('parent', 2), error => error.code === 'receipt_capacity');
  assert.equal(second.state.enters, fencedOnce, 'a capacity refusal never enters the fence');
  assert.equal((await readJson(file)).receiptEpochs[digest('parent')], 2, 'a refused rollover changes nothing');

  // Collecting the unreferenced archives restores capacity, so the next epoch
  // can reclaim again - with the fence around its own durable phase.
  assert.equal(await board.collectReceiptArchives('parent', new Set()), rules.MAX_RECEIPT_ARCHIVE_FILES);
  const next = await board.rolloverReceipts('parent', 2);
  assert.equal(next.epoch, 3);
  assert.equal(second.state.enters, fencedOnce + 1);
  assert.equal(second.state.nested, 0);
  await board.close();
});

test('a view rollover and its pending-intent retry each hold one store write fence', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-fence');
  const root = path.join(base, 'root');
  const store = path.join(base, 'store');
  const indexFile = path.join(store, 'index.json');
  await fs.mkdir(root);
  const first = exclusiveFence();
  let views = new IsolatedViews(store, root, { withStorageWrite: first.run });
  await views.open();

  const observed = {};
  const originalPreflight = rules.preflightArchivePublication;
  const originalPublish = rules.publishArchivePublication;
  rules.preflightArchivePublication = async (...args) => {
    observed.preflightFenced = first.state.active === 1;
    return originalPreflight(...args);
  };
  rules.publishArchivePublication = async (...args) => {
    observed.publishFenced = first.state.active === 1;
    observed.intentAtPublish = (await readJson(indexFile)).receiptArchivePublications?.length;
    return originalPublish(...args);
  };
  const exits = [];
  let rolled;
  try {
    first.state.onExit = async () => { exits.push(await readJson(indexFile)); };
    rolled = await views.rolloverReceipts('parent', 0);
  } finally {
    first.state.onExit = undefined;
    rules.preflightArchivePublication = originalPreflight;
    rules.publishArchivePublication = originalPublish;
  }
  assert.equal(rolled.epoch, 1);
  assert.equal(observed.preflightFenced, true, 'the view preflight runs inside the fence');
  assert.equal(observed.publishFenced, true, 'view parts are opened inside the fence');
  assert.equal(observed.intentAtPublish, 1, 'the view intent is durable before its parts');
  assert.equal(first.state.enters, 1);
  assert.equal(first.state.nested, 0);
  assert.deepEqual(exits[0].receiptEpochs, { [digest('parent')]: 1 }, 'the view epoch commit is durable before release');
  assert.equal(exits[0].receiptArchivePublications, undefined);

  const replay = await views.rolloverReceipts('parent', 0);
  assert.equal(replay.replay, true);
  assert.equal(first.state.enters, 1, 'a pure view epoch replay is not fenced');

  await views.close();

  // Interrupted inside the fenced phase: the intent survives, the fence is released.
  const interruption = exclusiveFence();
  rules.publishArchivePublication = async () => {
    assert.equal(interruption.state.active, 1, 'view parts are opened only inside the fence');
    throw new Error('simulated interruption inside the fenced view phase');
  };
  views = new IsolatedViews(store, root, { withStorageWrite: interruption.run });
  try {
    await views.open();
    await assert.rejects(views.rolloverReceipts('parent', 1), /simulated interruption inside the fenced view phase/);
    assert.equal(interruption.state.enters, 1);
    assert.equal(interruption.state.active, 0, 'a failure inside the view fence releases it');
    const pending = (await readJson(indexFile)).receiptArchivePublications;
    assert.equal(pending.length, 1, 'the view intent is durable and still pending');
    assert.equal((await readJson(indexFile)).receiptEpochs[digest('parent')], 1, 'no view epoch was committed');
    await views.close();

    // Reload: the exact intent is completed under a fresh fence. The
    // interception moves to the retry handle and delegates to the real
    // publisher, so it proves the RETRY's own fence holds the parts.
    const retry = exclusiveFence();
    const reopened = new IsolatedViews(store, root, { withStorageWrite: retry.run });
    await reopened.open();
    let retryFenced;
    rules.publishArchivePublication = async (...args) => {
      retryFenced = retry.state.active === 1;
      return originalPublish(...args);
    };
    const resumedExits = [];
    let resumed;
    try {
      retry.state.onExit = async () => { resumedExits.push(await readJson(indexFile)); };
      resumed = await reopened.rolloverReceipts('parent', 1);
    } finally { retry.state.onExit = undefined; }
    assert.equal(resumed.resumed, true);
    assert.equal(retryFenced, true, 'the pending-intent retry publishes parts inside its own fence');
    assert.deepEqual(resumed.archives, pending[0].archives);
    assert.equal(retry.state.enters, 1, 'the view pending-intent retry takes the fence too');
    assert.equal(retry.state.nested, 0);
    assert.deepEqual(resumedExits[0].receiptEpochs, { [digest('parent')]: 2 });
    await reopened.close();
  } finally { rules.publishArchivePublication = originalPublish; }
});

test('a released submission replays before the reference gate and the fresh path checks scope first', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'release-replay');
  const root = path.join(base, 'root');
  const store = path.join(base, 'store');
  await fs.mkdir(root);
  const namespace = sha256(path.resolve(store));
  const snapshot = viewSnapshot(hex64(71), 'parent', hex64(971));
  const submissionId = hex64(72);
  const uri = `codex-subagent://submission/${namespace}/${submissionId}/1`;
  const pinId = hex64(73);
  const pinned = { id: pinId, ownerId: 'parent', teamId: TEAM, name: 'native', resource: { kind: 'submission', id: submissionId } };
  const submitted = {
    id: submissionId, teamId: TEAM, snapshotId: snapshot.id, overlayId: hex64(74), version: 1, uri,
    workerId: TEAM, workerCreatedAt: AT, ownerId: 'parent', head: null, revision: 0, released: false, createdAt: AT
  };
  await seedIndex(store, root, {
    snapshots: { [snapshot.id]: snapshot },
    submissions: { [submissionId]: submitted },
    pins: { [pinId]: pinned }
  });
  const scope = { ownerId: 'parent', teamId: TEAM };
  const ack = { released: true, kind: 'submission', id: submissionId };
  const release = (handle, target, requestId, retained, preserveConsumers) =>
    handle.release({ ...target, requestId, kind: 'submission', id: submissionId }, undefined, undefined, retained, preserveConsumers);

  const views = new IsolatedViews(store, root);
  await views.open();
  try {
    // The native pin keeps a released submission readable, so this release is
    // exactly the durable state the repro starts from.
    assert.deepEqual(await release(views, scope, 'release-1', new Set()), ack);
    const held = await views.inspect('parent', TEAM);
    assert.equal(held.submissions[0].released, true);
    assert.equal(held.pins.length, 1, 'the native pin still retains the released submission');

    // A board/evidence reference added AFTERWARDS must not turn the same
    // authorized release into artifact_retained: the stored ACK replays first.
    assert.deepEqual(await release(views, scope, 'release-1', new Set([uri])), ack);
    assert.deepEqual(await release(views, scope, 'release-1', new Set([uri]), true), ack,
      'the acknowledgement replays before the consumer-preservation gate too');
    assert.equal((await views.inspect('parent', TEAM)).submissions[0].released, true, 'the replay is not re-applied');

    // A FRESH release still honors the retained-reference gate.
    await assert.rejects(release(views, scope, 'release-2', new Set([uri])), error => error.code === 'artifact_retained');
    // The fresh path proves the exact owner/team scope BEFORE that gate.
    await assert.rejects(release(views, { ownerId: 'parent', teamId: 'b'.repeat(32) }, 'release-3', new Set([uri])),
      error => error.code === 'not_found');

    // The acknowledgement is durable: a reloaded handle replays it unchanged.
    const reopened = new IsolatedViews(store, root);
    await reopened.open();
    try {
      assert.deepEqual(await release(reopened, scope, 'release-1', new Set([uri])), ack);
      await assert.rejects(release(reopened, { ownerId: 'parent', teamId: 'b'.repeat(32) }, 'release-4', new Set([uri])),
        error => error.code === 'not_found');
    } finally { await reopened.close(); }
  } finally { await views.close(); }
});

// --- First-registration ordering under a physical archive refusal ------------
//
// A rollover can be the first governed mutation of an opted-out store, so its
// registration must not run before the archive directory is proven usable: the
// COMPLETE read-only archive preflight (identities, byte comparison and both
// caps) runs under the domain mutex, BEFORE the host's first registration. A
// structural refusal or a bounded part that no longer matches its content
// address would otherwise leave the epoch and receipts untouched while the store
// silently became a governed participant. A healthy retry still enrolls once and
// commits its epoch.

test('a board rollover refused by its archive preflight enrolls nothing and still commits after repair', { timeout: 60000 }, async t => {
  const f = await boardFixture(t, 'board-layout-enroll');
  const enrollments = [];
  // The host runs the handed check first and only then registers; the test keeps
  // that exact order, so a refused check leaves `enrollments` empty.
  const enroll = async check => { await check(); enrollments.push('board'); };
  const planned = rules.planArchivePublication(digest(f.root), 'parent', 0, { ...f.board.data.requests });
  const part = path.join(f.archivesDir, `${planned.archives[0].hash}.json.gz`);

  // A bounded file at the EXACT planned name with the wrong bytes: a shape check
  // would accept it, so this proves the pre-enrollment check compares content.
  await fs.mkdir(f.archivesDir, { recursive: true });
  await fs.writeFile(part, zlib.gzipSync(Buffer.from('{"schema":1}', 'utf8')));
  await assert.rejects(f.board.rolloverReceipts('parent', 0, enroll), error => error.code === 'receipt_corrupt');
  assert.deepEqual(enrollments, [], 'a replaced part registers nothing');
  assert.equal((await boardJson(f)).receiptEpochs, undefined, 'no epoch was committed');
  assert.equal((await boardJson(f)).receiptArchivePublications, undefined, 'no publication intent became durable');
  await fs.rm(f.archivesDir, { recursive: true, force: true });

  // A structural refusal: the archive path exists but is not a directory.
  await fs.writeFile(f.archivesDir, 'not a directory');
  await assert.rejects(f.board.rolloverReceipts('parent', 0, enroll), error => error.code === 'receipt_corrupt');
  assert.deepEqual(enrollments, [], 'a non-directory archive path registers nothing');
  const refused = await boardJson(f);
  assert.equal(refused.receiptEpochs, undefined, 'no epoch was committed');
  assert.equal(refused.receiptArchivePublications, undefined, 'no publication intent became durable');
  assert.equal(Object.keys(refused.requests).length, 1, 'the live receipt stays accepted');
  assert.equal(await fs.readFile(f.archivesDir, 'utf8'), 'not a directory', 'the refusal changed nothing on disk');

  // The archive PARENT is proven too: Windows reports ENOENT for a scan whose
  // parent is a regular file, which must be diagnosed instead of read as empty.
  await fs.rm(f.archivesDir);
  await fs.rm(f.retentionDir, { recursive: true, force: true });
  await fs.writeFile(f.retentionDir, 'not a directory either');
  await assert.rejects(f.board.rolloverReceipts('parent', 0, enroll), error => error.code === 'receipt_corrupt');
  assert.deepEqual(enrollments, [], 'a non-directory archive parent registers nothing');
  await fs.rm(f.retentionDir);

  // The very same store commits the very same epoch once the layout is usable.
  const rolled = await f.board.rolloverReceipts('parent', 0, enroll);
  assert.deepEqual(enrollments, ['board'], 'only the committed rollover enrolled the store');
  assert.equal(rolled.epoch, 1);
  assert.equal(rolled.archives.length, 1);
  const committed = await boardJson(f);
  assert.deepEqual(committed.receiptEpochs, { [digest('parent')]: 1 });
  assert.equal(committed.receiptArchivePublications, undefined, 'the completed intent is cleared');
  assert.equal(committed.receiptArchives.length, 1);
  await f.board.close();
});

test('a view rollover refused by its archive preflight enrolls nothing and still commits after repair', { timeout: 60000 }, async t => {
  const base = await tempBase(t, 'views-layout-enroll');
  const root = path.join(base, 'root'); const store = path.join(base, 'store');
  await fs.mkdir(root);
  const snapshot = viewSnapshot(hex64(1), 'parent', hex64(901));
  const indexFile = await seedIndex(store, root, { snapshots: { [snapshot.id]: snapshot } });
  const archivesDir = path.join(store, 'receipt-archives');
  await fs.writeFile(archivesDir, 'not a directory');
  const views = new IsolatedViews(store, root);
  await views.open();
  t.after(() => views.close().catch(() => undefined));
  const enrollments = [];
  const enroll = async check => { await check(); enrollments.push('views'); };
  await assert.rejects(views.rolloverReceipts('parent', 0, enroll), error => error.code === 'receipt_corrupt');
  assert.deepEqual(enrollments, [], 'a refused archive preflight registers nothing');
  const refused = await readJson(indexFile);
  assert.equal(refused.receiptEpochs, undefined, 'no epoch was committed');
  assert.equal(refused.receiptArchivePublications, undefined, 'no publication intent became durable');
  assert.equal(await fs.readFile(archivesDir, 'utf8'), 'not a directory', 'the refusal changed nothing on disk');

  await fs.rm(archivesDir);
  const rolled = await views.rolloverReceipts('parent', 0, enroll);
  assert.deepEqual(enrollments, ['views'], 'only the committed rollover enrolled the store');
  assert.equal(rolled.epoch, 1);
  assert.equal(rolled.archives.length, 1);
  const committed = await readJson(indexFile);
  assert.deepEqual(committed.receiptEpochs, { [digest('parent')]: 1 });
  assert.equal(committed.receiptArchivePublications, undefined, 'the completed intent is cleared');
  assert.equal(committed.receiptArchives.length, 1);
});

test('a trusted rollover refused by a physical archive fault registers nothing and legacy writes stay unregistered', { timeout: 60000 }, async t => {
  const { WorkerBroker, unpack } = require(path.join(buildDir, 'runtime'));
  const { resourceDefaults } = require(path.join(buildDir, 'resource-governor'));
  const { defaults } = require(path.join(buildDir, 'engine'));
  const nodeFs = require('node:fs');
  const base = await tempBase(t, 'broker-enroll');
  const root = path.join(base, 'project'); const resourcesDirectory = path.join(base, 'resources');
  await fs.mkdir(root);
  const model = { id: 'enroll-model', name: 'enroll', maxTokens: 1000 };
  const provider = { models: async () => [model], countTokens: async () => 10, async *stream() { yield { type: 'text', text: 'done' }; } };
  let enabled = false;
  const errors = [];
  const broker = new WorkerBroker({
    storage: path.join(base, 'storage'), registry: path.join(base, 'bridges'), roots: [root], identity: 'enroll', provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { numSessions: 4 } } }),
    taskBoardEnabled: () => true, isolatedViewsEnabled: () => true,
    resources: () => ({ ...resourceDefaults, enabled }), resourceDirectory: resourcesDirectory,
    files: { canWrite: () => true, allowShell: () => true, approveCommand: async () => true },
    onChange: () => undefined, onError: message => errors.push(message)
  });
  t.after(() => broker.close().catch(() => undefined));
  await broker.start();
  const store = broker.local.get(root).store.directory;
  const archivesDir = path.join(store, 'board-retention', 'receipt-archives');
  const call = async (name, args = {}) => unpack(await broker.invoke(root, name, args));
  const markerState = () => fs.readFile(path.join(store, 'resource-store.json'), 'utf8').then(text => JSON.parse(text).state, error => error.code);
  const ledgerRows = async () => {
    const text = await fs.readFile(path.join(resourcesDirectory, 'ledger.json'), 'utf8').catch(error => error.code);
    return text === 'ENOENT' ? 0 : Object.keys(JSON.parse(text).stores ?? {}).length;
  };
  const boardJsonFile = async () => JSON.parse(await fs.readFile(path.join(store, 'task-board.json'), 'utf8'));

  // One real board receipt in an opted-out scope: nothing is registered yet.
  const team = await call('subagent_team_create', { ownerId: 'parent', requestId: 'team', name: 'team', description: '' });
  assert.equal(await markerState(), 'ENOENT', 'an opted-out legacy store starts unregistered');

  // Trusted opt-in. The ONLY injected fault is one readdir EIO for the exact
  // archive directory, so the epoch, the intents and every receipt stay valid.
  enabled = true;
  await fs.mkdir(archivesDir, { recursive: true });
  const realReaddir = nodeFs.promises.readdir;
  let injected = 0;
  nodeFs.promises.readdir = async function patched(target, ...rest) {
    if (String(target) === archivesDir && injected === 0) {
      injected += 1;
      const error = new Error(`EIO: i/o error, scandir '${String(target)}'`);
      error.code = 'EIO'; error.syscall = 'scandir'; error.path = String(target);
      throw error;
    }
    return realReaddir.call(this, target, ...rest);
  };
  let refused;
  try {
    await call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 });
  } catch (error) { refused = error; } finally { nodeFs.promises.readdir = realReaddir; }
  assert.ok(refused, 'the physical archive refusal is reported');
  assert.equal(injected, 1, 'the exact archive directory read really failed');
  assert.equal(await markerState(), 'ENOENT', 'the refused rollover published no local registration');
  assert.equal(await ledgerRows(), 0, 'and no aggregate store row');
  assert.equal(await broker.resources.hasStore(store), false, 'this store never joined the aggregate');
  assert.equal(broker.resourceUsed, false, 'this window never became a participant');
  const refusedBoard = await boardJsonFile();
  assert.equal(refusedBoard.receiptEpochs, undefined, 'no epoch was committed');
  assert.equal(refusedBoard.receiptArchivePublications, undefined, 'no publication intent was left behind');
  assert.equal(Object.keys(refusedBoard.requests).length, 1, 'the receipt stays live and replayable');

  // The trusted switch is turned off again: this scope keeps ordinary legacy
  // behavior and its writes must not enroll it as a side effect.
  enabled = false;
  await call('subagent_team_create', { ownerId: 'parent', requestId: 'legacy-1', name: 'legacy', description: '' });
  assert.equal(await markerState(), 'ENOENT', 'the legacy write enrolled nothing');
  assert.equal(await ledgerRows(), 0);
  assert.equal(await broker.resources.hasStore(store), false);
  assert.equal(broker.resourceUsed, false);

  // A healthy rollover on the same current epoch is the intended first opt-in.
  enabled = true;
  const firstCalls = [];
  const enrollingPreflight = rules.preflightArchivePublication;
  rules.preflightArchivePublication = async (...args) => {
    firstCalls.push(args[1].fromEpoch);
    return enrollingPreflight(...args);
  };
  let rolled;
  try {
    rolled = await call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 0 });
  } finally { rules.preflightArchivePublication = enrollingPreflight; }
  assert.equal(rolled.epoch, 1);
  assert.equal(rolled.archives.length, 1);
  assert.equal(await markerState(), 'registered', 'a committed rollover enrolls the store');
  assert.equal(await ledgerRows(), 1, 'exactly one aggregate row was published');
  assert.equal(broker.resourceUsed, true);
  const committed = await boardJsonFile();
  assert.deepEqual(committed.receiptEpochs, { [digest('parent')]: 1 });
  assert.equal(committed.receiptArchivePublications, undefined);
  assert.equal(committed.receiptArchives.length, 1);

  // An already registered store skips the pre-enrollment preparation: one
  // further rollover runs the exported preflight only for its fenced phase,
  // while the first (enrolling) rollover ran it once more, before registration.
  const calls = [];
  const originalPreflight = rules.preflightArchivePublication;
  rules.preflightArchivePublication = async (...args) => {
    calls.push(args[1].fromEpoch);
    return originalPreflight(...args);
  };
  let second;
  try {
    second = await call('subagent_metadata_rollover', { ownerId: 'parent', teamId: team.id, kind: 'board', expectedEpoch: 1 });
  } finally { rules.preflightArchivePublication = originalPreflight; }
  assert.equal(second.epoch, 2);
  assert.deepEqual(calls, [1], 'a registered store runs only its fenced preflight');
  assert.deepEqual(firstCalls, [0, 0], 'the first enrollment proved its archive twice, enrolling after the first');
  assert.equal(await markerState(), 'registered');
  assert.deepEqual(errors, []);
});
