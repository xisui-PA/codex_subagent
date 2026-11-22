// Focused integration-publication tests: raw-byte publication (BOM/CRLF and
// binary preserved), preflight before any effect, path/mode/editor/stale/hard-
// link conflicts, open-editor aliases matched by canonical identity (including
// an absent untitled leaf reached through a junction or symlink parent), a
// changed open-document inventory that is re-read after the target disk proof, a
// POSIX mode edit during staging, an in-place write visible only at the final
// lstat of the staged check, pinned directory identities, durable per-file intent and
// completion, proof-only interruption recovery that never repeats an effect
// (including through a replaced or junction-linked parent), exact replay that
// never overwrites later user edits, POSIX permission fidelity (every existing
// bit is preserved when the approved executable class is unchanged), bounded reads,
// capacity refusals that are structured results instead of throws, journal
// refusal, and the journal ROLLBACK floor: a validated journal restored to an
// earlier genuine revision is terminal (no rewrite, no effect, not even in
// proof-only recovery), a positive floor makes a missing journal terminal, and
// the caller's per-effect intent checkpoint is awaited after the durable intent
// and before any staged or real effect. A row that must stage again reconciles
// its OWN recorded staging entry first: a retryable `pending` row whose effect
// left debris, and a resolved `applied` row whose completion was proved before
// its cleanup, keep that exact record - and the staging path it names - until the
// path is proved absent. An existing record is never replaced by a fresh staging
// name, so no old `.codex-stage` payload is orphaned or erased from the journal;
// while it cannot be proved removable the row reports a retryable conflict naming
// that staging path. Real temp directories only; the module
// is loaded from .test-build unless STEP5_TEST_BUILD is set.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const buildDir = path.resolve(__dirname, '..', process.env.STEP5_TEST_BUILD?.trim() || '.test-build');
const { publishIntegration } = require(path.join(buildDir, 'integration-publication'));

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const entryOf = (bytes, mode) => ({
  type: 'file',
  hash: hash(bytes),
  size: bytes.length,
  ...(mode === undefined ? {} : { mode })
});
const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const ordered = changes => [...changes].sort(byPath);
// Mirrors the module's plan digest (ordered entries + exact decimal directory
// identities); a mismatch fails closed as a journal conflict.
const planDigest = (entries, trust) => digest({
  entries: ordered(entries).map(entry => [entry.path, entry.before, entry.after]),
  trust: {
    root: [trust.root.dev, trust.root.ino],
    parents: Object.keys(trust.parents).sort().map(key => [key, [trust.parents[key].dev, trust.parents[key].ino]])
  }
});

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-publication-'));
  const root = path.join(base, 'workspace');
  const journalPath = path.join(base, 'store', 'publication.json');
  await fs.mkdir(root);
  await fs.mkdir(path.dirname(journalPath));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, journalPath };
}

async function write(root, rel, bytes) {
  const target = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}

async function exists(target) {
  return fs.lstat(target).then(() => true, () => false);
}

function requestFor(fx, changes, options = {}) {
  const contents = new Map(Object.entries(options.contents || {}));
  return {
    root: fx.root,
    journalPath: options.journalPath || fx.journalPath,
    identity: options.identity || 'candidate-approved',
    changes,
    read: async key => {
      const bytes = contents.get(key);
      if (bytes === undefined) {
        throw new Error(`no approved content for ${key}`);
      }
      return Buffer.from(bytes);
    },
    openDocuments: options.openDocuments || (() => []),
    authorize: options.authorize || (() => undefined),
    // Optional recovery contract, forwarded verbatim only when supplied.
    ...(options.requireJournal === undefined ? {} : { requireJournal: options.requireJournal }),
    ...(options.recoveryOnly === undefined ? {} : { recoveryOnly: options.recoveryOnly }),
    ...(options.onJournalReady === undefined ? {} : { onJournalReady: options.onJournalReady }),
    ...(options.minimumJournalRevision === undefined ? {} : { minimumJournalRevision: options.minimumJournalRevision }),
    ...(options.onJournalIntent === undefined ? {} : { onJournalIntent: options.onJournalIntent })
  };
}

/** Pins the identities the module itself would pin for the current disk. */
async function diskTrust(root, keys) {
  const real = await fs.realpath(root);
  const rootStat = await fs.lstat(real, { bigint: true });
  const parents = {};
  for (const key of keys) {
    const segments = key.split('/').slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const rel = segments.slice(0, index).join('/');
      const stat = await fs.lstat(path.join(real, ...segments.slice(0, index)), { bigint: true });
      // Exact decimal strings, never a rounded double.
      parents[rel] = { dev: stat.dev.toString(), ino: stat.ino.toString() };
    }
  }
  return { root: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() }, parents };
}

/**
 * Seeds the documented durable journal shape to reproduce a crash window. An
 * entry may carry the additive `stage` record of an interrupted staging effect.
 */
async function seedJournal(fx, entries, options = {}) {
  const root = await fs.realpath(fx.root);
  const changes = entries.map(({ path: key, before, after }) => ({ path: key, before, after }));
  const trust = await diskTrust(root, changes.map(change => change.path));
  const journal = {
    schema: 2,
    identity: options.identity || 'candidate-approved',
    root,
    plan: planDigest(changes, trust),
    revision: options.revision === undefined ? 1 : options.revision,
    trust,
    entries: ordered(entries).map(({ path: key, state, before, after, stage }) => ({
      path: key, state, before, after, ...(stage === undefined ? {} : { stage })
    }))
  };
  await fs.writeFile(fx.journalPath, JSON.stringify(journal));
  return journal;
}

async function readJournal(fx) {
  return JSON.parse(await fs.readFile(fx.journalPath, 'utf8'));
}

async function canSymlinkDirectory() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-publication-link-'));
  try {
    await fs.mkdir(path.join(base, 'real'));
    await fs.symlink(path.join(base, 'real'), path.join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

/** Windows junctions need an absolute, existing target; POSIX uses dir links. */
async function linkDirectory(target, link) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(path.resolve(target), link, type);
    return true;
  } catch {
    return false;
  }
}

// The module stages its payload under a SHORT, FIXED-LENGTH sibling name that
// never depends on the destination's length: a valid 234-character leaf plus a
// destination-suffixed temporary name overflows the 255-character component
// bound, so every staging assertion below matches that exact shape and never a
// `.publish.tmp` suffix or a prefix.
const STAGE_NAME = /^\.codex-stage-[0-9a-f]{16}\.tmp$/;
const isStageEntry = target => typeof target === 'string' && STAGE_NAME.test(path.basename(target));

/** Names of the staging entries left in one directory. */
async function stagingEntries(directory) {
  return (await fs.readdir(directory)).filter(name => STAGE_NAME.test(name)).sort();
}

test('publishes creations, replacements and deletions with raw bytes', async t => {
  const fx = await fixture(t);
  const baseEdit = Buffer.from('one\r\ntwo\r\n', 'utf8');
  const approvedEdit = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8')]);
  const baseGone = Buffer.from('remove me\n', 'utf8');
  const approvedNew = Buffer.from([0, 1, 2, 255, 13, 10]);
  await write(fx.root, 'edit.txt', baseEdit);
  await write(fx.root, 'gone.txt', baseGone);
  const changes = [
    { path: 'new.bin', before: null, after: entryOf(approvedNew) },
    { path: 'gone.txt', before: entryOf(baseGone), after: null },
    { path: 'edit.txt', before: entryOf(baseEdit), after: entryOf(approvedEdit) }
  ];
  const result = await publishIntegration(requestFor(fx, changes, {
    contents: { 'edit.txt': approvedEdit, 'new.bin': approvedNew }
  }));
  assert.deepEqual(result, { state: 'applied', applied: ['edit.txt', 'gone.txt', 'new.bin'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'edit.txt')), approvedEdit, 'BOM and CRLF bytes are preserved verbatim');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'new.bin')), approvedNew, 'binary content is preserved verbatim');
  assert.equal(await exists(path.join(fx.root, 'gone.txt')), false);
  const journal = await readJournal(fx);
  assert.equal(journal.schema, 2);
  assert.equal(journal.identity, 'candidate-approved');
  assert.deepEqual(journal.entries.map(entry => [entry.path, entry.state]), [
    ['edit.txt', 'applied'], ['gone.txt', 'applied'], ['new.bin', 'applied']
  ]);
  // The plan pins the root and each parent directory identity, and nothing else.
  const rootStat = await fs.lstat(await fs.realpath(fx.root), { bigint: true });
  assert.deepEqual(journal.trust.root, { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() });
  assert.deepEqual(Object.keys(journal.trust.parents), []);
  await write(fx.root, 'nested/deep.txt', Buffer.from('deep base\n'));
  const deepBase = entryOf(Buffer.from('deep base\n'));
  const deepNext = Buffer.from('deep next\n');
  const deepJournal = path.join(fx.base, 'store', 'nested.json');
  const deep = await publishIntegration(requestFor(fx, [
    { path: 'nested/deep.txt', before: deepBase, after: entryOf(deepNext) }
  ], { contents: { 'nested/deep.txt': deepNext }, journalPath: deepJournal }));
  assert.equal(deep.state, 'applied');
  const nestedJournal = JSON.parse(await fs.readFile(deepJournal, 'utf8'));
  assert.deepEqual(Object.keys(nestedJournal.trust.parents), ['nested']);
  assert.equal(nestedJournal.plan, planDigest(
    [{ path: 'nested/deep.txt', before: deepBase, after: entryOf(deepNext) }],
    nestedJournal.trust
  ));
  assert.deepEqual(await stagingEntries(fx.root), [], 'no temporary payload is left behind');
  assert.deepEqual((await fs.readdir(path.dirname(fx.journalPath))).filter(name => name.endsWith('.tmp')), [], 'the journal helper leaves no temporary file');
});

test('preflight conflicts block every effect and write no journal', async t => {
  const fx = await fixture(t);
  const firstBase = Buffer.from('first base\n');
  const secondBase = Buffer.from('second base\n');
  await write(fx.root, 'first.txt', firstBase);
  await write(fx.root, 'second.txt', secondBase);
  const firstNext = Buffer.from('first next\n');
  const staleBase = entryOf(Buffer.from('never on disk\n'));
  const changes = [
    { path: 'first.txt', before: entryOf(firstBase), after: entryOf(firstNext) },
    { path: 'second.txt', before: staleBase, after: entryOf(Buffer.from('second next\n')) }
  ];
  const result = await publishIntegration(requestFor(fx, changes, {
    contents: { 'first.txt': firstNext, 'second.txt': Buffer.from('second next\n') }
  }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, 'second.txt');
  assert.match(result.conflicts[0].reason, /stale content/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'first.txt')), firstBase, 'the first change is untouched');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written when preflight fails');
});

test('creation and replacement require existing plain parents and absent or matching destinations', async t => {
  const fx = await fixture(t);
  const presentBase = Buffer.from('already here\n');
  await write(fx.root, 'present.txt', presentBase);
  await write(fx.root, 'blocker', Buffer.from('not a directory\n'));
  const changes = [
    { path: 'present.txt', before: null, after: entryOf(Buffer.from('new content\n')) },
    { path: 'missing/child.txt', before: null, after: entryOf(Buffer.from('child\n')) },
    { path: 'blocker/child.txt', before: null, after: entryOf(Buffer.from('child\n')) },
    { path: 'present.txt/more.txt', before: null, after: entryOf(Buffer.from('child\n')) }
  ];
  const result = await publishIntegration(requestFor(fx, changes, {
    contents: {
      'present.txt': Buffer.from('new content\n'),
      'missing/child.txt': Buffer.from('child\n'),
      'blocker/child.txt': Buffer.from('child\n'),
      'present.txt/more.txt': Buffer.from('child\n')
    }
  }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  const reasons = new Map(result.conflicts.map(conflict => [conflict.path, conflict.reason]));
  assert.match(reasons.get('present.txt'), /unexpected path/);
  assert.match(reasons.get('missing/child.txt'), /unavailable directory/);
  assert.match(reasons.get('blocker/child.txt'), /unsafe directory/);
  assert.match(reasons.get('present.txt/more.txt'), /unsafe directory/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'present.txt')), presentBase);
  assert.equal(await exists(path.join(fx.root, 'missing')), false, 'publication never creates directories');
});

test('stale hash, symlinked destination and hard-linked destination are refused', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('guarded base\n');
  const next = Buffer.from('guarded next\n');
  const target = await write(fx.root, 'guarded.txt', base);
  const stale = await publishIntegration(requestFor(fx, [
    { path: 'guarded.txt', before: entryOf(Buffer.from('different base\n')), after: entryOf(next) }
  ], { contents: { 'guarded.txt': next } }));
  assert.equal(stale.state, 'conflict');
  assert.match(stale.conflicts[0].reason, /stale content/);

  const linked = await fs.link(target, path.join(fx.root, 'guarded-link.txt')).then(() => true, () => false);
  if (linked) {
    const hard = await publishIntegration(requestFor(fx, [
      { path: 'guarded.txt', before: entryOf(base), after: entryOf(next) }
    ], { contents: { 'guarded.txt': next } }));
    assert.equal(hard.state, 'conflict');
    assert.match(hard.conflicts[0].reason, /hard-linked/);
    assert.deepEqual(await fs.readFile(target), base);
    await fs.unlink(path.join(fx.root, 'guarded-link.txt'));
  }

  if (await canSymlinkDirectory()) {
    await fs.unlink(target);
    const outside = path.join(fx.root, 'outside-target');
    await fs.mkdir(outside);
    // A link at the destination path: a Windows junction, a POSIX dir link.
    const created = await linkDirectory(outside, target);
    if (!created) {
      t.diagnostic('destination links are unavailable on this host; the parent-link case still covers the guard');
      return;
    }
    const symlinked = await publishIntegration(requestFor(fx, [
      { path: 'guarded.txt', before: entryOf(base), after: entryOf(next) }
    ], { contents: { 'guarded.txt': next } }));
    assert.equal(symlinked.state, 'conflict');
    assert.match(symlinked.conflicts[0].reason, /symbolic link/);
    assert.deepEqual(await fs.readdir(outside), [], 'the linked directory is never written through');
  }
});

test('one open editor document on a touched path blocks publication only for that path', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('editor base\n');
  const next = Buffer.from('editor next\n');
  await write(fx.root, 'open.txt', base);
  await write(fx.root, 'closed.txt', base);
  const blocked = await publishIntegration(requestFor(fx, [
    { path: 'open.txt', before: entryOf(base), after: entryOf(next) }
  ], {
    contents: { 'open.txt': next },
    openDocuments: () => [
      { path: path.join(fx.root, 'open.txt'), text: 'unsaved editor text', version: 3 },
      { path: 'relative/ignored.txt', text: 'not absolute' }
    ]
  }));
  assert.equal(blocked.state, 'conflict');
  assert.match(blocked.conflicts[0].reason, /open editor/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'open.txt')), base);

  const allowed = await publishIntegration(requestFor(fx, [
    { path: 'closed.txt', before: entryOf(base), after: entryOf(next) }
  ], {
    contents: { 'closed.txt': next },
    openDocuments: () => [{ path: path.join(fx.root, 'open.txt'), text: 'unrelated document' }]
  }));
  assert.equal(allowed.state, 'applied');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'closed.txt')), next);
});

