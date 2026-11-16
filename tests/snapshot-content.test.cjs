const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ContentStore, captureContent, resolveDocumentKey,
  DEFAULT_FILE_MODE, EXECUTABLE_FILE_MODE, fileModeOf, fileModeFromPermissions, isFileMode
} = require(path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build', 'snapshot-content'));

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const createRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-content-'));

async function seed(root) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'readme v1');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'console.log(1)');
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'pkg.js'), 'dep');
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{}');
}

const blobFile = (store, hash) => path.join(store.directory, 'blobs', hash.slice(0, 2), hash.slice(2));

test('CAS dedupes, verifies, and fails closed on missing, corrupt and put-over-corrupt', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ContentStore(path.join(root, 'store'));
  const a = await store.put(Buffer.from('shared bytes'));
  const b = await store.put(Buffer.from('shared bytes'));
  const c = await store.put(Buffer.from('other bytes'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.deepEqual(await store.read(a), Buffer.from('shared bytes'));
  await assert.rejects(store.read('0'.repeat(64)), { code: 'snapshot_content_missing' });
  assert.equal(await store.has(a), true);
  assert.equal(await store.has('0'.repeat(64)), false);
  const missing = await store.put(Buffer.from('dying bytes'));
  await fs.rm(blobFile(store, missing));
  await assert.rejects(store.read(missing), { code: 'snapshot_content_missing' });
  const corrupt = await store.put(Buffer.from('corruptible'));
  await fs.appendFile(blobFile(store, corrupt), 'x');
  await assert.rejects(store.read(corrupt), { code: 'snapshot_content_missing', message: /hash verification/ });
  // put() must verify an existing blob before reusing its hash: a corrupt
  // blob rejects instead of publishing an unreadable capture.
  await assert.rejects(store.put(Buffer.from('corruptible')), { code: 'snapshot_content_missing', message: /corrupt/ });
  assert.equal(await store.has(corrupt), true);
  assert.deepEqual(await store.read(a), Buffer.from('shared bytes'));
});

test('CAS snapshots caller-owned buffers before asynchronous publication', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ContentStore(path.join(root, 'store'));
  const original = Buffer.from('immutable bytes');
  const input = Buffer.from(original);
  const pending = store.put(input);
  input.fill(0);
  const hash = await pending;
  assert.equal(hash, sha256(original));
  assert.deepEqual(await store.read(hash), original);
});

test('manifest is stable after live edits and removals; exclusions are case-insensitive', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  await fs.mkdir(path.join(root, 'Vendor'));
  await fs.writeFile(path.join(root, 'Vendor', 'mjs'), 'dep');
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store);
  assert.equal(manifest.entries['README.md'].type, 'file');
  assert.equal(manifest.entries['src/main.js'].size, 14);
  assert.equal(manifest.entries.src.type, 'directory');
  assert.equal(manifest.entries['node_modules/dep/pkg.js'], undefined);
  assert.equal(manifest.entries['Vendor/mjs'], undefined);
  assert.match(manifest.entries['node_modules'].detail, /^excluded-directory/);
  assert.match(manifest.entries['Vendor'].detail, /^excluded-directory/);
  assert.equal(manifest.entries['.vscode'].detail, 'excluded-protected-component');
  await fs.writeFile(path.join(root, 'README.md'), 'mutated live');
  await fs.rm(path.join(root, 'src', 'main.js'));
  assert.deepEqual(await store.read(manifest.entries['README.md'].hash), Buffer.from('readme v1'));
  assert.deepEqual(await store.read(manifest.entries['src/main.js'].hash), Buffer.from('console.log(1)'));
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.totalBytes, 9 + 14);
});

