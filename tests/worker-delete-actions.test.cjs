const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const pathModule = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const {
  groupWorkerTargets, manualWorkerDelete, workerDeleteChoices, workerDeleteConfirmation,
  workerDeleteReport, workerDeleteScopeFromNode, workerDeleteTargetFromNode,
  workerDeleteTargetsFromArgs, workerDeleteTargetsFromSessions, workerGroupChoices, workerGroupKey
} = require('../.test-build/worker-delete-actions');

const WS_A = 'C:\\workspace\\alpha';
const WS_B = 'C:\\workspace\\beta';
const ONE = '1'.repeat(32);
const TWO = '2'.repeat(32);
const THREE = '3'.repeat(32);
const FOUR = '4'.repeat(32);

const session = (root, id, over = {}) => ({
  workspaceRoot: root, id, state: 'completed', title: `saved ${id.slice(0, 4)}`, ...over
});
const workerNode = (root, id, over = {}) => ({ kind: 'worker', session: session(root, id, over) });
const groupNode = (root, over = {}) => ({ kind: 'group', id: 'row-group', label: 'Alpha · alpha', workspaceRoot: root, ...over });
const key = (root, id) => JSON.stringify([root, id]);

function fixture({ sessions = [], confirm = true, remove, lookup, failures = new Map() } = {}) {
  const map = new Map(sessions.map(entry => [key(entry.workspaceRoot, entry.id), entry]));
  const calls = { session: [], remove: [], confirm: [], info: [], refresh: 0 };
  const ports = {
    session: async (root, id) => {
      calls.session.push({ root, id });
      const failed = failures.get(key(root, id));
      if (failed) {
        throw failed;
      }
      if (lookup) {
        const custom = lookup(root, id);
        if (custom) {
          return custom;
        }
      }
      const found = map.get(key(root, id));
      if (!found) {
        const error = new Error(`Worker ${id} was not found in this workspace.`);
        error.code = 'not_found';
        throw error;
      }
      return found;
    },
    remove: async (root, id, ownerId) => {
      calls.remove.push({ root, id, ownerId });
      if (remove) {
        await remove({ root, id, ownerId });
      }
    },
    confirm: async (message, detail) => { calls.confirm.push({ message, detail }); return confirm; },
    info: message => { calls.info.push(message); },
    refresh: async () => { calls.refresh += 1; }
  };
  return { calls, ports, add: entry => map.set(key(entry.workspaceRoot, entry.id), entry) };
}

test('a selection containing the clicked worker deletes exactly those workers once', () => {
  const clicked = workerNode(WS_A, ONE, { ownerId: 'parent-a' });
  const targets = workerDeleteTargetsFromArgs(clicked, [
    clicked,
    workerNode(WS_A, TWO, { ownerId: 'parent-a' }),
    workerNode(WS_A, ONE),
    workerNode(WS_B, ONE, { ownerId: 'parent-b' })
  ]);
  assert.deepEqual(targets.map(target => [target.workspaceRoot, target.id]), [
    [WS_A, ONE], [WS_A, TWO], [WS_B, ONE]
  ], 'duplicate root+id targets collapse, while the same id under another root stays distinct');
});

test('a clicked worker outside the selection targets only that worker', () => {
  const targets = workerDeleteTargetsFromArgs(workerNode(WS_B, TWO), [workerNode(WS_A, ONE), workerNode(WS_A, TWO)]);
  assert.deepEqual(targets.map(target => [target.workspaceRoot, target.id]), [[WS_B, TWO]], 'previously selected unrelated workers are never swept in');
});