test('an open editor reported through a junction or symlink alias of its parent blocks publication', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('alias editor base\n');
  const next = Buffer.from('alias editor next\n');
  await write(fx.root, 'sub/open.txt', base);
  const target = path.join(fx.root, 'sub', 'open.txt');
  const alias = path.join(fx.base, 'alias');
  const aliasFile = path.join(alias, 'open.txt');
  if (!await linkDirectory(path.join(fx.root, 'sub'), alias)) {
    t.diagnostic('directory links are unavailable on this host; the literal same-path guard still covers the exact-name case');
    return;
  }
  // Two spellings of one file: the lexical paths differ, the identity does not.
  assert.equal(await fs.realpath(aliasFile), await fs.realpath(target));
  assert.notEqual(path.resolve(aliasFile).toLowerCase(), path.resolve(target).toLowerCase());
  const changes = [{ path: 'sub/open.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'sub/open.txt': next };

  // Control: the canonical spelling is recognized and refused.
  const control = await publishIntegration(requestFor(fx, changes, {
    contents,
    journalPath: path.join(fx.base, 'store', 'control.json'),
    openDocuments: () => [{ path: target, text: 'unsaved editor text', version: 3 }]
  }));
  assert.equal(control.state, 'conflict');
  assert.match(control.conflicts[0].reason, /open editor/);
  assert.deepEqual(await fs.readFile(target), base);

  // The same open document named through the alias must conflict too, before
  // any effect: same dev/ino identity, different spelling.
  const aliased = await publishIntegration(requestFor(fx, changes, {
    contents,
    openDocuments: () => [{ path: aliasFile, text: 'unsaved editor text', version: 3 }]
  }));
  assert.equal(aliased.state, 'conflict');
  assert.deepEqual(aliased.applied, []);
  assert.deepEqual(aliased.conflicts.map(conflict => conflict.path), ['sub/open.txt']);
  assert.match(aliased.conflicts[0].reason, /open editor/);
  assert.deepEqual(await fs.readFile(target), base, 'the aliased open document blocks the replacement');
  assert.deepEqual(await fs.readFile(aliasFile), base);
  assert.equal(await exists(fx.journalPath), false, 'the conflict is decided before any journal or effect');

  // A creation whose associated untitled leaf does not exist yet is still caught
  // through its canonical parent+leaf location: the junction (Windows) or
  // symlinked (POSIX) parent resolves to the destination's parent, so both
  // canonical paths coincide even though NEITHER leaf has an identity yet.
  const created = Buffer.from('alias editor created\n');
  const createdTarget = path.join(fx.root, 'sub', 'created.txt');
  const createdViaAlias = path.join(alias, 'created.txt');
  const creation = await publishIntegration(requestFor(fx, [
    { path: 'sub/created.txt', before: null, after: entryOf(created) }
  ], {
    contents: { 'sub/created.txt': created },
    journalPath: path.join(fx.base, 'store', 'creation.json'),
    openDocuments: () => [{ path: createdViaAlias, text: '', version: 5 }]
  }));
  assert.equal(await exists(createdViaAlias), false, 'the associated untitled leaf does not exist yet');
  assert.equal(creation.state, 'conflict');
  assert.deepEqual(creation.applied, []);
  assert.deepEqual(creation.conflicts.map(conflict => conflict.path), ['sub/created.txt']);
  assert.match(creation.conflicts[0].reason, /open editor/);
  assert.equal(await exists(createdTarget), false, 'the aliased untitled leaf blocks the creation');
  assert.equal(await exists(path.join(fx.base, 'store', 'creation.json')), false, 'no journal is written');
});

test('an open-document inventory that changes during the target disk proof is a retryable per-file conflict', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('inventory base\n');
  const next = Buffer.from('inventory next\n');
  const target = await write(fx.root, 'inventory.txt', base);
  const changes = [{ path: 'inventory.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'inventory.txt': next };
  // The inventory changes exactly when the target itself is opened, i.e. during
  // the final disk proof. The boundary therefore captures an empty inventory and
  // re-reads a non-empty one AFTER that proof; the re-read must still see the
  // change, be taken after the proof rather than before it, and refuse this file
  // as a retryable per-file editor conflict instead of applying a stale view.
  const open = fsPromisesOpen();
  let proofRan = false;
  setPromisesOpen(async (file, ...args) => {
    if (typeof file === 'string' && path.basename(file) === 'inventory.txt') {
      proofRan = true;
    }
    return open(file, ...args);
  });
  let calls = 0;
  let proofRanAtReRead;
  const unstable = () => {
    calls += 1;
    if (calls >= 2) {
      proofRanAtReRead = proofRan;
    }
    return proofRan ? [{ path: path.join(fx.root, 'unrelated-open.txt'), text: '', version: 1 }] : [];
  };
  let result;
  try {
    result = await publishIntegration(requestFor(fx, changes, { contents, openDocuments: unstable }));
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(proofRan, true, 'the target disk proof runs before the inventory re-read completes the check');
  assert.ok(calls >= 2, 'the scoped inventory is re-read after the disk proof');
  assert.equal(proofRanAtReRead, true, 'the re-read is taken after the target proof, not before it');
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['inventory.txt']);
  assert.match(result.conflicts[0].reason, /open editor: the set of open documents changed/);
  assert.deepEqual(await fs.readFile(target), base, 'the stale inventory never reaches an effect');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written for a stale inventory');

  // The same change with a stable inventory applies, so the refusal is a retry
  // condition rather than a permanent block.
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['inventory.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
});

test('a document path with no resolvable parent entry is ignored unless it is exactly the destination', async t => {
  const fx = await fixture(t);
  const created = Buffer.from('untitled creation\n');
  const changes = [{ path: 'created-by-editor.txt', before: null, after: entryOf(created) }];
  const contents = { 'created-by-editor.txt': created };
  const destination = path.join(fx.root, 'created-by-editor.txt');

  // An associated untitled buffer carries an absolute path that does not exist
  // yet. Its spelling IS the destination, so the literal same-path rule catches
  // it here; under a junction parent the canonical parent+leaf rule catches the
  // same absent leaf through the alias instead (see the alias regression).
  const blocked = await publishIntegration(requestFor(fx, changes, {
    contents,
    openDocuments: () => [{ path: destination, text: '', version: 7 }]
  }));
  assert.equal(blocked.state, 'conflict');
  assert.match(blocked.conflicts[0].reason, /open editor/);
  assert.equal(await exists(destination), false, 'the creation never starts');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written');

  // A document path whose PARENT directory does not exist resolves to neither an
  // identity nor the destination's canonical location, so it cannot name this
  // file and is deliberately ignored.
  const allowed = await publishIntegration(requestFor(fx, changes, {
    contents,
    openDocuments: () => [{ path: path.join(fx.root, 'missing', 'unrelated.txt'), text: '', version: 1 }]
  }));
  assert.deepEqual(allowed, { state: 'applied', applied: ['created-by-editor.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(destination), created);
});

test('a POSIX owner mode edit during staging is refused and left intact', { skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const base = Buffer.from('staged mode base\n');
  const next = Buffer.from('staged mode next\n');
  const target = await write(fx.root, 'staged.txt', base);
  await fs.chmod(target, 0o644);
  const changes = [{ path: 'staged.txt', before: entryOf(base, 0o644), after: entryOf(next, 0o644) }];
  const contents = { 'staged.txt': next };
  // The owner narrows the live file to 0o600 exactly while the approved payload
  // is staged: the first live check saw 0o644, the final check sees 0o600.
  const open = fsPromisesOpen();
  let edited = false;
  setPromisesOpen(async (file, ...args) => {
    if (isStageEntry(file) && !edited) {
      await fs.chmod(target, 0o600);
      edited = true;
    }
    return open(file, ...args);
  });
  let result;
  try {
    result = await publishIntegration(requestFor(fx, changes, { contents }));
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(edited, true, 'the owner edit is injected during staging');
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['staged.txt']);
  assert.match(result.conflicts[0].reason, /stale mode: the destination permissions changed while the publication was staged/);
  assert.deepEqual(await fs.readFile(target), base, 'the live file is never replaced');
  assert.equal((await fs.stat(target)).mode % 0o1000, 0o600, 'the 0o600 owner edit stays intact');
  assert.deepEqual(await stagingEntries(fx.root), [], 'only this call\'s temporary name is removed');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['staged.txt', 'pending']],
    'nothing reached the destination, so the entry stays retryable');

  // A retry stages with the live 0o600 permissions and keeps them.
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['staged.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mode % 0o1000, 0o600, 'the retry preserves the owner permissions');
});

test('path and mode preconditions are refused without touching the workspace', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('mode base\n');
  const next = Buffer.from('mode next\n');
  await write(fx.root, 'mode.txt', base);
  const protectedResult = await publishIntegration(requestFor(fx, [
    { path: '.git/config', before: null, after: entryOf(next) }
  ], { contents: { '.git/config': next } }));
  assert.equal(protectedResult.state, 'conflict');
  assert.match(protectedResult.conflicts[0].reason, /protected configuration directory/);

  const escapeResult = await publishIntegration(requestFor(fx, [
    { path: '../escape.txt', before: null, after: entryOf(next) }
  ], { contents: { '../escape.txt': next } }));
  assert.equal(escapeResult.state, 'conflict');

  const modeChange = { path: 'mode.txt', before: entryOf(base, 0o644), after: entryOf(next, 0o755) };
  if (process.platform === 'win32') {
    const result = await publishIntegration(requestFor(fx, [modeChange], { contents: { 'mode.txt': next } }));
    assert.equal(result.state, 'conflict');
    assert.match(result.conflicts[0].reason, /mode unsupported/);
    assert.deepEqual(await fs.readFile(path.join(fx.root, 'mode.txt')), base);
    // A deletion has no mode effect, so an executable-looking base still deletes.
    const deleteTarget = await write(fx.root, 'delete-mode.txt', base);
    const deletion = await publishIntegration(requestFor(fx, [
      { path: 'delete-mode.txt', before: entryOf(base, 0o755), after: null }
    ]));
    assert.equal(deletion.state, 'applied');
    assert.equal(await exists(deleteTarget), false);
  } else {
    const result = await publishIntegration(requestFor(fx, [modeChange], { contents: { 'mode.txt': next } }));
    assert.equal(result.state, 'applied');
    const stat = await fs.stat(path.join(fx.root, 'mode.txt'));
    assert.equal(stat.mode % 8, 5, 'the approved executable mode is applied');
  }
});

test('exact replay applies nothing and never overwrites later user edits', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('replay base\n');
  const next = Buffer.from('replay next\n');
  const target = await write(fx.root, 'replay.txt', base);
  const changes = [{ path: 'replay.txt', before: entryOf(base), after: entryOf(next) }];
  const request = requestFor(fx, changes, { contents: { 'replay.txt': next } });
  const first = await publishIntegration(request);
  assert.deepEqual(first, { state: 'applied', applied: ['replay.txt'], conflicts: [] });
  const revision = (await readJournal(fx)).revision;

  const past = new Date('2001-01-01T00:00:00.000Z');
  await fs.utimes(target, past, past);
  const publishedStat = await fs.stat(target);
  const replay = await publishIntegration(request);
  assert.deepEqual(replay, first);
  const replayedStat = await fs.stat(target);
  assert.deepEqual(await fs.readFile(target), next, 'an applied path is never rewritten');
  assert.equal(replayedStat.mtimeMs, publishedStat.mtimeMs, 'replay performs no filesystem effect');
  assert.equal((await readJournal(fx)).revision, revision, 'replay writes no journal revision');

  const userEdit = Buffer.from('later user edit\n');
  await fs.writeFile(target, userEdit);
  const afterEdit = await fs.stat(target);
  const third = await publishIntegration(request);
  assert.deepEqual(third, first);
  assert.deepEqual(await fs.readFile(target), userEdit, 'a later user edit on an applied path is preserved');
  assert.equal((await fs.stat(target)).mtimeMs, afterEdit.mtimeMs);
});

test('a durable intent is resolved by proof only and never repeated', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('intent base\n');
  const next = Buffer.from('intent next\n');
  const target = await write(fx.root, 'intent.txt', base);

  // Intent whose destination still equals the base: the effect may have run.
  await seedJournal(fx, [{ path: 'intent.txt', state: 'intent', before: entryOf(base), after: entryOf(next) }]);
  const pendingEffect = requestFor(fx, [{ path: 'intent.txt', before: entryOf(base), after: entryOf(next) }], {
    contents: { 'intent.txt': next }
  });
  const interrupted = await publishIntegration(pendingEffect);
  assert.equal(interrupted.state, 'interrupted');
  assert.deepEqual(interrupted.applied, []);
  assert.equal(interrupted.conflicts.length, 1);
  assert.equal(interrupted.conflicts[0].path, 'intent.txt');
  assert.match(interrupted.conflicts[0].reason, /interrupted/);
  assert.deepEqual(await fs.readFile(target), base, 'an uncertain effect is never repeated');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['interrupted']);

  // Exact replay of the recorded interruption is stable and effect-free.
  const revision = (await readJournal(fx)).revision;
  const again = await publishIntegration(pendingEffect);
  assert.deepEqual(again, interrupted);
  assert.deepEqual(await fs.readFile(target), base);
  assert.equal((await readJournal(fx)).revision, revision);

  // Intent whose destination already matches the approved result is complete:
  // it is recorded as applied and is not rewritten.
  await fs.writeFile(target, next);
  if (process.platform !== 'win32') {
    await fs.chmod(target, 0o644);
  }
  await seedJournal(fx, [{ path: 'intent.txt', state: 'intent', before: entryOf(base), after: entryOf(next) }]);
  const recoveredStat = await fs.stat(target);
  const recovered = await publishIntegration(pendingEffect);
  assert.deepEqual(recovered, { state: 'applied', applied: ['intent.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, recoveredStat.mtimeMs, 'a proven completion is not rewritten');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['applied']);
});

test('an intent under a replaced plain parent directory is never proven applied', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('parent base\n');
  const next = Buffer.from('parent after\n');
  await write(fx.root, 'parent/a.txt', base);
  await seedJournal(fx, [{ path: 'parent/a.txt', state: 'intent', before: entryOf(base), after: entryOf(next) }]);
  const request = requestFor(fx, [
    { path: 'parent/a.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'parent/a.txt': next } });

  // Replace the pinned parent with a DIFFERENT plain directory holding exactly
  // the approved bytes: identity, not content, decides trust.
  await fs.rm(path.join(fx.root, 'parent'), { recursive: true, force: true });
  await write(fx.root, 'parent/a.txt', next);
  const result = await publishIntegration(request);
  assert.equal(result.state, 'interrupted');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['parent/a.txt']);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'parent/a.txt')), next, 'the replacement directory is untouched');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['interrupted']);
});

test('an intent under a replaced junction or symlink parent is never proven applied', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('junction base\n');
  const next = Buffer.from('junction after\n');
  await write(fx.root, 'parent/a.txt', base);
  await seedJournal(fx, [{ path: 'parent/a.txt', state: 'intent', before: entryOf(base), after: entryOf(next) }]);
  const request = requestFor(fx, [
    { path: 'parent/a.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'parent/a.txt': next } });

  const outside = path.join(fx.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'a.txt'), next);
  const parent = path.join(fx.root, 'parent');
  await fs.rm(parent, { recursive: true, force: true });
  if (!await linkDirectory(outside, parent)) {
    t.diagnostic('directory links are unavailable on this host; the plain-directory identity case still covers the guard');
    return;
  }
  const stat = await fs.lstat(parent);
  assert.equal(stat.isSymbolicLink(), true, process.platform === 'win32' ? 'a Windows junction is reported as a link' : 'a directory symlink is reported as a link');

  const result = await publishIntegration(request);
  assert.equal(result.state, 'interrupted');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['parent/a.txt']);
  assert.deepEqual(await fs.readFile(path.join(outside, 'a.txt')), next, 'the linked directory content is never treated as proof');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['interrupted']);

  // The same guard refuses a live publication through the linked parent.
  await fs.rm(fx.journalPath);
  const live = await publishIntegration(requestFor(fx, [
    { path: 'parent/a.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'parent/a.txt': next } }));
  assert.equal(live.state, 'conflict');
  assert.deepEqual(live.applied, []);
  assert.match(live.conflicts[0].reason, /unsafe directory/);
  assert.deepEqual(await fs.readFile(path.join(outside, 'a.txt')), next);
});

test('a pending entry under a different plain parent directory is untrusted', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('pending parent base\n');
  const next = Buffer.from('pending parent after\n');
  await write(fx.root, 'parent/a.txt', base);
  await seedJournal(fx, [{ path: 'parent/a.txt', state: 'pending', before: entryOf(base), after: entryOf(next) }]);
  await fs.rm(path.join(fx.root, 'parent'), { recursive: true, force: true });
  await write(fx.root, 'parent/a.txt', base);
  const result = await publishIntegration(requestFor(fx, [
    { path: 'parent/a.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'parent/a.txt': next } }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.match(result.conflicts[0].reason, /unsafe directory|untrusted directory/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'parent/a.txt')), base, 'the same bytes in a new directory are not trusted');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['pending']);
});

test('a pending journal entry is safely applicable on retry', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('pending base\n');
  const next = Buffer.from('pending next\n');
  const target = await write(fx.root, 'pending.txt', base);
  await seedJournal(fx, [{ path: 'pending.txt', state: 'pending', before: entryOf(base), after: entryOf(next) }]);
  const result = await publishIntegration(requestFor(fx, [
    { path: 'pending.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'pending.txt': next } }));
  assert.deepEqual(result, { state: 'applied', applied: ['pending.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
});

test('an effect failure after its intent leaves a never-repeated interruption', async t => {
  const fx = await fixture(t);
  const firstBase = Buffer.from('first base\n');
  const secondBase = Buffer.from('second base\n');
  const firstNext = Buffer.from('first next\n');
  const secondNext = Buffer.from('second next\n');
  const firstTarget = await write(fx.root, 'a.txt', firstBase);
  const secondTarget = await write(fx.root, 'b.txt', secondBase);
  const changes = [
    { path: 'a.txt', before: entryOf(firstBase), after: entryOf(firstNext) },
    { path: 'b.txt', before: entryOf(secondBase), after: entryOf(secondNext) }
  ];
  const request = requestFor(fx, changes, { contents: { 'a.txt': firstNext, 'b.txt': secondNext } });

  const open = fsPromisesOpen();
  let injected = false;
  let creates = 0;
  setPromisesOpen(async (file, ...args) => {
    // Injected at the SECOND file's exclusive staging create, so the first entry
    // is already applied and this one is interrupted before any payload byte.
    if (isStageEntry(file) && args[0] === 'wx') {
      creates += 1;
      if (creates === 2) {
        injected = true;
        const error = new Error('injected effect failure');
        error.code = 'EACCES';
        throw error;
      }
    }
    return open(file, ...args);
  });
  try {
    await assert.rejects(publishIntegration(request), /injected effect failure/);
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(injected, true, 'the failure is injected at the second file payload');
  assert.deepEqual(await fs.readFile(firstTarget), firstNext, 'the first file completed');
  assert.deepEqual(await fs.readFile(secondTarget), secondBase, 'the uncertain file is untouched');
  const journal = await readJournal(fx);
  assert.deepEqual(journal.entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'interrupted']
  ]);
  assert.deepEqual(await stagingEntries(fx.root), [], 'a failed staging create leaves no staging entry behind');

  const revision = journal.revision;
  const retry = await publishIntegration(request);
  assert.equal(retry.state, 'interrupted');
  assert.deepEqual(retry.applied, ['a.txt']);
  assert.deepEqual(retry.conflicts.map(conflict => conflict.path), ['b.txt']);
  assert.deepEqual(await fs.readFile(secondTarget), secondBase, 'the uncertain effect is never repeated');
  assert.equal((await readJournal(fx)).revision, revision, 'no effect or completion is written for a recorded interruption');
});

test('an aborted publication leaves pending work that a retry completes without rewriting applied files', async t => {
  const fx = await fixture(t);
  const baseA = Buffer.from('a base\n');
  const baseB = Buffer.from('b base\n');
  const baseC = Buffer.from('c base\n');
  const nextA = Buffer.from('a next\n');
  const nextB = Buffer.from('b next\n');
  const nextC = Buffer.from('c next\n');
  const targetA = await write(fx.root, 'a.txt', baseA);
  await write(fx.root, 'b.txt', baseB);
  await write(fx.root, 'c.txt', baseC);
  const changes = [
    { path: 'a.txt', before: entryOf(baseA), after: entryOf(nextA) },
    { path: 'b.txt', before: entryOf(baseB), after: entryOf(nextB) },
    { path: 'c.txt', before: entryOf(baseC), after: entryOf(nextC) }
  ];
  const contents = { 'a.txt': nextA, 'b.txt': nextB, 'c.txt': nextC };
  let abortArmed = true;
  const request = requestFor(fx, changes, {
    contents,
    authorize: () => {
      if (!abortArmed) {
        return;
      }
      let states;
      try {
        states = new Map(readJournalSync(fx.journalPath).entries.map(entry => [entry.path, entry.state]));
      } catch {
        return;
      }
      // Abort exactly before b's durable intent: a is complete, b/c are pending.
      if (states.get('a.txt') === 'applied' && states.get('b.txt') === 'pending') {
        throw new Error('aborted before the second intent');
      }
    }
  });
  await assert.rejects(publishIntegration(request), /aborted before the second intent/);
  abortArmed = false;
  const journal = await readJournal(fx);
  assert.deepEqual(journal.entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'pending'], ['c.txt', 'pending']
  ]);
  assert.deepEqual(await fs.readFile(targetA), nextA);
  const appliedStat = await fs.stat(targetA);

  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['a.txt', 'b.txt', 'c.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(targetA), nextA);
  assert.equal((await fs.stat(targetA)).mtimeMs, appliedStat.mtimeMs, 'the applied file is not rewritten by the retry');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'b.txt')), nextB);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'c.txt')), nextC);
});

test('a live conflict on a later file stops the run and leaves the rest pending', async t => {
  const fx = await fixture(t);
  const baseA = Buffer.from('order a base\n');
  const baseB = Buffer.from('order b base\n');
  const baseC = Buffer.from('order c base\n');
  const nextA = Buffer.from('order a next\n');
  const nextB = Buffer.from('order b next\n');
  const nextC = Buffer.from('order c next\n');
  const targetA = await write(fx.root, 'a.txt', baseA);
  const targetB = await write(fx.root, 'b.txt', baseB);
  await write(fx.root, 'c.txt', baseC);
  const changes = [
    { path: 'a.txt', before: entryOf(baseA), after: entryOf(nextA) },
    { path: 'b.txt', before: entryOf(baseB), after: entryOf(nextB) },
    { path: 'c.txt', before: entryOf(baseC), after: entryOf(nextC) }
  ];
  const contents = { 'a.txt': nextA, 'b.txt': nextB, 'c.txt': nextC };
  // The editor opens b only once a is already applied, i.e. exactly at the live
  // check that runs immediately before b's effect.
  let armed = true;
  const openDocuments = () => {
    if (!armed) {
      return [];
    }
    let aNow;
    let bNow;
    try {
      aNow = fsSync.readFileSync(targetA);
      bNow = fsSync.readFileSync(targetB);
    } catch {
      return [];
    }
    return aNow.equals(nextA) && bNow.equals(baseB) ? [{ path: targetB, text: 'opened after preflight', version: 1 }] : [];
  };
  const result = await publishIntegration(requestFor(fx, changes, { contents, openDocuments }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, ['a.txt']);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['b.txt']);
  assert.match(result.conflicts[0].reason, /open editor/);
  assert.deepEqual(await fs.readFile(targetA), nextA, 'the earlier change stays applied');
  assert.deepEqual(await fs.readFile(targetB), baseB, 'the conflicting change never starts');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'pending'], ['c.txt', 'pending']
  ]);

  armed = false;
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['a.txt', 'b.txt', 'c.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(targetB), nextB);
});

test('a guard revoked at the completion write leaves the durable intent', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('intent guard base\n');
  const next = Buffer.from('intent guard next\n');
  const target = await write(fx.root, 'guarded.txt', base);
  const changes = [{ path: 'guarded.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'guarded.txt': next };
  // Revoke as soon as the effect is visible on disk, i.e. exactly at the
  // completion journal write.
  let revoked = false;
  const authorize = () => {
    if (revoked) {
      throw new Error('authorization revoked');
    }
    let current;
    try {
      current = fsSync.readFileSync(target);
    } catch {
      return;
    }
    if (current.equals(next)) {
      revoked = true;
      throw new Error('authorization revoked before the completion record');
    }
  };
  await assert.rejects(publishIntegration(requestFor(fx, changes, { contents, authorize })), /authorization revoked/);
  assert.deepEqual(await fs.readFile(target), next, 'the completed effect is on disk');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['guarded.txt', 'intent']],
    'a revoked guard never publishes an unguarded completion');
  const revision = (await readJournal(fx)).revision;

  const stat = await fs.stat(target);
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['guarded.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, stat.mtimeMs, 'the completed file is proven, not rewritten');
  assert.ok((await readJournal(fx)).revision > revision, 'the recovered completion is durable');
});

test('oversized destinations are refused before they are read', async t => {
  const fx = await fixture(t);
  const target = await write(fx.root, 'large.bin', Buffer.from('x'));
  await fs.truncate(target, 40 * 1024 * 1024);
  const expected = { type: 'file', hash: 'a'.repeat(64), size: 5 };
  const open = fsPromisesOpen();
  let openedTarget = 0;
  setPromisesOpen(async (file, ...args) => {
    if (typeof file === 'string' && file === target) {
      openedTarget += 1;
    }
    return open(file, ...args);
  });
  try {
    const result = await publishIntegration(requestFor(fx, [
      { path: 'large.bin', before: expected, after: entryOf(Buffer.from('small\n')) }
    ], { contents: { 'large.bin': Buffer.from('small\n') } }));
    assert.equal(result.state, 'conflict');
    assert.match(result.conflicts[0].reason, /stale content/);
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(openedTarget, 0, 'the destination is never opened or allocated before its size matches');
  assert.equal((await fs.stat(target)).size, 40 * 1024 * 1024);
});

test('a destination modified while it is read is refused', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('racing base\n');
  const next = Buffer.from('racing next\n');
  const target = await write(fx.root, 'racing.txt', base);
  const open = fsPromisesOpen();
  let touched = false;
  setPromisesOpen(async (file, ...args) => {
    if (typeof file !== 'string' || file !== target) {
      return open(file, ...args);
    }
    const handle = await open(file, ...args);
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      close: () => handle.close(),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!touched) {
          touched = true;
          await fs.utimes(target, new Date(), new Date(Date.now() + 2000));
        }
        return result;
      }
    };
  });
  try {
    const result = await publishIntegration(requestFor(fx, [
      { path: 'racing.txt', before: entryOf(base), after: entryOf(next) }
    ], { contents: { 'racing.txt': next } }));
    assert.equal(result.state, 'conflict');
    assert.match(result.conflicts[0].reason, /changed while it was inspected/);
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(touched, true, 'the change is injected during the read');
  assert.deepEqual(await fs.readFile(target), base, 'the racing destination is never rewritten');
});

// The final lstat of the staged check is the LAST observation before the rename,
// and the hashed read already matched, so an in-place write to the same inode
// that lands while that lstat is in flight is visible only there. The final path
// entry is compared with the handle's post-read stat (identity, size, precise
// mtime/ctime, link count, mode), so such a write is a conflict instead of a
// rename over the user's bytes. Only the entry that was actually checked is
// affected; the approved payload stays staged under this call's own name.
test('an in-place write during the final lstat of the staged check is a conflict', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('lstat base\n');
  const userEdit = Buffer.from('user edit!\n');
  assert.equal(userEdit.length, base.length, 'the injected write keeps the approved size, so only the times differ');
  const next = Buffer.from('lstat next\n');
  const target = await write(fx.root, 'lstat.txt', base);
  // A distant mtime, so the injected write is distinguishable from the approved
  // base even on a coarse-timestamp filesystem.
  const past = new Date('2001-01-01T00:00:00.000Z');
  await fs.utimes(target, past, past);
  const changes = [{ path: 'lstat.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'lstat.txt': next };

  const open = fsPromisesOpen();
  const lstat = fsPromisesLstat();
  let staged = false;
  let hashed = false;
  let injected = false;
  let lstatCalls = 0;
  setPromisesOpen(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (isStageEntry(file)) {
      // The approved payload is staged: the next target check is the final one.
      staged = true;
      hashed = false;
      return handle;
    }
    if (typeof file !== 'string' || file !== target) {
      return handle;
    }
    // The destination is inspected: its second handle stat is the post-read one,
    // i.e. the bytes have just been hashed and accepted.
    let observations = 0;
    hashed = false;
    return {
      stat: async (...statArgs) => {
        const stat = await handle.stat(...statArgs);
        observations += 1;
        hashed = observations === 2;
        return stat;
      },
      close: () => handle.close(),
      read: (...readArgs) => handle.read(...readArgs)
    };
  });
  let result;
  try {
    setPromisesLstat(async (file, ...args) => {
      if (staged && hashed && !injected && typeof file === 'string' && file === target) {
        injected = true;
        hashed = false;
        lstatCalls += 1;
        // Same inode, same size, written in place immediately before the real
        // stat: only this final observation can still see the change.
        fsSync.writeFileSync(target, userEdit);
      }
      return lstat(file, ...args);
    });
    result = await publishIntegration(requestFor(fx, changes, { contents }));
  } finally {
    setPromisesOpen(open);
    setPromisesLstat(lstat);
  }
  assert.equal(injected, true, 'the write is injected during the final lstat of the staged check');
  assert.equal(lstatCalls, 1);
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['lstat.txt']);
  assert.match(result.conflicts[0].reason, /changed while it was inspected/);
  assert.deepEqual(await fs.readFile(target), userEdit, 'the user bytes are intact');
  assert.deepEqual(await stagingEntries(fx.root), [],
    'only this call\'s own temporary name is removed');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['lstat.txt', 'pending']],
    'nothing reached the destination, so the entry stays retryable');

  // The retry cannot resurrect the approved base: the in-place edit is still the
  // only content on disk and is never overwritten.
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(retry.state, 'conflict');
  assert.match(retry.conflicts[0].reason, /stale content/);
  assert.deepEqual(await fs.readFile(target), userEdit, 'the user bytes are never overwritten');

  // The same observation also covers recovery proof: a durable intent whose
  // destination already matches the approved result is still proven applied and
  // is never rewritten, so the stricter check refuses changes only.
  const proof = await fixture(t);
  const proofBase = Buffer.from('proof base\n');
  const proofNext = Buffer.from('proof next\n');
  const proofTarget = await write(proof.root, 'proof.txt', proofNext);
  await seedJournal(proof, [{ path: 'proof.txt', state: 'intent', before: entryOf(proofBase), after: entryOf(proofNext) }]);
  const provenStat = await fs.stat(proofTarget);
  const proven = await publishIntegration(requestFor(proof, [
    { path: 'proof.txt', before: entryOf(proofBase), after: entryOf(proofNext) }
  ], { contents: { 'proof.txt': proofNext }, requireJournal: true }));
  assert.deepEqual(proven, { state: 'applied', applied: ['proof.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(proofTarget), proofNext);
  assert.equal((await fs.stat(proofTarget)).mtimeMs, provenStat.mtimeMs, 'a proven completion is not rewritten');
  assert.deepEqual((await readJournal(proof)).entries.map(entry => [entry.path, entry.state]), [['proof.txt', 'applied']]);
});

test('foreign, corrupt, unpinned and in-workspace journals are refused', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('journal base\n');
  const next = Buffer.from('journal next\n');
  await write(fx.root, 'journal.txt', base);
  const changes = [{ path: 'journal.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'journal.txt': next };

  await fs.writeFile(fx.journalPath, '{ not json');
  const corrupt = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(corrupt.state, 'conflict');
  assert.deepEqual(corrupt.applied, []);
  assert.match(corrupt.conflicts[0].reason, /journal conflict/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'journal.txt')), base);

  await fs.rm(fx.journalPath);
  await seedJournal(fx, [{ path: 'journal.txt', state: 'pending', before: entryOf(base), after: entryOf(next) }]);
  const otherIdentity = await publishIntegration(requestFor(fx, changes, { contents, identity: 'another-candidate' }));
  assert.equal(otherIdentity.state, 'conflict');
  assert.match(otherIdentity.conflicts[0].reason, /different approved candidate/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'journal.txt')), base, 'a journal of another candidate is never applied');

  const differentPlan = await publishIntegration(requestFor(fx, [
    { path: 'journal.txt', before: entryOf(base), after: entryOf(next) },
    { path: 'extra.txt', before: null, after: entryOf(Buffer.from('extra\n')) }
  ], { contents: { ...contents, 'extra.txt': Buffer.from('extra\n') } }));
  assert.equal(differentPlan.state, 'conflict');
  assert.match(differentPlan.conflicts[0].reason, /different changes/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'journal.txt')), base, 'a foreign journal never publishes');

  // A self-consistent journal pinned to a forged root identity is refused: the
  // pinned identity, not the journal's own consistency, decides trust.
  const pinned = await readJournal(fx);
  const forged = { ...pinned, trust: { root: { dev: '0', ino: '0' }, parents: pinned.trust.parents } };
  forged.plan = planDigest(forged.entries, forged.trust);
  await fs.writeFile(fx.journalPath, JSON.stringify(forged));
  const replacedRoot = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(replacedRoot.state, 'conflict');
  assert.match(replacedRoot.conflicts[0].reason, /unsafe directory|unsafe root/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'journal.txt')), base, 'a journal pinned to a foreign root never publishes');

  // A journal that omits the parent identity its own entries require is corrupt.
  const nestedBase = Buffer.from('nested base\n');
  const nestedNext = Buffer.from('nested next\n');
  await write(fx.root, 'nested/a.txt', nestedBase);
  await seedJournal(fx, [{ path: 'nested/a.txt', state: 'pending', before: entryOf(nestedBase), after: entryOf(nestedNext) }]);
  const nestedJournal = await readJournal(fx);
  const stripped = { ...nestedJournal, trust: { root: nestedJournal.trust.root, parents: {} } };
  stripped.plan = planDigest(stripped.entries, stripped.trust);
  await fs.writeFile(fx.journalPath, JSON.stringify(stripped));
  const unpinned = await publishIntegration(requestFor(fx, [
    { path: 'nested/a.txt', before: entryOf(nestedBase), after: entryOf(nestedNext) }
  ], { contents: { 'nested/a.txt': nestedNext } }));
  assert.equal(unpinned.state, 'conflict');
  assert.match(unpinned.conflicts[0].reason, /journal conflict/);
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'nested/a.txt')), nestedBase);

  await assert.rejects(
    publishIntegration(requestFor(fx, changes, { contents, journalPath: path.join(fx.root, 'publication.json') })),
    error => error.code === 'invalid_publication'
  );
  assert.equal(await exists(path.join(fx.root, 'publication.json')), false);

  if (await canSymlinkDirectory()) {
    const real = path.join(fx.base, 'real-journal');
    await fs.mkdir(real);
    await fs.rm(fx.journalPath);
    // A link at the journal path is never adopted as a journal file.
    const created = await linkDirectory(real, fx.journalPath);
    if (!created) {
      t.diagnostic('journal links are unavailable on this host');
      return;
    }
    const symlinked = await publishIntegration(requestFor(fx, changes, { contents }));
    assert.equal(symlinked.state, 'conflict');
    assert.match(symlinked.conflicts[0].reason, /journal conflict/);
    assert.deepEqual(await fs.readdir(real), [], 'the linked directory is never used as a journal');
  }
});