test('unsaved editor text overrides disk once; new docs create virtual directories', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  const documents = [
    { path: path.join(root, 'README.md'), text: 'readme unsaved', version: 1 },
    { path: path.join(root, 'src', 'deep', 'new-doc.ts'), text: 'const x = 1;', version: 1 },
    { path: path.join(root, 'node_modules', 'dep', 'dirty.js'), text: 'should be ignored', version: 1 },
    { path: path.join(root, '..', 'outside.txt'), text: 'escape', version: 1 },
    { path: 'relative-doc.txt', text: 'non-absolute paths are ignored', version: 1 }
  ];
  const manifest = await captureContent(root, store, { openDocuments: () => documents });
  assert.equal(manifest.entries['README.md'].size, 'readme unsaved'.length);
  assert.deepEqual(await store.read(manifest.entries['README.md'].hash), Buffer.from('readme unsaved'));
  assert.equal(manifest.entries['src/deep/new-doc.ts'].size, 'const x = 1;'.length);
  assert.deepEqual(await store.read(manifest.entries['src/deep/new-doc.ts'].hash), Buffer.from('const x = 1;'));
  assert.equal(manifest.entries['src/deep'].type, 'directory');
  assert.equal(manifest.entries['node_modules/dep/dirty.js'], undefined);
  assert.equal(manifest.entries['outside.txt'], undefined);
  assert.equal(manifest.entries['relative-doc.txt'], undefined);
  assert.equal(manifest.fileCount, 3);
  // Disk bytes 9 + 14, override adjusts by (14 - 9), new doc adds 12.
  assert.equal(manifest.totalBytes, 9 + 14 + ('readme unsaved'.length - 9) + 'const x = 1;'.length);
  await fs.writeFile(path.join(root, 'README.md'), 'disk saved');
  const second = await captureContent(root, store);
  assert.deepEqual(await store.read(second.entries['README.md'].hash), Buffer.from('disk saved'));
  assert.deepEqual(await store.read(manifest.entries['README.md'].hash), Buffer.from('readme unsaved'));
  assert.equal(manifest.entries['src/main.js'].hash, second.entries['src/main.js'].hash);
});

test('editor documents are re-enumerated before and after every scan', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  let state = 0;
  // One-time change in afterScan: detected before verification, retry succeeds.
  const manifest = await captureContent(root, store, {
    openDocuments: () => [{ path: path.join(root, 'README.md'), text: `v${state}`, version: state }],
    afterScan: attempt => { if (attempt === 1) { state = 1; } }
  });
  assert.equal(manifest.entries['README.md'].size, 2);
  assert.deepEqual(await store.read(manifest.entries['README.md'].hash), Buffer.from('v1'));
  // A change in afterScan on EVERY attempt: the stale pre-verify enumeration
  // no longer hides it; retries are exhausted.
  state = 0;
  let attempts = 0;
  await assert.rejects(captureContent(root, store, {
    openDocuments: () => [{ path: path.join(root, 'README.md'), text: `v${state}`, version: state }],
    afterScan: async () => { attempts += 1; state = attempts * 10; await new Promise(resolve => setTimeout(resolve, 1)); }
  }), { code: 'inconsistent_capture' });
  assert.equal(attempts, 3);
  // Deterministic every-attempt editor race at the enumeration points.
  let calls = 0;
  await assert.rejects(captureContent(root, store, {
    openDocuments: () => {
      calls += 1;
      return [{ path: path.join(root, 'README.md'), text: calls % 2 === 1 ? 'odd' : 'even', version: calls }];
    }
  }), { code: 'inconsistent_capture' });
  assert.equal(calls, 6);
});

test('race during capture retries, then fails inconsistent_capture', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  const first = await captureContent(root, store, {
    afterScan: async attempt => { if (attempt === 1) { await fs.writeFile(path.join(root, 'README.md'), 'churn'); } }
  });
  assert.equal(first.entries['README.md'].size, 'churn'.length);
  let attempts = 0;
  await assert.rejects(captureContent(root, store, {
    afterScan: async () => { attempts += 1; await fs.writeFile(path.join(root, 'README.md'), `churn ${attempts}`); }
  }), { code: 'inconsistent_capture', retryable: true });
  assert.equal(attempts, 3);
  let toggles = 0;
  await assert.rejects(captureContent(root, store, {
    afterScan: async () => {
      toggles += 1;
      const file = path.join(root, 'src', 'main.js');
      if (toggles % 2 === 1) {
        await fs.rm(file);
      } else {
        await fs.writeFile(file, 'console.log(1)');
      }
    }
  }), { code: 'inconsistent_capture' });
  assert.equal(toggles, 3);
});

