const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

// Loader: CODEX_TEST_BUILD env first, otherwise the shared .test-build.
function loadBuildDir() {
  const dir = process.env.CODEX_TEST_BUILD || '.test-build';
  return path.join(__dirname, '..', dir);
}

const buildDir = loadBuildDir();
const { LayeredTree } = require(path.join(buildDir, 'layered-tree'));
const { fileModeOf } = require(path.join(buildDir, 'snapshot-content'));
const { WorkerError } = require(path.join(buildDir, 'types'));

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const file = (hash, size) => ({ type: 'file', hash, size });
const dir = () => ({ type: 'directory' });
const unsupported = detail => ({ type: 'unsupported', detail });
const excluded = detail => ({ type: 'excluded', detail });

// Shared base (9 entries); trees must never mutate it.
const sharedBase = {
  'src': dir(),
  'src/main.ts': file(hashA, 10),
  'README.md': file(hashB, 20),
  'bin/tool.sh': file(hashC, 30),
  'bin': dir(),
  'bin/tools': dir(),
  'bin/ghost.dll': unsupported('symlink'),
  'docs/hidden.txt': excluded('protected-name'),
  'docs': dir(),
};
const options = { caseInsensitive: true };
const winRoot = 'C:\\workspace\\demo';
const unixRoot = '/workspace/demo';

test('merged namespace is coherent and base input is untouched', () => {
  const base = structuredClone(sharedBase);
  const deltaA = { 'src/extra.ts': file(hashC, 1), 'src/main.ts': null };
  const treeA = new LayeredTree(unixRoot, base, [deltaA], options);
  const treeB = new LayeredTree(unixRoot, base, [{ 'src/other.ts': file(hashB, 2) }], options);

  // A and B see each other's changes absent: independent deltas.
  assert.equal(treeA.stat('src/extra.ts')?.hash, hashC);
  assert.equal(treeA.stat('src/main.ts'), undefined);
  assert.equal(treeB.stat('src/extra.ts'), undefined);
  assert.equal(treeB.stat('src/main.ts')?.hash, hashA);
  assert.equal(treeB.stat('src/other.ts')?.hash, hashB);

  // One-level listings never leak nested names.
  assert.deepEqual(treeA.list('.').map(e => e.name).sort(), ['README.md', 'bin', 'docs', 'src']);
  assert.deepEqual(treeA.list('src').map(e => e.name), ['extra.ts']);
  assert.deepEqual(treeA.list('bin').map(e => e.name), ['ghost.dll', 'tool.sh', 'tools']);
  assert.equal(treeA.stat('bin/ghost.dll').type, 'unsupported');
  assert.equal(treeA.stat('docs/hidden.txt').type, 'excluded');
  assert.equal(treeA.size, 9);

  // Base and delta objects were not mutated.
  assert.deepEqual(base, sharedBase);
  assert.deepEqual(deltaA, { 'src/extra.ts': file(hashC, 1), 'src/main.ts': null });

  // Root is read/list valid, mutations invalid.
  assert.equal(treeA.resolve('.'), '.');
  assert.equal(treeA.stat('.'), undefined);
  assert.throws(() => treeA.write('.', hashA, 1, 'new'), { code: 'invalid_path' });
  assert.throws(() => treeA.mkdir('.'), { code: 'invalid_path' });
  assert.throws(() => treeA.delete('.', hashA), { code: 'invalid_path' });
  assert.throws(() => treeA.rename('.', 'x', hashA), { code: 'invalid_path' });
});

test('delta layering applies later deltas over earlier ones', () => {
  const d1 = { 'a.txt': file(hashA, 1) };
  const d2 = { 'a.txt': file(hashB, 2) };
  const d3 = { 'a.txt': null };
  const win = new LayeredTree(winRoot, { 'a.txt': file(hashC, 0) }, [d1, d2, d3], options);
  assert.equal(win.stat('a.txt'), undefined);
  const mid = new LayeredTree(unixRoot, {}, [d1, d2], options);
  assert.equal(mid.stat('a.txt')?.hash, hashB);
});