test('every effect and journal write is guarded by authorize', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('guard base\n');
  const next = Buffer.from('guard next\n');
  await write(fx.root, 'guard.txt', base);
  let calls = 0;
  const result = await publishIntegration(requestFor(fx, [
    { path: 'guard.txt', before: entryOf(base), after: entryOf(next) }
  ], {
    contents: { 'guard.txt': next },
    authorize: () => {
      calls += 1;
    }
  }));
  assert.equal(result.state, 'applied');
  // At minimum: request, preflight, live check, plan write (before + before the
  // rename), intent write, effect, completion write.
  assert.ok(calls >= 7, `authorize was consulted ${calls} times`);
});

test('POSIX replacements preserve non-exec bits and refuse special bits', { skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const base = Buffer.from('perm base\n');
  const next = Buffer.from('perm next\n');
  const target = await write(fx.root, 'perm.txt', base);
  await fs.chmod(target, 0o600);
  const kept = await publishIntegration(requestFor(fx, [
    { path: 'perm.txt', before: entryOf(base, 0o644), after: entryOf(next, 0o644) }
  ], { contents: { 'perm.txt': next } }));
  assert.equal(kept.state, 'applied');
  assert.equal((await fs.stat(target)).mode % 0o1000, 0o600, 'an ordinary edit never widens 0o600 to 0o644');
  assert.deepEqual(await fs.readFile(target), next);

  const execBase = Buffer.from('exec base\n');
  const execNext = Buffer.from('exec next\n');
  const execTarget = await write(fx.root, 'exec.sh', execBase);
  await fs.chmod(execTarget, 0o640);
  const executed = await publishIntegration(requestFor(fx, [
    { path: 'exec.sh', before: entryOf(execBase, 0o644), after: entryOf(execNext, 0o755) }
  ], { contents: { 'exec.sh': execNext } }));
  assert.equal(executed.state, 'applied');
  assert.equal((await fs.stat(execTarget)).mode % 0o1000, 0o750, 'only the supported executable bits are added');

  const created = await publishIntegration(requestFor(fx, [
    { path: 'created.sh', before: null, after: entryOf(Buffer.from('#!/bin/sh\n'), 0o755) }
  ], { contents: { 'created.sh': Buffer.from('#!/bin/sh\n') } }));
  assert.equal(created.state, 'applied');
  assert.equal((await fs.stat(path.join(fx.root, 'created.sh'))).mode % 0o1000, 0o755, 'a creation uses the approved mode');

  const specialBase = Buffer.from('special base\n');
  const specialTarget = await write(fx.root, 'special.txt', specialBase);
  await fs.chmod(specialTarget, 0o1644);
  const refused = await publishIntegration(requestFor(fx, [
    { path: 'special.txt', before: entryOf(specialBase), after: entryOf(next) }
  ], { contents: { 'special.txt': next } }));
  assert.equal(refused.state, 'conflict');
  assert.match(refused.conflicts[0].reason, /special permission bits/);
  assert.deepEqual(await fs.readFile(specialTarget), specialBase);
});

