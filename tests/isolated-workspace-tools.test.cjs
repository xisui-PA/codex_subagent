const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');

// Loader: CODEX_TEST_BUILD env first, otherwise the normal freshly compiled build.
function loadBuildDir() {
  const dir = process.env.CODEX_TEST_BUILD?.trim() || '.test-build';
  return path.join(__dirname, '..', dir);
}

const buildDir = loadBuildDir();
const { IsolatedWorkspaceTools } = require(path.join(buildDir, 'isolated-workspace-tools'));
const { revisionState } = require(path.join(buildDir, 'overlay-revisions'));
const { LayeredTree } = require(path.join(buildDir, 'layered-tree'));
const { WorkerError } = require(path.join(buildDir, 'types'));

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaStr = s => sha(Buffer.from(s, 'utf8'));
const BOM = '\uFEFF';
const abortSignal = () => new AbortController().signal;

/**
 * In-memory IsolatedViewPort double: REAL LayeredTree + revisionState, bytes
 * keyed by raw SHA-256. Not a persistence or integration claim; it exercises
 * adapter routing, identity capture and the revisionState contract.
 */
class PortDouble {
  constructor(root, baseEntries) {
    this.root = root;
    this.baseEntries = baseEntries;
    this.chains = new Map();
    this.map = new Map();
    this.puts = 0;
    this.calls = [];
    this.corruptNextRead = false;
  }

  stateFor(key) {
    const chain = this.chains.get(key) ?? [];
    // Deltas are stored oldest-first; LayeredTree applies them in order.
    const deltas = chain.map(record => record.changes);
    const tree = new LayeredTree(this.root, this.baseEntries, deltas, { caseInsensitive: true });
    const self = this;
    return {
      tree,
      revision: chain.length,
      state: revisionState(tree, chain.length, async hash => {
        if (self.corruptNextRead) {
          self.corruptNextRead = false;
          return Buffer.from('corrupt-bytes-that-do-not-match');
        }
        const bytes = self.map.get(hash);
        if (bytes === undefined) {
          throw new WorkerError('snapshot_content_missing', `no content for ${hash}`);
        }
        return bytes;
      }, () => undefined)
    };
  }

  async withView(binding, identity, action, authorize) {
    this.calls.push({ op: 'withView', binding, identity });
    authorize?.();
    const view = this.stateFor(this.keyOf(binding));
    return action(view.state, authorize);
  }

  async edit(binding, identity, planner, authorize) {
    this.calls.push({ op: 'edit', binding, identity });
    const key = this.keyOf(binding);
    const view = this.stateFor(key);
    const put = async bytes => {
      const copy = Buffer.from(bytes);
      const hash = sha(copy);
      this.map.set(hash, copy);
      this.puts += 1;
      return hash;
    };
    authorize?.();
    const delta = await planner(view.state, put);
    authorize?.();
    if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) {
      throw new WorkerError('isolation_corrupt', 'planner did not return a delta');
    }
    const chain = this.chains.get(key) ?? [];
    chain.push({ changes: delta, revision: chain.length + 1 });
    this.chains.set(key, chain);
    return { revision: chain.length };
  }

  async seal() {
    throw new WorkerError('unavailable', 'seal is outside this adapter assignment');
  }

  async status(binding, identity) {
    this.calls.push({ op: 'status', binding, identity });
    throw new WorkerError('unavailable', 'status is outside this adapter assignment');
  }

  keyOf(binding) {
    return `${binding.teamId}:${binding.snapshotId}:${binding.overlayId}`;
  }
}

const rootA = 'C:\\work\\demo';
const mainContent = 'main file content';
const notesContent = 'notes content';
const gitContent = 'git config';
const baseA = {
  'src': { type: 'directory' },
  'src/main.ts': { type: 'file', hash: shaStr(mainContent), size: mainContent.length },
  'notes.md': { type: 'file', hash: shaStr(notesContent), size: notesContent.length },
  '.git': { type: 'directory' },
  '.git/config': { type: 'file', hash: shaStr(gitContent), size: gitContent.length }
};
const bindA = { teamId: 'a'.repeat(32), snapshotId: 'b'.repeat(64), overlayId: 'c'.repeat(64) };
const identityA = { ownerId: 'owner-1', workerId: 'd'.repeat(32), workerCreatedAt: '2026-01-01T00:00:00.000Z' };