test('constructor deep-clones and freezes; input mutation cannot alter tree', () => {
  const base = { 'src': dir(), 'src/main.ts': file(hashA, 10) };
  const tree = new LayeredTree(unixRoot, base, undefined, options);

  // Mutating the original entry object after construction has no effect.
  base['src/main.ts'].hash = hashB;
  base['src/main.ts'].size = 999;
  base['src'] = { type: 'file', hash: hashB, size: 1 };
  assert.equal(tree.stat('src/main.ts')?.hash, hashA);
  assert.equal(tree.stat('src/main.ts')?.size, 10);
  assert.equal(tree.stat('src')?.type, 'directory');

  // Returned entries are frozen objects.
  const entry = tree.stat('src/main.ts');
  assert.ok(Object.isFrozen(entry));
  entry.hash = hashB;
  assert.equal(tree.stat('src/main.ts')?.hash, hashA);

  // The entries record is frozen and A/B namespaces stay isolated.
  assert.ok(Object.isFrozen(tree.entries));
  const treeB = new LayeredTree(unixRoot, structuredClone(sharedBase), undefined, options);
  assert.equal(treeB.stat('src/main.ts')?.hash, hashA);

  // Non-plain records are rejected, including non-null containers.
  assert.throws(() => new LayeredTree(unixRoot, [file(hashA, 1)], undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, {}, [[file(hashA, 1)]], options), { code: 'isolation_corrupt' });
});

test('write planners: hash exactness, stale, new, parent conflicts', () => {
  const tree = new LayeredTree(unixRoot, sharedBase, undefined, options);
  const delta = tree.write('src/main.ts', hashB, 11, hashA);
  assert.deepEqual(delta, { 'src/main.ts': file(hashB, 11) });
  assert.throws(() => tree.write('src/main.ts', hashB, 11, 'new'), { code: 'path_conflict' });
  assert.throws(() => tree.write('src/main.ts', hashB, 11, hashC), { code: 'stale_hash' });
  assert.throws(() => tree.write('missing.txt', hashA, 1, hashA), { code: 'stale_hash' });
  assert.throws(() => tree.write('bin/extra/inner.txt', hashA, 1, 'new'), { code: 'not_found', message: /no such parent/ });
  assert.deepEqual(tree.write('bin/new.txt', hashA, 1, 'new'), { 'bin/new.txt': file(hashA, 1) });
  assert.throws(() => tree.write('src/extra/inner.txt', hashA, 1, 'new'), { code: 'not_found' });
  // Writing over a directory or readonly entry is refused.
  assert.throws(() => tree.write('src', hashA, 1, 'new'), { code: 'readonly_path' });
  assert.throws(() => tree.write('bin/ghost.dll', hashA, 1, 'new'), { code: 'readonly_path' });
  assert.throws(() => tree.write('docs/hidden.txt', hashA, 1, 'new'), { code: 'readonly_path' });
  // Malformed hash/size are rejected.
  assert.throws(() => tree.write('x.txt', 'nothex', 1, 'new'), { code: 'invalid_path' });
  assert.throws(() => tree.write('x.txt', hashA, -1, 'new'), { code: 'invalid_path' });

  // Planners do not mutate the tree.
  tree.write('src/main.ts', hashB, 11, hashA);
  assert.equal(tree.stat('src/main.ts')?.hash, hashA);
});

test('mkdir planners: parent required, idempotent, file conflicts', () => {
  const tree = new LayeredTree(unixRoot, sharedBase, undefined, options);
  assert.deepEqual(tree.mkdir('src/sub'), { 'src/sub': dir() });
  assert.deepEqual(tree.mkdir('src/sub'), { 'src/sub': dir() });
  assert.throws(() => tree.mkdir('src/main.ts'), { code: 'path_conflict' });
  assert.throws(() => tree.mkdir('bin/ghost.dll/inner'), { code: 'not_a_directory' });
  const wins = new LayeredTree(winRoot, sharedBase, undefined, options);
  assert.deepEqual(wins.mkdir('SRC\\sub'), { 'src/sub': dir() });
});

