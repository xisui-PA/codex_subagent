const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const path = require('node:path');

// Loader: this task's dedicated compile first (STEP5_TEST_BUILD), otherwise the
// shared .test-build. Compile with:
//   npm exec -- tsc -p tsconfig.json --outDir .test-step5-merge --sourceMap false
const buildDir = path.resolve(__dirname, '..', process.env.STEP5_TEST_BUILD?.trim() || '.test-build');
const { mergeIntegrationTrees } = require(path.join(buildDir, 'integration-merge'));
const { LayeredTree } = require(path.join(buildDir, 'layered-tree'));
const {
  fileModeOf, DEFAULT_FILE_MODE, EXECUTABLE_FILE_MODE
} = require(path.join(buildDir, 'snapshot-content'));

const root = '/workspace/demo';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const bytesOf = value => (Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8'));

const file = (bytes, mode) => {
  const buffer = bytesOf(bytes);
  const entry = { type: 'file', hash: sha256(buffer), size: buffer.length };
  if (mode !== undefined) {
    entry.mode = mode;
  }
  return entry;
};
const dir = () => ({ type: 'directory' });
const unsupported = detail => ({ type: 'unsupported', detail });
const excluded = detail => ({ type: 'excluded', detail });

const REMOVE = Symbol('remove');

function addParents(entries, name) {
  const parts = name.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const parent = parts.slice(0, index).join('/');
    if (entries[parent] === undefined) {
      entries[parent] = dir();
    }
  }
}

// Shared fixture style: a namespace is written as path -> contents (string or
// Buffer), path -> SnapshotEntry (directory/unsupported/excluded/file), and its
// file contents are kept for the read() callbacks.
function tree(files) {
  const entries = {};
  const content = new Map();
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      const buffer = bytesOf(value);
      entries[name] = file(buffer);
      content.set(name, buffer);
    } else {
      entries[name] = value;
    }
    addParents(entries, name);
  }
  return { entries, content };
}

function variant(baseFiles, edits) {
  const files = { ...baseFiles };
  for (const [name, value] of Object.entries(edits)) {
    if (value === REMOVE) {
      delete files[name];
    } else {
      files[name] = value;
    }
  }
  return files;
}

function putter() {
  const calls = [];
  const blobs = new Map();
  return {
    calls,
    blobs,
    put: async bytes => {
      const copy = Buffer.from(bytes);
      calls.push(copy);
      const hash = sha256(copy);
      blobs.set(hash, copy);
      return hash;
    }
  };
}

async function run(baseFiles, specs) {
  const base = tree(baseFiles);
  const calls = { read: 0 };
  const baseRead = async name => {
    calls.read += 1;
    const bytes = base.content.get(name);
    assert.ok(bytes !== undefined, `missing base bytes for ${name}`);
    return { bytes };
  };
  const inputs = specs.map(spec => {
    const built = tree(spec.files);
    return {
      id: spec.id,
      entries: built.entries,
      read: async name => {
        calls.read += 1;
        const bytes = built.content.get(name);
        assert.ok(bytes !== undefined, `missing bytes for ${spec.id}:${name}`);
        return { bytes };
      }
    };
  });
  const store = putter();
  const result = await mergeIntegrationTrees(root, base.entries, baseRead, inputs, store.put);
  return { result, store, base, calls, inputs };
}

function applied(baseEntries, changes) {
  return new LayeredTree(root, baseEntries, [changes], { caseInsensitive: false }).entries;
}

test('distinct paths combine and untouched paths stay out of the delta', async () => {
  const baseFiles = { 'README.md': 'readme\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' };
  const first = variant(baseFiles, { 'src/a.ts': 'a1\n', 'src/c.ts': 'c\n' });
  const second = variant(baseFiles, { 'src/b.ts': 'b1\n' });
  const baseBefore = tree(baseFiles).entries;
  const { result, store, calls, base, inputs } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(result.changes['src/a.ts'].hash, sha256('a1\n'));
  assert.equal(result.changes['src/a.ts'].size, 3);
  assert.equal(result.changes['src/c.ts'].hash, sha256('c\n'));
  assert.equal(result.changes['src/b.ts'].hash, sha256('b1\n'));
  assert.equal(Object.hasOwn(result.changes['src/a.ts'], 'mode'), false);

  // No textual merge ran, so neither the base reader nor put() was used.
  assert.equal(calls.read, 0);
  assert.equal(store.calls.length, 0);

  // Base and input namespaces are pure inputs.
  assert.deepEqual(base.entries, baseBefore);
  assert.deepEqual(inputs[0].entries, tree(first).entries);
  assert.deepEqual(inputs[1].entries, tree(second).entries);

  // The delta applies cleanly to the shared base.
  const final = applied(base.entries, result.changes);
  assert.equal(final['src/a.ts'].hash, sha256('a1\n'));
  assert.equal(final['src/b.ts'].hash, sha256('b1\n'));
  assert.equal(final['src/c.ts'].hash, sha256('c\n'));
});