test('swapped junction parent is detected; editor doc through a junction is ignored', async t => {
  const parent = await createRoot();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(root, { recursive: true });
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const outsideBytes = 'outside bytes that must never be captured';
  await fs.writeFile(path.join(outside, 'secret.txt'), outsideBytes);
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  const inner = path.join(root, 'src', 'inner');
  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(path.join(inner, 'file.txt'), 'inner file');
  // Deterministic swap: right before file.txt is read, its parent becomes a
  // junction to outside. The dev/ino component recheck must catch it without
  // ever reading the outside bytes.
  const manifest = await captureContent(root, store, {
    beforeRead: async absolute => {
      if (path.resolve(absolute) === path.join(inner, 'file.txt')) {
        await fs.rm(inner, { recursive: true, force: true });
        await fs.symlink(outside, inner, 'junction');
      }
    }
  });
  assert.equal(manifest.entries['src/inner'].type, 'unsupported');
  assert.equal(manifest.entries['src/inner/file.txt'], undefined);
  assert.equal(await store.has(sha256(outsideBytes)), false);
  // An editor document whose parent is a junction is unsupported/ignored: no
  // outside descendant is captured under the virtual name.
  const second = await captureContent(root, store, {
    openDocuments: () => [{ path: path.join(inner, 'secret.txt'), text: 'must not be captured', version: 1 }]
  });
  assert.equal(second.entries['src/inner'].type, 'unsupported');
  assert.equal(second.entries['src/inner/secret.txt'], undefined);
  for (const entry of Object.values(second.entries)) {
    if (entry.type === 'file') {
      assert.notEqual(await store.read(entry.hash), Buffer.from(outsideBytes));
    }
  }
});

test('legal dotted names are not treated as parent references', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '..notes'), 'dotted but legal');
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'sub', '..deep.md'), 'nested dotted');
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store);
  assert.equal(manifest.entries['..notes'].size, 'dotted but legal'.length);
  assert.equal(manifest.entries['sub/..deep.md'].size, 'nested dotted'.length);
});

test('capacity caps are enforced incrementally; limits are validated', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ContentStore(path.join(root, 'store'));
  for (let i = 0; i < 10; i += 1) {
    await fs.writeFile(path.join(root, `f${i}.txt`), '12345');
  }
  await assert.rejects(captureContent(root, store, { limits: { maxTotalBytes: 30 } }), { code: 'snapshot_capacity', message: /maxTotalBytes/ });
  await assert.rejects(captureContent(root, store, { limits: { maxFiles: 3 } }), { code: 'snapshot_capacity', message: /maxFiles/ });
  await assert.rejects(captureContent(root, store, { limits: { maxFileBytes: 4 } }), { code: 'snapshot_capacity', message: /maxFileBytes/ });
  await assert.rejects(captureContent(root, store, { limits: { maxEntries: 5 } }), { code: 'snapshot_capacity', message: /maxEntries/ });
  for (const bad of [{ maxFiles: 0 }, { maxFiles: 1.5 }, { maxFileBytes: -1 }, { maxTotalBytes: Number.NaN }]) {
    await assert.rejects(captureContent(root, store, { limits: bad }), { code: 'invalid_capture_limits' });
  }
  await assert.rejects(captureContent(root, store, { maxAttempts: 0 }), { code: 'invalid_capture_limits' });
  await assert.rejects(captureContent(root, store, { maxAttempts: 2.5 }), { code: 'invalid_capture_limits' });
  const manifest = await captureContent(root, store, { limits: { maxTotalBytes: 50 } });
  assert.equal(manifest.fileCount, 10);
});

test('live guard recheck aborts before blob publication', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const alive = { value: true };
  const guard = () => { if (!alive.value) { throw new Error('host closing'); } };
  const store = new ContentStore(path.join(root, 'store'), { guard });
  await assert.rejects(captureContent(root, store, {
    guard,
    afterScan: () => { alive.value = false; }
  }), { message: /host closing/ });
  const published = await fs.readdir(path.join(store.directory, 'blobs')).catch(() => []);
  assert.equal(published.length, 0);
  alive.value = true;
  const manifest = await captureContent(root, store, { guard });
  assert.equal(manifest.fileCount, 2);
  alive.value = false;
  await assert.rejects(store.put(Buffer.from('late write')), { message: /host closing/ });
});

test('__proto__ filename roundtrips in the prototype-less manifest', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = 'own key, not the prototype';
  await fs.writeFile(path.join(root, '__proto__'), body);
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store);
  assert.equal(Object.getPrototypeOf(manifest.entries), null);
  assert.equal(manifest.entries['__proto__'].type, 'file');
  assert.equal(manifest.entries['__proto__'].size, body.length);
  assert.deepEqual(await store.read(manifest.entries['__proto__'].hash), Buffer.from(body));
  assert.equal(manifest.entries.constructor, undefined);
});