test('delete and rename planners: files only, hashes, destinations', () => {
  const tree = new LayeredTree(unixRoot, sharedBase, undefined, options);
  assert.deepEqual(tree.delete('README.md', hashB), { 'README.md': null });
  assert.throws(() => tree.delete('README.md', hashA), { code: 'stale_hash' });
  assert.throws(() => tree.delete('nope.txt', hashA), { code: 'not_found' });
  assert.throws(() => tree.delete('src', hashA), { code: 'unsupported' });
  assert.throws(() => tree.delete('bin/ghost.dll', hashA), { code: 'unsupported' });

  assert.deepEqual(tree.rename('README.md', 'notes.md', hashB), {
    'README.md': null,
    'notes.md': file(hashB, 20),
  });
  assert.throws(() => tree.rename('README.md', 'src/main.ts', hashB), { code: 'path_conflict' });
  assert.throws(() => tree.rename('README.md', 'src/missing/deep.md', hashB), { code: 'not_found' });
  assert.throws(() => tree.rename('README.md', 'README.md', hashA), { code: 'stale_hash' });
  assert.throws(() => tree.rename('src', 'x', hashB), { code: 'unsupported' });
  assert.throws(() => tree.rename('README.md', '.', hashB), { code: 'invalid_path' });
  // No-op rename of a file to itself is allowed with the right hash.
  assert.deepEqual(tree.rename('README.md', 'README.md', hashB), { 'README.md': file(hashB, 20) });
  // A directory-as-destination rename is refused.
  assert.throws(() => tree.rename('README.md', 'src', hashB), { code: 'path_conflict' });
});

test('case-insensitive aliases, case-only rename, collision refusal', () => {
  const base = { 'src': dir(), 'src/main.ts': file(hashA, 1) };
  const win = new LayeredTree(winRoot, base, undefined, options);
  assert.equal(win.resolve('SRC\\MAIN.TS'), 'src/main.ts');
  assert.equal(win.stat('src/Main.ts')?.hash, hashA);
  assert.equal(win.list('.').map(e => e.name).join(','), 'src');
  const delta = win.rename('src\\MAIN.ts', 'src/main2.ts', hashA);
  assert.deepEqual(delta, { 'src/main.ts': null, 'src/main2.ts': file(hashA, 1) });
  // Case-only rename succeeds and emits old tombstone + new-case file.
  const caseOnly = win.rename('src/MAIN.ts', 'src/main.TS', hashA);
  assert.deepEqual(caseOnly, { 'src/main.ts': null, 'src/main.TS': file(hashA, 1) });
  // The persisted case-only delta is reflected in the successor tree.
  const next = new LayeredTree(winRoot, base, [caseOnly], options);
  assert.equal(next.stat('src/main.ts')?.hash, hashA);
  assert.equal(next.stat('src/main.TS')?.hash, hashA);
  assert.equal(next.resolve('src/main.ts'), 'src/main.TS');
  assert.deepEqual(next.list('src').map(e => e.name), ['main.TS']);
  // Case-colliding persisted data is refused.
  assert.throws(() => new LayeredTree(unixRoot, { 'a': file(hashA, 1), 'A': file(hashB, 2) }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 's': dir(), 's/a': file(hashA, 1), 's/A': file(hashB, 2) }, undefined, options), { code: 'isolation_corrupt' });

  // Case-sensitive mode keeps aliases separate.
  const unix = new LayeredTree(unixRoot, base, undefined, { caseInsensitive: false });
  assert.equal(unix.resolve('src/Main.ts'), undefined);
  assert.equal(unix.stat('src/Main.ts'), undefined);
  assert.deepEqual(unix.rename('src/main.ts', 'src/Main.TS', hashA), {
    'src/main.ts': null,
    'src/Main.TS': file(hashA, 1),
  });
});

