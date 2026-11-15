// Selected snapshot capture regression tests.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ContentStore, captureContent, cloneSelectionQuery } = require(path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build', 'snapshot-content'));

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const createRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-selection-'));
const select = (paths, extra) => async () => ({ paths, fingerprint: 'fp', ...(extra || {}) });

test('a storage callback cannot replace captured bytes by mutating its buffer', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'original');
  const store = new ContentStore(path.join(root, 'store'));
  let calls = 0;
  await assert.rejects(captureContent(root, store, {
    selection: select(['a.txt']),
    storeContent: async (_key, bytes) => {
      calls += 1;
      bytes.fill(0x78);
      return store.put(bytes);
    }
  }), { code: 'snapshot_content_missing' });
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original');
});

// Namespace invariant: every file key has directory parents; no file key is a parent of another key.
function assertNamespace(entries) {
  const files = Object.keys(entries).filter(key => entries[key].type === 'file');
  for (const key of files) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      assert.equal(entries[parts.slice(0, i).join('/')].type, 'directory', `missing parent for ${key}`);
    }
    for (const other of files) {
      assert.equal(other.startsWith(`${key}/`), false, `file ${key} has file child ${other}`);
    }
  }
}

test('selection captures selected + hidden entries; the rest is skipped without reads, stats or fabrication', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'unselected readme');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'selected main');
  await fs.writeFile(path.join(root, 'src', '.vscode'), 'protected regular leaf');
  await fs.mkdir(path.join(root, 'src', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', '.git', 'secret.txt'), 'never read');
  await fs.mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'selected hidden');
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'x.js'), 'dep');
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'build', 'out.js'), 'build');
  const store = new ContentStore(path.join(root, 'store'));
  const visited = [];
  const reads = [];
  const manifest = await captureContent(root, store, {
    selection: select(['src/main.js', '.github/workflows/ci.yml', 'src/.git/config', 'src/.vscode/x', 'ghost/inner/file.txt']),
    beforeVisit: p => { visited.push(path.relative(root, p).split(path.sep).join('/')); },
    beforeRead: p => { reads.push(path.relative(root, p).split(path.sep).join('/')); },
    openDocuments: () => [
      { path: path.join(root, 'node_modules', 'dep', 'x.js'), text: 'doc in dep', version: 1 },
      { path: path.join(root, 'src', '.git', 'secret.txt'), text: 'doc in protected', version: 1 },
      { path: path.join(root, 'src', '.vscode'), text: 'doc on protected leaf', version: 1 }
    ]
  });
  assertNamespace(manifest.entries);
  assert.equal(manifest.entries['src/main.js'].type, 'file');
  assert.deepEqual(await store.read(manifest.entries['src/main.js'].hash), Buffer.from('selected main'));
  assert.equal(manifest.entries['.github/workflows/ci.yml'].type, 'file');
  assert.equal(manifest.entries['.github'].type, 'directory');
  assert.equal(manifest.entries['.github/workflows'].type, 'directory');
  assert.equal(manifest.entries.src.type, 'directory');
  assert.equal(manifest.entries['src/.git'].detail, 'excluded-protected-component');
  assert.equal(manifest.entries['src/.vscode'].detail, 'excluded-protected-component');
  for (const key of ['src/.git/config', 'src/.vscode/x', 'ghost', 'ghost/inner', 'ghost/inner/file.txt', 'README.md', 'node_modules', 'build', 'store', 'src/.git/secret.txt']) {
    assert.equal(manifest.entries[key], undefined, `unexpected entry ${key}`);
  }
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.totalBytes, 'selected main'.length + 'selected hidden'.length);
  // Both full scans run: each visited/read path appears exactly twice.
  // Exactly one complete traversal per full scan: every visited path occurs
  // twice (scan 1 + scan 2) and only the selected keys plus their parents.
  assert.equal(visited.length, 16);
  assert.deepEqual([...new Set(visited)].sort(), ['', '.github', '.github/workflows', '.github/workflows/ci.yml', 'src', 'src/.git', 'src/.vscode', 'src/main.js'].sort());
  for (const key of ['', '.github', '.github/workflows', 'src', 'src/.git', 'src/.vscode']) {
    assert.equal(visited.filter(p => p === key).length, 2);
  }
  assert.deepEqual([...new Set(reads)].sort(), ['.github/workflows/ci.yml', 'src/main.js'].sort());
  assert.equal(reads.filter(p => p === '.github/workflows/ci.yml').length, 2);
  assert.equal(reads.filter(p => p === 'src/main.js').length, 2);
});