function makeTools(port, overrides = {}) {
  return new IsolatedWorkspaceTools(
    rootA,
    port,
    overrides.binding ?? bindA,
    overrides.identity ?? identityA,
    overrides.permission ?? 'workspace-write',
    {
      canWrite: overrides.canWrite ?? (() => true),
      guard: overrides.guard
    }
  );
}

/** Create a port with baseA and populate the bytes map so reads verify. */
function portWithBaseA(root) {
  const port = new PortDouble(root ?? rootA, structuredClone(baseA));
  port.map.set(shaStr(mainContent), Buffer.from(mainContent, 'utf8'));
  port.map.set(shaStr(notesContent), Buffer.from(notesContent, 'utf8'));
  port.map.set(shaStr(gitContent), Buffer.from(gitContent, 'utf8'));
  return port;
}

async function makeTempMain() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-wt-'));
  const file = path.join(dir, 'main.ts');
  return { dir, file };
}

test('case 1: stable read/hash/list/search after actual main-file mutation', async () => {
  const crlfText = BOM + 'alpha line\r\nbeta line\r\ngamma line';
  const port = new PortDouble(rootA, {
    'main.ts': { type: 'file', hash: shaStr(crlfText), size: Buffer.byteLength(crlfText, 'utf8') },
    'readme.txt': { type: 'file', hash: shaStr('stable'), size: 6 }
  });
  port.map.set(shaStr(crlfText), Buffer.from(crlfText, 'utf8'));
  port.map.set(shaStr('stable'), Buffer.from('stable', 'utf8'));
  const tools = makeTools(port);
  const { dir, file } = await makeTempMain();
  try {
    await fs.writeFile(file, 'ORIGINAL');
    const read = JSON.parse(await tools.execute('read_file', { path: 'main.ts' }, 'workspace-write', abortSignal()));
    // Full raw SHA-256 includes the BOM bytes; decode keeps the BOM in text.
    assert.equal(read.hash, shaStr(crlfText));
    assert.equal(read.lineEndings, 'crlf');
    assert.equal(read.revision, 0);
    assert.ok(read.content.startsWith(BOM + 'alpha line'));

    await fs.writeFile(file, 'MUTATED-MAIN-CONTENT');

    const reread = JSON.parse(await tools.execute('read_file', { path: 'main.ts' }, 'workspace-write', abortSignal()));
    assert.equal(reread.hash, shaStr(crlfText));
    assert.ok(reread.content.startsWith(BOM + 'alpha line'));
    assert.ok(!reread.content.includes('MUTATED'));
    const listing = JSON.parse(await tools.execute('list_files', { path: '.' }, 'workspace-write', abortSignal()));
    assert.deepEqual(listing.entries.map(entry => entry.name).sort(), ['main.ts', 'readme.txt']);
    const search = JSON.parse(await tools.execute('search_files', { query: 'beta line' }, 'workspace-write', abortSignal()));
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].path, 'main.ts');
    assert.equal(search.results[0].line, 2);
    assert.equal(search.visited, 3); // root + 2 files
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('case 2: mutations update one merged view; virtual base and another port are unchanged', async () => {
  const baseText = 'line one\r\nline two';
  const otherText = 'other base';
  const port = new PortDouble(rootA, {
    'src': { type: 'directory' },
    'src/main.ts': { type: 'file', hash: shaStr(baseText), size: Buffer.byteLength(baseText, 'utf8') },
    'other.txt': { type: 'file', hash: shaStr(otherText), size: otherText.length }
  });
  port.map.set(shaStr(baseText), Buffer.from(baseText, 'utf8'));
  port.map.set(shaStr(otherText), Buffer.from(otherText, 'utf8'));
  const readOnlyPort = portWithBaseA();
  const tools = makeTools(port);
  const readTools = makeTools(readOnlyPort, { permission: 'read-only', binding: { teamId: 'e'.repeat(32), snapshotId: 'f'.repeat(64), overlayId: '0'.repeat(64) } });

  const written = JSON.parse(await tools.execute('write_file', { path: 'src/new.txt', content: 'created', expectedHash: 'new' }, 'workspace-write', abortSignal()));
  assert.equal(written.revision, 1);
  assert.equal(written.hash, shaStr('created'));
  const patched = JSON.parse(await tools.execute('patch_file', { path: 'src/main.ts', expectedHash: shaStr(baseText), oldText: 'line one', newText: 'line ONE' }, 'workspace-write', abortSignal()));
  assert.equal(patched.revision, 2);
  const renamed = JSON.parse(await tools.execute('rename_file', { path: 'other.txt', target: 'src/moved.txt', expectedHash: shaStr(otherText) }, 'workspace-write', abortSignal()));
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.target, 'src/moved.txt');
  await tools.execute('delete_file', { path: 'src/moved.txt', expectedHash: shaStr(otherText) }, 'workspace-write', abortSignal());

  const listing = JSON.parse(await tools.execute('list_files', { path: '.' }, 'workspace-write', abortSignal()));
  assert.deepEqual(listing.entries.map(entry => entry.name), ['src']);
  const srcListing = JSON.parse(await tools.execute('list_files', { path: 'src' }, 'workspace-write', abortSignal()));
  assert.deepEqual(srcListing.entries.map(entry => entry.name).sort(), ['main.ts', 'new.txt']);
  const search = JSON.parse(await tools.execute('search_files', { query: 'line ONE' }, 'workspace-write', abortSignal()));
  assert.deepEqual(search.results.map(result => result.path), ['src/main.ts']);

  // The virtual base records were never mutated (all changes live in deltas).
  assert.deepEqual(port.baseEntries, {
    'src': { type: 'directory' },
    'src/main.ts': { type: 'file', hash: shaStr(baseText), size: Buffer.byteLength(baseText, 'utf8') },
    'other.txt': { type: 'file', hash: shaStr(otherText), size: otherText.length }
  });

  // The second port sees neither the mutations nor the puts.
  assert.equal(port.puts, 2);
  const otherList = JSON.parse(await readTools.execute('list_files', { path: '.' }, 'read-only', abortSignal()));
  assert.deepEqual(otherList.entries.map(entry => entry.name).sort(), ['.git', 'notes.md', 'src']);
  assert.equal(readOnlyPort.puts, 0);
  const otherSearch = JSON.parse(await readTools.execute('search_files', { query: 'line one' }, 'read-only', abortSignal()));
  assert.equal(otherSearch.results.length, 0);
});