// A replacement whose approved entry asks for the executable class the
// destination already carries is NOT a mode change: every existing permission
// bit is preserved verbatim instead of being narrowed to the mapped slot. A
// planned change of the executable class still applies the approved class while
// keeping the destination's read/write bits, and special bits are still refused.
test('POSIX replacements preserve every permission bit of an unchanged executable class', { skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const base = Buffer.from('bits base\n');
  const next = Buffer.from('bits next\n');

  // 0o744 remains 0o744: the class is already executable, so the whole set stays.
  const ownerExec = await write(fx.root, 'owner.sh', base);
  await fs.chmod(ownerExec, 0o744);
  const kept = await publishIntegration(requestFor(fx, [
    { path: 'owner.sh', before: entryOf(base, 0o755), after: entryOf(next, 0o755) }
  ], { contents: { 'owner.sh': next } }));
  assert.equal(kept.state, 'applied');
  assert.equal((await fs.stat(ownerExec)).mode % 0o1000, 0o744, '0o744 remains 0o744');
  assert.deepEqual(await fs.readFile(ownerExec), next);

  // Execute bits on other slots are preserved too: 0o711 is not narrowed to 0o700.
  const otherExec = await write(fx.root, 'other.sh', base);
  await fs.chmod(otherExec, 0o711);
  const alsoKept = await publishIntegration(requestFor(fx, [
    { path: 'other.sh', before: entryOf(base, 0o755), after: entryOf(next, 0o755) }
  ], { contents: { 'other.sh': next } }));
  assert.equal(alsoKept.state, 'applied');
  assert.equal((await fs.stat(otherExec)).mode % 0o1000, 0o711, '0o711 remains 0o711');

  // An intentional supported mode change is still applied: an executable base
  // approved as 0o644 clears the execute bits and keeps the read/write bits.
  const cleared = await write(fx.root, 'cleared.sh', base);
  await fs.chmod(cleared, 0o744);
  const narrowed = await publishIntegration(requestFor(fx, [
    { path: 'cleared.sh', before: entryOf(base, 0o755), after: entryOf(next, 0o644) }
  ], { contents: { 'cleared.sh': next } }));
  assert.equal(narrowed.state, 'applied');
  assert.equal((await fs.stat(cleared)).mode % 0o1000, 0o644, 'the approved non-executable class is applied');

  // ... and a non-executable base approved as 0o755 gains the executable bit on
  // every readable slot while its group write bit is preserved.
  const executed = await write(fx.root, 'executed.sh', base);
  await fs.chmod(executed, 0o664);
  const widened = await publishIntegration(requestFor(fx, [
    { path: 'executed.sh', before: entryOf(base, 0o644), after: entryOf(next, 0o755) }
  ], { contents: { 'executed.sh': next } }));
  assert.equal(widened.state, 'applied');
  assert.equal((await fs.stat(executed)).mode % 0o1000, 0o775, 'the executable bit is added where the slot is readable');

  // Special bits are still refused, never carried into a replacement.
  const special = await write(fx.root, 'special-bits.sh', base);
  await fs.chmod(special, 0o1644);
  const refused = await publishIntegration(requestFor(fx, [
    { path: 'special-bits.sh', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'special-bits.sh': next } }));
  assert.equal(refused.state, 'conflict');
  assert.match(refused.conflicts[0].reason, /special permission bits/);
  assert.deepEqual(await fs.readFile(special), base, 'the special-bits file is never replaced');
});

test('journal trust keeps exact 64-bit identities instead of rounded doubles', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('exact base\n');
  const next = Buffer.from('exact next\n');
  const target = await write(fx.root, 'exact.txt', base);
  const changes = [{ path: 'exact.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'exact.txt': next };
  const applied = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(applied.state, 'applied');
  const journal = await readJournal(fx);
  const rootStat = await fs.lstat(await fs.realpath(fx.root), { bigint: true });
  assert.equal(journal.trust.root.ino, rootStat.ino.toString(), 'the durable identity is the exact decimal string');
  assert.equal(journal.trust.root.dev, rootStat.dev.toString());
  assert.match(journal.trust.root.ino, /^(?:0|[1-9][0-9]*)$/);

  // One unit away in the last digit: with doubles above 2^53 these two values
  // can round to the SAME number, so a journal pinned to the neighbour must
  // still be refused. Any other exact difference is refused for the same reason.
  const neighbour = { ...journal, trust: { root: { dev: journal.trust.root.dev, ino: (BigInt(journal.trust.root.ino) + 1n).toString() }, parents: journal.trust.parents } };
  neighbour.plan = planDigest(neighbour.entries, neighbour.trust);
  await fs.writeFile(fx.journalPath, JSON.stringify(neighbour));
  assert.equal((await publishIntegration(requestFor(fx, changes, { contents }))).state, 'conflict',
    'a neighbouring identity is never treated as the pinned root');
  assert.deepEqual(await fs.readFile(target), next, 'the applied file is untouched by the refused journal');

  // Non-canonical or numeric encodings are refused instead of coerced.
  for (const bad of [{ dev: Number(journal.trust.root.dev), ino: journal.trust.root.ino }, { dev: journal.trust.root.dev, ino: `0${journal.trust.root.ino}` }]) {
    const malformed = { ...journal, trust: { root: bad, parents: journal.trust.parents } };
    malformed.plan = planDigest(malformed.entries, malformed.trust);
    await fs.writeFile(fx.journalPath, JSON.stringify(malformed));
    const refused = await publishIntegration(requestFor(fx, changes, { contents }));
    assert.equal(refused.state, 'conflict');
    assert.match(refused.conflicts[0].reason, /decimal strings|canonical non-negative decimal integers/);
  }
});

test('a guard revoked at the interruption record leaves the durable intent for proof-only recovery', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('bookkeeping base\n');
  const next = Buffer.from('bookkeeping next\n');
  const target = await write(fx.root, 'bookkeeping.txt', base);
  const changes = [{ path: 'bookkeeping.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'bookkeeping.txt': next };
  // The effect fails for a non-authorization reason (injected), while the guard
  // is revoked as soon as the durable intent is visible.
  const open = fsPromisesOpen();
  setPromisesOpen(async (file, ...args) => {
    if (isStageEntry(file)) {
      const error = new Error('injected effect failure');
      error.code = 'EACCES';
      throw error;
    }
    return open(file, ...args);
  });
  const authorize = () => {
    let states;
    try {
      states = readJournalSync(fx.journalPath).entries.map(entry => entry.state);
    } catch {
      return;
    }
    if (states.includes('intent')) {
      throw new Error('authorization revoked after the durable intent');
    }
  };
  try {
    await assert.rejects(
      publishIntegration(requestFor(fx, changes, { contents, authorize })),
      /injected effect failure|authorization revoked/
    );
  } finally {
    setPromisesOpen(open);
  }
  assert.deepEqual(await fs.readFile(target), base, 'no effect reached the destination');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['bookkeeping.txt', 'intent']],
    'a revoked guard never publishes the interruption bookkeeping');

  const recovered = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(recovered.state, 'interrupted');
  assert.deepEqual(recovered.applied, []);
  assert.deepEqual(await fs.readFile(target), base, 'proof-only recovery never repeats the effect');
});

test('a plan beyond the change-count bound is a structured conflict, not a throw', async t => {
  const fx = await fixture(t);
  const approved = Buffer.from('count capacity\n');
  const changes = Array.from({ length: 1_025 }, (_, index) => ({
    path: `count-${index}.txt`, before: null, after: entryOf(approved)
  }));
  let reads = 0;
  const result = await publishIntegration({
    ...requestFor(fx, changes),
    read: async () => {
      reads += 1;
      throw new Error('an over-capacity plan must never read approved bytes');
    }
  });
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, '.', 'a root-wide refusal names the root, never an empty path the attempt ledger rejects');
  assert.match(result.conflicts[0].reason, /at most 1024 changes/);
  assert.equal(reads, 0, 'no approved byte is read');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written');
  assert.deepEqual(await fs.readdir(fx.root), [], 'no destination is touched');
});

test('a plan beyond the declared byte budget is refused before any approved byte is read', async t => {
  const fx = await fixture(t);
  // Nine DECLARED 32 MB results: 288 MB, above the 256 MB publication bound. The
  // sizes live in the approved entries only, so nothing large is allocated.
  const changes = Array.from({ length: 9 }, (_, index) => ({
    path: `budget-${index}.bin`, before: null, after: { type: 'file', hash: 'a'.repeat(64), size: 32 * 1024 * 1024 }
  }));
  let reads = 0;
  const result = await publishIntegration({
    ...requestFor(fx, changes),
    read: async () => {
      reads += 1;
      throw new Error('an over-budget plan must never allocate approved bytes');
    }
  });
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.equal(result.conflicts[0].path, '.', 'a root-wide refusal names the root, never an empty path the attempt ledger rejects');
  assert.match(result.conflicts[0].reason, /declares 301989888 approved bytes, above the 268435456-byte publication bound/);
  assert.equal(reads, 0, 'no approved byte is read');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written');
  assert.deepEqual(await fs.readdir(fx.root), [], 'no destination is created');
});

test('a resumed publication over the byte budget reports the paths it already applied', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('kept base\n');
  const next = Buffer.from('kept next\n');
  await write(fx.root, 'kept.txt', next);
  const changes = [
    { path: 'kept.txt', before: entryOf(base), after: entryOf(next) },
    ...Array.from({ length: 9 }, (_, index) => ({
      path: `resume-${index}.bin`, before: null, after: { type: 'file', hash: 'b'.repeat(64), size: 32 * 1024 * 1024 }
    }))
  ];
  await seedJournal(fx, [
    { path: 'kept.txt', state: 'applied', before: entryOf(base), after: entryOf(next) },
    ...changes.slice(1).map(change => ({ path: change.path, state: 'pending', before: change.before, after: change.after }))
  ]);
  const revision = (await readJournal(fx)).revision;
  let reads = 0;
  const result = await publishIntegration({
    ...requestFor(fx, changes),
    read: async () => {
      reads += 1;
      throw new Error('a resumed over-budget plan must never allocate approved bytes');
    }
  });
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, ['kept.txt'], 'the path already applied is reported');
  assert.equal(result.conflicts[0].path, '.', 'the resumed root-wide refusal names the root; the applied path stays in applied');
  assert.match(result.conflicts[0].reason, /declares 301989888 approved bytes/);
  assert.equal(reads, 0, 'no approved byte of the pending work is read');
  assert.equal((await readJournal(fx)).revision, revision, 'a capacity refusal writes no journal revision');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'kept.txt')), next, 'the applied file is not rewritten');
  assert.deepEqual(await fs.readdir(fx.root), ['kept.txt'], 'no pending destination is created');
});

test('a plan whose journal cannot fit the journal bound is refused before any effect', async t => {
  const fx = await fixture(t);
  // 1024 canonical 4096-character paths: the journal reaches more than 4 MB at
  // its worst-case encoding, above the bound its own recovery enforces, so the
  // plan must be refused instead of writing a journal that recovery cannot read.
  const approved = Buffer.from('j\n');
  const changes = Array.from({ length: 1_024 }, (_, index) => {
    const prefix = `p${index}-`;
    return { path: prefix + 'x'.repeat(4_096 - prefix.length), before: null, after: entryOf(approved) };
  });
  let reads = 0;
  const result = await publishIntegration({
    ...requestFor(fx, changes),
    read: async () => {
      reads += 1;
      throw new Error('an over-capacity journal must never read approved bytes');
    }
  });
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, fx.journalPath, 'a journal refusal names the journal');
  assert.match(result.conflicts[0].reason, /^journal capacity: .*above the 4194304-byte journal bound/);
  assert.equal(reads, 0, 'no approved byte is read');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written');
  assert.deepEqual(await fs.readdir(fx.root), [], 'no destination is created');
});

// fs.promises and the module's import share one object, so a narrow patch here
// injects a deterministic failure without changing the implementation.
function fsPromisesOpen() {
  return require('node:fs/promises').open;
}

function setPromisesOpen(next) {
  require('node:fs/promises').open = next;
}

/** The final staged check's last observation: the module's `fs.lstat`. */
function fsPromisesLstat() {
  return require('node:fs/promises').lstat;
}

function setPromisesLstat(next) {
  require('node:fs/promises').lstat = next;
}