test('identical edits from several inputs combine without reads or conflicts', async () => {
  const baseFiles = { 'src/a.ts': 'one\ntwo\n', 'src/b.ts': 'keep\n' };
  const edited = variant(baseFiles, { 'src/a.ts': 'one\nTWO\n' });
  const untouched = variant(baseFiles, {});
  const { result, store, calls } = await run(baseFiles, [
    { id: 'alpha', files: edited },
    { id: 'beta', files: edited },
    { id: 'gamma', files: untouched }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['src/a.ts']);
  assert.equal(result.changes['src/a.ts'].hash, sha256('one\nTWO\n'));
  assert.equal(calls.read, 0);
  assert.equal(store.calls.length, 0);
});

test('non-overlapping line edits merge and preserve CRLF bytes exactly', async () => {
  const baseFiles = { 'notes.txt': 'one\r\ntwo\r\nthree\r\n' };
  const first = variant(baseFiles, { 'notes.txt': 'ONE\r\ntwo\r\nthree\r\n' });
  const second = variant(baseFiles, { 'notes.txt': 'one\r\ntwo\r\nTHREE\r\n' });
  const { result, store } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  const expected = Buffer.from('ONE\r\ntwo\r\nTHREE\r\n', 'utf8');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.changes['notes.txt'].hash, sha256(expected));
  assert.equal(result.changes['notes.txt'].size, expected.length);
  assert.equal(fileModeOf(result.changes['notes.txt']), DEFAULT_FILE_MODE);
  assert.equal(Object.hasOwn(result.changes['notes.txt'], 'mode'), false);
  assert.equal(store.calls.length, 1);
  assert.deepEqual(store.calls[0], expected);
});

test('three inputs merge distinct UTF-8 lines and keep the missing final newline', async () => {
  const baseFiles = { 'α.txt': 'α\nβ\nγ' };
  const first = variant(baseFiles, { 'α.txt': 'Α\nβ\nγ' });
  const second = variant(baseFiles, { 'α.txt': 'α\nΒ\nγ' });
  const third = variant(baseFiles, { 'α.txt': 'α\nβ\nΓ' });
  const { result, store } = await run(baseFiles, [
    { id: 'a', files: first },
    { id: 'b', files: second },
    { id: 'c', files: third }
  ]);

  const expected = 'Α\nΒ\nΓ';
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['α.txt']);
  assert.equal(result.changes['α.txt'].hash, sha256(expected));
  assert.equal(result.changes['α.txt'].size, Buffer.byteLength(expected));
  assert.deepEqual(store.calls[0], Buffer.from(expected, 'utf8'));
});

test('overlapping edits conflict while disjoint edits stay in the delta', async () => {
  const baseFiles = { 'conflict.txt': 'a\nb\nc\n', 'keep.txt': 'k\n' };
  const first = variant(baseFiles, { 'conflict.txt': 'a\nB1\nc\n', 'one/new.txt': 'one\n' });
  const second = variant(baseFiles, { 'conflict.txt': 'a\nB2\nc\n', 'two/new.txt': 'two\n' });
  const { result, store, base } = await run(baseFiles, [
    { id: 'zeta', files: first },
    { id: 'alpha', files: second }
  ]);

  // Conflict ids keep caller order, not alphabetical order.
  assert.deepEqual(result.conflicts, [
    { paths: ['conflict.txt'], inputIds: ['zeta', 'alpha'], reason: 'textual overlap' }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['one', 'one/new.txt', 'two', 'two/new.txt']);
  assert.equal(store.calls.length, 0);

  // The conflicting path keeps the base bytes; the safe edits remain applied.
  const final = applied(base.entries, result.changes);
  assert.equal(final['conflict.txt'].hash, sha256('a\nb\nc\n'));
  assert.equal(final['one/new.txt'].hash, sha256('one\n'));
  assert.equal(final['two/new.txt'].hash, sha256('two\n'));
});

test('adjacent insertions and deletions at hunk boundaries merge cleanly', async () => {
  const baseFiles = { 'list.txt': 'a\nb\nc\n' };
  const first = variant(baseFiles, { 'list.txt': 'top\na\nc\n' });
  const second = variant(baseFiles, { 'list.txt': 'a\nb\nc\nbottom\n' });
  const { result } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.changes['list.txt'].hash, sha256('top\na\nc\nbottom\n'));
});