test('a clicked group or malformed node never expands to the selection; no clicked node uses selected workers', () => {
  const group = groupNode(WS_A, { ownerId: 'parent-a' });
  assert.deepEqual(workerDeleteTargetsFromArgs(group, [workerNode(WS_A, ONE)]), [], 'group rows are never expanded into workers');
  assert.deepEqual(workerDeleteTargetsFromArgs({ kind: 'worker', session: { id: ONE } }, [workerNode(WS_A, ONE)]), [], 'an unusable clicked node never falls back');
  assert.deepEqual(workerDeleteTargetsFromArgs(undefined, [
    workerNode(WS_A, ONE), workerNode(WS_A, ONE), workerNode(WS_B, ONE)
  ]).map(target => [target.workspaceRoot, target.id]), [[WS_A, ONE], [WS_B, ONE]], 'an explicit selection is deduplicated by root+id');
  assert.deepEqual(workerDeleteTargetsFromArgs(undefined), []);
});

test('malformed and synthetic targets and scopes never expand', () => {
  assert.equal(workerDeleteTargetFromNode({ kind: 'worker', session: { id: ONE } }), undefined, 'a worker without a root is not a target');
  assert.equal(workerDeleteTargetFromNode({ kind: 'worker', session: { workspaceRoot: WS_A, id: ONE, ownerId: 7 } }), undefined, 'a non-string owner is refused');
  assert.equal(workerDeleteTargetFromNode({ kind: 'group', workspaceRoot: WS_A, id: ONE }), undefined);
  assert.equal(workerDeleteScopeFromNode({ kind: 'group', ownerId: 'parent-a' }), undefined, 'a group without explicit root metadata is stale');
  assert.equal(workerDeleteScopeFromNode({ kind: 'group', workspaceRoot: WS_A, ownerId: 7 }), undefined);
  assert.equal(workerDeleteScopeFromNode(workerNode(WS_A, ONE)), undefined);
  assert.deepEqual(groupWorkerTargets([{ workspaceRoot: WS_A, id: ONE }], { workspaceRoot: WS_A, ownerId: 'parent-a' }), [], 'labels or synthetic owners never match');
  const dropped = workerDeleteTargetsFromSessions([
    { id: ONE, state: 'completed', workspaceRoot: WS_A },
    { id: TWO, state: 'completed' }
  ]);
  assert.deepEqual(dropped.map(target => target.id), [ONE], 'headers without a canonical root are dropped');
});