test('stable missing selected path (tracked deletion) is absent: no retries, no entries, no live fallback', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store, { selection: select(['a.txt', 'gone.txt']), maxAttempts: 1 });
  assert.equal(manifest.entries['a.txt'].type, 'file');
  assert.equal(manifest.entries['gone.txt'], undefined);
  assert.equal(manifest.fileCount, 1);
});

test('forced unsupported is never read or descended into; editor docs on/below it cannot override', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'ok.txt'), 'fine');
  await fs.mkdir(path.join(root, 'src', 'gitlink'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'gitlink', 'child.txt'), 'child on disk');
  await fs.writeFile(path.join(root, 'src', 'blob'), 'forced file');
  const store = new ContentStore(path.join(root, 'store'));
  const reads = [];
  const lists = [];
  const manifest = await captureContent(root, store, {
    selection: select(['ok.txt', 'src/gitlink', 'src/blob'], { unsupported: { 'src/gitlink': 'gitlink', 'src/blob': 'forced-unsupported' } }),
    beforeRead: p => { reads.push(path.relative(root, p).split(path.sep).join('/')); },
    beforeList: p => { lists.push(path.relative(root, p).split(path.sep).join('/')); },
    openDocuments: () => [
      { path: path.join(root, 'src', 'gitlink'), text: 'doc on forced', version: 1 },
      { path: path.join(root, 'src', 'gitlink', 'child.txt'), text: 'doc below forced', version: 1 }
    ]
  });
  assert.equal(manifest.entries['src/gitlink'].type, 'unsupported');
  assert.equal(manifest.entries['src/gitlink'].detail, 'gitlink');
  assert.equal(manifest.entries['src/blob'].type, 'unsupported');
  assert.equal(manifest.entries['src/blob'].detail, 'forced-unsupported');
  assert.equal(manifest.entries['src/gitlink/child.txt'], undefined);
  assert.equal(manifest.entries['ok.txt'].type, 'file');
  assert.equal(manifest.entries.src.type, 'directory');
  assert.equal(manifest.fileCount, 1);
  assert.deepEqual(reads, ['ok.txt', 'ok.txt']);
  assert.equal(lists.some(p => p.includes('gitlink') || p.includes('blob')), false);
  assert.deepEqual(await store.read(manifest.entries['ok.txt'].hash), Buffer.from('fine'));
});

test('mutable provider cannot mutate the baseline clone; churn fails closed or retries to stable', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  const store = new ContentStore(path.join(root, 'store'));
  // The baseline clone is independent of later provider-object mutation.
  const shared = { paths: ['a.txt'], fingerprint: 'fp1' };
  const clone = cloneSelectionQuery(shared);
  shared.paths.push('zzz.txt');
  shared.fingerprint = 'fp2';
  assert.deepEqual([...clone.paths], ['a.txt']);
  assert.equal(clone.fingerprint, 'fp1');
  // The provider mutates its returned object at boundary 2 of the attempt:
  // the baseline clone disagrees with the boundary-2 re-query.
  const churny = { paths: ['a.txt'], fingerprint: 'fp1' };
  let calls = 0;
  await assert.rejects(captureContent(root, store, {
    maxAttempts: 1,
    selection: async () => {
      calls += 1;
      if (calls === 2) {
        churny.fingerprint = 'fp2';
      }
      return churny;
    }
  }), { code: 'inconsistent_capture' });
  assert.equal(calls, 2);
  assert.equal(churny.fingerprint, 'fp2');
  // Stable provider is queried at all four boundaries.
  let queries = 0;
  const manifest = await captureContent(root, store, {
    selection: async () => { queries += 1; return { paths: ['a.txt'], fingerprint: 'fp' }; }
  });
  assert.equal(queries, 4);
  assert.equal(manifest.entries['a.txt'].type, 'file');
  // Churn on the first query only: the retry sees the stable provider and succeeds.
  const unstable = { paths: ['a.txt'], fingerprint: 'first' };
  let churn = 0;
  const recovered = await captureContent(root, store, {
    selection: async () => { churn += 1; unstable.fingerprint = churn === 1 ? 'first' : 'stable'; return unstable; }
  });
  assert.equal(recovered.entries['a.txt'].type, 'file');
  assert.equal(churn, 6);
});

