const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Loader: CODEX_RUNNER_VIEW_BUILD (this module's dedicated build), then
// CODEX_TEST_BUILD, then the standard shared .test-build used by npm test.
function loadBuildDir() {
  const dedicated = process.env.CODEX_RUNNER_VIEW_BUILD?.trim();
  const shared = process.env.CODEX_TEST_BUILD?.trim();
  return path.resolve(__dirname, '..', dedicated || shared || '.test-build');
}

const buildDir = loadBuildDir();
const { materializeRunnerView, importRunnerView, RUNNER_VIEW_LIMITS } = require(path.join(buildDir, 'runner-view'));
const { LayeredTree } = require(path.join(buildDir, 'layered-tree'));
const { WorkerError } = require(path.join(buildDir, 'types'));
const { fileModeFromPermissions } = require(path.join(buildDir, 'snapshot-content'));

const WINDOWS = process.platform === 'win32';
const treeRoot = WINDOWS ? 'C:\\work\\demo' : '/work/demo';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const tempRoot = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

/** Records bytes in a blob map and returns the matching ordinary file entry. */
function addFile(blobs, bytes, mode) {
  const buffer = Buffer.from(bytes);
  const hash = sha256(buffer);
  blobs.set(hash, buffer);
  return mode === undefined
    ? { type: 'file', hash, size: buffer.length }
    : { type: 'file', hash, size: buffer.length, mode };
}

function stateOf(tree, blobs, revision = 1) {
  const reads = [];
  return {
    tree,
    revision,
    reads,
    async read(input) {
      reads.push(input);
      const key = tree.resolve(input);
      if (key === undefined) {
        throw new WorkerError('not_found', `absent from the view: ${input}`);
      }
      const entry = tree.stat(key);
      if (!entry || entry.type !== 'file') {
        throw new WorkerError('unsupported_path', `${input} is not an ordinary captured file`);
      }
      const bytes = blobs.get(entry.hash);
      if (bytes === undefined) {
        throw new WorkerError('snapshot_content_missing', `missing blob for ${entry.hash}`);
      }
      return { path: key, bytes: Buffer.from(bytes), hash: entry.hash };
    }
  };
}

function makeView(entries, blobs, options = {}) {
  const tree = new LayeredTree(treeRoot, entries, options.deltas, { caseInsensitive: WINDOWS });
  return stateOf(tree, blobs, options.revision ?? 1);
}

async function walk(directory, base = '') {
  const files = new Map();
  const dirs = new Set();
  for (const dirent of await fs.readdir(path.join(directory, base), { withFileTypes: true })) {
    const relative = base === '' ? dirent.name : `${base}/${dirent.name}`;
    if (dirent.isDirectory()) {
      dirs.add(relative);
      const nested = await walk(directory, relative);
      for (const [key, value] of nested.files) {
        files.set(key, value);
      }
      for (const key of nested.dirs) {
        dirs.add(key);
      }
      continue;
    }
    files.set(relative, await fs.readFile(path.join(directory, relative)));
  }
  return { files, dirs };
}

/**
 * The merged namespace must be exactly the drained directory plus preserved
 * markers and the directories those markers still need.
 */
function assertRoundtrip(view, changes, disk, markers = []) {
  const merged = new LayeredTree(treeRoot, view.tree.entries, [changes], { caseInsensitive: WINDOWS });
  const expectedDirs = new Set(disk.dirs);
  for (const marker of markers) {
    const parts = marker.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirs.add(parts.slice(0, index).join('/'));
    }
  }
  const expected = [...disk.files.keys(), ...expectedDirs, ...markers].sort();
  assert.deepEqual(Object.keys(merged.entries).sort(), expected);
  for (const [key, bytes] of disk.files) {
    const entry = merged.stat(key);
    assert.equal(entry?.type, 'file', `merged ${key} must be a file`);
    assert.equal(entry.hash, sha256(bytes), `merged ${key} must keep its bytes`);
    assert.equal(entry.size, bytes.length);
  }
  for (const key of expectedDirs) {
    assert.equal(merged.stat(key)?.type, 'directory', `merged ${key} must stay a directory`);
  }
  for (const key of markers) {
    assert.equal(merged.stat(key)?.type, 'excluded', `merged ${key} must keep its marker`);
  }
  return merged;
}

/** Disk contents a delta is expected to expose (used to drop ignored output). */
function without(directory, prefixes) {
  const drop = key => prefixes.some(prefix => key === prefix || key.startsWith(`${prefix}/`));
  return {
    files: new Map([...directory.files].filter(([key]) => !drop(key))),
    dirs: new Set([...directory.dirs].filter(key => !drop(key)))
  };
}