function readJournalSync(file) {
  return JSON.parse(fsSync.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Recovery contract: requireJournal, onJournalReady and recoveryOnly.
//
// A publication that durably established a journal can never safely re-plan a
// lost one: the captured `before` entries are still satisfiable AFTER a user
// restores a file, so a fresh plan would happily overwrite that edit. The
// caller's latch is persisted through onJournalReady before any effect, and a
// missing journal is then terminal. recoveryOnly resolves durable state and
// never starts new or pending work.
// ---------------------------------------------------------------------------

/**
 * a.txt is applied and b.txt stays pending: the live check before b.txt's
 * effect sees an open editor, so the run stops with a durable journal.
 * `options` is forwarded to the request verbatim, so a caller can add its
 * recovery contract (the latch, the floor, the intent checkpoint).
 */
async function partialTwoFileApply(fx, bytes, options = {}) {
  const targetA = await write(fx.root, 'a.txt', bytes.baseA);
  const targetB = await write(fx.root, 'b.txt', bytes.baseB);
  const changes = [
    { path: 'a.txt', before: entryOf(bytes.baseA), after: entryOf(bytes.nextA) },
    { path: 'b.txt', before: entryOf(bytes.baseB), after: entryOf(bytes.nextB) }
  ];
  const contents = { 'a.txt': bytes.nextA, 'b.txt': bytes.nextB };
  let armed = true;
  const openDocuments = () => {
    if (!armed) {
      return [];
    }
    let aNow;
    let bNow;
    try {
      aNow = fsSync.readFileSync(targetA);
      bNow = fsSync.readFileSync(targetB);
    } catch {
      return [];
    }
    return aNow.equals(bytes.nextA) && bNow.equals(bytes.baseB)
      ? [{ path: targetB, text: 'opened after preflight', version: 1 }]
      : [];
  };
  const first = await publishIntegration(requestFor(fx, changes, { contents, openDocuments, ...options }));
  armed = false;
  return { targetA, targetB, changes, contents, first };
}

test('a partial apply whose established journal is lost is terminal and never rewrites a restored file', async t => {
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('lost journal a base\n'),
    baseB: Buffer.from('lost journal b base\n'),
    nextA: Buffer.from('lost journal a next\n'),
    nextB: Buffer.from('lost journal b next\n')
  };
  const setup = await partialTwoFileApply(fx, bytes);
  assert.equal(setup.first.state, 'conflict');
  assert.deepEqual(setup.first.applied, ['a.txt']);
  assert.deepEqual(setup.first.conflicts.map(conflict => conflict.path), ['b.txt']);
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'pending']
  ]);

  // The user later restores a.txt to exactly the bytes the plan captured as
  // `before` (a git checkout, or undoing the change), and the journal is lost.
  await fs.writeFile(setup.targetA, bytes.baseA);
  const restored = await fs.stat(setup.targetA);
  await fs.rm(fx.journalPath);

  // An established journal is REQUIRED: the missing one is terminal, and
  // neither the restored file nor the pending one is touched.
  const established = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, requireJournal: true
  }));
  assert.equal(established.state, 'interrupted');
  assert.deepEqual(established.applied, []);
  assert.deepEqual(established.conflicts.map(conflict => conflict.path), [fx.journalPath], 'a journal refusal names the journal');
  assert.match(established.conflicts[0].reason, /journal missing/);
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA, 'the restored user bytes survive');
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, restored.mtimeMs, 'no effect touched the restored file');
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB, 'the pending file is untouched');
  assert.equal(await exists(fx.journalPath), false, 'no replacement journal is written');

  // The same refusal holds for a storage-pressure recovery of that attempt.
  const recovery = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, requireJournal: true, recoveryOnly: true
  }));
  assert.equal(recovery.state, 'interrupted');
  assert.deepEqual(recovery.conflicts.map(conflict => conflict.path), [fx.journalPath]);
  assert.equal(await exists(fx.journalPath), false);
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA);
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB);
});

test('a fresh plan is used only while no journal was ever established', async t => {
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('fresh plan a base\n'),
    baseB: Buffer.from('fresh plan b base\n'),
    nextA: Buffer.from('fresh plan a next\n'),
    nextB: Buffer.from('fresh plan b next\n')
  };
  const setup = await partialTwoFileApply(fx, bytes);
  assert.equal(setup.first.state, 'conflict');
  await fs.writeFile(setup.targetA, bytes.baseA);
  await fs.rm(fx.journalPath);

  // requireJournal: false is the caller's proof that nothing was ever durably
  // established, so a truly fresh plan is still allowed - and the latch callback
  // observes the durable journal BEFORE any effect has run.
  let latchCalls = 0;
  let planned = null;
  let bytesAtLatch = null;
  const onJournalReady = async () => {
    latchCalls += 1;
    planned = (await readJournal(fx)).entries.map(entry => [entry.path, entry.state]);
    bytesAtLatch = await fs.readFile(setup.targetA);
  };
  const retry = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, requireJournal: false, onJournalReady
  }));
  assert.equal(latchCalls, 1, 'the latch is awaited exactly once');
  assert.deepEqual(planned, [['a.txt', 'pending'], ['b.txt', 'pending']], 'the fresh journal is durable first');
  assert.deepEqual(bytesAtLatch, bytes.baseA, 'no workspace effect runs before the latch');
  assert.deepEqual(retry, { state: 'applied', applied: ['a.txt', 'b.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.nextA, 'a fresh plan is only safe without an established journal');
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.nextB);
});

test('the caller latch is awaited before any effect and its rejection blocks publication', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('latch base\n');
  const next = Buffer.from('latch next\n');
  const target = await write(fx.root, 'latch.txt', base);
  const changes = [{ path: 'latch.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'latch.txt': next };

  // A rejected latch aborts before the destination is touched; only the durable
  // pending plan exists afterwards.
  await assert.rejects(publishIntegration(requestFor(fx, changes, {
    contents,
    onJournalReady: async () => {
      throw new Error('the latch store is unavailable');
    }
  })), /the latch store is unavailable/);
  assert.deepEqual(await fs.readFile(target), base, 'no effect runs before the latch is durable');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => entry.state), ['pending']);

  // An existing journal is the durable proof, so the latch runs before the
  // pending effect of the retry as well.
  const order = [];
  let bytesAtLatch = null;
  const result = await publishIntegration(requestFor(fx, changes, {
    contents,
    requireJournal: true,
    onJournalReady: async () => {
      order.push('latch');
      bytesAtLatch = await fs.readFile(target);
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push('latch-done');
    }
  }));
  order.push('result');
  assert.deepEqual(bytesAtLatch, base, 'the loaded journal latches before the effect');
  assert.deepEqual(order, ['latch', 'latch-done', 'result'], 'the latch is awaited, not raced');
  assert.deepEqual(result, { state: 'applied', applied: ['latch.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
});

test('proof-only recovery resolves durable state and never starts pending work', async t => {
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('recovery a base\n'),
    baseB: Buffer.from('recovery b base\n'),
    nextA: Buffer.from('recovery a next\n'),
    nextB: Buffer.from('recovery b next\n')
  };
  const setup = await partialTwoFileApply(fx, bytes);
  assert.equal(setup.first.state, 'conflict');
  const committed = await readJournal(fx);
  // The later user edit, and the pending file the recovery must leave alone.
  await fs.writeFile(setup.targetA, bytes.baseA);
  const restored = await fs.stat(setup.targetA);
  const pending = await fs.stat(setup.targetB);

  const recovery = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, requireJournal: true, recoveryOnly: true
  }));
  assert.equal(recovery.state, 'conflict', 'outstanding pending work stays a retryable conflict');
  assert.deepEqual(recovery.applied, ['a.txt'], 'the intact journal keeps its known applied paths');
  assert.deepEqual(recovery.conflicts.map(conflict => conflict.path), ['.']);
  assert.match(recovery.conflicts[0].reason, /^recovery pending: .*retry with a new request/);
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA, 'the restored bytes are preserved');
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, restored.mtimeMs, 'no effect ran on the applied path');
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB, 'the pending file is unchanged');
  assert.equal((await fs.stat(setup.targetB)).mtimeMs, pending.mtimeMs, 'no effect ran on the pending path');
  assert.equal((await readJournal(fx)).revision, committed.revision, 'recovery starts no journal revision');

  // An all-applied journal is reported as applied and writes nothing.
  const settled = await fixture(t);
  const settledBytes = {
    baseA: Buffer.from('settled a base\n'),
    baseB: Buffer.from('settled b base\n'),
    nextA: Buffer.from('settled a next\n'),
    nextB: Buffer.from('settled b next\n')
  };
  const settledChanges = [
    { path: 'a.txt', before: entryOf(settledBytes.baseA), after: entryOf(settledBytes.nextA) },
    { path: 'b.txt', before: entryOf(settledBytes.baseB), after: entryOf(settledBytes.nextB) }
  ];
  const settledContents = { 'a.txt': settledBytes.nextA, 'b.txt': settledBytes.nextB };
  await write(settled.root, 'a.txt', settledBytes.baseA);
  await write(settled.root, 'b.txt', settledBytes.baseB);
  const full = await publishIntegration(requestFor(settled, settledChanges, { contents: settledContents }));
  assert.deepEqual(full, { state: 'applied', applied: ['a.txt', 'b.txt'], conflicts: [] });
  const settledRevision = (await readJournal(settled)).revision;
  const reported = await publishIntegration(requestFor(settled, settledChanges, {
    contents: settledContents, requireJournal: true, recoveryOnly: true
  }));
  assert.deepEqual(reported, { state: 'applied', applied: ['a.txt', 'b.txt'], conflicts: [] });
  assert.equal((await readJournal(settled)).revision, settledRevision, 'an all-applied recovery writes nothing');

  // A durable intent is still resolved by proof only, and an uncertain one is
  // terminal: recovery never repeats it.
  const intents = await fixture(t);
  const intentBytes = {
    baseA: Buffer.from('intent a base\n'),
    baseB: Buffer.from('intent b base\n'),
    nextA: Buffer.from('intent a next\n'),
    nextB: Buffer.from('intent b next\n')
  };
  const intentChanges = [
    { path: 'a.txt', before: entryOf(intentBytes.baseA), after: entryOf(intentBytes.nextA) },
    { path: 'b.txt', before: entryOf(intentBytes.baseB), after: entryOf(intentBytes.nextB) }
  ];
  const intentContents = { 'a.txt': intentBytes.nextA, 'b.txt': intentBytes.nextB };
  await write(intents.root, 'a.txt', intentBytes.nextA);
  await write(intents.root, 'b.txt', intentBytes.baseB);
  await seedJournal(intents, [
    { path: 'a.txt', state: 'applied', before: entryOf(intentBytes.baseA), after: entryOf(intentBytes.nextA) },
    { path: 'b.txt', state: 'intent', before: entryOf(intentBytes.baseB), after: entryOf(intentBytes.nextB) }
  ]);
  const uncertain = await publishIntegration(requestFor(intents, intentChanges, {
    contents: intentContents, requireJournal: true, recoveryOnly: true
  }));
  assert.equal(uncertain.state, 'interrupted');
  assert.deepEqual(uncertain.applied, ['a.txt']);
  assert.deepEqual(uncertain.conflicts.map(conflict => conflict.path), ['b.txt']);
  assert.match(uncertain.conflicts[0].reason, /interrupted/);
  assert.deepEqual(await fs.readFile(path.join(intents.root, 'b.txt')), intentBytes.baseB, 'the uncertain effect is never repeated');
  assert.deepEqual((await readJournal(intents)).entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'interrupted']
  ]);

  // No journal at all: recovery resolves nothing, creates none and writes none.
  const empty = await fixture(t);
  const emptyBase = Buffer.from('nothing to recover\n');
  const emptyNext = Buffer.from('nothing to recover next\n');
  await write(empty.root, 'a.txt', emptyBase);
  const unavailable = await publishIntegration(requestFor(empty, [
    { path: 'a.txt', before: entryOf(emptyBase), after: entryOf(emptyNext) }
  ], { contents: { 'a.txt': emptyNext }, requireJournal: false, recoveryOnly: true }));
  assert.equal(unavailable.state, 'conflict');
  assert.deepEqual(unavailable.conflicts.map(conflict => conflict.path), ['.']);
  assert.match(unavailable.conflicts[0].reason, /^recovery unavailable: /);
  assert.equal(await exists(empty.journalPath), false, 'no journal is created under storage pressure');
  assert.deepEqual(await fs.readFile(path.join(empty.root, 'a.txt')), emptyBase);
});

// ---------------------------------------------------------------------------
// Journal ROLLBACK floor: minimumJournalRevision and onJournalIntent.
//
// Every check the module can run on a loaded journal is self-consistency:
// identity, root, plan digest and change signatures are all unchanged by a
// rollback, and neither the revision number nor the per-entry state is part of
// the plan. An intact journal restored to an EARLIER genuine revision therefore
// re-plans a change whose effect already completed, and combined with the
// recurring user edit (restoring a file to exactly its captured `before` bytes)
// the retry's preflight passes and the effect overwrites that edit. The attempt
// ledger persists the revision handed to onJournalIntent after each durable
// intent and passes it back as the floor.
// ---------------------------------------------------------------------------

const PAST = new Date('2001-01-01T00:00:00.000Z');

test('a journal rolled back below the durable minimum revision is terminal and rewrites nothing', async t => {
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('rollback a base\n'),
    baseB: Buffer.from('rollback b base\n'),
    nextA: Buffer.from('rollback a next\n'),
    nextB: Buffer.from('rollback b next\n')
  };
  // The FIRST durable revision - both entries pending, captured before any
  // effect - is what a caller's own latch/proof store observes.
  let captured = null;
  const setup = await partialTwoFileApply(fx, bytes, {
    onJournalReady: async () => {
      captured = await fs.readFile(fx.journalPath, 'utf8');
    }
  });
  const capturedJournal = JSON.parse(captured);
  const committed = await readJournal(fx);
  assert.equal(setup.first.state, 'conflict');
  assert.deepEqual(setup.first.applied, ['a.txt']);
  assert.deepEqual(capturedJournal.entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'pending'], ['b.txt', 'pending']
  ], 'the captured revision still records the already-applied a.txt as pending');
  assert.ok(capturedJournal.revision < committed.revision, 'the rollback target is an earlier genuine revision');
  assert.equal(capturedJournal.plan, committed.plan,
    'the plan digest is unchanged by the rollback, so only the revision separates the two journals');

  // The recurring user edit (undo / re-checkout restores the captured `before`
  // bytes) and then the journal rolled back BYTE-IDENTICALLY to that revision:
  // still a perfectly valid, self-consistent journal.
  await fs.writeFile(setup.targetA, bytes.baseA);
  await fs.utimes(setup.targetA, PAST, PAST);
  await fs.writeFile(fx.journalPath, captured);
  const aBefore = await fs.stat(setup.targetA);
  const bBefore = await fs.stat(setup.targetB);

  let latchCalls = 0;
  let intentCalls = 0;
  const guarded = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents,
    requireJournal: true,
    minimumJournalRevision: committed.revision,
    onJournalReady: async () => { latchCalls += 1; },
    onJournalIntent: async () => { intentCalls += 1; }
  }));
  assert.equal(guarded.state, 'interrupted');
  assert.deepEqual(guarded.applied, [], 'a rolled-back journal reports no applied path');
  assert.deepEqual(guarded.conflicts.map(conflict => conflict.path), [fx.journalPath], 'the refusal names the journal');
  assert.match(guarded.conflicts[0].reason, /^journal rollback: /);
  assert.match(guarded.conflicts[0].reason,
    new RegExp(`revision ${capturedJournal.revision}, below the durable minimum revision ${committed.revision}`));
  assert.equal(latchCalls, 0, 'no latch is persisted for a journal below the floor');
  assert.equal(intentCalls, 0, 'no intent checkpoint is taken for a journal below the floor');
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA, 'the restored user bytes survive');
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, aBefore.mtimeMs, 'no effect touched the restored file');
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB, 'the pending file is untouched');
  assert.equal((await fs.stat(setup.targetB)).mtimeMs, bBefore.mtimeMs, 'no effect touched the pending file');
  assert.equal(await fs.readFile(fx.journalPath, 'utf8'), captured, 'the rolled-back journal is never rewritten');

  // Proof-only recovery does not soften it: the journal is still below the floor.
  const recovery = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, recoveryOnly: true, minimumJournalRevision: committed.revision
  }));
  assert.equal(recovery.state, 'interrupted');
  assert.deepEqual(recovery.applied, []);
  assert.deepEqual(recovery.conflicts.map(conflict => conflict.path), [fx.journalPath]);
  assert.match(recovery.conflicts[0].reason, /^journal rollback: /);
  assert.equal(await fs.readFile(fx.journalPath, 'utf8'), captured, 'proof-only recovery does not rewrite it either');
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA);
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, aBefore.mtimeMs);
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB);
});

test('a positive minimum revision makes a missing journal terminal instead of a fresh plan', async t => {
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('floor missing a base\n'),
    baseB: Buffer.from('floor missing b base\n'),
    nextA: Buffer.from('floor missing a next\n'),
    nextB: Buffer.from('floor missing b next\n')
  };
  const setup = await partialTwoFileApply(fx, bytes);
  assert.equal(setup.first.state, 'conflict');
  const committed = await readJournal(fx);
  // The user restores a.txt to exactly the bytes a fresh plan would capture as
  // `before`, and the journal is lost.
  await fs.writeFile(setup.targetA, bytes.baseA);
  await fs.utimes(setup.targetA, PAST, PAST);
  const restored = await fs.stat(setup.targetA);
  await fs.rm(fx.journalPath);

  // A positive floor is the caller's own durable evidence that a journal WAS
  // established, so the floor alone (no requireJournal) is terminal.
  const result = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, minimumJournalRevision: committed.revision
  }));
  assert.equal(result.state, 'interrupted');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), [fx.journalPath]);
  assert.match(result.conflicts[0].reason, /journal missing/);
  assert.equal(await exists(fx.journalPath), false, 'no replacement journal is written');
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA, 'the restored user bytes survive');
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, restored.mtimeMs, 'no effect touched the restored file');
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.baseB);

  // The same holds for a storage-pressure recovery of that attempt.
  const recovery = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents, recoveryOnly: true, minimumJournalRevision: committed.revision
  }));
  assert.equal(recovery.state, 'interrupted');
  assert.deepEqual(recovery.conflicts.map(conflict => conflict.path), [fx.journalPath]);
  assert.match(recovery.conflicts[0].reason, /journal missing/);
  assert.equal(await exists(fx.journalPath), false);
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA);
});

