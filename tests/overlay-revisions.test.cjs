// Focused coverage for optional executable mode metadata in overlay revisions:
// parsing, legacy entries without a mode, and a full loadRevisionTree roundtrip.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const { parseOverlayRevision, loadRevisionTree } = require(path.join(buildDir, 'overlay-revisions'));
const { ContentStore, fileModeOf } = require(path.join(buildDir, 'snapshot-content'));

const hex = character => character.repeat(64);
const overlayId = hex('a');
const revisionBytes = (changes, revision = 1, parent = null) => Buffer.from(JSON.stringify({
  schema: 1, overlayId, parent, revision, changes
}), 'utf8');

test('overlay changes accept mode metadata on files only and keep legacy entries', () => {
  const executable = parseOverlayRevision(revisionBytes({
    'bin/tool.sh': { type: 'file', hash: hex('b'), size: 4, mode: 0o755 }
  }));
  assert.equal(executable.changes['bin/tool.sh'].mode, 0o755);

  // Legacy revisions: an absent mode is valid and reads as the documented
  // 0o644 default, so previously persisted overlays still load unchanged.
  const legacy = parseOverlayRevision(revisionBytes({
    'a.txt': { type: 'file', hash: hex('c'), size: 1 }
  }));
  assert.equal(legacy.changes['a.txt'].mode, undefined);
  assert.equal(fileModeOf(legacy.changes['a.txt']), 0o644);

  // Tombstones and directories are unchanged.
  assert.equal(parseOverlayRevision(revisionBytes({ 'a.txt': null })).changes['a.txt'], null);
  assert.equal(parseOverlayRevision(revisionBytes({ d: { type: 'directory' } })).changes.d.type, 'directory');

  // A directory change may never carry a mode.
  assert.throws(() => parseOverlayRevision(revisionBytes({ d: { type: 'directory', mode: 0o755 } })), { code: 'isolation_corrupt' });
  // Files reject any mode other than the two recorded values.
  for (const bad of [0o600, 0o777, '755', null, true]) {
    assert.throws(() => parseOverlayRevision(revisionBytes({
      'bin/tool.sh': { type: 'file', hash: hex('b'), size: 4, mode: bad }
    })), { code: 'isolation_corrupt' }, `mode ${String(bad)} must be rejected`);
  }
});

test('mode metadata roundtrips through loadRevisionTree, writes and renames', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-mode-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new ContentStore(path.join(base, 'store'));
  const manifest = {
    schema: 1,
    root: '/workspace/demo',
    capturedAt: new Date().toISOString(),
    fingerprint: hex('d'),
    fileCount: 2,
    totalBytes: 3,
    entries: {
      bin: { type: 'directory' },
      'bin/tool.sh': { type: 'file', hash: hex('b'), size: 2, mode: 0o755 },
      'legacy.txt': { type: 'file', hash: hex('c'), size: 1 }
    }
  };
  const head = await store.put(revisionBytes({
    'bin/tool.sh': { type: 'file', hash: hex('e'), size: 3, mode: 0o755 },
    'legacy.txt': { type: 'file', hash: hex('f'), size: 2 }
  }));
  const first = await loadRevisionTree(store, manifest, overlayId, head, 1, () => undefined);
  assert.equal(first.tree.stat('bin/tool.sh').mode, 0o755, 'persisted mode survives loading');
  assert.deepEqual(first.tree.stat('legacy.txt'), { type: 'file', hash: hex('f'), size: 2 }, 'legacy entry keeps its exact shape');
  assert.equal(fileModeOf(first.tree.stat('legacy.txt')), 0o644);
  assert.equal(first.marks.has(hex('e')), true, 'mode metadata does not change revision marks');

  // A planner delta carries the executable bit through a second revision.
  const delta = {
    ...first.tree.write('bin/new.sh', hex('e'), 3, 'new', 0o755),
    ...first.tree.rename('bin/tool.sh', 'bin/copy.sh', hex('e'))
  };
  const head2 = await store.put(revisionBytes(delta, 2, head));
  const chain = await loadRevisionTree(store, manifest, overlayId, head2, 2, () => undefined);
  assert.equal(chain.tree.stat('bin/new.sh').mode, 0o755, 'new executable file keeps its mode');
  assert.equal(chain.tree.stat('bin/copy.sh').mode, 0o755, 'rename preserves the recorded mode');
  assert.equal(chain.tree.stat('bin/tool.sh'), undefined);

  // History stays immutable: the first head still reports the original mode.
  const replay = await loadRevisionTree(store, manifest, overlayId, head, 1, () => undefined);
  assert.equal(replay.tree.stat('bin/tool.sh').mode, 0o755);
  assert.equal(replay.tree.stat('bin/new.sh'), undefined);
});