test('canonical parent case: write/mkdir/rename under SRC new paths', () => {
  const base = { 'src': dir(), 'src/main.ts': file(hashA, 1) };
  const win = new LayeredTree(winRoot, base, undefined, options);
  // New paths under a different-case parent are canonicalized; leaf case kept.
  assert.deepEqual(win.write('SRC/new.txt', hashB, 2, 'new'), { 'src/new.txt': file(hashB, 2) });
  assert.deepEqual(win.mkdir('SRC/sub'), { 'src/sub': dir() });
  const caseOnly = win.rename('src/MAIN.ts', 'SRC/main.TS', hashA);
  assert.deepEqual(caseOnly, { 'src/main.ts': null, 'src/main.TS': file(hashA, 1) });
  // Successor tree builds from these deltas and lists canonical parents.
  const next = new LayeredTree(winRoot, base, [win.write('SRC/new.txt', hashB, 2, 'new'), caseOnly], options);
  assert.deepEqual(next.list('src').map(e => e.name).sort(), ['main.TS', 'new.txt']);
  assert.equal(next.stat('src\\new.txt')?.hash, hashB);
});

test('absolute Windows root case aliases, drive case included', () => {
  const win = new LayeredTree(winRoot, sharedBase, undefined, options);
  assert.equal(win.resolve('c:\\WORKSPACE\\demo'), '.');
  assert.equal(win.resolve('C:/workspace/demo/README.md'), 'README.md');
  assert.equal(win.stat('c:\\workspace\\demo\\BIN\\TOOL.SH')?.hash, hashC);
  // Outside and drive-relative inputs are still refused.
  assert.throws(() => win.resolve('D:\\other'), { code: 'invalid_path' });
  assert.throws(() => win.write('D:\\other\\a.txt', hashA, 1, 'new'), { code: 'invalid_path' });
  // Case-sensitive mode refuses drive-case aliasing.
  const strict = new LayeredTree(winRoot, sharedBase, undefined, { caseInsensitive: false });
  assert.throws(() => strict.resolve('c:\\workspace\\demo'), { code: 'invalid_path' });
  assert.throws(() => strict.write('c:\\workspace\\demo\\x.txt', hashA, 1, 'new'), { code: 'invalid_path' });
});

test('path protections: escapes, reserved names, controls, separators', () => {
  const tree = new LayeredTree(unixRoot, sharedBase, undefined, options);
  const cases = [
    ['src/../..', 'invalid_path'],
    ['../etc/passwd', 'invalid_path'],
    ['/etc/passwd', 'invalid_path'],
    ['C:/other/file.txt', 'invalid_path'],
    ['a:evil', 'invalid_path'],
    ['CON.txt', 'invalid_path'],
    ['LPT1/foo', 'invalid_path'],
    ['trailing.txt.', 'invalid_path'],
    ['trail .txt ', 'invalid_path'],
    ['bad\x00name', 'invalid_path'],
    ['bad\x1fname', 'invalid_path'],
    ['a*b.txt', 'invalid_path'],
    ['a<b.txt', 'invalid_path'],
    ['a>b.txt', 'invalid_path'],
    ['a?b.txt', 'invalid_path'],
    ['a|b.txt', 'invalid_path'],
    ['a"b.txt', 'invalid_path'],
    ['.git/config', 'protected_path'],
    ['src/.vscode/settings.json', 'protected_path'],
    ['.Codex/hooks', 'protected_path'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => tree.write(input, hashA, 1, 'new'), { code });
    assert.throws(() => tree.mkdir(input), { code });
    assert.throws(() => tree.delete(input, hashA), { code });
    assert.throws(() => tree.rename(input, 'x', hashA), { code });
    assert.throws(() => tree.rename('README.md', input, hashB), { code });
  }
  // Legal names survive: 'file con.txt' and the relative name '..notes'.
  assert.deepEqual(tree.write('file con.txt', hashA, 1, 'new'), { 'file con.txt': file(hashA, 1) });
  assert.equal(new LayeredTree(unixRoot, { '..notes': file(hashA, 1) }, undefined, options).stat('..notes')?.hash, hashA);
  // Backslash input is accepted under the Windows root.
  const win = new LayeredTree(winRoot, sharedBase, undefined, options);
  assert.equal(win.resolve('src\\main.ts'), 'src/main.ts');
  assert.equal(win.stat('BIN\\Tool.SH')?.hash, hashC);
  assert.equal(win.resolve(winRoot), '.');
  assert.equal(win.resolve(`${winRoot}\\README.md`), 'README.md');
  // Length overflow is rejected, never truncated.
  assert.throws(() => tree.write('a/'.repeat(4100) + 'x', hashA, 1, 'new'), { code: 'invalid_path' });
  const longKey = 'a'.repeat(4097);
  assert.throws(() => new LayeredTree(unixRoot, { [longKey]: file(hashA, 1) }, undefined, options), { code: 'isolation_corrupt' });
});