test('binary content conflicts instead of being transcoded', async () => {
  const baseFiles = {
    'blob.bin': Buffer.from([0, 1, 2, 3, 4]),
    'plain.txt': 'p\n'
  };
  const first = variant(baseFiles, { 'blob.bin': Buffer.from([0, 1, 2, 3, 9]) });
  const second = variant(baseFiles, { 'blob.bin': Buffer.from([0, 1, 2, 3, 8]), 'other.txt': 'o\n' });
  const { result, store, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['blob.bin'], inputIds: ['first', 'second'], reason: 'binary content' }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['other.txt']);
  assert.equal(store.calls.length, 0);
  assert.equal(applied(base.entries, result.changes)['blob.bin'].hash, sha256(baseFiles['blob.bin']));
});

test('invalid UTF-8 without NUL bytes is treated as binary', async () => {
  const baseFiles = { 'latin.bin': Buffer.from([0xff, 0xfe, 0x41]) };
  const first = variant(baseFiles, { 'latin.bin': Buffer.from([0xff, 0xfe, 0x42]) });
  const second = variant(baseFiles, { 'latin.bin': Buffer.from([0xff, 0xfe, 0x43]) });
  const { result } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['latin.bin'], inputIds: ['first', 'second'], reason: 'binary content' }
  ]);
  assert.deepEqual(result.changes, {});
});

test('delete/modify conflicts, while agreed deletes and deletes over untouched paths apply', async () => {
  const baseFiles = { 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n', 'd.md': 'd\n' };
  const first = variant(baseFiles, {
    'a.md': REMOVE, 'b.md': REMOVE, 'c.md': REMOVE, 'd.md': REMOVE
  });
  const second = variant(baseFiles, { 'a.md': 'a2\n', 'c.md': REMOVE });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['a.md'], inputIds: ['first', 'second'], reason: 'delete/modify' }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['b.md', 'c.md', 'd.md']);
  for (const key of ['b.md', 'c.md', 'd.md']) {
    assert.equal(result.changes[key], null);
  }
  const final = applied(base.entries, result.changes);
  assert.equal(final['a.md'].hash, sha256('a\n'));
  assert.equal(final['b.md'], undefined);
  assert.equal(final['c.md'], undefined);
  assert.equal(final['d.md'], undefined);
});

test('additions combine when identical and conflict when divergent', async () => {
  const baseFiles = { 'keep.txt': 'k\n' };
  const first = variant(baseFiles, { 'same.txt': 's\n', 'different.txt': 'one\n' });
  const second = variant(baseFiles, { 'same.txt': 's\n', 'different.txt': 'two\n' });
  const { result } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['different.txt'], inputIds: ['first', 'second'], reason: 'add/add' }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['same.txt']);
  assert.equal(result.changes['same.txt'].hash, sha256('s\n'));
});

test('executable mode merges with content and conflicts only on disagreement', async () => {
  const baseFiles = {
    'run.sh': file('v1\n', DEFAULT_FILE_MODE),
    'tool.sh': file('t\n', DEFAULT_FILE_MODE),
    'keep.txt': 'k\n'
  };
  const first = variant(baseFiles, {
    'run.sh': file('v2\n', DEFAULT_FILE_MODE),
    'tool.sh': file('t\n', EXECUTABLE_FILE_MODE),
    'new.sh': file('x\n', EXECUTABLE_FILE_MODE)
  });
  const second = variant(baseFiles, {
    'run.sh': file('v1\n', EXECUTABLE_FILE_MODE),
    'new.sh': file('x\n', DEFAULT_FILE_MODE)
  });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  // Content from one input plus the mode from the other combine cleanly.
  assert.deepEqual(result.conflicts.filter(c => c.paths.includes('new.sh')), [
    { paths: ['new.sh'], inputIds: ['first', 'second'], reason: 'mode conflict' }
  ]);
  assert.equal(result.changes['run.sh'].hash, sha256('v2\n'));
  assert.equal(fileModeOf(result.changes['run.sh']), EXECUTABLE_FILE_MODE);
  assert.equal(result.changes['run.sh'].mode, EXECUTABLE_FILE_MODE);
  assert.equal(result.changes['tool.sh'].hash, sha256('t\n'));
  assert.equal(fileModeOf(result.changes['tool.sh']), EXECUTABLE_FILE_MODE);
  assert.equal(result.changes['new.sh'], undefined);

  const final = applied(base.entries, result.changes);
  assert.equal(fileModeOf(final['run.sh']), EXECUTABLE_FILE_MODE);
  assert.equal(fileModeOf(final['tool.sh']), EXECUTABLE_FILE_MODE);
  assert.equal(final['new.sh'], undefined);
});