test('win32 editor case alias resolves to the captured canonical key; non-absolute rejected', async t => {
  assert.equal(resolveDocumentKey(['README.md', 'src/Main.js'], 'readme.MD', true), 'README.md');
  assert.equal(resolveDocumentKey(['README.md', 'src/Main.js'], 'SRC/MAIN.JS', true), 'src/Main.js');
  assert.equal(resolveDocumentKey(['README.md'], 'OTHER.md', true), 'OTHER.md');
  assert.equal(resolveDocumentKey(['README.md', 'Readme.md'], 'readme.md', false), 'readme.md');
  if (process.platform === 'win32') {
    const root = await createRoot();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'README.md'), 'readme v1');
    const store = new ContentStore(path.join(root, 'store'));
    const manifest = await captureContent(root, store, {
      openDocuments: () => [{ path: path.join(root, 'readme.MD'), text: 'case alias override', version: 1 }]
    });
    assert.equal(manifest.entries['README.md'].size, 'case alias override'.length);
    assert.equal(manifest.entries['readme.MD'], undefined);
    assert.deepEqual(await store.read(manifest.entries['README.md'].hash), Buffer.from('case alias override'));
  }
});

test('symlinks are recorded unsupported, never traversed or captured', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(root, 'README.md'), path.join(root, 'link.md'));
    const manifest = await captureContent(root, store);
    assert.equal(manifest.entries['link.md'].type, 'unsupported');
    assert.match(manifest.entries['link.md'].detail, /symlink/);
  }
  await fs.symlink(path.join(root, 'src'), path.join(root, 'dirlink'), 'junction');
  const manifest = await captureContent(root, store);
  assert.equal(manifest.entries['dirlink'].type, 'unsupported');
  assert.match(manifest.entries['dirlink'].detail, /symlink/);
  assert.equal(manifest.fileCount, 2);
});

test('directory swapped to an outside junction at beforeList is never traversed', async t => {
  const parent = await createRoot();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(root, { recursive: true });
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const outsideBytes = 'outside bytes that must never be captured';
  await fs.writeFile(path.join(outside, 'secret.txt'), outsideBytes);
  await fs.writeFile(path.join(root, 'README.md'), 'readme v1');
  const store = new ContentStore(path.join(root, 'store'));
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  const reads = [];
  let swapped = false;
  const manifest = await captureContent(root, store, {
    beforeRead: absolute => { reads.push(path.resolve(absolute)); },
    beforeList: async absolute => {
      const target = path.resolve(absolute);
      if (!swapped && target === empty) {
        swapped = true;
        await fs.rm(empty, { recursive: true, force: true });
        await fs.symlink(outside, empty, 'junction');
        return;
      }
      if (swapped && target === path.resolve(root)) {
        await fs.rm(empty, { recursive: true, force: true });
        await fs.mkdir(empty);
      }
    }
  });
  assert.equal(manifest.entries.empty.type, 'directory');
  assert.equal(manifest.entries['empty/secret.txt'], undefined);
  assert.equal(reads.some(p => p.startsWith(path.join(outside, path.sep))), false);
  assert.equal(await store.has(sha256(outsideBytes)), false);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), outsideBytes);
});

test('editor docs never create file+descendant contradictions or ENOTDIR probes', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const store = new ContentStore(path.join(root, 'store'));
  const first = await captureContent(root, store, {
    openDocuments: () => [
      { path: path.join(root, 'src'), text: 'ignored: src is a directory', version: 1 },
      { path: path.join(root, 'README.md', 'child'), text: 'ignored: README.md is a file', version: 1 }
    ]
  });
  assert.equal(first.fileCount, 2);
  assert.equal(first.entries.src.type, 'directory');
  assert.equal(first.entries['README.md'].size, 9);
  assert.equal(first.entries['README.md/child'], undefined);
  const forward = await captureContent(root, store, {
    openDocuments: () => [
      { path: path.join(root, 'a'), text: 'a alone', version: 1 },
      { path: path.join(root, 'a', 'b'), text: 'child of a file', version: 2 }
    ]
  });
  assert.equal(forward.entries.a.type, 'file');
  assert.deepEqual(await store.read(forward.entries.a.hash), Buffer.from('a alone'));
  assert.equal(forward.entries['a/b'], undefined);
  const reverse = await captureContent(root, store, {
    openDocuments: () => [
      { path: path.join(root, 'a', 'b'), text: 'child wins', version: 1 },
      { path: path.join(root, 'a'), text: 'a alone', version: 1 }
    ]
  });
  assert.equal(reverse.entries.a.type, 'directory');
  assert.equal(reverse.entries['a/b'].type, 'file');
  assert.deepEqual(await store.read(reverse.entries['a/b'].hash), Buffer.from('child wins'));
});