test('group targets require the exact root and owner; literal ungrouped stays separate', () => {
  const workers = [
    { workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a', ownerLabel: 'Same label' },
    { workspaceRoot: WS_A, id: TWO, ownerLabel: 'Ungrouped' },
    { workspaceRoot: WS_A, id: THREE, ownerId: 'ungrouped', ownerLabel: 'Ungrouped' },
    { workspaceRoot: WS_B, id: ONE, ownerId: 'parent-a', ownerLabel: 'Same label' }
  ];
  assert.deepEqual(groupWorkerTargets(workers, { workspaceRoot: WS_A, ownerId: 'parent-a' }).map(target => target.id), [ONE]);
  assert.deepEqual(groupWorkerTargets(workers, { workspaceRoot: WS_A }).map(target => target.id), [TWO], 'ownerless matches only the missing owner, not the literal id ungrouped');
  assert.deepEqual(groupWorkerTargets(workers, { workspaceRoot: WS_A, ownerId: 'ungrouped' }).map(target => target.id), [THREE]);
  assert.deepEqual(groupWorkerTargets(workers, { workspaceRoot: WS_B, ownerId: 'parent-a' }).map(target => target.id), [ONE]);
  assert.deepEqual(groupWorkerTargets(workers, { workspaceRoot: WS_A + '\\', ownerId: 'parent-a' }), [], 'the exact canonical root is required');
  assert.notEqual(workerGroupKey(WS_A), workerGroupKey(WS_A, 'ungrouped'));
  assert.notEqual(workerGroupKey(WS_A, 'parent-a'), workerGroupKey(WS_B, 'parent-a'));
});

test('group palette choices distinguish identical labels by their exact root and owner', () => {
  const workers = [
    { workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a', ownerLabel: 'Same' },
    { workspaceRoot: WS_B, id: TWO, ownerId: 'parent-a', ownerLabel: 'Same' },
    { workspaceRoot: WS_A, id: THREE, ownerLabel: 'Ungrouped' },
    { workspaceRoot: WS_A, id: FOUR, ownerId: 'ungrouped', ownerLabel: 'Ungrouped' }
  ];
  const choices = workerGroupChoices(workers);
  assert.equal(choices.length, 4);
  const same = choices.filter(choice => choice.label === 'Same');
  assert.deepEqual(same.map(choice => choice.scope.workspaceRoot).sort(), [WS_A, WS_B].sort());
  assert.ok(same.every(choice => choice.detail.includes(choice.scope.workspaceRoot)));
  const ungrouped = choices.filter(choice => choice.label === 'Ungrouped');
  assert.deepEqual(ungrouped.map(choice => choice.scope.ownerId), [undefined, 'ungrouped'], 'ownerless and literal ungrouped remain two groups');
  assert.deepEqual(choices.find(choice => choice.scope.ownerId === 'parent-a' && choice.scope.workspaceRoot === WS_A).scope, {
    workspaceRoot: WS_A, ownerId: 'parent-a', label: 'Same'
  });
});

test('palette choices carry state, owner and workspace context', () => {
  const choices = workerDeleteChoices([
    { workspaceRoot: WS_A, id: ONE, state: 'failed', ownerId: 'parent-a', ownerLabel: 'Manual tasks', title: 'Fix build' }
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].label, 'Fix build');
  assert.match(choices[0].description, /failed/);
  assert.match(choices[0].description, /Manual tasks/);
  assert.match(choices[0].detail, new RegExp(WS_A.replace(/\\/g, '\\\\')));
  assert.match(choices[0].detail, /parent-a/);
  assert.match(choices[0].detail, new RegExp(ONE));
});

test('confirmation names the count, exact group/root scope, item identities and permanent history loss', () => {
  const prompt = workerDeleteConfirmation([
    { workspaceRoot: WS_A, id: ONE, title: 'Fix build' }, { workspaceRoot: WS_A, id: TWO }
  ], { workspaceRoot: WS_A, ownerId: 'parent-a', label: 'Manual tasks' });
  assert.equal(prompt.message, 'Permanently delete 2 saved workers?');
  for (const text of [WS_A, 'Manual tasks', 'parent-a', 'histories', 'archives', 'permanently removed', 'Fix build', ONE]) {
    assert.ok(prompt.detail.includes(text), `confirmation identifies ${text}`);
  }
  const single = workerDeleteConfirmation([{ workspaceRoot: WS_A, id: ONE, title: 'Fix build' }]);
  assert.match(single.message, /1 saved worker\?/);
  assert.ok(single.detail.includes('Fix build'), 'a single-worker prompt keeps the title');
  assert.ok(single.detail.includes(ONE), 'a single-worker prompt keeps the exact worker id');
  assert.ok(single.detail.includes(WS_A), 'a single-worker prompt keeps the exact root');
  assert.match(workerDeleteConfirmation([{ workspaceRoot: WS_A, id: ONE }], { workspaceRoot: WS_A }).detail, /owner \(none\)/);
  const many = workerDeleteConfirmation(Array.from({ length: 8 }, (_, index) => ({ workspaceRoot: WS_A, id: String(index).padStart(32, '0') })));
  assert.match(many.detail, /and 3 more/);
});

test('mixed busy and idle selections delete only idle workers and refresh once', async () => {
  const f = fixture({ sessions: [session(WS_A, ONE), session(WS_A, TWO, { state: 'running' })] });
  const summary = await manualWorkerDelete(f.ports, {
    targets: workerDeleteTargetsFromArgs(workerNode(WS_A, ONE), [workerNode(WS_A, ONE), workerNode(WS_A, TWO)])
  });

  assert.deepEqual(summary.deleted.map(target => target.id), [ONE]);
  assert.deepEqual(summary.skipped, [{ target: { workspaceRoot: WS_A, id: TWO, title: `saved ${TWO.slice(0, 4)}`, state: 'completed' }, reason: 'busy' }]);
  assert.equal(summary.status, 'deleted');
  assert.deepEqual(f.calls.remove, [{ root: WS_A, id: ONE, ownerId: undefined }]);
  assert.equal(f.calls.session.length, 2, 'every selected worker is re-fetched after confirmation');
  assert.equal(f.calls.refresh, 1, 'one final refresh suffices');
  assert.equal(f.calls.confirm.length, 1);
  assert.match(f.calls.info[0], /Deleted 1 of 2 selected saved workers/);
  assert.match(f.calls.info[0], /1 skipped \(1 busy\)/);
});

test('cancelling the one confirmation performs zero reads, deletes and refreshes', async () => {
  const f = fixture({ sessions: [session(WS_A, ONE)], confirm: false });
  const summary = await manualWorkerDelete(f.ports, { targets: workerDeleteTargetsFromArgs(workerNode(WS_A, ONE)) });

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.confirmed, 1);
  assert.equal(f.calls.session.length, 0);
  assert.equal(f.calls.remove.length, 0);
  assert.equal(f.calls.refresh, 0);
  assert.equal(f.calls.info.length, 0);
});

test('an empty snapshot reports a clear no-op and never confirms', async () => {
  const f = fixture();
  const summary = await manualWorkerDelete(f.ports, { targets: [], unavailableMessage: 'No saved workers remain in this group.' });
  assert.equal(summary.status, 'unavailable');
  assert.equal(f.calls.confirm.length, 0);
  assert.equal(f.calls.remove.length, 0);
  assert.equal(f.calls.refresh, 0);
  assert.deepEqual(f.calls.info, ['No saved workers remain in this group.']);
});

test('state changes after selection make the fresh session authoritative', async () => {
  const f = fixture({
    sessions: [session(WS_A, ONE, { state: 'running' }), session(WS_A, TWO), session(WS_A, THREE)],
    remove: async ({ id }) => {
      if (id === TWO) {
        const error = new Error('Cancel and wait for the worker to stop before deleting it.');
        error.code = 'worker_busy';
        throw error;
      }
    }
  });
  const summary = await manualWorkerDelete(f.ports, {
    targets: [workerNode(WS_A, ONE), workerNode(WS_A, TWO), workerNode(WS_A, THREE)].map(node => node.session)
  });

  assert.deepEqual(summary.deleted.map(target => target.id), [THREE]);
  assert.deepEqual(summary.skipped.map(entry => [entry.target.id, entry.reason]), [[ONE, 'busy'], [TWO, 'busy']]);
  assert.equal(f.calls.remove.length, 2, 'a locally busy worker is never sent to the backend');
  assert.equal(f.calls.refresh, 1);
});

test('missing, busy and failing items do not stop later deletions; totals are exact', async () => {
  const f = fixture({
    sessions: [session(WS_A, ONE), session(WS_A, THREE), session(WS_A, FOUR)],
    remove: async ({ id }) => {
      if (id === ONE) {
        throw new Error('disk write failed');
      }
      if (id === THREE) {
        const error = new Error('Worker was not found in this workspace.');
        error.code = 'not_found';
        throw error;
      }
    }
  });
  const summary = await manualWorkerDelete(f.ports, {
    targets: [ONE, TWO, THREE, FOUR].map(id => ({ workspaceRoot: WS_A, id }))
  });

  assert.deepEqual(summary.deleted.map(target => target.id), [FOUR]);
  assert.deepEqual(summary.absent.map(target => target.id), [TWO, THREE]);
  assert.deepEqual(summary.failed.map(entry => entry.target.id), [ONE]);
  assert.match(summary.failed[0].message, /disk write failed/);
  assert.equal(summary.status, 'partial');
  assert.equal(f.calls.remove.length, 3, 'every target that still exists is attempted once');
  assert.equal(f.calls.refresh, 1);
  assert.match(f.calls.info[0], /Deleted 1 of 4/);
  assert.match(f.calls.info[0], /2 already missing/);
  assert.match(f.calls.info[0], /1 failed/);
  assert.equal(summary.refreshed, true);
});

test('a missing target is absent and never deleted', async () => {
  const f = fixture({ sessions: [session(WS_B, ONE)] });
  const summary = await manualWorkerDelete(f.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_B, id: ONE }]
  });
  assert.deepEqual(summary.absent, [{ workspaceRoot: WS_A, id: ONE }]);
  assert.deepEqual(summary.deleted, [{ workspaceRoot: WS_B, id: ONE }]);
  assert.deepEqual(f.calls.remove, [{ root: WS_B, id: ONE, ownerId: undefined }]);
  assert.equal(f.calls.refresh, 1);
});