test('hostile persisted records fail closed; prototype keys stay ordinary', () => {
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': { type: 'file', hash: 'nope', size: 1 } }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': { type: 'file', hash: hashA, size: 1.5 } }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': { type: 'file', hash: hashA, size: -2 } }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': { type: 'link' } }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': 'not an object' }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': file(hashA, 1), 'a.txt/b.txt': file(hashB, 1) }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'd': dir(), 'd/a.txt': file(hashA, 1), 'absent/child': dir() }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { '.': dir() }, undefined, options), { code: 'isolation_corrupt' });
  assert.throws(() => new LayeredTree(unixRoot, { 'a\\b': file(hashA, 1) }, undefined, options), { code: 'isolation_corrupt' });
  // A malformed base entry is not hidden by a later, valid delta overwrite.
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': { type: 'file', hash: 'nope', size: 1 } }, [{ 'a.txt': file(hashA, 1) }], options), { code: 'isolation_corrupt' });
  // A malformed tombstone is not ignored even when later content replaces it.
  assert.throws(() => new LayeredTree(unixRoot, { 'a.txt': file(hashA, 1) }, [{ '../escape': null }, { 'a.txt': file(hashA, 1) }], options), { code: 'isolation_corrupt' });
  // A corrupt intermediate revision cannot be hidden by a later fix.
  assert.throws(() => new LayeredTree(unixRoot, {}, [{ 'a.txt': { type: 'file', hash: 'nope', size: 1 } }, { 'a.txt': file(hashA, 1) }], options), { code: 'isolation_corrupt' });
  // __proto__ must be an ordinary own key, not a prototype write.
  const protoKey = JSON.parse(JSON.stringify(Object.fromEntries([['__proto__', file(hashA, 1)]])));
  const protoTree = new LayeredTree(unixRoot, protoKey, undefined, options);
  assert.equal(Object.hasOwn(protoTree.entries, '__proto__'), true);
  assert.equal(protoTree.stat('__proto__')?.hash, hashA);
  // Overflow of the entry cap is rejected.
  const many = {};
  for (let i = 0; i <= 20_000; i += 1) {
    many[`f${i}`] = file(hashA, i);
  }
  assert.throws(() => new LayeredTree(unixRoot, many, undefined, options), { code: 'isolation_corrupt' });
});

test('errors are WorkerError instances with stable codes', () => {
  const tree = new LayeredTree(unixRoot, sharedBase, undefined, options);
  try {
    tree.write('src/missing/inner.txt', hashA, 1, 'new');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof WorkerError);
    assert.equal(err.code, 'not_found');
    assert.ok(err instanceof Error);
  }
});

test('delta ordering cannot erase case renames or hide collisions and invalid data', () => {
  const base = { 'src': dir(), 'src/main.ts': file(hashA, 1) };
  const reversed = { 'src/main.TS': file(hashA, 1), 'src/main.ts': null };
  const next = new LayeredTree(winRoot, base, [reversed], options);
  assert.equal(next.resolve('SRC/MAIN.ts'), 'src/main.TS');
  assert.deepEqual(next.list('src').map(entry => entry.name), ['main.TS']);
  assert.throws(() => new LayeredTree(winRoot, {}, [{ 'a': file(hashA, 1), 'A': file(hashB, 2) }], options), { code: 'isolation_corrupt' });
  for (const invalid of [{ 'a': null }, new Date(), { 'a': { ...file(hashA, 1), extra: true } }]) {
    assert.throws(() => new LayeredTree(winRoot, invalid, undefined, options), { code: 'isolation_corrupt' });
  }
});