test('materializes a complete base+overlay view with raw bytes, directories and modes', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const base = {
    'README.md': addFile(blobs, '# base\r\nsecond line\r\n'),
    'src': { type: 'directory' },
    'src/app.ts': addFile(blobs, 'export const a = 1;\n'),
    'src/removed.ts': addFile(blobs, 'gone\n'),
    'bin': { type: 'directory' },
    'bin/run.sh': addFile(blobs, '#!/bin/sh\necho hi\n', 0o755),
    'assets': { type: 'directory' },
    'assets/logo.bin': addFile(blobs, Buffer.from([0, 1, 2, 255, 13, 10, 239, 187, 191])),
    'docs': { type: 'directory' },
    'docs/hidden.txt': { type: 'excluded', detail: 'protected-name' }
  };
  const overlay = {
    'src/app.ts': addFile(blobs, 'export const a = 2;\r\n'),
    'src/added.txt': addFile(blobs, '\ufeffnew\r\nline'),
    'src/removed.ts': null
  };
  const view = makeView(base, blobs, { deltas: [overlay], revision: 7 });

  // A decoy "live workspace" that must never be consulted.
  const live = path.join(root, 'workspace', 'src');
  await fs.mkdir(live, { recursive: true });
  await fs.writeFile(path.join(live, 'app.ts'), 'LIVE');

  const baseline = await materializeRunnerView(view, target, () => undefined);

  const disk = await walk(target);
  assert.deepEqual([...disk.files.keys()].sort(), ['README.md', 'assets/logo.bin', 'bin/run.sh', 'src/added.txt', 'src/app.ts']);
  assert.deepEqual([...disk.dirs].sort(), ['assets', 'bin', 'docs', 'src']);
  assert.deepEqual(disk.files.get('src/app.ts'), Buffer.from('export const a = 2;\r\n'));
  assert.deepEqual(disk.files.get('src/added.txt'), Buffer.from('\ufeffnew\r\nline'));
  assert.deepEqual(disk.files.get('assets/logo.bin'), Buffer.from([0, 1, 2, 255, 13, 10, 239, 187, 191]));
  assert.equal(fsSync.existsSync(path.join(target, 'src', 'removed.ts')), false);
  // Excluded markers occupy no path; the live workspace was never read.
  assert.equal(fsSync.existsSync(path.join(target, 'docs', 'hidden.txt')), false);
  assert.equal(await fs.readFile(path.join(live, 'app.ts'), 'utf8'), 'LIVE');

  // Bytes are read only through the immutable view.
  const readKeys = [...view.reads].sort();
  assert.deepEqual(readKeys, ['README.md', 'assets/logo.bin', 'bin/run.sh', 'src/added.txt', 'src/app.ts']);

  // Baseline identity carries modes, the legacy "no mode" shape and a fingerprint.
  assert.equal(baseline.directory, target);
  assert.equal(baseline.revision, 7);
  assert.equal(baseline.files, 5);
  assert.equal(baseline.entries['bin/run.sh'].mode, 0o755);
  assert.equal(baseline.entries['README.md'].mode, null);
  assert.deepEqual([...baseline.directoryEntries], ['assets', 'bin', 'docs', 'src']);
  assert.match(baseline.fingerprint, /^[a-f0-9]{64}$/);

  // Executable mode is real on disk wherever the platform can represent it.
  const scriptMode = (await fs.stat(path.join(target, 'bin', 'run.sh'))).mode;
  const documentMode = (await fs.stat(path.join(target, 'README.md'))).mode;
  if (!WINDOWS) {
    assert.equal(fileModeFromPermissions(scriptMode), 0o755);
    assert.equal(fileModeFromPermissions(documentMode), 0o644);
  }
});