test('storeContent writes once per file, stays stable after live edits, and fails closed on bad hash or revocation', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(root, 'b.txt'), 'beta');
  const store = new ContentStore(path.join(root, 'store'));
  const external = new Map();
  const storedKeys = [];
  const manifest = await captureContent(root, store, {
    selection: select(['a.txt', 'b.txt']),
    storeContent: async (key, bytes) => { storedKeys.push(key); external.set(key, Buffer.from(bytes)); return sha256(bytes); }
  });
  assert.equal(manifest.entries['a.txt'].hash, sha256('alpha'));
  assert.equal(external.size, 2);
  assert.deepEqual(storedKeys.sort(), ['a.txt', 'b.txt'], 'each file is stored exactly once after the matching scans');
  assert.deepEqual(external.get('a.txt'), Buffer.from('alpha'));
  assert.deepEqual(external.get('b.txt'), Buffer.from('beta'));
  // The default CAS was never used for this capture.
  assert.equal(await fs.stat(path.join(store.directory, 'blobs')).catch(() => null), null);
  // Stored bytes are stable after the live file changes.
  await fs.writeFile(path.join(root, 'a.txt'), 'mutated live');
  assert.deepEqual(external.get('a.txt'), Buffer.from('alpha'));
  // A returned hash that is not the exact SHA-256 fails closed.
  await assert.rejects(captureContent(root, store, {
    selection: select(['a.txt']),
    storeContent: async () => 'f'.repeat(64)
  }), { code: 'snapshot_content_missing', message: /not the exact SHA-256/ });
  // Guard revocation after the storage await aborts before the manifest.
  const revoked = { value: false };
  const guard = () => { if (revoked.value) { throw new Error('store revoked'); } };
  await assert.rejects(captureContent(root, store, {
    selection: select(['a.txt']),
    guard,
    storeContent: async (key, bytes) => { await tick(); revoked.value = true; return sha256(bytes); }
  }), { message: /store revoked/ });
});

test('same-byte rewrite with touched times and root replacement are churn, not false matches', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'f.txt'), 'same');
  const store = new ContentStore(path.join(root, 'store'));
  await assert.rejects(captureContent(root, store, {
    selection: select(['f.txt']),
    maxAttempts: 1,
    afterScan: async () => {
      const file = path.join(root, 'f.txt');
      await fs.writeFile(file, 'same');
      const past = new Date(Date.now() - 120000);
      await fs.utimes(file, past, past);
    }
  }), { code: 'inconsistent_capture' });
  const replaced = await createRoot();
  t.after(() => fs.rm(replaced, { recursive: true, force: true }));
  await fs.writeFile(path.join(replaced, 'r.txt'), 'r');
  await assert.rejects(captureContent(replaced, new ContentStore(path.join(replaced, 'store')), {
    selection: select(['r.txt']),
    maxAttempts: 1,
    afterScan: async () => {
      await fs.rm(replaced, { recursive: true, force: true });
      await fs.mkdir(replaced);
    }
  }), { code: 'inconsistent_capture' });
});