test('a group deletion uses the exact root+owner and skips workers that changed owner', async () => {
  const workers = [
    { workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a', ownerLabel: 'Alpha' },
    { workspaceRoot: WS_A, id: TWO, ownerId: 'parent-a', ownerLabel: 'Alpha' },
    { workspaceRoot: WS_B, id: ONE, ownerId: 'parent-a', ownerLabel: 'Alpha' }
  ];
  const f = fixture({
    sessions: [
      session(WS_A, ONE, { ownerId: 'parent-b' }),
      session(WS_A, TWO, { ownerId: 'parent-a' })
    ]
  });
  const scope = { workspaceRoot: WS_A, ownerId: 'parent-a', label: 'Alpha' };
  const summary = await manualWorkerDelete(f.ports, { targets: groupWorkerTargets(workers, scope), scope });

  assert.deepEqual(summary.skipped, [{ target: workers[0], reason: 'identity_changed' }]);
  assert.deepEqual(summary.deleted.map(target => target.id), [TWO]);
  assert.deepEqual(f.calls.remove, [{ root: WS_A, id: TWO, ownerId: 'parent-a' }], 'the changed owner never broadens the group');
  assert.doesNotMatch(f.calls.remove.map(call => call.id).join(','), new RegExp(WS_B));
  assert.equal(f.calls.refresh, 1);
  assert.match(f.calls.info[0], /In Alpha \(C:\\workspace\\alpha\)/);
  assert.match(f.calls.info[0], /1 skipped \(1 no longer in this group\)/);
});

test('workers created after confirmation stay outside the finite snapshot', async () => {
  const list = [{ workspaceRoot: WS_A, id: ONE, state: 'completed' }];
  const targets = workerDeleteTargetsFromSessions(list);
  const f = fixture({ sessions: [session(WS_A, ONE)], confirm: true });
  const originalConfirm = f.ports.confirm;
  f.ports.confirm = async (message, detail) => {
    list.push({ workspaceRoot: WS_A, id: TWO, state: 'completed' });
    f.add(session(WS_A, TWO));
    return originalConfirm(message, detail);
  };
  const summary = await manualWorkerDelete(f.ports, { targets });
  assert.deepEqual(summary.deleted.map(target => target.id), [ONE]);
  assert.deepEqual(f.calls.remove.map(call => call.id), [ONE], 'a worker created after confirmation is never deleted');
});

test('single-worker and palette Select All flows use the same once-only confirmation', async () => {
  const single = fixture({ sessions: [session(WS_A, ONE)] });
  const one = await manualWorkerDelete(single.ports, { targets: workerDeleteTargetsFromArgs(workerNode(WS_A, ONE)) });
  assert.deepEqual(one.deleted.map(target => target.id), [ONE]);
  assert.equal(single.calls.confirm.length, 1);
  assert.equal(single.calls.refresh, 1);

  const all = fixture({ sessions: [session(WS_A, ONE), session(WS_B, TWO)] });
  const choices = workerDeleteChoices(workerDeleteTargetsFromSessions([
    { workspaceRoot: WS_A, id: ONE, state: 'completed', title: 'one' },
    { workspaceRoot: WS_B, id: TWO, state: 'failed', title: 'two' }
  ]));
  const picked = await manualWorkerDelete(all.ports, { targets: choices.map(choice => choice.target) });
  assert.equal(choices.length, 2);
  assert.equal(picked.confirmed, 2);
  assert.equal(picked.deleted.length, 2);
  assert.match(all.calls.confirm[0].message, /Permanently delete 2 saved workers\?/);
  assert.ok(all.calls.confirm[0].detail.includes(ONE));
  assert.ok(all.calls.confirm[0].detail.includes(TWO));
  assert.equal(all.calls.refresh, 1);
});

test('workers that left the confirmed group are skipped and only refresh the tree', async () => {
  const f = fixture({ sessions: [session(WS_A, ONE, { ownerId: 'parent-b' }), session(WS_A, TWO, { ownerId: 'parent-a' })] });
  const scope = { workspaceRoot: WS_A, ownerId: 'parent-a', label: 'Alpha' };
  const summary = await manualWorkerDelete(f.ports, {
    targets: groupWorkerTargets([
      { workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a' }, { workspaceRoot: WS_A, id: TWO, ownerId: 'parent-a' }
    ], scope),
    scope
  });
  assert.deepEqual(summary.skipped.map(entry => [entry.target.id, entry.reason]), [[ONE, 'identity_changed']]);
  assert.deepEqual(summary.deleted.map(target => target.id), [TWO]);
  assert.deepEqual(f.calls.remove, [{ root: WS_A, id: TWO, ownerId: 'parent-a' }]);
  assert.equal(f.calls.refresh, 1, 'a stale group row is refreshed after the scope changed');
});

test('an owner change skips the item outside any group scope too, without broadening', async () => {
  const owned = fixture({ sessions: [session(WS_A, ONE, { ownerId: 'parent-b' }), session(WS_A, TWO, { ownerId: 'parent-a' })] });
  const ownedSummary = await manualWorkerDelete(owned.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a' }, { workspaceRoot: WS_A, id: TWO, ownerId: 'parent-a' }]
  });
  assert.deepEqual(ownedSummary.skipped, [{ target: { workspaceRoot: WS_A, id: ONE, ownerId: 'parent-a' }, reason: 'identity_changed' }]);
  assert.deepEqual(ownedSummary.deleted.map(target => target.id), [TWO], 'a later unchanged target still deletes');
  assert.deepEqual(owned.calls.remove, [{ root: WS_A, id: TWO, ownerId: 'parent-a' }]);
  assert.match(owned.calls.info[0], /1 skipped \(1 identity changed\)/);
  assert.equal(owned.calls.refresh, 1);

  const adopted = fixture({ sessions: [session(WS_A, ONE, { ownerId: 'new-owner' })] });
  const adoptedSummary = await manualWorkerDelete(adopted.ports, { targets: [{ workspaceRoot: WS_A, id: ONE }] });
  assert.deepEqual(adoptedSummary.skipped, [{ target: { workspaceRoot: WS_A, id: ONE }, reason: 'identity_changed' }], 'an ownerless worker that gained an owner is not deleted');
  assert.deepEqual(adopted.calls.remove, []);
  assert.equal(adopted.calls.refresh, 1);
});

test('a re-read worker with a different id or root is never deleted and later targets still run', async () => {
  const wrongId = fixture({
    sessions: [session(WS_A, TWO)],
    lookup: (root, id) => id === ONE ? session(WS_A, THREE) : undefined
  });
  const idSummary = await manualWorkerDelete(wrongId.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_A, id: TWO }]
  });
  assert.deepEqual(idSummary.skipped.map(entry => [entry.target.id, entry.reason]), [[ONE, 'identity_changed']]);
  assert.deepEqual(idSummary.deleted.map(target => target.id), [TWO]);
  assert.deepEqual(wrongId.calls.remove, [{ root: WS_A, id: TWO, ownerId: undefined }], 'the returned different id is never deleted');

  const wrongRoot = fixture({
    sessions: [session(WS_A, TWO)],
    lookup: (root, id) => id === ONE ? session(WS_B, ONE) : undefined
  });
  const rootSummary = await manualWorkerDelete(wrongRoot.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_A, id: TWO }]
  });
  assert.deepEqual(rootSummary.skipped.map(entry => [entry.target.id, entry.reason]), [[ONE, 'identity_changed']]);
  assert.deepEqual(wrongRoot.calls.remove, [{ root: WS_A, id: TWO, ownerId: undefined }], 'the returned different root is never deleted');
  assert.equal(wrongRoot.calls.refresh, 1);
});