test('materialization refuses preexisting content, unsupported entries and unsafe targets', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();

  // Preexisting content.
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'stale.txt'), 'stale');
  const plain = makeView({ 'a.txt': addFile(blobs, 'a') }, blobs);
  await assert.rejects(materializeRunnerView(plain, target, () => undefined), { code: 'runner_view_directory_not_empty' });
  assert.equal(await fs.readFile(path.join(target, 'stale.txt'), 'utf8'), 'stale');

  // Unsupported snapshot entries fail setup instead of publishing a partial view.
  const unsupportedView = makeView({ 'bin': { type: 'directory' }, 'bin/ghost.dll': { type: 'unsupported', detail: 'symlink' } }, blobs);
  const fresh = path.join(root, 'fresh');
  await assert.rejects(materializeRunnerView(unsupportedView, fresh, () => undefined), { code: 'runner_view_unsupported' });
  assert.equal(fsSync.existsSync(fresh), false);

  // A linked (junction/symlink) target directory is never written through.
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const linkTarget = path.join(root, 'linked');
  let linked = true;
  try {
    await fs.symlink(outside, linkTarget, WINDOWS ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (linked) {
    await assert.rejects(materializeRunnerView(plain, linkTarget, () => undefined), { code: 'runner_view_directory_unsafe' });
    assert.deepEqual(await fs.readdir(outside), []);
  }

  // Corrupt or failing immutable reads never leave a partial view behind.
  const corrupt = makeView({ 'a.txt': addFile(blobs, 'a'), 'b.txt': addFile(blobs, 'b') }, blobs);
  const failing = path.join(root, 'failing');
  const brokenView = {
    tree: corrupt.tree,
    revision: 1,
    read: async input => ({ path: input, bytes: Buffer.from('tampered'), hash: corrupt.tree.stat(input).hash })
  };
  await assert.rejects(materializeRunnerView(brokenView, failing, () => undefined), { code: 'snapshot_content_missing' });
  assert.deepEqual(await fs.readdir(failing), []);
  const throwingView = {
    tree: corrupt.tree,
    revision: 1,
    read: async () => {
      throw new WorkerError('snapshot_content_missing', 'stale blob');
    }
  };
  await assert.rejects(materializeRunnerView(throwingView, failing, () => undefined), { code: 'snapshot_content_missing' });

  // The guard is honoured before the first write.
  const guarded = path.join(root, 'guarded');
  await assert.rejects(materializeRunnerView(plain, guarded, () => {
    throw new WorkerError('revoked', 'guard revoked');
  }), { code: 'revoked' });
  assert.equal(fsSync.existsSync(guarded), false);
});

test('import plans one delta for edits, additions, deletions and a directory rename', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const entries = {
    'src': { type: 'directory' },
    'src/app.ts': addFile(blobs, '\ufeffconst a = 1;\r\n'),
    'src/legacy.ts': addFile(blobs, 'legacy\r\n'),
    'bin': { type: 'directory' },
    'bin/run.sh': addFile(blobs, '#!/bin/sh\necho one\n', 0o755),
    'docs': { type: 'directory' },
    'docs/readme.md': addFile(blobs, '# docs\r\n'),
    'docs/hidden.txt': { type: 'excluded', detail: 'protected-name' },
    'assets': { type: 'directory' },
    'assets/binary.dat': addFile(blobs, Buffer.from([0, 1, 2, 3, 255]))
  };
  const view = makeView(entries, blobs, { revision: 3 });
  const baseline = await materializeRunnerView(view, target, () => undefined);

  // Command side effects: edit, add, delete, rename a whole directory, add binary.
  await fs.writeFile(path.join(target, 'src', 'app.ts'), '\ufeffconst a = 2;\r\n');
  await fs.writeFile(path.join(target, 'src', 'new.ts'), 'export const b = 0;\n');
  await fs.rm(path.join(target, 'src', 'legacy.ts'));
  await fs.rename(path.join(target, 'docs'), path.join(target, 'guides'));
  await fs.writeFile(path.join(target, 'assets', 'new.dat'), Buffer.from([0, 0, 7, 255, 13]));
  await fs.writeFile(path.join(target, 'bin', 'run.sh'), '#!/bin/sh\necho two\n');

  const stored = new Map();
  const put = async bytes => {
    const hash = sha256(bytes);
    stored.set(hash, Buffer.from(bytes));
    return hash;
  };
  const result = await importRunnerView(view, target, put, () => undefined, baseline);

  assert.equal(result.revision, 3);
  assert.deepEqual(result.added, ['assets/new.dat', 'guides', 'guides/readme.md', 'src/new.ts']);
  assert.deepEqual(result.deleted, ['docs/readme.md', 'src/legacy.ts']);
  assert.ok(result.modified.includes('src/app.ts'));
  assert.ok(result.modified.includes('bin/run.sh'));
  assert.deepEqual(result.renames, [{ kind: 'directory', from: 'docs', to: 'guides' }]);
  assert.deepEqual(result.ignoredOutputs, []);
  assert.deepEqual(result.ignoredProtected, []);

  // Exactly one delta object; markers are preserved, never tombstoned.
  const changes = result.changes;
  assert.equal(changes['src/legacy.ts'], null);
  assert.equal(changes['docs/readme.md'], null);
  assert.equal(Object.hasOwn(changes, 'docs/hidden.txt'), false);
  assert.equal(Object.hasOwn(changes, 'docs'), false);
  assert.deepEqual(changes['guides'], { type: 'directory' });
  // Windows-mode stability: the changed script keeps its recorded mode.
  assert.deepEqual(changes['bin/run.sh'], { type: 'file', hash: sha256(Buffer.from('#!/bin/sh\necho two\n')), size: 19, mode: 0o755 });
  // A plain new file records no mode (documented 0o644 default).
  assert.deepEqual(changes['src/new.ts'], { type: 'file', hash: sha256(Buffer.from('export const b = 0;\n')), size: 20 });
  assert.equal(result.bytes > 0, true);
  for (const [hash, bytes] of stored) {
    assert.equal(sha256(bytes), hash);
  }

  // The merged namespace reproduces the drained directory exactly.
  const disk = await walk(target);
  assertRoundtrip(view, changes, disk, ['docs/hidden.txt']);

  // BOM, CRLF and binary bytes survive the roundtrip verbatim.
  const merged = new LayeredTree(treeRoot, view.tree.entries, [changes], { caseInsensitive: WINDOWS });
  assert.deepEqual(stored.get(merged.stat('src/app.ts').hash), Buffer.from('\ufeffconst a = 2;\r\n'));
  assert.deepEqual(stored.get(merged.stat('assets/new.dat').hash), Buffer.from([0, 0, 7, 255, 13]));
  // Untouched content is never re-stored and keeps its original identity.
  assert.equal(merged.stat('assets/binary.dat').hash, view.tree.stat('assets/binary.dat').hash);
  assert.equal(stored.has(view.tree.stat('assets/binary.dat').hash), false);
});