test('a journal at or above the minimum revision is trusted and its equal-revision intent is proven', async t => {
  // (a) The intact journal AT the floor: the applied a.txt keeps the user's
  // restored bytes and only the still-pending b.txt is applied.
  const fx = await fixture(t);
  const bytes = {
    baseA: Buffer.from('floor pass a base\n'),
    baseB: Buffer.from('floor pass b base\n'),
    nextA: Buffer.from('floor pass a next\n'),
    nextB: Buffer.from('floor pass b next\n')
  };
  const setup = await partialTwoFileApply(fx, bytes);
  assert.equal(setup.first.state, 'conflict');
  const committed = await readJournal(fx);
  await fs.writeFile(setup.targetA, bytes.baseA);
  await fs.utimes(setup.targetA, PAST, PAST);
  const restored = await fs.stat(setup.targetA);

  let latchCalls = 0;
  const checkpoints = [];
  const allowed = await publishIntegration(requestFor(fx, setup.changes, {
    contents: setup.contents,
    requireJournal: true,
    minimumJournalRevision: committed.revision,
    onJournalReady: async () => { latchCalls += 1; },
    onJournalIntent: async revision => {
      const durable = readJournalSync(fx.journalPath);
      checkpoints.push({ revision, durable: durable.revision });
    }
  }));
  assert.deepEqual(allowed, { state: 'applied', applied: ['a.txt', 'b.txt'], conflicts: [] },
    'a journal at the floor is trusted');
  assert.equal(latchCalls, 1, 'the floor does not disable the caller latch');
  assert.equal(checkpoints.length, 1, 'only the file with a real effect is checkpointed');
  assert.equal(checkpoints[0].revision, checkpoints[0].durable,
    'the checkpoint reports the revision of that entry\'s durable intent record');
  assert.ok(checkpoints[0].revision > committed.revision);
  assert.deepEqual(await fs.readFile(setup.targetA), bytes.baseA, 'the restored bytes are never overwritten');
  assert.equal((await fs.stat(setup.targetA)).mtimeMs, restored.mtimeMs);
  assert.deepEqual(await fs.readFile(setup.targetB), bytes.nextB, 'the pending work completes');

  // (b) An equal-revision durable intent whose destination already matches the
  // approved result is a proven completion, not a rollback: equal is accepted.
  const proof = await fixture(t);
  const proofBase = Buffer.from('equal revision base\n');
  const proofNext = Buffer.from('equal revision next\n');
  const proofTarget = await write(proof.root, 'proof.txt', proofNext);
  const proofChanges = [{ path: 'proof.txt', before: entryOf(proofBase), after: entryOf(proofNext) }];
  const proofContents = { 'proof.txt': proofNext };
  await seedJournal(proof, [{ path: 'proof.txt', state: 'intent', before: entryOf(proofBase), after: entryOf(proofNext) }],
    { revision: 3 });
  const completed = await fs.stat(proofTarget);
  const proven = await publishIntegration(requestFor(proof, proofChanges, {
    contents: proofContents, requireJournal: true, minimumJournalRevision: 3
  }));
  assert.deepEqual(proven, { state: 'applied', applied: ['proof.txt'], conflicts: [] },
    'a journal at exactly the floor is not a rollback');
  assert.deepEqual(await fs.readFile(proofTarget), proofNext);
  assert.equal((await fs.stat(proofTarget)).mtimeMs, completed.mtimeMs, 'a proven completion is never rewritten');

  // (c) The same equal-revision intent whose destination does NOT match is
  // terminal by proof: the effect may have started, so it is never repeated.
  await fs.writeFile(proofTarget, proofBase);
  await fs.utimes(proofTarget, PAST, PAST);
  await seedJournal(proof, [{ path: 'proof.txt', state: 'intent', before: entryOf(proofBase), after: entryOf(proofNext) }],
    { revision: 3 });
  const uncertainStat = await fs.stat(proofTarget);
  const uncertain = await publishIntegration(requestFor(proof, proofChanges, {
    contents: proofContents, requireJournal: true, minimumJournalRevision: 3
  }));
  assert.equal(uncertain.state, 'interrupted');
  assert.deepEqual(uncertain.applied, []);
  assert.deepEqual(uncertain.conflicts.map(conflict => conflict.path), ['proof.txt']);
  assert.match(uncertain.conflicts[0].reason, /interrupted/);
  assert.deepEqual(await fs.readFile(proofTarget), proofBase, 'an uncertain effect is never repeated');
  assert.equal((await fs.stat(proofTarget)).mtimeMs, uncertainStat.mtimeMs);
  assert.deepEqual((await readJournal(proof)).entries.map(entry => [entry.path, entry.state]), [['proof.txt', 'interrupted']]);
});

test('a rejected intent checkpoint stops before any staged or real effect and keeps the durable intent', async t => {
  const fx = await fixture(t);
  const baseA = Buffer.from('checkpoint a base\n');
  const baseB = Buffer.from('checkpoint b base\n');
  const nextA = Buffer.from('checkpoint a next\n');
  const nextB = Buffer.from('checkpoint b next\n');
  const targetA = await write(fx.root, 'a.txt', baseA);
  const targetB = await write(fx.root, 'b.txt', baseB);
  const changes = [
    { path: 'a.txt', before: entryOf(baseA), after: entryOf(nextA) },
    { path: 'b.txt', before: entryOf(baseB), after: entryOf(nextB) }
  ];
  const contents = { 'a.txt': nextA, 'b.txt': nextB };
  const observed = [];
  const onJournalIntent = async revision => {
    const durable = readJournalSync(fx.journalPath);
    observed.push({
      revision,
      durable: durable.revision,
      states: durable.entries.map(entry => [entry.path, entry.state]),
      staged: await stagingEntries(fx.root),
      bytesA: await fs.readFile(targetA),
      bytesB: await fs.readFile(targetB)
    });
    if (durable.entries.some(entry => entry.path === 'b.txt' && entry.state === 'intent')) {
      throw new Error('the attempt ledger is unavailable');
    }
  };
  await assert.rejects(
    publishIntegration(requestFor(fx, changes, { contents, onJournalIntent })),
    /the attempt ledger is unavailable/
  );
  assert.equal(observed.length, 2, 'one checkpoint per real effect');
  assert.equal(observed[0].revision, observed[0].durable,
    'the checkpoint runs AFTER that entry\'s durable intent record');
  assert.deepEqual(observed[0].states, [['a.txt', 'intent'], ['b.txt', 'pending']]);
  assert.deepEqual(observed[0].staged, [], 'nothing is staged yet at the first checkpoint');
  assert.deepEqual(observed[0].bytesA, baseA, 'the effect of the first entry has not started');
  assert.deepEqual(observed[0].bytesB, baseB);
  assert.deepEqual(observed[1].states, [['a.txt', 'applied'], ['b.txt', 'intent']]);
  assert.deepEqual(observed[1].staged, [], 'the rejected checkpoint stops BEFORE any staged payload');
  assert.deepEqual(observed[1].bytesA, nextA, 'the first effect completed before the second checkpoint');
  assert.deepEqual(observed[1].bytesB, baseB, 'the rejected checkpoint stops BEFORE the second effect');
  assert.ok(observed[1].revision > observed[0].revision);
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [
    ['a.txt', 'applied'], ['b.txt', 'intent']
  ], 'the durable intent is left in place for proof-only recovery');
  const appliedStat = await fs.stat(targetA);
  const pendingStat = await fs.stat(targetB);
  assert.deepEqual(await stagingEntries(fx.root), []);

  // The retry accepts the journal at that revision (it is not below the floor)
  // and resolves the durable intent by proof only: never by repeating it.
  const retry = await publishIntegration(requestFor(fx, changes, {
    contents,
    requireJournal: true,
    minimumJournalRevision: observed[1].revision
  }));
  assert.equal(retry.state, 'interrupted');
  assert.deepEqual(retry.applied, ['a.txt']);
  assert.deepEqual(retry.conflicts.map(conflict => conflict.path), ['b.txt']);
  assert.match(retry.conflicts[0].reason, /interrupted/);
  assert.deepEqual(await fs.readFile(targetA), nextA);
  assert.equal((await fs.stat(targetA)).mtimeMs, appliedStat.mtimeMs, 'the applied file is not rewritten');
  assert.deepEqual(await fs.readFile(targetB), baseB);
  assert.equal((await fs.stat(targetB)).mtimeMs, pendingStat.mtimeMs, 'the uncertain effect is never repeated');

  // A rejection at the VERY FIRST checkpoint leaves the workspace completely
  // untouched, with only the durable intent recorded.
  const fresh = await fixture(t);
  const freshBase = Buffer.from('checkpoint only base\n');
  const freshNext = Buffer.from('checkpoint only next\n');
  const freshTarget = await write(fresh.root, 'only.txt', freshBase);
  const freshChanges = [{ path: 'only.txt', before: entryOf(freshBase), after: entryOf(freshNext) }];
  const freshContents = { 'only.txt': freshNext };
  await assert.rejects(publishIntegration(requestFor(fresh, freshChanges, {
    contents: freshContents,
    onJournalIntent: async () => {
      throw new Error('the attempt ledger is unavailable');
    }
  })), /the attempt ledger is unavailable/);
  assert.deepEqual(await fs.readFile(freshTarget), freshBase, 'the very first effect never starts');
  assert.deepEqual((await readJournal(fresh)).entries.map(entry => [entry.path, entry.state]), [['only.txt', 'intent']],
    'the durable intent stays in place for proof-only recovery');
  assert.deepEqual(await stagingEntries(fresh.root), [], 'nothing was staged');
  const freshRetry = await publishIntegration(requestFor(fresh, freshChanges, {
    contents: freshContents, requireJournal: true, minimumJournalRevision: 1
  }));
  assert.equal(freshRetry.state, 'interrupted');
  assert.deepEqual(freshRetry.conflicts.map(conflict => conflict.path), ['only.txt']);
  assert.deepEqual(await fs.readFile(freshTarget), freshBase, 'the effect is never repeated');
});

test('a malformed rollback contract is refused before any journal or effect', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('contract base\n');
  const next = Buffer.from('contract next\n');
  const target = await write(fx.root, 'contract.txt', base);
  const changes = [{ path: 'contract.txt', before: entryOf(base), after: entryOf(next) }];
  let reads = 0;
  const request = {
    ...requestFor(fx, changes, { contents: { 'contract.txt': next } }),
    read: async () => {
      reads += 1;
      throw new Error('a malformed contract must never read approved bytes');
    }
  };
  for (const bad of [{ minimumJournalRevision: -1 }, { minimumJournalRevision: 1.5 }, { minimumJournalRevision: Number.NaN }]) {
    await assert.rejects(publishIntegration({ ...request, ...bad }), error => error.code === 'invalid_publication');
  }
  await assert.rejects(publishIntegration({ ...request, onJournalIntent: 'not a function' }),
    error => error.code === 'invalid_publication');
  assert.equal(reads, 0, 'no approved byte is read');
  assert.equal(await exists(fx.journalPath), false, 'no journal is written');
  assert.deepEqual(await fs.readFile(target), base);
});

// ---------------------------------------------------------------------------
// Staging: fixed-length sibling names, durable stage bookkeeping and
// proof-only cleanup.
//
// A destination-suffixed temporary name (`<leaf>.<uuid>.publish.tmp`) is 49
// characters longer than its destination, so a valid 234-character leaf failed
// with ENOENT while creating it and the journal was then left interrupted.
// Staging now uses a short FIXED-LENGTH sibling name, pins it into the entry's
// durable intent, creates it exclusively, records its actual identity before the
// first payload byte and removes it again only when that identity, its content
// and its link state prove it is this module's own entry.
// ---------------------------------------------------------------------------

test('a maximal-length destination leaf publishes through a fixed-length staging sibling', async t => {
  const fx = await fixture(t);
  // 234 characters: inside the 255-character component bound, and 49 characters
  // more than any destination-suffixed temporary name can carry.
  const leaf = `${'n'.repeat(230)}.txt`;
  assert.equal(leaf.length, 234);
  const base = Buffer.from('long leaf base\n');
  const next = Buffer.from('long leaf next\n');
  const target = await write(fx.root, leaf, base);
  const changes = [{ path: leaf, before: entryOf(base), after: entryOf(next) }];
  const contents = { [leaf]: next };
  const replaced = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(replaced, { state: 'applied', applied: [leaf], conflicts: [] },
    'the replacement is applied instead of failing with ENOENT on the staging name');
  assert.deepEqual(await fs.readFile(target), next, 'the maximal leaf carries the approved bytes');
  assert.deepEqual(await stagingEntries(fx.root), [], 'the fixed-length staging sibling is gone');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [[leaf, 'applied']]);

  // A creation publishes by link()+unlink() under the same fixed-length name, so
  // it is not the rename path alone that stays inside the component bound.
  const createdLeaf = `${'c'.repeat(230)}.txt`;
  const created = Buffer.from('long created\n');
  const creation = await publishIntegration(requestFor(fx, [
    { path: createdLeaf, before: null, after: entryOf(created) }
  ], { contents: { [createdLeaf]: created }, journalPath: path.join(fx.base, 'store', 'created.json') }));
  assert.deepEqual(creation, { state: 'applied', applied: [createdLeaf], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(fx.root, createdLeaf)), created);
  assert.deepEqual(await stagingEntries(fx.root), []);
});

// A REAL process exit: the child publishes through the built module and exits
// inside the final replacement, after the staged payload is flushed and
// re-checked. Nothing in this process can clean that up, so the durable stage
// record has to make the cleanup provable on the next (real) recovery.
const CRASH_PUBLISHER = `
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const STAGE = /^\\.codex-stage-[0-9a-f]{16}\\.tmp$/;
const { publishIntegration } = require(path.join(process.env.STEP5_TEST_BUILD, 'integration-publication'));
const spec = JSON.parse(process.env.STEP5_CRASH_SPEC);
const target = path.join(spec.root, spec.rel);
const entry = bytes => ({ type: 'file', hash: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
(async () => {
  const base = await fsp.readFile(target);
  const next = Buffer.from(spec.next, 'utf8');
  // Exit at the final replacement of THIS destination only; the journal
  // helper's own rename is passed through unchanged.
  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (STAGE.test(path.basename(String(from))) && path.resolve(String(to)) === path.resolve(target)) {
      process.exit(9);
    }
    return realRename(from, to);
  };
  await publishIntegration({
    root: spec.root,
    journalPath: spec.journalPath,
    identity: spec.identity,
    changes: [{ path: spec.rel, before: entry(base), after: entry(next) }],
    read: async () => Buffer.from(next),
    openDocuments: () => [],
    authorize: () => undefined
  });
  process.exit(7);
})().catch(error => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
`;