test('unsupported and excluded entries are never replaced or merged implicitly', async () => {
  const baseFiles = {
    'link.dll': unsupported('symlink'),
    'hidden.txt': excluded('protected-name'),
    'ok.txt': 'k\n'
  };
  const first = variant(baseFiles, { 'link.dll': 'one\n', 'hidden.txt': 'x\n' });
  const second = variant(baseFiles, { 'link.dll': 'two\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['hidden.txt'], inputIds: ['first'], reason: 'unsupported entry' },
    { paths: ['link.dll'], inputIds: ['first', 'second'], reason: 'unsupported entry' }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['link.dll'].type, 'unsupported');
  assert.equal(final['hidden.txt'].type, 'excluded');

  // Agreed deletion of an unsupported entry is still a clean change.
  const deleted = variant(baseFiles, { 'link.dll': REMOVE });
  const agreed = await run(baseFiles, [
    { id: 'first', files: deleted },
    { id: 'second', files: deleted }
  ]);
  assert.deepEqual(agreed.result.conflicts, []);
  assert.deepEqual(agreed.result.changes, { 'link.dll': null });
});

test('case collisions are refused and base is preserved', async () => {
  const baseFiles = { 'src/a.ts': 'a\n' };
  const first = variant(baseFiles, { 'src/New.ts': 'n\n' });
  const second = variant(baseFiles, { 'src/new.ts': 'm\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['src/New.ts', 'src/new.ts'], inputIds: ['first', 'second'], reason: 'case collision' }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['src/New.ts'], undefined);
  assert.equal(final['src/new.ts'], undefined);
});

test('file/directory collisions are refused and the base directory survives', async () => {
  const baseFiles = { 'x/a.txt': 'a\n', 'x/b.txt': 'b\n', 'keep.txt': 'k\n' };
  const first = variant(baseFiles, {
    'x/a.txt': REMOVE, 'x/b.txt': REMOVE, 'x': 'now a file\n'
  });
  const second = variant(baseFiles, { 'x/c.txt': 'c\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['x', 'x/c.txt'], inputIds: ['first', 'second'], reason: 'file/directory collision' }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['x/a.txt', 'x/b.txt']);
  const final = applied(base.entries, result.changes);
  assert.equal(final['x'].type, 'directory');
  assert.equal(final['x/a.txt'], undefined);
  assert.equal(final['x/b.txt'], undefined);
  assert.equal(final['x/c.txt'], undefined);
});

test('divergent exact-content renames conflict instead of duplicating a file', async () => {
  const baseFiles = { 'old.txt': 'moved\n', 'keep.txt': 'k\n' };
  const first = variant(baseFiles, { 'old.txt': REMOVE, 'one/old.txt': 'moved\n' });
  const second = variant(baseFiles, { 'old.txt': REMOVE, 'two/old.txt': 'moved\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['old.txt', 'one/old.txt', 'two/old.txt'],
      inputIds: ['first', 'second'],
      reason: 'divergent rename'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('moved\n'));
  assert.equal(final['one/old.txt'], undefined);
  assert.equal(final['two/old.txt'], undefined);
});

test('a rename whose destination conflicts preserves the source file', async () => {
  // Repro: base old.txt=original; A renames old.txt -> new.txt exactly; B keeps
  // old.txt and adds a different new.txt. The failed rename must not delete the
  // source, and both related paths must be reported.
  const baseFiles = { 'old.txt': 'original\n' };
  const renamed = variant(baseFiles, { 'old.txt': REMOVE, 'new.txt': 'original\n' });
  const competing = variant(baseFiles, { 'new.txt': 'different\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: renamed },
    { id: 'competing', files: competing }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['new.txt', 'old.txt'], inputIds: ['rename', 'competing'], reason: 'add/add' }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('original\n'));
  assert.equal(final['new.txt'], undefined);
});

test('a rename destination rejected by a case collision also preserves the source', async () => {
  const baseFiles = { 'src/keep.txt': 'k\n', 'old.txt': 'original\n' };
  const renamed = variant(baseFiles, { 'old.txt': REMOVE, 'src/New.txt': 'original\n' });
  const competing = variant(baseFiles, { 'src/new.txt': 'different\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: renamed },
    { id: 'competing', files: competing }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['old.txt', 'src/New.txt', 'src/new.txt'],
      inputIds: ['rename', 'competing'],
      reason: 'case collision'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('original\n'));
  assert.equal(final['src/New.txt'], undefined);
  assert.equal(final['src/new.txt'], undefined);
});

test('a rename destination rejected by a file/directory collision preserves the source', async () => {
  const baseFiles = { 'x/a.txt': 'a\n', 'old.txt': 'original\n' };
  const renamed = variant(baseFiles, {
    'old.txt': REMOVE, 'x/a.txt': REMOVE, 'x': 'original\n'
  });
  const competing = variant(baseFiles, { 'x/c.txt': 'c\n', 'notes.md': 'n\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: renamed },
    { id: 'competing', files: competing }
  ]);

  // The refused replacement reports the source, the destination, the dependent
  // delete it made to clear that directory, and the competing child.
  assert.deepEqual(result.conflicts, [
    {
      paths: ['old.txt', 'x', 'x/a.txt', 'x/c.txt'],
      inputIds: ['rename', 'competing'],
      reason: 'file/directory collision'
    }
  ]);
  // Only the genuinely unrelated change survives in the delta.
  assert.deepEqual(Object.keys(result.changes), ['notes.md']);
  assert.equal(result.changes['notes.md'].hash, sha256('n\n'));
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('original\n'));
  assert.equal(final.x.type, 'directory');
  assert.equal(final['x/a.txt'].hash, sha256('a\n'));
  assert.equal(final['x/c.txt'], undefined);
  assert.equal(final['notes.md'].hash, sha256('n\n'));
});

test('an agreed rename merges as one delete plus one add', async () => {
  const baseFiles = { 'old.txt': 'moved\n' };
  const moved = variant(baseFiles, { 'old.txt': REMOVE, 'new/old.txt': 'moved\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: moved },
    { id: 'second', files: moved }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['new', 'new/old.txt', 'old.txt']);
  assert.equal(result.changes['old.txt'], null);
  assert.equal(result.changes['new/old.txt'].hash, sha256('moved\n'));
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'], undefined);
  assert.equal(final['new/old.txt'].hash, sha256('moved\n'));
});

test('a rename against a concurrent modification conflicts on both paths', async () => {
  const baseFiles = { 'old.txt': 'moved\n' };
  const first = variant(baseFiles, { 'old.txt': REMOVE, 'moved/old.txt': 'moved\n' });
  const second = variant(baseFiles, { 'old.txt': 'edited\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['moved/old.txt', 'old.txt'],
      inputIds: ['first', 'second'],
      reason: 'delete/modify'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('moved\n'));
  assert.equal(final['moved/old.txt'], undefined);
});

test('directory tombstones are emitted only when no descendant survives', async () => {
  const baseFiles = {
    'gone/a.txt': 'a\n',
    'gone/b.txt': 'b\n',
    'stay/c.txt': 'c\n',
    'stay/d.txt': 'd\n'
  };
  const wiped = variant(baseFiles, {
    'gone/a.txt': REMOVE,
    'gone/b.txt': REMOVE,
    'stay/c.txt': REMOVE,
    'stay/d.txt': REMOVE
  });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: wiped },
    { id: 'second', files: wiped }
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), [
    'gone', 'gone/a.txt', 'gone/b.txt', 'stay', 'stay/c.txt', 'stay/d.txt'
  ]);
  assert.equal(result.changes.gone, null);
  assert.equal(result.changes.stay, null);
  const final = applied(base.entries, result.changes);
  assert.equal(final.gone, undefined);
  assert.equal(final.stay, undefined);

  // A surviving child keeps the directory: the tombstone is dropped, not fatal.
  const deletesStay = variant(baseFiles, { 'stay/c.txt': REMOVE, 'stay/d.txt': REMOVE });
  const addsChild = variant(baseFiles, { 'stay/e.txt': 'e\n' });
  const survivor = await run(baseFiles, [
    { id: 'first', files: deletesStay },
    { id: 'second', files: addsChild }
  ]);
  assert.deepEqual(survivor.result.conflicts, []);
  assert.equal(survivor.result.changes.stay, undefined);
  assert.equal(survivor.result.changes['stay/c.txt'], null);
  assert.equal(survivor.result.changes['stay/d.txt'], null);
  assert.equal(survivor.result.changes['stay/e.txt'].hash, sha256('e\n'));
  const survivorTree = applied(survivor.base.entries, survivor.result.changes);
  assert.equal(survivorTree.stay.type, 'directory');
  assert.equal(survivorTree['stay/c.txt'], undefined);
  assert.equal(survivorTree['stay/e.txt'].hash, sha256('e\n'));
});

test('text merging is bounded and reports oversized diffs as conflicts', async () => {
  const lines = count => Array.from({ length: count }, (value, index) => `line ${index}\n`).join('');
  const baseText = lines(1200);
  const baseFiles = { 'big.txt': baseText };
  const firstLines = baseText.split('\n');
  firstLines[5] = 'first edit';
  const secondLines = baseText.split('\n');
  secondLines[1100] = 'second edit';
  const first = variant(baseFiles, { 'big.txt': firstLines.join('\n') });
  const second = variant(baseFiles, { 'big.txt': secondLines.join('\n') });
  const { result, store } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, [
    { paths: ['big.txt'], inputIds: ['first', 'second'], reason: 'text merge too large' }
  ]);
  assert.deepEqual(result.changes, {});
  assert.equal(store.calls.length, 0);

  // The same shape of edit below the bound still merges.
  const smallBase = { 'small.txt': lines(40) };
  const smallFirst = smallBase['small.txt'].split('\n');
  smallFirst[3] = 'first edit';
  const smallSecond = smallBase['small.txt'].split('\n');
  smallSecond[30] = 'second edit';
  const belowBound = await run(smallBase, [
    { id: 'first', files: variant(smallBase, { 'small.txt': smallFirst.join('\n') }) },
    { id: 'second', files: variant(smallBase, { 'small.txt': smallSecond.join('\n') }) }
  ]);
  assert.deepEqual(belowBound.result.conflicts, []);
  assert.equal(
    belowBound.result.changes['small.txt'].hash,
    sha256(smallFirst.map((line, index) => (index === 30 ? 'second edit' : line)).join('\n'))
  );
});

test('results are deterministic and every delta validates through LayeredTree', async () => {
  const baseFiles = { 'a.txt': 'a\nb\nc\n', 'dir/x.txt': 'x\n' };
  const first = variant(baseFiles, { 'a.txt': 'a\nB\nc\n', 'dir/new.txt': 'n\n' });
  const second = variant(baseFiles, { 'a.txt': 'a\nb\nC\n', 'dir/x.txt': REMOVE });
  const specs = [{ id: 'first', files: first }, { id: 'second', files: second }];

  const one = await run(baseFiles, specs);
  const two = await run(baseFiles, specs);
  assert.deepEqual(one.result, two.result);
  assert.deepEqual(one.store.calls.map(String), two.store.calls.map(String));
  assert.deepEqual(Object.keys(one.result.changes), [...Object.keys(one.result.changes)].sort());
  assert.deepEqual(one.result.conflicts, []);
  new LayeredTree(root, one.base.entries, [one.result.changes]);
});

test('duplicate ids and malformed namespaces fail closed', async () => {
  const baseFiles = { 'keep.txt': 'k\n' };
  const base = tree(baseFiles);
  const store = putter();
  const read = async name => ({ bytes: base.content.get(name) });
  const good = { id: 'same', entries: base.entries, read };

  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, read, [good, { ...good }], store.put),
    { code: 'invalid_input', message: /duplicate integration input id: same/ }
  );
  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, read, [{ ...good, id: '' }], store.put),
    { code: 'invalid_input' }
  );
  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, read, [{
      id: 'broken',
      entries: { 'child/file.txt': file('x\n') },
      read
    }], store.put),
    { code: 'isolation_corrupt', message: /input broken:/ }
  );
  assert.equal(store.calls.length, 0);
});