test('case 3: stale hashes and expectedHash=new conflicts reject before any put', async () => {
  const fileContent = 'abcde';
  const realHash = shaStr(fileContent);
  const port = new PortDouble(rootA, {
    'x.txt': { type: 'file', hash: realHash, size: fileContent.length }
  });
  port.map.set(realHash, Buffer.from(fileContent, 'utf8'));
  const tools = makeTools(port);
  const wrongHash = '2'.repeat(64);

  // All rejects must happen before any private content is added.
  await assert.rejects(
    tools.execute('write_file', { path: 'x.txt', content: 'zzz', expectedHash: wrongHash }, 'workspace-write', abortSignal()),
    { code: 'stale_hash' }
  );
  await assert.rejects(
    tools.execute('patch_file', { path: 'x.txt', expectedHash: wrongHash, oldText: 'abc', newText: 'a' }, 'workspace-write', abortSignal()),
    { code: 'stale_hash' }
  );
  await assert.rejects(
    tools.execute('write_file', { path: 'x.txt', content: 'zzz', expectedHash: 'new' }, 'workspace-write', abortSignal()),
    { code: 'path_conflict' }
  );
  await assert.rejects(
    tools.execute('write_file', { path: 'missing.txt', content: 'zzz', expectedHash: wrongHash }, 'workspace-write', abortSignal()),
    { code: 'stale_hash' }
  );
  assert.equal(port.puts, 0);
  assert.equal(port.chains.size, 0);

  const ok = JSON.parse(await tools.execute('write_file', { path: 'x.txt', content: 'abcde-replaced', expectedHash: realHash }, 'workspace-write', abortSignal()));
  assert.equal(ok.revision, 1);
  assert.equal(port.puts, 1);
});