test('empty selection with dirty existing + new nested docs keeps coherent parents; win32 aliases canonicalize', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a'), 'disk a');
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store, {
    selection: select([]),
    openDocuments: () => [
      { path: path.join(root, 'src', 'a'), text: 'dirty a', version: 1 },
      { path: path.join(root, 'src', 'new', 'deep', 'b.txt'), text: 'new b', version: 1 }
    ]
  });
  assertNamespace(manifest.entries);
  assert.equal(manifest.entries.src.type, 'directory');
  assert.equal(manifest.entries['src/a'].type, 'file');
  assert.deepEqual(await store.read(manifest.entries['src/a'].hash), Buffer.from('dirty a'));
  assert.equal(manifest.entries['src/new'].type, 'directory');
  assert.equal(manifest.entries['src/new/deep'].type, 'directory');
  assert.equal(manifest.entries['src/new/deep/b.txt'].type, 'file');
  if (process.platform === 'win32') {
    const root2 = await createRoot();
    t.after(() => fs.rm(root2, { recursive: true, force: true }));
    await fs.mkdir(path.join(root2, 'src'), { recursive: true });
    await fs.writeFile(path.join(root2, 'src', 'main.js'), 'main');
    const store2 = new ContentStore(path.join(root2, 'store'));
    const second = await captureContent(root2, store2, {
      selection: select(['src/main.js']),
      openDocuments: () => [{ path: path.join(root2, 'SRC', 'new', 'x.txt'), text: 'aliased new', version: 1 }]
    });
    assertNamespace(second.entries);
    assert.equal(second.entries['src/new'].type, 'directory');
    assert.equal(second.entries['src/new/x.txt'].type, 'file');
    assert.deepEqual(await store2.read(second.entries['src/new/x.txt'].hash), Buffer.from('aliased new'));
    assert.deepEqual(Object.keys(second.entries).filter(key => key.toLowerCase() === 'src'), ['src']);
  }
});

test('POSIX case-sensitive selection matches exact case (win32 runs via temporary platform override)', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'UPPER.txt'), 'upper file');
  const store = new ContentStore(path.join(root, 'store'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const overridden = process.platform === 'win32';
  if (overridden && (!descriptor || !descriptor.configurable)) {
    t.skip('process.platform descriptor is not redefinable');
    return;
  }
  if (overridden) {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  }
  try {
    const exact = await captureContent(root, store, { selection: select(['UPPER.txt']) });
    assert.equal(exact.entries['UPPER.txt'].type, 'file');
    assert.deepEqual(await store.read(exact.entries['UPPER.txt'].hash), Buffer.from('upper file'));
    const caseMiss = await captureContent(root, store, { selection: select(['upper.txt']) });
    assert.equal(caseMiss.entries['UPPER.txt'], undefined);
    assert.equal(caseMiss.fileCount, 0);
  } finally {
    if (overridden) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
});

test('invalid selection shapes fail closed; valid NFD names are accepted, not normalized or rejected', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  const store = new ContentStore(path.join(root, 'store'));
  const bad = [
    { paths: [''], fingerprint: 'fp' },
    { paths: ['a/../../b'], fingerprint: 'fp' },
    { paths: ['a/./b'], fingerprint: 'fp' },
    { paths: ['a\\b'], fingerprint: 'fp' },
    { paths: ['/abs'], fingerprint: 'fp' },
    { paths: ['a\0b'], fingerprint: 'fp' },
    { paths: ['x'.repeat(4097)], fingerprint: 'fp' },
    { paths: ['a.txt'], fingerprint: 'fp', unsupported: { 'other.txt': 'detail' } },
    { paths: ['a.txt'], fingerprint: 'fp', unsupported: { 'a.txt': 42 } },
    { paths: ['a.txt'], fingerprint: 'fp', unsupported: ['a.txt'] }
  ];
  for (const item of bad) {
    await assert.rejects(captureContent(root, store, { selection: async () => item }), { code: 'invalid_capture_selection' });
  }
  await assert.rejects(captureContent(root, store, {
    selection: async () => ({ paths: ['a.txt', 'b.txt', 'c.txt'], fingerprint: 'fp' }),
    limits: { maxEntries: 2 }
  }), { code: 'invalid_capture_selection' });
  await assert.rejects(captureContent(root, store, { selection: async () => null }), { code: 'invalid_capture_selection' });
  await assert.rejects(captureContent(root, store, { selection: async () => ({ fingerprint: 'fp' }) }), { code: 'invalid_capture_selection' });
  // A valid NFD filename must be accepted (no NFC restriction); it is captured
  // when the filesystem preserves the exact name, and simply absent otherwise.
  const nfdName = 'caf\u0065\u0301.txt';
  await fs.writeFile(path.join(root, nfdName), 'nfd');
  const manifest = await captureContent(root, store, { selection: select([nfdName]) });
  if ((await fs.readdir(root)).includes(nfdName)) {
    assert.equal(manifest.entries[nfdName].type, 'file');
    assert.equal(manifest.fileCount, 1);
  } else {
    assert.equal(manifest.fileCount, 0);
  }
});