test('content read failures propagate instead of seeding a conflict', async () => {
  const baseFiles = { 'f.txt': 'one\ntwo\n' };
  const base = tree(baseFiles);
  const left = tree(variant(baseFiles, { 'f.txt': 'ONE\ntwo\n' }));
  const right = tree(variant(baseFiles, { 'f.txt': 'one\nTWO\n' }));
  const store = putter();
  const readBase = async name => ({ bytes: base.content.get(name) });
  const readLeft = async name => ({ bytes: left.content.get(name) });
  const readRight = async name => ({ bytes: right.content.get(name) });

  // Missing immutable input bytes during a textual merge: the original error is
  // rethrown; it is never downgraded to a conflict seed or a partial delta.
  const missing = () => Promise.reject(Object.assign(
    new Error('snapshot blob missing for f.txt'),
    { code: 'snapshot_content_missing' }
  ));
  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, readBase, [
      { id: 'left', entries: left.entries, read: readLeft },
      { id: 'right', entries: right.entries, read: missing }
    ], store.put),
    { code: 'snapshot_content_missing', message: /snapshot blob missing for f\.txt/ }
  );

  // The shared base reader is a real ancestor read: its failure propagates too.
  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, async () => {
      throw new Error('corrupt base blob for f.txt');
    }, [
      { id: 'left', entries: left.entries, read: readLeft },
      { id: 'right', entries: right.entries, read: readRight }
    ], store.put),
    /corrupt base blob for f\.txt/
  );

  // A reader that resolves without a Buffer fails closed explicitly.
  await assert.rejects(
    mergeIntegrationTrees(root, base.entries, readBase, [
      { id: 'left', entries: left.entries, read: readLeft },
      { id: 'right', entries: right.entries, read: async () => ({ bytes: 'one\nTWO\n' }) }
    ], store.put),
    { code: 'merge_read_invalid', message: /no bytes for f\.txt/ }
  );

  // Nothing was published and no provisional delta escaped.
  assert.equal(store.calls.length, 0);
});