test('a nonchanging import produces no changes and keeps legacy mode shapes', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const entries = {
    'src': { type: 'directory' },
    'src/plain.txt': addFile(blobs, 'plain\r\n'),
    'bin': { type: 'directory' },
    'bin/tool.sh': addFile(blobs, '#!/bin/sh\n', 0o755),
    'docs': { type: 'directory' },
    'docs/hidden.txt': { type: 'excluded', detail: 'protected-name' }
  };
  const view = makeView(entries, blobs);
  await materializeRunnerView(view, target, () => undefined);

  const put = async () => assert.fail('an unchanged import must not store content');
  const result = await importRunnerView(view, target, put, () => undefined);
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(Object.keys(result.changes), []);
  assert.equal(result.unchanged, 2);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.modified, []);
  assert.deepEqual(result.deleted, []);

  // A changed legacy file (no recorded mode) still records no mode on import.
  await fs.writeFile(path.join(target, 'src', 'plain.txt'), 'changed\r\n');
  const changed = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);
  assert.deepEqual(changed.changedPaths, ['src/plain.txt']);
  assert.equal(Object.hasOwn(changed.changes['src/plain.txt'], 'mode'), false);
  assert.deepEqual(changed.changes['src/plain.txt'], {
    type: 'file', hash: sha256(Buffer.from('changed\r\n')), size: 9
  });
});

test('a failed command keeps its side effects importable and its output ignored', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'src': { type: 'directory' },
    'src/index.ts': addFile(blobs, 'one\n')
  }, blobs);
  const baseline = await materializeRunnerView(view, target, () => undefined);

  // A failing command that still wrote real source and dependency output.
  await fs.writeFile(path.join(target, 'src', 'index.ts'), 'two\n');
  await fs.mkdir(path.join(target, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(target, 'node_modules', 'pkg', 'index.js'), 'dependency');
  await fs.mkdir(path.join(target, 'dist'), { recursive: true });
  await fs.writeFile(path.join(target, 'dist', 'bundle.js'), 'bundle');
  await fs.mkdir(path.join(target, '.git'), { recursive: true });
  await fs.writeFile(path.join(target, '.git', 'config'), 'protected');
  await fs.mkdir(path.join(target, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(target, '.vscode', 'settings.json'), '{}');
  await fs.mkdir(path.join(target, '.codex'), { recursive: true });
  await fs.writeFile(path.join(target, '.codex', 'hooks.json'), '{}');

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined, baseline);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.modified, ['src/index.ts']);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.ignoredOutputs.map(entry => entry.path).sort(), ['dist', 'node_modules']);
  assert.deepEqual(result.ignoredProtected, ['.codex', '.git', '.vscode']);
  assert.deepEqual(Object.keys(result.changes), ['src/index.ts']);
  assert.equal(fsSync.existsSync(path.join(target, 'node_modules', 'pkg', 'index.js')), true);
  assert.equal(fsSync.existsSync(path.join(target, '.git', 'config')), true);
});