test('an all-busy confirmed batch still refreshes exactly once and reports totals', async () => {
  const f = fixture({
    sessions: [session(WS_A, ONE, { state: 'queued' }), session(WS_A, TWO, { state: 'running' })]
  });
  const summary = await manualWorkerDelete(f.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_A, id: TWO }]
  });
  assert.deepEqual(summary.deleted, []);
  assert.deepEqual(summary.skipped.map(entry => entry.reason), ['busy', 'busy']);
  assert.equal(summary.status, 'none');
  assert.equal(f.calls.remove.length, 0);
  assert.equal(f.calls.refresh, 1, 'the tree is refreshed once even when nothing was deleted');
  assert.match(f.calls.info[0], /Deleted 0 of 2/);
  assert.match(f.calls.info[0], /2 skipped \(2 busy\)/);
});

test('failed lookups keep later targets running, refresh once and never retry', async () => {
  const failures = new Map([[key(WS_A, ONE), Object.assign(new Error('host reconnecting'), { code: 'host_reconnecting' })]]);
  const f = fixture({ sessions: [session(WS_A, TWO)], failures });
  const summary = await manualWorkerDelete(f.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_A, id: TWO }]
  });
  assert.deepEqual(summary.failed.map(entry => [entry.target.id, entry.code]), [[ONE, 'host_reconnecting']]);
  assert.deepEqual(summary.deleted.map(target => target.id), [TWO]);
  assert.equal(summary.status, 'partial');
  assert.deepEqual(f.calls.session.map(call => call.id), [ONE, TWO], 'each target is read exactly once');
  assert.equal(f.calls.refresh, 1);
  assert.match(f.calls.info[0], /1 failed/);

  const allFail = new Map([
    [key(WS_A, ONE), Object.assign(new Error('host reconnecting'), { code: 'host_reconnecting' })],
    [key(WS_A, TWO), Object.assign(new Error('host reconnecting'), { code: 'host_reconnecting' })]
  ]);
  const none = fixture({ failures: allFail });
  const noneSummary = await manualWorkerDelete(none.ports, {
    targets: [{ workspaceRoot: WS_A, id: ONE }, { workspaceRoot: WS_A, id: TWO }]
  });
  assert.equal(noneSummary.failed.length, 2);
  assert.equal(noneSummary.deleted.length, 0);
  assert.equal(none.calls.refresh, 1, 'a read-failure-only batch still refreshes once');
  assert.equal(none.calls.session.length, 2, 'no failed lookup is retried');
  assert.match(none.calls.info[0], /Deleted 0 of 2/);
});