test('a merged text edit records the executable mode it merged with', async () => {
  const baseFiles = { 'run.sh': file('one\ntwo\n', DEFAULT_FILE_MODE) };
  const first = variant(baseFiles, { 'run.sh': file('ONE\ntwo\n', DEFAULT_FILE_MODE) });
  const second = variant(baseFiles, { 'run.sh': file('one\ntwo\n', EXECUTABLE_FILE_MODE) });
  const { result } = await run(baseFiles, [
    { id: 'first', files: first },
    { id: 'second', files: second }
  ]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.changes['run.sh'].hash, sha256('ONE\ntwo\n'));
  assert.equal(result.changes['run.sh'].mode, EXECUTABLE_FILE_MODE);
  assert.equal(fileModeOf(result.changes['run.sh']), EXECUTABLE_FILE_MODE);
});

test('an overwrite-rename onto an existing destination conflicts instead of losing the source', async () => {
  // Repro: base old.txt=payload-X and destination.txt=base text. One input
  // deletes old.txt and writes its exact bytes over the existing
  // destination.txt (an overwrite-rename); another edits that same destination.
  // Before the fix the move was invisible, so the source tombstone survived and
  // X disappeared from the merged tree entirely.
  const baseFiles = {
    'old.txt': 'payload-X\n',
    'destination.txt': 'base destination\nsecond line\n'
  };
  const moved = variant(baseFiles, { 'old.txt': REMOVE, 'destination.txt': 'payload-X\n' });
  const competing = variant(baseFiles, { 'destination.txt': 'base DESTINATION\nsecond line\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: moved },
    { id: 'competing', files: competing }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['destination.txt', 'old.txt'],
      inputIds: ['rename', 'competing'],
      reason: 'textual overlap'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('payload-X\n'));
  assert.equal(final['destination.txt'].hash, sha256('base destination\nsecond line\n'));
});

test('an uncontested overwrite-rename keeps the destination bytes and the source tombstone', async () => {
  const baseFiles = { 'old.txt': 'payload-X\n', 'destination.txt': 'base destination\n' };
  const moved = variant(baseFiles, { 'old.txt': REMOVE, 'destination.txt': 'payload-X\n' });
  const { result, base } = await run(baseFiles, [{ id: 'rename', files: moved }]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['destination.txt', 'old.txt']);
  assert.equal(result.changes['old.txt'], null);
  assert.equal(result.changes['destination.txt'].hash, sha256('payload-X\n'));
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'], undefined);
  assert.equal(final['destination.txt'].hash, sha256('payload-X\n'));
});

test('an untouched duplicate or mode-only destination is never inferred as a move', async () => {
  // copy.txt already holds exactly the deleted bytes. As long as its own content
  // did not change it is not a move destination, so the delete stays clean and
  // the file is not reported as a refused rename.
  const baseFiles = { 'old.txt': 'payload-X\n', 'copy.txt': 'payload-X\n' };
  const deleted = variant(baseFiles, { 'old.txt': REMOVE });
  const { result, base } = await run(baseFiles, [{ id: 'delete', files: deleted }]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.changes), ['old.txt']);
  assert.equal(result.changes['old.txt'], null);
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'], undefined);
  assert.equal(final['copy.txt'].hash, sha256('payload-X\n'));

  // A mode-only edit rewrites the entry but not its bytes: same conclusion.
  const modeOnly = variant(baseFiles, {
    'old.txt': REMOVE,
    'copy.txt': file('payload-X\n', EXECUTABLE_FILE_MODE)
  });
  const rewritten = await run(baseFiles, [{ id: 'delete', files: modeOnly }]);
  assert.deepEqual(rewritten.result.conflicts, []);
  assert.equal(rewritten.result.changes['old.txt'], null);
  assert.equal(rewritten.result.changes['copy.txt'].hash, sha256('payload-X\n'));
  assert.equal(fileModeOf(rewritten.result.changes['copy.txt']), EXECUTABLE_FILE_MODE);
});