test('capture-only guard is carried into every store.put and the existing-blob return', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seed(root);
  const live = { value: true };
  const guard = () => { if (!live.value) { throw new Error('capture revoked'); } };
  class Early extends ContentStore {
    put(bytes, authorize) { live.value = false; return super.put(bytes, authorize); }
  }
  const early = new Early(path.join(root, 'early'));
  await assert.rejects(captureContent(root, early, { guard }), { message: /capture revoked/ });
  assert.deepEqual(await fs.readdir(path.join(early.directory, 'blobs')).catch(() => []), []);
  live.value = true;
  class Late extends ContentStore {
    async put(bytes, authorize) { const hash = await super.put(bytes, authorize); live.value = false; return hash; }
  }
  await assert.rejects(captureContent(root, new Late(path.join(root, 'late')), { guard }), { message: /capture revoked/ });
  live.value = true;
  class RevokeHas extends ContentStore {
    constructor(dir) { super(dir); this.lookups = 0; }
    async has(hash) { this.lookups += 1; const present = await super.has(hash); if (this.lookups === 2) { live.value = false; } return present; }
  }
  const s = new RevokeHas(path.join(root, 'store'));
  const first = await s.put(Buffer.from('existing bytes'));
  assert.equal(first, sha256('existing bytes'));
  await assert.rejects(s.put(Buffer.from('existing bytes'), guard), { message: /capture revoked/ });
});

test('limits are exact at their bounds; over-default limits and oversized editor overrides reject', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 10; i += 1) {
    await fs.writeFile(path.join(root, `f${i}.txt`), '12345');
  }
  const store = new ContentStore(path.join(root, 'store'));
  const atLimit = await captureContent(root, store, { limits: { maxFiles: 10 } });
  assert.equal(atLimit.fileCount, 10);
  await fs.writeFile(path.join(root, 'f10.txt'), '12345');
  await assert.rejects(captureContent(root, store, { limits: { maxFiles: 10 } }), { code: 'snapshot_capacity', message: /maxFiles/ });
  await assert.rejects(captureContent(root, store, { maxAttempts: 4 }), { code: 'invalid_capture_limits' });
  await assert.rejects(captureContent(root, store, { limits: { maxAttempts: 4 } }), { code: 'invalid_capture_limits' });
  for (const over of [{ maxFiles: 10001 }, { maxFileBytes: 32 * 1024 * 1024 + 1 }, { maxTotalBytes: 512 * 1024 * 1024 + 1 }, { maxEntries: 20001 }]) {
    await assert.rejects(captureContent(root, store, { limits: over }), { code: 'invalid_capture_limits' });
  }
  await fs.writeFile(path.join(root, 'small.txt'), 'abc');
  await assert.rejects(captureContent(root, store, {
    limits: { maxFileBytes: 5 },
    openDocuments: () => [{ path: path.join(root, 'small.txt'), text: '0123456789', version: 1 }]
  }), { code: 'snapshot_capacity', message: /maxFileBytes/ });
});

// ---------------------------------------------------------------------------
// Executable mode metadata (bounded prerequisite for mode-faithful runners).
// ---------------------------------------------------------------------------

test('captured files record executable mode metadata and never transcode bytes', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const posix = process.platform !== 'win32';
  await fs.writeFile(path.join(root, 'plain.txt'), 'plain');
  await fs.writeFile(path.join(root, 'tool.sh'), '#!/bin/sh\necho hi\n');
  if (posix) {
    await fs.chmod(path.join(root, 'tool.sh'), 0o755);
  }
  // A BOM + CRLF document proves mode metadata is added without touching the
  // captured bytes (raw bytes already preserve encodings).
  const bomCrlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]);
  await fs.writeFile(path.join(root, 'bom.txt'), bomCrlf);
  const store = new ContentStore(path.join(root, 'store'));
  const manifest = await captureContent(root, store);
  assert.equal(manifest.entries['plain.txt'].mode, DEFAULT_FILE_MODE);
  // Windows has no POSIX execute bits, so a disk capture is never executable.
  assert.equal(manifest.entries['tool.sh'].mode, posix ? EXECUTABLE_FILE_MODE : DEFAULT_FILE_MODE);
  assert.equal(manifest.entries['bom.txt'].hash, sha256(bomCrlf));
  assert.equal(manifest.entries['bom.txt'].mode, DEFAULT_FILE_MODE);
  assert.deepEqual(await store.read(manifest.entries['bom.txt'].hash), bomCrlf);
  // Every captured file entry carries an explicit mode; legacy manifests omit it.
  for (const entry of Object.values(manifest.entries)) {
    if (entry.type === 'file') {
      assert.equal(isFileMode(entry.mode), true);
    }
  }
});