test('case 4: CRLF patch from LF multiline query preserves CRLF, BOM and raw hash', async () => {
  const base = BOM + 'first\r\nsecond\r\nthird';
  const port = new PortDouble(rootA, {
    'crlf.txt': { type: 'file', hash: shaStr(base), size: Buffer.byteLength(base, 'utf8') }
  });
  port.map.set(shaStr(base), Buffer.from(base, 'utf8'));
  const tools = makeTools(port);

  const before = JSON.parse(await tools.execute('read_file', { path: 'crlf.txt' }, 'workspace-write', abortSignal()));
  assert.equal(before.lineEndings, 'crlf');
  assert.equal(before.hash, shaStr(base));
  // decode with ignoreBOM keeps the BOM in the returned text; the hash covers
  // the raw bytes including the BOM.
  assert.ok(before.content.startsWith(BOM + 'first'));

  const result = JSON.parse(await tools.execute('patch_file', {
    path: 'crlf.txt',
    expectedHash: shaStr(base),
    oldText: 'first\nsecond',
    newText: 'first!\nSECOND'
  }, 'workspace-write', abortSignal()));
  assert.equal(result.revision, 1);
  assert.equal(result.lineEndings, 'crlf');
  // BOM is retained (decode kept it in the patched text, so the new raw hash
  // still covers the BOM bytes).
  const expectedAfter = BOM + 'first!\r\nSECOND\r\nthird';
  assert.equal(result.hash, shaStr(expectedAfter));

  const after = JSON.parse(await tools.execute('read_file', { path: 'crlf.txt' }, 'workspace-write', abortSignal()));
  assert.equal(after.hash, shaStr(expectedAfter));
  assert.ok(after.content.startsWith(BOM + 'first!'));
  assert.ok(after.content.includes('first!\r\nSECOND\r\nthird'));

  // An LF file accepts a CRLF query via the same normalization path.
  const lfBase = 'alpha\nbeta';
  const lfPort = new PortDouble(rootA, { 'lf.txt': { type: 'file', hash: shaStr(lfBase), size: lfBase.length } });
  lfPort.map.set(shaStr(lfBase), Buffer.from(lfBase, 'utf8'));
  const lfTools = makeTools(lfPort);
  const lfResult = JSON.parse(await lfTools.execute('patch_file', {
    path: 'lf.txt',
    expectedHash: shaStr(lfBase),
    oldText: 'alpha\r\nbeta',
    newText: 'ALPHA\r\nbeta'
  }, 'workspace-write', abortSignal()));
  assert.equal(lfResult.lineEndings, 'lf');
  assert.equal(lfResult.hash, shaStr('ALPHA\nbeta'));
});