/**
 * The palette bug was WIRING, not the pure helper: the registered
 * `deleteSelectedWorkers` callback read only `args[0]`/`args[1]`. Parse the
 * real registration out of src/extension.ts, transpile just that callback and
 * evaluate it with narrowly stubbed collaborators, so the test exercises the
 * shipped wiring instead of a mirror of it.
 */
function registeredDeleteSelectedCallback() {
  const file = pathModule.join(pathModule.resolve(__dirname, '..'), 'src', 'extension.ts');
  const source = ts.createSourceFile('extension.ts', fsSync.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let callback;
  const visit = node => {
    if (callback) {
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'command'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'deleteSelectedWorkers') {
      callback = node.arguments[1];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, 'extension.ts must register codexSubagent.deleteSelectedWorkers through command()');
  const transpiled = ts.transpileModule(`const callback = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  return new Function('workerDeleteTargetsFromArgs', 'workersView', 'vscode', 'manualWorkerDelete', 'workerDeletePorts', 'reportWorkerDelete',
    `${transpiled.outputText}\nreturn callback;`);
}

function deleteSelectedHarness(selection) {
  const calls = { deleted: [], info: [] };
  const callback = registeredDeleteSelectedCallback()(
    workerDeleteTargetsFromArgs,
    { selection },
    { window: { showInformationMessage: message => { calls.info.push(message); } } },
    async (ports, options) => { calls.deleted.push({ ports, options }); return { failed: [] }; },
    { session() {}, remove() {}, confirm() {}, info() {}, refresh() {} },
    () => undefined
  );
  return { calls, callback };
}

const ids = targets => targets.map(target => [target.workspaceRoot, target.id]);

test('a palette Delete Selected Workers call reads the live Workers view selection', async () => {
  const selection = [workerNode(WS_A, ONE), groupNode(WS_A, { ownerId: 'parent-a', workers: [workerNode(WS_A, THREE)] }), workerNode(WS_B, TWO)];
  const { calls, callback } = deleteSelectedHarness(selection);

  await callback();

  assert.equal(calls.deleted.length, 1, 'the no-argument palette call must reach the shared delete helper');
  assert.deepEqual(ids(calls.deleted[0].options.targets), [[WS_A, ONE], [WS_B, TWO]], 'only explicit selected workers, group rows are never expanded');
  assert.equal(typeof calls.deleted[0].ports.session, 'function', 'the shared worker-delete ports object is used');
  assert.equal(calls.info.length, 0, 'a usable selection never shows the nothing-selected message');
});

test('a palette call with an empty or group-only current selection deletes nothing', async () => {
  const empty = deleteSelectedHarness([]);
  await empty.callback();
  assert.equal(empty.calls.deleted.length, 0);
  assert.equal(empty.calls.info.length, 1);

  const groupOnly = deleteSelectedHarness([groupNode(WS_A, { ownerId: 'parent-a', workers: [workerNode(WS_A, THREE)] })]);
  await groupOnly.callback();
  assert.equal(groupOnly.calls.deleted.length, 0, 'a selected group row is not a deletion target');
  assert.equal(groupOnly.calls.info.length, 1);
});

test('context-menu arguments keep precedence over the live tree selection', async () => {
  const clicked = workerNode(WS_A, ONE, { ownerId: 'parent-a' });
  const context = deleteSelectedHarness([workerNode(WS_B, THREE)]);
  await context.callback(clicked, [clicked, workerNode(WS_A, TWO, { ownerId: 'parent-a' })]);
  assert.deepEqual(ids(context.calls.deleted[0].options.targets), [[WS_A, ONE], [WS_A, TWO]], 'the supplied clicked+selected pair decides, not the view selection');

  const outside = deleteSelectedHarness([workerNode(WS_B, THREE)]);
  await outside.callback(workerNode(WS_B, FOUR), [workerNode(WS_B, THREE)]);
  assert.deepEqual(ids(outside.calls.deleted[0].options.targets), [[WS_B, FOUR]], 'a clicked worker outside its selection targets only itself');

  const group = deleteSelectedHarness([workerNode(WS_B, THREE)]);
  await group.callback(groupNode(WS_A, { ownerId: 'parent-a' }));
  assert.equal(group.calls.deleted.length, 0, 'a group context never falls back to the live tree selection');
  assert.equal(group.calls.info.length, 1);

  const emptySelection = deleteSelectedHarness([workerNode(WS_B, THREE)]);
  await emptySelection.callback(clicked, []);
  assert.deepEqual(ids(emptySelection.calls.deleted[0].options.targets), [[WS_A, ONE]], 'an explicit empty selected-nodes array keeps the clicked worker as the whole context');
});

test('report totals remain concise for skipped-only outcomes', () => {
  const message = workerDeleteReport({
    status: 'none', confirmed: 2, deleted: [], absent: [],
    skipped: [{ target: { workspaceRoot: WS_A, id: ONE }, reason: 'busy' }],
    failed: [], refreshed: false
  });
  assert.match(message, /Deleted 0 of 2/);
  assert.match(message, /1 skipped \(1 busy\)/);
});