test('output-patterned paths already visible in the view stay visible and importable', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'vendor': { type: 'directory' },
    'vendor/lib.js': addFile(blobs, 'tracked vendor\n'),
    'build': { type: 'directory' },
    'build/config.json': addFile(blobs, '{}\n')
  }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  await fs.writeFile(path.join(target, 'vendor', 'lib.js'), 'tracked vendor v2\n');
  await fs.writeFile(path.join(target, 'vendor', 'added.js'), 'new vendor\n');
  await fs.writeFile(path.join(target, 'build', 'config.json'), '{"a":1}\n');
  await fs.mkdir(path.join(target, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(target, 'node_modules', 'x', 'index.js'), 'ignored');

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);

  assert.deepEqual(result.ignoredOutputs.map(entry => entry.path), ['node_modules']);
  assert.deepEqual(result.changedPaths, ['build/config.json', 'vendor/added.js', 'vendor/lib.js']);
  assertRoundtrip(view, result.changes, without(await walk(target), ['node_modules']));

  // A visible output-patterned file that disappears is a real deletion.
  await fs.rm(path.join(target, 'vendor', 'lib.js'));
  await fs.rm(path.join(target, 'vendor', 'added.js'));
  const afterDelete = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);
  assert.ok(afterDelete.deleted.includes('vendor/lib.js'));
  assert.equal(afterDelete.changes['vendor/lib.js'], null);
});

test('new ordinary files named like output directories import as ordinary source', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'README.md': addFile(blobs, 'readme\r\n'),
    'src': { type: 'directory' },
    'src/index.ts': addFile(blobs, 'export const a = 1;\r\n')
  }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  // A command that creates FIVE new ordinary files whose basenames match the
  // snapshot output names. Capture and the private file tools treat those as
  // ordinary source; only DIRECTORIES with such a name are ephemeral output.
  const produced = new Map([
    ['build', '#!/bin/sh\necho build\n'],
    ['coverage', 'coverage: 100%\r\n'],
    ['dist', '\ufeffbinary-ish\r\n'],
    ['node_modules', 'not a dependency directory\n'],
    ['vendor', 'vendored source\n']
  ]);
  for (const [name, text] of produced) {
    await fs.writeFile(path.join(target, name), text);
  }
  if (!WINDOWS) {
    await fs.chmod(path.join(target, 'build'), 0o755);
  }

  const stored = new Map();
  const put = async bytes => {
    const hash = sha256(bytes);
    stored.set(hash, Buffer.from(bytes));
    return hash;
  };
  const result = await importRunnerView(view, target, put, () => undefined);
  const names = [...produced.keys()].sort();

  // Every one of them is imported: nothing is silently dropped, so the caller
  // never reports "unchanged" for a command that really created source files.
  assert.deepEqual(result.added, names);
  assert.deepEqual(result.changedPaths, names);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.ignoredOutputs, []);
  assert.deepEqual(result.renames, []);
  assert.equal(result.unchanged, 2);
  assert.ok(result.bytes > 0);

  const merged = new LayeredTree(treeRoot, view.tree.entries, [result.changes], { caseInsensitive: WINDOWS });
  for (const [name, text] of produced) {
    const entry = merged.stat(name);
    assert.equal(entry?.type, 'file', `${name} must import as an ordinary file`);
    assert.equal(entry.size, Buffer.byteLength(text));
    assert.deepEqual(stored.get(entry.hash), Buffer.from(text), `${name} bytes must survive verbatim`);
  }
  // Mode handling is unchanged: a brand-new executable records 0o755 from the
  // disk on POSIX and the documented absent default elsewhere.
  const buildEntry = merged.stat('build');
  if (WINDOWS) {
    assert.equal(Object.hasOwn(buildEntry, 'mode'), false);
  } else {
    assert.equal(buildEntry.mode, 0o755);
  }
  assertRoundtrip(view, result.changes, await walk(target));
});

test('nested output-named files import while new output-named directories stay ignored', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'tools': { type: 'directory' },
    'tools/run.sh': addFile(blobs, '#!/bin/sh\necho v1\n', 0o755),
    'pkg': { type: 'directory' },
    'pkg/index.js': addFile(blobs, 'module.exports = 1;\n')
  }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  // Nested new ordinary files with output basenames are ordinary source...
  await fs.writeFile(path.join(target, 'tools', 'build'), 'nested build file\n');
  await fs.writeFile(path.join(target, 'pkg', 'dist'), 'nested dist file\n');
  // ...while NEW directories with such a name stay ephemeral output and are
  // never descended (the documented, unchanged contract).
  await fs.mkdir(path.join(target, 'tools', 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(target, 'tools', 'node_modules', 'dep', 'index.js'), 'dependency');
  await fs.mkdir(path.join(target, 'vendor'));
  await fs.writeFile(path.join(target, 'vendor', 'lib.js'), 'vendored output');

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);

  assert.deepEqual(result.added, ['pkg/dist', 'tools/build']);
  assert.deepEqual(result.changedPaths, ['pkg/dist', 'tools/build']);
  assert.deepEqual(result.ignoredOutputs.map(entry => entry.path).sort(), ['tools/node_modules', 'vendor']);
  assert.deepEqual(result.ignoredOutputs.map(entry => entry.reason), ['ephemeral-output-directory', 'ephemeral-output-directory']);
  // Ignored output is left untouched on disk and never enters the delta.
  assert.equal(fsSync.existsSync(path.join(target, 'vendor', 'lib.js')), true);
  assertRoundtrip(view, result.changes, without(await walk(target), ['vendor', 'tools/node_modules']));
});