test('case 5: mixed endings require exact match; overlapping matches reject', async () => {
  const mixed = 'start\r\nmid\nend';
  const crlfOnly = 'start\r\nmid\r\nend';
  const repeats = 'xx\ntop\nxx';
  const port = new PortDouble(rootA, {
    'mixed.txt': { type: 'file', hash: shaStr(mixed), size: Buffer.byteLength(mixed, 'utf8') },
    'crlf.txt': { type: 'file', hash: shaStr(crlfOnly), size: Buffer.byteLength(crlfOnly, 'utf8') },
    'repeat.txt': { type: 'file', hash: shaStr(repeats), size: Buffer.byteLength(repeats, 'utf8') }
  });
  port.map.set(shaStr(mixed), Buffer.from(mixed, 'utf8'));
  port.map.set(shaStr(crlfOnly), Buffer.from(crlfOnly, 'utf8'));
  port.map.set(shaStr(repeats), Buffer.from(repeats, 'utf8'));
  const tools = makeTools(port);
  const lfQuery = 'start\nmid';

  // Mixed file: the LF multiline query does not match exactly.
  await assert.rejects(
    tools.execute('patch_file', { path: 'mixed.txt', expectedHash: shaStr(mixed), oldText: lfQuery, newText: 'X' }, 'workspace-write', abortSignal()),
    { code: 'patch_conflict' }
  );
  // The exact mixed query is accepted (proves mixed requires exact match).
  const exact = JSON.parse(await tools.execute('patch_file', { path: 'mixed.txt', expectedHash: shaStr(mixed), oldText: 'start\r\nmid', newText: 'START' }, 'workspace-write', abortSignal()));
  // After replacing the CRLF portion, the remaining \n makes it lf.
  assert.equal(exact.lineEndings, 'lf');
  // Uniform CRLF file accepts the LF query through normalization.
  const normalized = JSON.parse(await tools.execute('patch_file', { path: 'crlf.txt', expectedHash: shaStr(crlfOnly), oldText: lfQuery, newText: 'ONE' }, 'workspace-write', abortSignal()));
  assert.equal(normalized.lineEndings, 'crlf');
  // Multiple occurrences must fail, never patch the first.
  await assert.rejects(
    tools.execute('patch_file', { path: 'repeat.txt', expectedHash: shaStr(repeats), oldText: 'xx', newText: 'y' }, 'workspace-write', abortSignal()),
    { code: 'patch_conflict' }
  );
  assert.equal(port.puts, 2);
});

test('case 6: binary/oversized search is skipped with counts; missing/corrupt content throws', async () => {
  const valid = 'CODEXPROBE here';
  const oversized = Buffer.alloc(2_100_000, 97);
  const binary = Buffer.from([0x42, 0x43, 0x00, 0x80, 0xC3, 0x28]);
  const port = new PortDouble('C:\\work\\search', {
    'ok.txt': { type: 'file', hash: shaStr(valid), size: valid.length },
    'big.bin': { type: 'file', hash: sha(oversized), size: oversized.length },
    'bin.dat': { type: 'file', hash: sha(binary), size: binary.length }
  });
  port.map.set(shaStr(valid), Buffer.from(valid, 'utf8'));
  port.map.set(sha(oversized), oversized);
  port.map.set(sha(binary), binary);
  const tools = new IsolatedWorkspaceTools(
    'C:\\work\\search',
    port,
    bindA,
    identityA,
    'workspace-write',
    { canWrite: () => true }
  );

  const search = JSON.parse(await tools.execute('search_files', { query: 'CODEXPROBE' }, 'workspace-write', abortSignal()));
  assert.deepEqual(search.results.map(result => result.path), ['ok.txt']);
  assert.equal(search.skipped.binaryOrOversized, 2);
  assert.equal(search.visited, 4); // root + 3 files

  await assert.rejects(
    tools.execute('read_file', { path: 'bin.dat' }, 'workspace-write', abortSignal()),
    { code: 'file_limit' }
  );
  await assert.rejects(
    tools.execute('read_file', { path: 'nope.txt' }, 'workspace-write', abortSignal()),
    { code: 'not_found' }
  );
  // Corrupt stored bytes (hash mismatch) must surface as an error, never a skip.
  port.corruptNextRead = true;
  await assert.rejects(
    tools.execute('read_file', { path: 'ok.txt' }, 'workspace-write', abortSignal()),
    { code: 'snapshot_content_missing' }
  );
  port.corruptNextRead = true;
  await assert.rejects(
    tools.execute('search_files', { query: 'CODEXPROBE' }, 'workspace-write', abortSignal()),
    { code: 'snapshot_content_missing' }
  );
  // Missing content entirely is also an error.
  port.map.delete(shaStr(valid));
  await assert.rejects(
    tools.execute('search_files', { query: 'CODEXPROBE' }, 'workspace-write', abortSignal()),
    { code: 'snapshot_content_missing' }
  );
  assert.equal(port.puts, 0);
});