test('filesystem root anchors preserve absolute paths and reject drive-relative aliases', () => {
  assert.equal(new LayeredTree('/', { 'a': file(hashA, 1) }).resolve('/a'), 'a');
  const drive = new LayeredTree('C:/', { 'a': file(hashA, 1) }, undefined, options);
  assert.equal(drive.resolve('c:/a'), 'a');
  assert.throws(() => drive.resolve('C:'), { code: 'invalid_path' });
  for (const invalid of ['', 'relative', 'C:']) {
    assert.throws(() => new LayeredTree(invalid, {}), { code: 'isolation_corrupt' });
  }
});

// ---------------------------------------------------------------------------
// Executable mode metadata: validate, freeze and preserve through overlays.
// ---------------------------------------------------------------------------

test('executable mode metadata roundtrips through overlay writes and renames', () => {
  const executable = { type: 'file', hash: hashA, size: 10, mode: 0o755 };
  const base = { 'bin': dir(), 'bin/tool.sh': executable, 'README.md': file(hashB, 20) };
  const tree = new LayeredTree(unixRoot, base, undefined, options);

  // Persisted mode metadata is validated, preserved and frozen.
  const stat = tree.stat('bin/tool.sh');
  assert.equal(stat.mode, 0o755);
  assert.ok(Object.isFrozen(stat));

  // Overwrites keep the recorded mode unless an explicit mode is supplied.
  assert.deepEqual(tree.write('bin/tool.sh', hashB, 2, hashA), {
    'bin/tool.sh': { type: 'file', hash: hashB, size: 2, mode: 0o755 },
  });
  assert.deepEqual(tree.write('bin/tool.sh', hashB, 2, hashA, 0o644), {
    'bin/tool.sh': { type: 'file', hash: hashB, size: 2, mode: 0o644 },
  });

  // Renames preserve the mode; a legacy entry without one keeps its exact shape.
  assert.deepEqual(tree.rename('bin/tool.sh', 'bin/copy.sh', hashA), {
    'bin/tool.sh': null,
    'bin/copy.sh': { type: 'file', hash: hashA, size: 10, mode: 0o755 },
  });
  assert.deepEqual(tree.rename('README.md', 'notes.md', hashB), {
    'README.md': null,
    'notes.md': file(hashB, 20),
  });

  // New files: an explicit mode is recorded; an omitted one stays absent and
  // resolves to the documented 0o644 default.
  assert.deepEqual(tree.write('bin/new.sh', hashC, 1, 'new', 0o755), {
    'bin/new.sh': { type: 'file', hash: hashC, size: 1, mode: 0o755 },
  });
  const plain = tree.write('bin/plain.txt', hashC, 1, 'new');
  assert.deepEqual(plain, { 'bin/plain.txt': file(hashC, 1) });
  assert.equal(fileModeOf(plain['bin/plain.txt']), 0o644);

  // A successor tree carries every recorded mode through the persisted deltas.
  const next = new LayeredTree(unixRoot, base, [
    tree.rename('bin/tool.sh', 'bin/copy.sh', hashA),
    tree.write('bin/new.sh', hashC, 1, 'new', 0o755),
  ], options);
  assert.equal(next.stat('bin/copy.sh').mode, 0o755);
  assert.equal(next.stat('bin/new.sh').mode, 0o755);
  assert.equal(fileModeOf(next.stat('README.md')), 0o644);

  // Invalid modes fail closed on persisted data and on planner input.
  for (const bad of [0o600, 0o777, '755', null]) {
    assert.throws(() => new LayeredTree(unixRoot, { 'a.sh': { ...file(hashA, 1), mode: bad } }, undefined, options), { code: 'isolation_corrupt' });
  }
  assert.throws(() => tree.write('bin/x.sh', hashA, 1, 'new', 0o600), { code: 'invalid_path' });
  assert.throws(() => tree.write('bin/tool.sh', hashB, 2, hashA, 392), { code: 'invalid_path' });

  // Entries are deep-cloned: mutating the caller's object cannot change the tree.
  const mutable = { ...executable };
  const isolated = new LayeredTree(unixRoot, { 'bin': dir(), 'bin/tool.sh': mutable }, undefined, options);
  mutable.mode = 0o644;
  assert.equal(isolated.stat('bin/tool.sh').mode, 0o755);
});