test('source edits and new output-named files import in one delta while output directories stay ignored', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'src': { type: 'directory' },
    'src/a.ts': addFile(blobs, 'export const a = 1;\r\n')
  }, blobs);
  const baseline = await materializeRunnerView(view, target, () => undefined);

  await fs.writeFile(path.join(target, 'src', 'a.ts'), 'export const a = 2;\r\n');
  await fs.writeFile(path.join(target, 'src', 'b.ts'), 'export const b = 2;\r\n');
  await fs.writeFile(path.join(target, 'build'), '#!/bin/sh\necho generated\n');
  await fs.mkdir(path.join(target, 'dist'), { recursive: true });
  await fs.writeFile(path.join(target, 'dist', 'bundle.js'), 'bundle');
  await fs.mkdir(path.join(target, '.git'), { recursive: true });
  await fs.writeFile(path.join(target, '.git', 'config'), 'protected');

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined, baseline);

  // One atomic delta: the source edit, the new source file AND the new
  // output-named ordinary file; the output directory and the protected path
  // are diagnostics only.
  assert.deepEqual(result.changedPaths, ['build', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(result.added, ['build', 'src/b.ts']);
  assert.deepEqual(result.modified, ['src/a.ts']);
  assert.deepEqual(result.ignoredOutputs.map(entry => entry.path), ['dist']);
  assert.deepEqual(result.ignoredProtected, ['.git']);
  assert.ok(result.bytes > 0);
  const merged = new LayeredTree(treeRoot, view.tree.entries, [result.changes], { caseInsensitive: WINDOWS });
  assert.equal(merged.stat('build')?.type, 'file');
  assert.equal(merged.stat('src/b.ts')?.type, 'file');
  assert.equal(merged.stat('dist'), undefined, 'ignored output directory never enters the view');
  assertRoundtrip(view, result.changes, without(await walk(target), ['dist', '.git']));
});

test('a new dot-directory is ordinary source and roundtrips', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({ 'a.txt': addFile(blobs, 'a\n') }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  await fs.mkdir(path.join(target, '.cache', 'data'), { recursive: true });
  await fs.writeFile(path.join(target, '.cache', 'data', 'notes.txt'), 'dot source\n');
  await fs.writeFile(path.join(target, '.env'), 'KEY=1\n');

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);
  assert.deepEqual(result.added, ['.cache', '.cache/data', '.cache/data/notes.txt', '.env']);
  assertRoundtrip(view, result.changes, await walk(target));
});

test('a renamed then modified file keeps its 755 mode through the baseline identity', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'bin': { type: 'directory' },
    'bin/tool.sh': addFile(blobs, '#!/bin/sh\necho v1\n', 0o755),
    'README.md': addFile(blobs, 'readme\n')
  }, blobs);
  const baseline = await materializeRunnerView(view, target, () => undefined);

  // Every created plain file carries its physical identity (dev/ino), which is
  // the only rename proof that survives a content change.
  const toolIdentity = baseline.entries['bin/tool.sh'];
  assert.equal(typeof toolIdentity.dev, 'number');
  assert.equal(typeof toolIdentity.ino, 'number');
  assert.notEqual(toolIdentity.ino, baseline.entries['README.md'].ino);
  assert.equal(toolIdentity.mode, 0o755);

  // Rename AND change the bytes, so no content match can explain the move.
  const changed = '#!/bin/sh\necho v2\n';
  await fs.rename(path.join(target, 'bin', 'tool.sh'), path.join(target, 'bin', 'moved.sh'));
  await fs.writeFile(path.join(target, 'bin', 'moved.sh'), changed);
  if (!WINDOWS) {
    // POSIX keeps the execute bit across rename+write: the identity path must
    // agree with the disk instead of downgrading it.
    assert.equal(fileModeFromPermissions((await fs.stat(path.join(target, 'bin', 'moved.sh'))).mode), 0o755);
  }

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined, baseline);
  assert.deepEqual(result.added, ['bin/moved.sh']);
  assert.deepEqual(result.deleted, ['bin/tool.sh']);
  assert.deepEqual(result.renames, [{ kind: 'file', from: 'bin/tool.sh', to: 'bin/moved.sh' }]);
  assert.equal(result.changes['bin/tool.sh'], null);
  assert.deepEqual(result.changes['bin/moved.sh'], {
    type: 'file', hash: sha256(Buffer.from(changed)), size: Buffer.from(changed).length, mode: 0o755
  });
});