test('case 7: run_command is always unavailable; bound permission and live guards block writes', async () => {
  const port = portWithBaseA();
  const signal = abortSignal();
  let error = null;
  try {
    await makeTools(port).execute('run_command', { command: 'dir' }, 'workspace-write', signal);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof WorkerError, 'run_command must throw');
  assert.equal(error.code, 'isolated_shell_unavailable');
  assert.equal(port.puts, 0);
  // Read-only bound permission: writes are refused even for a workspace-write request.
  const readonlyTools = makeTools(port, { permission: 'read-only' });
  await assert.rejects(
    readonlyTools.execute('write_file', { path: 'src/new.txt', content: 'x', expectedHash: 'new' }, 'workspace-write', signal),
    { code: 'permission_denied' }
  );
  assert.equal(port.puts, 0);
  assert.equal(port.chains.size, 0);
  const definitionNames = readonlyTools.definitions('workspace-write').map(tool => tool.name);
  assert.ok(!definitionNames.includes('write_file'), 'read-only definitions must hide mutations');
  assert.ok(definitionNames.includes('run_command'), 'shell stays visible but unavailable');

  // Live canWrite gate: revoking between construction and execution blocks the write.
  let writable = true;
  const liveTools = makeTools(port, { canWrite: () => writable });
  const ok = JSON.parse(await liveTools.execute('write_file', { path: 'src/live.txt', content: 'ok', expectedHash: 'new' }, 'workspace-write', signal));
  assert.equal(ok.revision, 1);
  writable = false;
  await assert.rejects(
    liveTools.execute('write_file', { path: 'src/second.txt', content: 'no', expectedHash: 'new' }, 'workspace-write', signal),
    { code: 'permission_denied' }
  );
  assert.equal(port.puts, 1);

  // Live option guard aborts before any state change.
  const gatedTools = makeTools(port, { guard: () => { throw new WorkerError('host_stopping', 'draining'); } });
  await assert.rejects(gatedTools.execute('read_file', { path: '.' }, 'workspace-write', signal), { code: 'host_stopping' });
});

test('case 8: constructor identity cannot be spoofed; protected paths and traversal fail through the tree', async () => {
  const port = portWithBaseA();
  const tools = makeTools(port);
  const spoofedSession = {
    id: 'e'.repeat(32), ownerId: 'spoofed-owner', workspaceRoot: 'C:\\evil',
    permission: 'workspace-write'
  };

  await tools.execute('read_file', { path: 'src/main.ts' }, 'workspace-write', abortSignal(), spoofedSession);
  const last = port.calls[port.calls.length - 1];
  assert.deepEqual(last.identity, identityA, 'the port must receive the constructor-bound identity, never session input');
  assert.deepEqual(last.binding, bindA, 'the port must receive the constructor-bound binding');

  const readResult = JSON.parse(await tools.execute('read_file', { path: 'src/main.ts' }, 'workspace-write', abortSignal(), spoofedSession));
  assert.equal(readResult.revision, 0);
  assert.equal(readResult.hash, shaStr(mainContent));
  assert.equal(port.puts, 0);

  // Traversal and foreign absolute paths are refused through the tree.
  await assert.rejects(
    tools.execute('write_file', { path: '../escape.txt', content: 'x', expectedHash: 'new' }, 'workspace-write', abortSignal(), spoofedSession),
    { code: 'invalid_path' }
  );
  await assert.rejects(
    tools.execute('write_file', { path: 'C:\\evil\\file.txt', content: 'x', expectedHash: 'new' }, 'workspace-write', abortSignal(), spoofedSession),
    { code: 'invalid_path' }
  );
  // Windows-cased alias of an existing parent still resolves.
  const cased = JSON.parse(await tools.execute('list_files', { path: 'SRC' }, 'workspace-write', abortSignal(), spoofedSession));
  assert.deepEqual(cased.entries.map(entry => entry.name), ['main.ts']);
  // Protected configuration paths are refused even when readable in the base.
  await assert.rejects(
    tools.execute('write_file', { path: '.git/config', content: 'x', expectedHash: shaStr(gitContent) }, 'workspace-write', abortSignal(), spoofedSession),
    { code: 'protected_path' }
  );
  await assert.rejects(
    tools.execute('create_directory', { path: '.vscode/settings' }, 'workspace-write', abortSignal(), spoofedSession),
    { code: 'protected_path' }
  );
  assert.equal(port.puts, 0);
});