test('staged bytes left by an exited process are cleaned by a real recovery', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('crash base\n');
  const next = Buffer.from('crash next\n');
  const target = await write(fx.root, 'crash.txt', base);
  const changes = [{ path: 'crash.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'crash.txt': next };
  const script = path.join(fx.base, 'crash-publisher.cjs');
  await fs.writeFile(script, CRASH_PUBLISHER);
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STEP5_TEST_BUILD: buildDir,
      STEP5_CRASH_SPEC: JSON.stringify({
        root: fx.root, rel: 'crash.txt', journalPath: fx.journalPath, identity: 'candidate-approved',
        next: next.toString('utf8')
      })
    }
  });
  assert.equal(run.status, 9, `the publisher exited after the staged flush (stderr: ${run.stderr})`);
  assert.deepEqual(await fs.readFile(target), base, 'the replacement never happened');

  // The crash state: one complete staged payload and a durable intent that pins
  // the exact name and identity.
  const left = await stagingEntries(fx.root);
  assert.equal(left.length, 1, 'exactly one staged payload is left behind');
  assert.deepEqual(await fs.readFile(path.join(fx.root, left[0])), next, 'the staged payload is complete');
  const crashed = await readJournal(fx);
  assert.deepEqual(crashed.entries.map(entry => [entry.path, entry.state]), [['crash.txt', 'intent']]);
  const pinned = crashed.entries[0].stage;
  assert.equal(pinned.name, left[0], 'the durable intent pins the exact staging basename');
  const stagedStat = await fs.lstat(path.join(fx.root, left[0]), { bigint: true });
  assert.deepEqual(pinned.identity, { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() },
    'the staged identity was recorded durably before the payload');
  const crashedRevision = crashed.revision;

  // REAL recovery from the durable journal only: the verified staged bytes are
  // removed BEFORE the intent is resolved, and the intent itself is never
  // repeated.
  const recovered = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(recovered.state, 'interrupted', 'a possibly started effect is never repeated');
  assert.deepEqual(recovered.applied, []);
  assert.deepEqual(recovered.conflicts.map(conflict => conflict.path), ['crash.txt']);
  assert.deepEqual(await stagingEntries(fx.root), [], 'the verified staged payload is cleaned up');
  assert.deepEqual(await fs.readFile(target), base, 'recovery leaves the destination alone');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['crash.txt', 'interrupted']]);
  assert.ok((await readJournal(fx)).revision > crashedRevision, 'the resolved intent is durable');

  // Exact replay of the resolved interruption is stable and effect-free.
  const revision = (await readJournal(fx)).revision;
  const again = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(again, recovered);
  assert.equal((await readJournal(fx)).revision, revision, 'no revision is written for a resolved interruption');

  // Storage-pressure recovery starts no pending work either, and a clean
  // workspace stays clean.
  const pressure = await publishIntegration(requestFor(fx, changes, { contents, recoveryOnly: true }));
  assert.equal(pressure.state, 'interrupted');
  assert.deepEqual(await stagingEntries(fx.root), []);
});

test('recovery removes only a staging entry whose identity, content and link state it proves', async t => {
  const base = Buffer.from('stage proof base\n');
  const next = Buffer.from('stage proof next\n');
  const changesOf = (key, before, after) => [{ path: key, before: entryOf(before), after: entryOf(after) }];

  // (a) Same inode, LATER-EDITED bytes of the approved size: the identity still
  //     matches, so only the content proof can protect the file.
  const edited = await fixture(t);
  const editedTarget = await write(edited.root, 'edited.txt', base);
  const editedStage = '.codex-stage-00112233aabbccdd.tmp';
  const editedPath = path.join(edited.root, editedStage);
  await fs.writeFile(editedPath, next);
  const editedStat = await fs.lstat(editedPath, { bigint: true });
  const laterEdit = Buffer.from('x'.repeat(next.length));
  assert.equal(laterEdit.length, next.length);
  await fs.writeFile(editedPath, laterEdit);
  await seedJournal(edited, [{
    path: 'edited.txt', state: 'intent', before: entryOf(base), after: entryOf(next),
    stage: { name: editedStage, identity: { dev: editedStat.dev.toString(), ino: editedStat.ino.toString() } }
  }]);
  const editedResult = await publishIntegration(requestFor(edited, changesOf('edited.txt', base, next), {
    contents: { 'edited.txt': next }
  }));
  assert.equal(editedResult.state, 'interrupted');
  assert.deepEqual(await fs.readFile(editedPath), laterEdit, 'later-edited staging content is never removed');
  assert.deepEqual(await fs.readFile(editedTarget), base);

  // (b) A byte-identical CLONE at the pinned name (a different inode): the
  //     content matches, so only the identity proof can protect it.
  const cloned = await fixture(t);
  const clonedTarget = await write(cloned.root, 'cloned.txt', base);
  const clonedStage = '.codex-stage-8899aabbccddeeff.tmp';
  const clonedPath = path.join(cloned.root, clonedStage);
  await fs.writeFile(clonedPath, next);
  const clonedStat = await fs.lstat(clonedPath, { bigint: true });
  await fs.rm(clonedPath);
  await fs.copyFile(clonedTarget, clonedPath);
  await fs.writeFile(clonedPath, next);
  await seedJournal(cloned, [{
    path: 'cloned.txt', state: 'intent', before: entryOf(base), after: entryOf(next),
    stage: { name: clonedStage, identity: { dev: clonedStat.dev.toString(), ino: clonedStat.ino.toString() } }
  }]);
  const clonedResult = await publishIntegration(requestFor(cloned, changesOf('cloned.txt', base, next), {
    contents: { 'cloned.txt': next }
  }));
  assert.equal(clonedResult.state, 'interrupted');
  assert.deepEqual(await fs.readFile(clonedPath), next, 'a same-name clone is never removed');
  assert.deepEqual(await fs.readFile(clonedTarget), base);

  // (c) A PARTIAL payload is not provable either: it is neither the approved
  //     bytes, so it is left in place.
  const partial = await fixture(t);
  const partialTarget = await write(partial.root, 'partial.txt', base);
  const partialStage = '.codex-stage-0123456789abcdef.tmp';
  const partialPath = path.join(partial.root, partialStage);
  await fs.writeFile(partialPath, next.subarray(0, 4));
  const partialStat = await fs.lstat(partialPath, { bigint: true });
  await seedJournal(partial, [{
    path: 'partial.txt', state: 'intent', before: entryOf(base), after: entryOf(next),
    stage: { name: partialStage, identity: { dev: partialStat.dev.toString(), ino: partialStat.ino.toString() } }
  }]);
  const partialResult = await publishIntegration(requestFor(partial, changesOf('partial.txt', base, next), {
    contents: { 'partial.txt': next }
  }));
  assert.equal(partialResult.state, 'interrupted');
  assert.deepEqual(await fs.readFile(partialPath), next.subarray(0, 4), 'a partial payload is left untouched');
  assert.deepEqual(await fs.readFile(partialTarget), base);

  // (d) A LEGACY v2 intent carries no stage data at all: nothing is inferred and
  //     nothing is removed, even when a staging-shaped file happens to exist.
  const legacy = await fixture(t);
  await write(legacy.root, 'legacy.txt', base);
  const legacyPath = path.join(legacy.root, '.codex-stage-ffffffffffffeeee.tmp');
  await fs.writeFile(legacyPath, next);
  await seedJournal(legacy, [{ path: 'legacy.txt', state: 'intent', before: entryOf(base), after: entryOf(next) }]);
  const legacyResult = await publishIntegration(requestFor(legacy, changesOf('legacy.txt', base, next), {
    contents: { 'legacy.txt': next }
  }));
  assert.equal(legacyResult.state, 'interrupted');
  assert.deepEqual(await fs.readFile(legacyPath), next, 'legacy debris is never guessed at');
  assert.deepEqual((await readJournal(legacy)).entries.map(entry => [entry.path, entry.state]), [['legacy.txt', 'interrupted']]);
});

test('recovery removes the second link of an interrupted creation and proves the completion', async t => {
  const fx = await fixture(t);
  const next = Buffer.from('linked creation\n');
  const target = await write(fx.root, 'linked.txt', next);
  const stageName = '.codex-stage-0f0e0d0c0b0a0908.tmp';
  const staged = path.join(fx.root, stageName);
  // A creation publishes by link()+unlink(), so an exit between the two leaves
  // the staging name as a SECOND link to the inode the destination already
  // holds. The destination proof refuses a hard-linked destination, so the extra
  // link has to be separated and removed first.
  const publishedStat = await fs.lstat(target, { bigint: true });
  await fs.link(target, staged);
  assert.equal((await fs.lstat(staged, { bigint: true })).nlink, 2n);
  await seedJournal(fx, [{
    path: 'linked.txt', state: 'intent', before: null, after: entryOf(next),
    stage: { name: stageName, identity: { dev: publishedStat.dev.toString(), ino: publishedStat.ino.toString() } }
  }]);
  const changes = [{ path: 'linked.txt', before: null, after: entryOf(next) }];
  const published = await fs.stat(target);
  const recovered = await publishIntegration(requestFor(fx, changes, { contents: { 'linked.txt': next } }));
  assert.deepEqual(recovered, { state: 'applied', applied: ['linked.txt'], conflicts: [] },
    'the creation is provably complete once the extra link is gone');
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, published.mtimeMs, 'the published inode is never rewritten');
  assert.equal(await exists(staged), false, 'only the staging link is removed');
  assert.deepEqual(await stagingEntries(fx.root), []);
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['linked.txt', 'applied']]);
});

test('recovery preserves an owned staging file truncated by a later edit', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('marker base\n');
  const next = Buffer.from('marker next\n');
  const target = await write(fx.root, 'marker.txt', base);
  const stageName = '.codex-stage-a1b2c3d4e5f60718.tmp';
  const staged = path.join(fx.root, stageName);
  await fs.writeFile(staged, next);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  await seedJournal(fx, [{
    path: 'marker.txt', state: 'intent', before: entryOf(base), after: entryOf(next),
    stage: { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } }
  }]);
  await fs.truncate(staged, 0);
  const recovered = await publishIntegration(requestFor(fx, [
    { path: 'marker.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'marker.txt': next } }));
  assert.equal(recovered.state, 'interrupted', 'the intent itself is still never repeated');
  assert.deepEqual(await fs.readFile(staged), Buffer.alloc(0), 'the later truncation is preserved');
  assert.deepEqual(await fs.readFile(target), base);
});

test('a staging record with an invalid name or identity shape is a journal conflict', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('stage shape base\n');
  const next = Buffer.from('stage shape next\n');
  const target = await write(fx.root, 'shape.txt', base);
  const changes = [{ path: 'shape.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'shape.txt': next };
  const stat = await fs.lstat(target, { bigint: true });
  const identity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
  for (const stage of [
    { name: 'shape.txt', identity },
    { name: '../escape.tmp', identity },
    { name: '.codex-stage-0123456789abcdef.tmp', identity, extra: true },
    { name: '.codex-stage-0123456789abcdef.tmp', identity: { dev: 1, ino: identity.ino } }
  ]) {
    await seedJournal(fx, [{ path: 'shape.txt', state: 'intent', before: entryOf(base), after: entryOf(next), stage }]);
    const refused = await publishIntegration(requestFor(fx, changes, { contents }));
    assert.equal(refused.state, 'conflict', `the stage record ${JSON.stringify(stage)} is refused`);
    assert.match(refused.conflicts[0].reason, /journal conflict: .*stage/);
    assert.deepEqual(await fs.readFile(target), base);
    assert.equal(await exists(path.join(fx.root, '.codex-stage-0123456789abcdef.tmp')), false);
  }

  // A deletion has nothing to stage, so a stage record on it is refused too.
  await seedJournal(fx, [{
    path: 'shape.txt', state: 'intent', before: entryOf(base), after: null,
    stage: { name: '.codex-stage-0123456789abcdef.tmp', identity }
  }]);
  const deletion = await publishIntegration(requestFor(fx, [
    { path: 'shape.txt', before: entryOf(base), after: null }
  ], { contents }));
  assert.equal(deletion.state, 'conflict');
  assert.match(deletion.conflicts[0].reason, /journal conflict: .*stage/);
  assert.deepEqual(await fs.readFile(target), base, 'the refused journal deletes nothing');
});

test('a same-size edit of the staged payload during publication is never published or removed', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('stage edit base\n');
  const next = Buffer.from('stage edit next\n');
  const edited = Buffer.from('stage edit EDIT\n');
  assert.equal(edited.length, next.length, 'the injected edit keeps the approved size, so only the bytes differ');
  const target = await write(fx.root, 'edited-stage.txt', base);
  const changes = [{ path: 'edited-stage.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'edited-stage.txt': next };
  // The staged payload is complete and flushed, then written IN PLACE - same
  // inode, same size - immediately before its sync: its identity still matches
  // the recorded one, so only the approved-hash proof can refuse it.
  const open = fsPromisesOpen();
  let stagingPath = null;
  let injected = false;
  setPromisesOpen(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!isStageEntry(file) || args[0] !== 'wx') {
      return handle;
    }
    stagingPath = file;
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
      close: () => handle.close(),
      writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
      sync: async () => {
        if (!injected) {
          injected = true;
          fsSync.writeFileSync(file, edited);
        }
        return handle.sync();
      }
    };
  });
  let result;
  try {
    result = await publishIntegration(requestFor(fx, changes, { contents }));
  } finally {
    setPromisesOpen(open);
  }
  assert.equal(injected, true, 'the edit is injected into the staged payload');
  assert.notEqual(stagingPath, null, 'the staging entry was created');
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), ['edited-stage.txt']);
  assert.match(result.conflicts[0].reason, /^staging conflict: /);
  assert.deepEqual(await fs.readFile(target), base, 'the edited staged bytes are never published');
  // Same size and same inode, so only the bytes distinguish it: they are not the
  // approved payload, so the cleanup leaves them and the durable record says so.
  assert.deepEqual(await fs.readFile(stagingPath), edited, 'later-edited staging content is left in place');
  const journal = await readJournal(fx);
  assert.deepEqual(journal.entries.map(entry => [entry.path, entry.state]), [['edited-stage.txt', 'pending']]);
  assert.equal(journal.entries[0].stage.name, path.basename(stagingPath),
    'a known owned stage is never silently dropped from the durable record');
  const stagedStat = await fs.lstat(stagingPath, { bigint: true });
  assert.deepEqual(journal.entries[0].stage.identity,
    { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() }, 'the durable identity is unchanged');

  // NECESSARY PRECONDITION (the old expectation is deliberately replaced): a
  // retry may NOT stage under a fresh name while the recorded staging entry still
  // exists. The single per-row stage slot is never overwritten, so the row keeps
  // that exact record and returns a retryable conflict naming the staging path -
  // an edited payload has to be moved away by its owner first. Staging again
  // would leave the old `.codex-stage` file behind with no record of it.
  const blocked = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(blocked.state, 'conflict');
  assert.deepEqual(blocked.applied, []);
  assert.deepEqual(blocked.conflicts.map(conflict => conflict.path), [stagingPath],
    'the conflict names the exact recorded staging path');
  assert.match(blocked.conflicts[0].reason, /^stage debris: /);
  assert.deepEqual(await fs.readFile(target), base, 'nothing is published while the debris remains');
  assert.deepEqual(await fs.readFile(stagingPath), edited, 'unproved debris is never removed by a retry either');
  assert.deepEqual(await stagingEntries(fx.root), [path.basename(stagingPath)], 'no second staging name is created');
  const kept = await readJournal(fx);
  assert.deepEqual(kept.entries.map(entry => [entry.path, entry.state]), [['edited-stage.txt', 'pending']],
    'the row stays retryable');
  assert.deepEqual(kept.entries[0].stage, journal.entries[0].stage, 'the exact record is preserved verbatim');
  assert.equal(kept.revision, journal.revision, 'a refused reconciliation writes no journal revision');

  // The owner moves the edited payload out of the way. Once the recorded path is
  // provably absent, exactly that old staging entry is reconciled away and the
  // retry publishes under a new pinned name.
  const moved = path.join(fx.root, 'moved-away-stage.bin');
  await fs.rename(stagingPath, moved);
  const retry = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.deepEqual(retry, { state: 'applied', applied: ['edited-stage.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
  assert.deepEqual(await stagingEntries(fx.root), [], 'the recorded staging path is gone and no new one remains');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state, entry.stage]),
    [['edited-stage.txt', 'applied', undefined]], 'the reconciled record is dropped only after its path is absent');
  assert.deepEqual(await fs.readFile(moved), edited, 'the moved file itself is never touched');
});

test('proof-only recovery cleans a provable stage on a terminal row without replaying it', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('terminal stage base\n');
  const next = Buffer.from('terminal stage next\n');
  const target = await write(fx.root, 'terminal.txt', base);
  const changes = [{ path: 'terminal.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'terminal.txt': next };
  const seedTerminal = async (name) => {
    const staged = path.join(fx.root, name);
    await fs.writeFile(staged, next);
    const stat = await fs.lstat(staged, { bigint: true });
    await seedJournal(fx, [{
      path: 'terminal.txt', state: 'interrupted', before: entryOf(base), after: entryOf(next),
      stage: { name, identity: { dev: stat.dev.toString(), ino: stat.ino.toString() } }
    }], { revision: 4 });
    return staged;
  };

  // (a) Proof-only recovery: an already-terminal row is never re-proved, but the
  //     staging entry its own record describes is proved and removed.
  const first = await seedTerminal('.codex-stage-1a2b3c4d5e6f7081.tmp');
  const recovery = await publishIntegration(requestFor(fx, changes, {
    contents, recoveryOnly: true, minimumJournalRevision: 4
  }));
  assert.equal(recovery.state, 'interrupted');
  assert.deepEqual(recovery.applied, []);
  assert.deepEqual(recovery.conflicts.map(conflict => conflict.path), ['terminal.txt']);
  assert.equal(await exists(first), false, 'the provable staged bytes are cleaned');
  assert.deepEqual(await fs.readFile(target), base, 'the terminal row is never replayed');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['terminal.txt', 'interrupted']]);
  assert.equal((await readJournal(fx)).revision, 4, 'cleanup of a terminal row writes no journal revision');

  // (b) The same holds for a normal retry, and a settled row replays stably.
  const second = await seedTerminal('.codex-stage-8190f7e6d5c4b3a2.tmp');
  const retried = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(retried.state, 'interrupted');
  assert.equal(await exists(second), false);
  assert.deepEqual(await fs.readFile(target), base);
  assert.equal((await readJournal(fx)).revision, 4);
  const replay = await publishIntegration(requestFor(fx, changes, { contents }));
  assert.equal(replay.state, 'interrupted');
  assert.equal((await readJournal(fx)).revision, 4, 'a settled terminal row is stable and effect-free');
});