test('content-identical deleted files with mixed modes never choose a mode arbitrarily', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const shared = 'same bytes\n';
  const view = makeView({
    // Sorted first, so an arbitrary `shift()` would pick the 0o755 record.
    'aaa-exec.sh': addFile(blobs, shared, 0o755),
    'copy.txt': addFile(blobs, shared)
  }, blobs);
  const baseline = await materializeRunnerView(view, target, () => undefined);

  // Both content-identical sources disappear; a brand-new file has the same
  // bytes but a different physical identity.
  await fs.rm(path.join(target, 'aaa-exec.sh'));
  await fs.rm(path.join(target, 'copy.txt'));
  await fs.writeFile(path.join(target, 'fresh.txt'), shared);

  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined, baseline);
  assert.deepEqual(result.deleted, ['aaa-exec.sh', 'copy.txt']);
  assert.deepEqual(result.added, ['fresh.txt']);
  // 0o755 and "no mode" are equally plausible, so neither may be chosen.
  assert.equal(Object.hasOwn(result.changes['fresh.txt'], 'mode'), false);
  assert.deepEqual(result.renames, []);
  assert.deepEqual(result.changes['fresh.txt'], {
    type: 'file', hash: sha256(Buffer.from(shared)), size: Buffer.from(shared).length
  });
});

test('a legacy baseline without physical identity is accepted and stays a no-op', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'bin': { type: 'directory' },
    'bin/tool.sh': addFile(blobs, '#!/bin/sh\n', 0o755),
    'src': { type: 'directory' },
    'src/plain.txt': addFile(blobs, 'plain\r\n')
  }, blobs);
  const baseline = await materializeRunnerView(view, target, () => undefined);

  // A baseline recorded before physical identity existed: hash/size/mode only.
  const legacy = {
    ...baseline,
    entries: Object.fromEntries(Object.entries(baseline.entries).map(([key, identity]) => [
      key, { hash: identity.hash, size: identity.size, mode: identity.mode }
    ]))
  };
  assert.equal(Object.hasOwn(legacy.entries['bin/tool.sh'], 'dev'), false);

  const put = async () => assert.fail('an unchanged import must not store content');
  const unchanged = await importRunnerView(view, target, put, () => undefined, legacy);
  assert.deepEqual(unchanged.changedPaths, []);
  assert.deepEqual(unchanged.renames, []);
  assert.equal(unchanged.bytes, 0);

  // A changed legacy file keeps its absent-mode shape; a changed 755 file keeps
  // its recorded mode.
  await fs.writeFile(path.join(target, 'src', 'plain.txt'), 'changed\r\n');
  await fs.writeFile(path.join(target, 'bin', 'tool.sh'), '#!/bin/sh\necho changed\n');
  const changed = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined, legacy);
  assert.equal(Object.hasOwn(changed.changes['src/plain.txt'], 'mode'), false);
  assert.equal(changed.changes['bin/tool.sh'].mode, 0o755);
});