test('a source-side conflict restores the base destination of a refused overwrite-rename', async () => {
  const baseFiles = {
    'old.txt': 'payload-X\n',
    'destination.txt': 'base destination\nsecond line\n'
  };
  const moved = variant(baseFiles, { 'old.txt': REMOVE, 'destination.txt': 'payload-X\n' });
  const editedSource = variant(baseFiles, { 'old.txt': 'edited source\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: moved },
    { id: 'editor', files: editedSource }
  ]);

  // The move is known, so its refused destination is reported together with the
  // source instead of overwriting the pre-existing destination file.
  assert.deepEqual(result.conflicts, [
    {
      paths: ['destination.txt', 'old.txt'],
      inputIds: ['rename', 'editor'],
      reason: 'delete/modify'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('payload-X\n'));
  assert.equal(final['destination.txt'].hash, sha256('base destination\nsecond line\n'));
});

test('a refused overwrite-rename leaves none of its bytes at an independently edited destination', async () => {
  // Same shape, but the other input edits the destination on a line the moved
  // bytes do not touch. Only the refused move is recomputed away, so the
  // destination keeps exactly the independent edit and none of the moved lines;
  // the source stays at its base bytes.
  const baseFiles = {
    'old.txt': 'base destination\nmoved line\n',
    'destination.txt': 'base destination\nsecond line\n'
  };
  const moved = variant(baseFiles, {
    'old.txt': REMOVE,
    'destination.txt': 'base destination\nmoved line\n'
  });
  const competing = variant(baseFiles, {
    'old.txt': 'edited source\n',
    'destination.txt': 'base destination EDITED\nsecond line\n'
  });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: moved },
    { id: 'competing', files: competing }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['destination.txt', 'old.txt'],
      inputIds: ['rename', 'competing'],
      reason: 'delete/modify'
    }
  ]);
  assert.deepEqual(Object.keys(result.changes), ['destination.txt']);
  // The independent edit alone: no `moved line` from the refused move.
  assert.equal(result.changes['destination.txt'].hash, sha256('base destination EDITED\nsecond line\n'));
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('base destination\nmoved line\n'));
  assert.equal(final['destination.txt'].hash, sha256('base destination EDITED\nsecond line\n'));
});