test('recovery never removes a two-link staging entry of a replacement', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('two link base\n');
  const next = Buffer.from('two link next\n');
  const target = await write(fx.root, 'two-link.txt', base);
  const stageName = '.codex-stage-0011ee22dd33cc44.tmp';
  const staged = path.join(fx.root, stageName);
  await fs.writeFile(staged, next);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  // A second, UNRELATED link to the staged inode: a replacement has no
  // interrupted link() window, so this shape is never provable.
  const extra = path.join(fx.root, 'unrelated-link.txt');
  if (!await fs.link(staged, extra).then(() => true, () => false)) {
    t.diagnostic('hard links are unavailable on this host');
    return;
  }
  assert.equal((await fs.lstat(staged, { bigint: true })).nlink, 2n);
  await seedJournal(fx, [{
    path: 'two-link.txt', state: 'intent', before: entryOf(base), after: entryOf(next),
    stage: { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } }
  }]);
  const recovered = await publishIntegration(requestFor(fx, [
    { path: 'two-link.txt', before: entryOf(base), after: entryOf(next) }
  ], { contents: { 'two-link.txt': next } }));
  assert.equal(recovered.state, 'interrupted');
  assert.deepEqual(await fs.readFile(staged), next, 'a two-link replacement stage is left untouched');
  assert.deepEqual(await fs.readFile(extra), next);
  assert.deepEqual(await fs.readFile(target), base, 'the target is never replayed');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state]), [['two-link.txt', 'interrupted']]);
});

// The REAL first-apply reproduction: an editor opens the destination between the
// staged write and the final destination check, and it also reports this attempt's
// own staging entry, so the destination effect is refused AND the in-process
// cleanup cannot prove the staging entry removable. The journal therefore keeps a
// `pending` row together with its exact stage record. Closing the editors must let
// the retry remove that EXACT old staging entry before it stages again, so the old
// `.codex-stage` payload is never orphaned and its record is never erased by a
// newer, unrelated staging name.
test('a first editor refusal that also blocks stage cleanup is resolved by a retry that removes the exact recorded stage', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('editor stage base\n');
  const next = Buffer.from('editor stage next\n');
  const target = await write(fx.root, 'editor-stage.txt', base);
  const changes = [{ path: 'editor-stage.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'editor-stage.txt': next };
  let blocking = true;
  // The editor sees the destination and the staging entry only once this attempt
  // has staged its payload, so preflight and the first live check pass and the
  // refusal lands exactly between the staged write and its publication.
  const openDocuments = () => {
    if (!blocking) {
      return [];
    }
    const staged = fsSync.readdirSync(fx.root).filter(name => STAGE_NAME.test(name));
    if (staged.length === 0) {
      return [];
    }
    return [
      { path: target, text: 'unsaved editor text', version: 2 },
      ...staged.map(name => ({ path: path.join(fx.root, name), text: 'unsaved staging text', version: 1 }))
    ];
  };
  const first = await publishIntegration(requestFor(fx, changes, { contents, openDocuments }));
  assert.equal(first.state, 'conflict');
  assert.deepEqual(first.applied, []);
  assert.deepEqual(first.conflicts.map(conflict => conflict.path), ['editor-stage.txt']);
  assert.match(first.conflicts[0].reason, /open editor/);
  assert.deepEqual(await fs.readFile(target), base, 'the destination is never published');
  const left = await stagingEntries(fx.root);
  assert.equal(left.length, 1, 'the approved payload was staged and could not be cleaned');
  const oldStage = path.join(fx.root, left[0]);
  assert.deepEqual(await fs.readFile(oldStage), next, 'the staged payload is the approved bytes');
  const oldStat = await fs.lstat(oldStage, { bigint: true });
  const durable = await readJournal(fx);
  assert.deepEqual(durable.entries.map(entry => [entry.path, entry.state]), [['editor-stage.txt', 'pending']]);
  assert.deepEqual(durable.entries[0].stage,
    { name: left[0], identity: { dev: oldStat.dev.toString(), ino: oldStat.ino.toString() } },
    'the known owned stage is never silently dropped from the durable record');

  // Proof-only recovery starts no new effect and reports the same exact path.
  const pressure = await publishIntegration(requestFor(fx, changes, { contents, openDocuments, recoveryOnly: true }));
  assert.equal(pressure.state, 'conflict');
  assert.deepEqual(pressure.conflicts.map(conflict => conflict.path), [oldStage]);
  assert.match(pressure.conflicts[0].reason, /^stage debris: /);
  assert.equal((await readJournal(fx)).revision, durable.revision, 'a refused reconciliation writes no revision');
  assert.deepEqual(await fs.readFile(target), base);
  assert.deepEqual(await fs.readFile(oldStage), next);

  // The editors close. The retry reconciles the EXACT recorded entry first, then
  // stages and publishes under a new name - nothing is orphaned.
  blocking = false;
  const retry = await publishIntegration(requestFor(fx, changes, { contents, openDocuments }));
  assert.deepEqual(retry, { state: 'applied', applied: ['editor-stage.txt'], conflicts: [] });
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal(await exists(oldStage), false, 'the exact old staging entry is removed before new staging');
  assert.deepEqual(await stagingEntries(fx.root), [], 'no staging entry is left behind');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state, entry.stage]),
    [['editor-stage.txt', 'applied', undefined]], 'the reconciled record is dropped only after its path is absent');
});

// A resolved intent whose destination proves applied but whose staging cleanup was
// refused keeps its stage reference, and a later proof-only recovery reconciles
// that applied row's OWN verified stage without replaying its destination. While
// an editor holds the staging entry, the pointer survives every attempt.
test('a resolved applied row keeps its verified stage until a recovery proves it absent', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('settled stage base\n');
  const next = Buffer.from('settled stage next\n');
  const target = await write(fx.root, 'settled-stage.txt', next);
  const stageName = '.codex-stage-0102030405060708.tmp';
  const staged = path.join(fx.root, stageName);
  await fs.writeFile(staged, next);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  const stage = { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } };
  const changes = [{ path: 'settled-stage.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'settled-stage.txt': next };
  const publishedStat = await fs.stat(target);
  await seedJournal(fx, [{ path: 'settled-stage.txt', state: 'applied', before: entryOf(base), after: entryOf(next), stage }],
    { revision: 2 });

  // An editor holds the staging entry: the applied destination is never re-proved
  // or replayed, the exact record survives, and the conflict names the staging path.
  const held = () => [{ path: staged, text: 'unsaved staging text', version: 4 }];
  const refused = await publishIntegration(requestFor(fx, changes, {
    contents, recoveryOnly: true, minimumJournalRevision: 2, openDocuments: held
  }));
  assert.equal(refused.state, 'conflict');
  assert.deepEqual(refused.applied, ['settled-stage.txt'], 'the applied path is still reported');
  assert.deepEqual(refused.conflicts.map(conflict => conflict.path), [staged],
    'the conflict names the exact recorded staging path');
  assert.match(refused.conflicts[0].reason, /^stage debris: /);
  assert.deepEqual(await fs.readFile(staged), next, 'the editor-held staging entry is never removed');
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, publishedStat.mtimeMs, 'the applied destination is never replayed');
  const stillHeld = await readJournal(fx);
  assert.equal(stillHeld.revision, 2, 'a refused reconciliation writes no journal revision');
  assert.deepEqual(stillHeld.entries[0].stage, stage, 'the exact stage record is preserved');

  // Repeated recovery is stable: the same refusal and the same pointer.
  const again = await publishIntegration(requestFor(fx, changes, { contents, openDocuments: held }));
  assert.deepEqual(again, refused);
  assert.deepEqual((await readJournal(fx)).entries[0].stage, stage, 'repeated refusal preserves the pointer');
  assert.equal((await readJournal(fx)).revision, 2);

  // With the editor closed the exact entry is proved and removed, and the applied
  // row is reported applied - its destination is still never rewritten.
  const settled = await publishIntegration(requestFor(fx, changes, {
    contents, recoveryOnly: true, minimumJournalRevision: 2
  }));
  assert.deepEqual(settled, { state: 'applied', applied: ['settled-stage.txt'], conflicts: [] });
  assert.equal(await exists(staged), false, 'the verified stage of the applied row is removed');
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, publishedStat.mtimeMs, 'the applied destination is never replayed');
  const reconciled = await readJournal(fx);
  assert.deepEqual(reconciled.entries.map(entry => [entry.path, entry.state, entry.stage]),
    [['settled-stage.txt', 'applied', undefined]]);
  assert.ok(reconciled.revision > 2, 'the reconciled record is durable');

  // The settled state replays without any further effect or revision.
  const replay = await publishIntegration(requestFor(fx, changes, { contents, recoveryOnly: true }));
  assert.deepEqual(replay, settled);
  assert.equal((await readJournal(fx)).revision, reconciled.revision, 'a settled applied row writes nothing');
});

// The intent -> applied transition must NOT end terminal when its own stage could
// not be cleared: Service.apply only re-enters the journal while the attempt's
// outcome is a retryable conflict, so a bare `applied` result would strand the
// staging entry forever. The SAME call therefore reports the stage conflict and the
// already applied path; the retry (after the editor closes) reconciles the exact
// recorded stage and preserves the published destination.
test('an intent proven applied with an uncleared stage is a retryable conflict that the next apply cleans', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('applied debris base\n');
  const next = Buffer.from('applied debris next\n');
  // The destination ALREADY holds the approved bytes: the intent is proven applied
  // without any replay. The staging file is an independent, owned copy of the same
  // payload, held open by an editor so no cleanup can be proved.
  const target = await write(fx.root, 'applied-debris.txt', next);
  const stageName = '.codex-stage-0a0b0c0d0e0f1020.tmp';
  const staged = path.join(fx.root, stageName);
  await fs.writeFile(staged, next);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  const stage = { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } };
  const changes = [{ path: 'applied-debris.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'applied-debris.txt': next };
  const published = await fs.stat(target);
  await seedJournal(fx, [{
    path: 'applied-debris.txt', state: 'intent', before: entryOf(base), after: entryOf(next), stage
  }], { revision: 2 });

  const held = () => [{ path: staged, text: 'unsaved staging text', version: 6 }];
  const pendingLedger = [];
  const first = await publishIntegration(requestFor(fx, changes, {
    contents, requireJournal: true, minimumJournalRevision: 2, openDocuments: held,
    onJournalIntent: async revision => { pendingLedger.push(revision); }
  }));
  // A retryable conflict, NOT a terminal applied result, and it carries the path
  // that is already applied.
  assert.equal(first.state, 'conflict');
  assert.deepEqual(first.applied, ['applied-debris.txt'], 'the already applied path is reported');
  assert.deepEqual(first.conflicts.map(conflict => conflict.path), [staged]);
  assert.match(first.conflicts[0].reason, /^stage debris: /);
  assert.deepEqual(pendingLedger, [], 'no new intent checkpoint is taken for a resolved row');
  assert.deepEqual(await fs.readFile(staged), next, 'the editor-held staging entry is never removed');
  assert.deepEqual(await fs.readFile(target), next);
  assert.equal((await fs.stat(target)).mtimeMs, published.mtimeMs, 'the proven destination is never replayed');
  const resolved = await readJournal(fx);
  assert.deepEqual(resolved.entries.map(entry => [entry.path, entry.state]), [['applied-debris.txt', 'applied']],
    'the row is durably applied');
  assert.deepEqual(resolved.entries[0].stage, stage, 'and it keeps the exact stage record');
  assert.ok(resolved.revision > 2, 'the resolved state is durable');

  // Repeated refusal before the editor closes is stable: same conflict, same
  // pointer, no new revision and no replayed destination.
  const again = await publishIntegration(requestFor(fx, changes, {
    contents, requireJournal: true, minimumJournalRevision: 2, openDocuments: held
  }));
  assert.deepEqual(again, first);
  assert.equal((await readJournal(fx)).revision, resolved.revision);
  assert.deepEqual((await readJournal(fx)).entries[0].stage, stage);

  // The editor closes: the retry re-enters the journal through that same conflict
  // path, reconciles the exact recorded stage, and reports the row applied without
  // touching the destination bytes or times.
  const retry = await publishIntegration(requestFor(fx, changes, {
    contents, requireJournal: true, minimumJournalRevision: 2
  }));
  assert.deepEqual(retry, { state: 'applied', applied: ['applied-debris.txt'], conflicts: [] });
  assert.equal(await exists(staged), false, 'the exact recorded staging entry is removed');
  assert.deepEqual(await fs.readFile(target), next, 'the destination is preserved');
  assert.equal((await fs.stat(target)).mtimeMs, published.mtimeMs, 'the destination is not rewritten');
  assert.deepEqual((await readJournal(fx)).entries.map(entry => [entry.path, entry.state, entry.stage]),
    [['applied-debris.txt', 'applied', undefined]], 'the record is dropped only after its path is absent');
});

// An absence is never accepted through an untrusted parent directory: a pinned
// parent that was replaced holds neither this module's staging entry nor any proof
// about it, so the record is preserved and the row stays a retryable conflict.
test('a staging record under a replaced parent is preserved instead of proved absent', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('replaced parent base\n');
  const next = Buffer.from('replaced parent next\n');
  await write(fx.root, 'parent/a.txt', base);
  const stageName = '.codex-stage-1111222233334444.tmp';
  const staged = path.join(fx.root, 'parent', stageName);
  await fs.writeFile(staged, next);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  const stage = { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } };
  await seedJournal(fx, [{ path: 'parent/a.txt', state: 'pending', before: entryOf(base), after: entryOf(next), stage }],
    { revision: 2 });
  const changes = [{ path: 'parent/a.txt', before: entryOf(base), after: entryOf(next) }];
  const contents = { 'parent/a.txt': next };

  // The pinned parent is replaced by a DIFFERENT plain directory that does not
  // contain the recorded staging name at all: its ENOENT proves nothing.
  await fs.rm(path.join(fx.root, 'parent'), { recursive: true, force: true });
  await write(fx.root, 'parent/a.txt', base);
  const result = await publishIntegration(requestFor(fx, changes, { contents, minimumJournalRevision: 2 }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.applied, []);
  assert.match(result.conflicts[0].reason, /stage debris: /);
  assert.equal(result.conflicts[0].path, staged, 'the conflict still names the recorded staging path');
  assert.deepEqual(await fs.readFile(path.join(fx.root, 'parent/a.txt')), base, 'nothing is applied');
  const kept = await readJournal(fx);
  assert.deepEqual(kept.entries.map(entry => [entry.path, entry.state]), [['parent/a.txt', 'pending']],
    'the row is not staged again and stays retryable');
  assert.deepEqual(kept.entries[0].stage, stage, 'the record is preserved through the replaced parent');
});

// A staging path that cannot be observed at all (here: a directory at the pinned
// name, which lstat sees but no removal can prove) is unproved, never "absent".
test('an unobservable staging path is unproved and keeps its record', async t => {
  const fx = await fixture(t);
  const base = Buffer.from('unreadable stage base\n');
  const next = Buffer.from('unreadable stage next\n');
  const target = await write(fx.root, 'unreadable.txt', base);
  const stageName = '.codex-stage-9999888877776666.tmp';
  const staged = path.join(fx.root, stageName);
  await fs.mkdir(staged);
  const stagedStat = await fs.lstat(staged, { bigint: true });
  const stage = { name: stageName, identity: { dev: stagedStat.dev.toString(), ino: stagedStat.ino.toString() } };
  await seedJournal(fx, [{ path: 'unreadable.txt', state: 'pending', before: entryOf(base), after: entryOf(next), stage }],
    { revision: 2 });
  const changes = [{ path: 'unreadable.txt', before: entryOf(base), after: entryOf(next) }];
  const result = await publishIntegration(requestFor(fx, changes, {
    contents: { 'unreadable.txt': next }, minimumJournalRevision: 2
  }));
  assert.equal(result.state, 'conflict');
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), [staged]);
  assert.match(result.conflicts[0].reason, /stage debris: /);
  assert.equal(await exists(staged), true, 'an unprovable staging path is never removed');
  assert.deepEqual(await fs.readFile(target), base, 'nothing is published over the recorded debris');
  assert.deepEqual((await readJournal(fx)).entries[0].stage, stage, 'the record is preserved');
  assert.equal((await readJournal(fx)).revision, 2, 'a refused reconciliation writes no revision');
});