test('links and special source changes are rejected without following them', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({ 'a.txt': addFile(blobs, 'a\n') }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  let linked = true;
  try {
    await fs.symlink(outside, path.join(target, 'link'), WINDOWS ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (!linked) {
    // The platform refused to create a link; the assertion below is impossible.
    return;
  }
  await assert.rejects(importRunnerView(view, target, async bytes => sha256(bytes), () => undefined), {
    code: 'runner_view_unsupported', message: /link or junction/
  });
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside secret');
});

test('a renamed file keeps its recorded executable mode on every platform', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({
    'bin': { type: 'directory' },
    'bin/tool.sh': addFile(blobs, '#!/bin/sh\n', 0o755)
  }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  await fs.rename(path.join(target, 'bin', 'tool.sh'), path.join(target, 'bin', 'renamed.sh'));
  const result = await importRunnerView(view, target, async bytes => sha256(bytes), () => undefined);

  assert.deepEqual(result.deleted, ['bin/tool.sh']);
  assert.deepEqual(result.added, ['bin/renamed.sh']);
  assert.deepEqual(result.renames, [{ kind: 'file', from: 'bin/tool.sh', to: 'bin/renamed.sh' }]);
  assert.equal(result.changes['bin/tool.sh'], null);
  assert.deepEqual(result.changes['bin/renamed.sh'], {
    type: 'file', hash: sha256(Buffer.from('#!/bin/sh\n')), size: 10, mode: 0o755
  });
  assertRoundtrip(view, result.changes, await walk(target));
});

test('capacity and unsafe namespaces are explicit', async t => {
  const root = await tempRoot(t);
  const blobs = new Map();
  const hash = sha256(Buffer.from('x'));

  // Too many files.
  const many = {};
  for (let index = 0; index <= RUNNER_VIEW_LIMITS.maxFiles; index += 1) {
    many[`f${index}.txt`] = { type: 'file', hash, size: 1 };
  }
  const crowded = makeView(many, blobs);
  await assert.rejects(materializeRunnerView(crowded, path.join(root, 'crowded'), () => undefined), { code: 'runner_view_capacity' });

  // Oversized file metadata fails before anything is written.
  const oversized = makeView({ 'big.bin': { type: 'file', hash, size: RUNNER_VIEW_LIMITS.maxFileBytes + 1 } }, blobs);
  await assert.rejects(materializeRunnerView(oversized, path.join(root, 'oversized'), () => undefined), { code: 'runner_view_capacity' });

  // A protected component in a supported entry can never enter a delta.
  const protectedView = makeView({
    '.git': { type: 'directory' },
    '.git/config': { type: 'file', hash, size: 1 },
    'a.txt': addFile(blobs, 'a\n')
  }, blobs);
  const target = path.join(root, 'source');
  await assert.rejects(importRunnerView(protectedView, target, async bytes => sha256(bytes), () => undefined), { code: 'runner_view_unsupported' });

  // Oversized command output is a capacity failure, not a partial import.
  const plain = makeView({ 'a.txt': addFile(blobs, 'a\n') }, blobs);
  const runner = path.join(root, 'runner');
  await materializeRunnerView(plain, runner, () => undefined);
  const handle = await fs.open(path.join(runner, 'huge.bin'), 'w');
  try {
    await handle.truncate(RUNNER_VIEW_LIMITS.maxFileBytes + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(importRunnerView(plain, runner, async bytes => sha256(bytes), () => undefined), { code: 'runner_view_capacity' });

  // A supplied baseline for another revision is stale, not silently trusted.
  const baseline = await materializeRunnerView(plain, path.join(root, 'baseline'), () => undefined);
  await assert.rejects(
    importRunnerView(plain, path.join(root, 'baseline'), async bytes => sha256(bytes), () => undefined, { ...baseline, revision: baseline.revision + 1 }),
    { code: 'runner_view_baseline_stale' }
  );
});

test('a changing command directory is never published as a partial delta', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({ 'flip.txt': addFile(blobs, 'a') }, blobs);
  await materializeRunnerView(view, target, () => undefined);

  // Deterministic churn: every root listing rewrites the file, so no pair of
  // complete scans can ever agree.
  const fsp = require('node:fs').promises;
  const originalReaddir = fsp.readdir;
  let flips = 0;
  fsp.readdir = async (where, options) => {
    const names = await originalReaddir.call(fsp, where, options);
    if (String(where) === target && names.includes('flip.txt')) {
      flips += 1;
      await fs.writeFile(path.join(target, 'flip.txt'), flips % 2 === 0 ? 'a' : 'b');
    }
    return names;
  };
  try {
    await assert.rejects(importRunnerView(view, target, async bytes => sha256(bytes), () => undefined), {
      code: 'runner_view_inconsistent', message: /partial change set/
    });
  } finally {
    fsp.readdir = originalReaddir;
  }
  assert.ok(flips >= 2);
});

test('the import guard is re-checked across awaits', async t => {
  const root = await tempRoot(t);
  const target = path.join(root, 'source');
  const blobs = new Map();
  const view = makeView({ 'src': { type: 'directory' }, 'src/a.txt': addFile(blobs, 'a\n') }, blobs);
  await materializeRunnerView(view, target, () => undefined);
  await fs.writeFile(path.join(target, 'src', 'a.txt'), 'b\n');

  let calls = 0;
  const guard = () => {
    calls += 1;
    if (calls > 4) {
      throw new WorkerError('revoked', 'guard revoked during import');
    }
  };
  await assert.rejects(importRunnerView(view, target, async bytes => sha256(bytes), guard), { code: 'revoked' });
  assert.ok(calls > 4);
});