test('editor overrides preserve the underlying mode; editor-only files use the default', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const posix = process.platform !== 'win32';
  await fs.writeFile(path.join(root, 'script.sh'), 'disk script');
  if (posix) {
    await fs.chmod(path.join(root, 'script.sh'), 0o755);
  }
  const store = new ContentStore(path.join(root, 'store'));
  const documents = [
    { path: path.join(root, 'script.sh'), text: 'unsaved script', version: 2 },
    { path: path.join(root, 'notes', 'new.txt'), text: 'new doc', version: 1 }
  ];
  const manifest = await captureContent(root, store, { openDocuments: () => documents });
  assert.equal(manifest.entries['script.sh'].mode, posix ? EXECUTABLE_FILE_MODE : DEFAULT_FILE_MODE, 'override keeps the underlying mode');
  assert.deepEqual(await store.read(manifest.entries['script.sh'].hash), Buffer.from('unsaved script'));
  assert.equal(manifest.entries['notes/new.txt'].mode, DEFAULT_FILE_MODE, 'editor-only file uses the documented default');
});

test('a caller-supplied mode (Git index) is validated and wins over the disk mode', async t => {
  const root = await createRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'tool.sh'), 'tool');
  await fs.writeFile(path.join(root, 'other.txt'), 'other');
  const store = new ContentStore(path.join(root, 'store'));
  // Supplying 0o755 for a disk file without execute bits models a
  // core.fileMode=false checkout: the recorded metadata is still faithful.
  const supplied = await captureContent(root, store, {
    fileMode: key => (key === 'tool.sh' ? EXECUTABLE_FILE_MODE : undefined)
  });
  assert.equal(supplied.entries['tool.sh'].mode, EXECUTABLE_FILE_MODE);
  assert.equal(supplied.entries['other.txt'].mode, DEFAULT_FILE_MODE);
  await assert.rejects(captureContent(root, store, { fileMode: () => 0o600 }), { code: 'invalid_capture_mode' });
});

test('legacy entries without mode resolve to the documented 0o644 default', () => {
  assert.equal(DEFAULT_FILE_MODE, 0o644);
  assert.equal(EXECUTABLE_FILE_MODE, 0o755);
  assert.equal(fileModeOf({ type: 'file', hash: sha256('legacy'), size: 6 }), DEFAULT_FILE_MODE);
  assert.equal(fileModeOf({ type: 'file', hash: sha256('legacy'), size: 6, mode: 0o755 }), EXECUTABLE_FILE_MODE);
  assert.equal(isFileMode(0o644), true);
  assert.equal(isFileMode(0o755), true);
  for (const invalid of [0o600, 0o777, 420.5, '644', null]) {
    assert.equal(isFileMode(invalid), false);
  }
});

test('POSIX permission bits map to the recorded executable mode', () => {
  // Typical stat() modes: the file-type bits are ignored and ANY owner/group/
  // other execute bit makes the file executable (deterministic on every host).
  for (const [bits, expected] of [
    [0o100644, DEFAULT_FILE_MODE],
    [0o100600, DEFAULT_FILE_MODE],
    [0o100664, DEFAULT_FILE_MODE],
    [0o100755, EXECUTABLE_FILE_MODE],
    [0o100700, EXECUTABLE_FILE_MODE],
    [0o100744, EXECUTABLE_FILE_MODE],
    [0o100070, EXECUTABLE_FILE_MODE],
    [0o100007, EXECUTABLE_FILE_MODE],
    [0o100000, DEFAULT_FILE_MODE],
    [0o644, DEFAULT_FILE_MODE],
    [0o755, EXECUTABLE_FILE_MODE]
  ]) {
    assert.equal(fileModeFromPermissions(bits), expected, `mode ${bits.toString(8)}`);
  }
});