test('a divergent overwrite-rename restores the base destination instead of overwriting it', async () => {
  const baseFiles = { 'old.txt': 'payload-X\n', 'destination.txt': 'base destination\n' };
  const ontoDestination = variant(baseFiles, { 'old.txt': REMOVE, 'destination.txt': 'payload-X\n' });
  const toNewPath = variant(baseFiles, { 'old.txt': REMOVE, 'new.txt': 'payload-X\n' });
  const { result, base } = await run(baseFiles, [
    { id: 'first', files: ontoDestination },
    { id: 'second', files: toNewPath }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['destination.txt', 'new.txt', 'old.txt'],
      inputIds: ['first', 'second'],
      reason: 'divergent rename'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('payload-X\n'));
  assert.equal(final['destination.txt'].hash, sha256('base destination\n'));
  assert.equal(final['new.txt'], undefined);
});

test('a refused overwrite-rename whose destination is independently deleted keeps both base files', async () => {
  // The destination is itself conflicted (the move overwrote it, another input
  // deleted it), so nothing is recomputed there: both base files survive and the
  // related change is reported once, not twice.
  const baseFiles = {
    'old.txt': 'base destination\nmoved line\n',
    'destination.txt': 'base destination\nsecond line\n'
  };
  const moved = variant(baseFiles, {
    'old.txt': REMOVE,
    'destination.txt': 'base destination\nmoved line\n'
  });
  const competing = variant(baseFiles, { 'old.txt': 'edited source\n', 'destination.txt': REMOVE });
  const { result, base } = await run(baseFiles, [
    { id: 'rename', files: moved },
    { id: 'competing', files: competing }
  ]);

  assert.deepEqual(result.conflicts, [
    {
      paths: ['destination.txt', 'old.txt'],
      inputIds: ['rename', 'competing'],
      reason: 'delete/modify'
    }
  ]);
  assert.deepEqual(result.changes, {});
  const final = applied(base.entries, result.changes);
  assert.equal(final['old.txt'].hash, sha256('base destination\nmoved line\n'));
  assert.equal(final['destination.txt'].hash, sha256('base destination\nsecond line\n'));
});
