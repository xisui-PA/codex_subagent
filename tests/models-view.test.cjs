const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = fn => {
      const emitter = this;
      emitter.listeners.push(fn);
      return { dispose() { emitter.listeners = emitter.listeners.filter(l => l !== fn); } };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) { listener(value); }
  }
  dispose() {
    this.disposed = true;
    this.listeners = [];
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id) { this.id = id; }
}
let inspected;
let fired;
let inspectImpl = key => ({ key, globalValue: inspected, workspaceValue: 'ignored' });
// The VS Code model catalog (display metadata only). Tests set a catalog of
// { id, name } entries or an error to exercise the missing/failed paths.
let catalog = async () => [];
const vscode = {
  EventEmitter,
  TreeItem,
  ThemeIcon,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  commands: {
    executeCommand: async () => undefined,
  },
  lm: {
    selectChatModels: () => catalog(),
  },
  workspace: {
    getConfiguration: () => ({ inspect: key => inspectImpl(key) }),
  },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest); };
const { ModelsTree, modelPolicyFields, snapshotPool } = require('../.test-build/models-view');
Module._load = originalLoad;

test('snapshotPool preserves insertion/priority order of the global pool', () => {
  const raw = { 'pool/b': { numSessions: 2 }, 'pool/a': {}, 'pool/c': { allowWrite: false } };
  const snap = snapshotPool(raw);
  assert.deepEqual(snap.modelIds, ['pool/b', 'pool/a', 'pool/c']);
  assert.equal(snap.empty, false);
  assert.equal(snap.error, undefined);
  assert.deepEqual(snapshotPool(undefined), { modelIds: [], policies: {}, empty: true });
  assert.deepEqual(snapshotPool({}), { modelIds: [], policies: {}, empty: true });
});

test('snapshotPool surfaces malformed settings instead of pretending the pool is empty', () => {
  const snap = snapshotPool({ 'pool/a': { numSessions: 9 } });
  assert.equal(snap.empty, false);
  assert.equal(snap.modelIds.length, 0);
  assert.match(snap.error, /codexSubagent\.models is invalid/);
  assert.match(snap.error, /pool\/a/);
});

test('modelPolicyFields shows effective defaults for omitted fields and configured values otherwise', () => {
  const defaults = modelPolicyFields({});
  const byKey = Object.fromEntries(defaults.map(field => [field.key, field]));
  assert.equal(byKey.allowWrite.value, 'true');
  assert.equal(byKey.allowWrite.effective, true);
  assert.equal(byKey.allowShell.value, 'true');
  assert.equal(byKey.allowShell.effective, true);
  assert.match(byKey.allowShell.detail, /workspace-write/);
  assert.equal(byKey.numSessions.value, '1');
  assert.equal(byKey.numSessions.effective, true);
  assert.equal(byKey.maxToolRounds.value, '40');
  assert.equal(byKey.maxToolRounds.effective, true);
  assert.equal(byKey.turnTimeoutSeconds.value, '600');
  assert.equal(byKey.turnTimeoutSeconds.effective, true);
  assert.equal(byKey.autoCompact.value, 'true');
  assert.equal(byKey.autoCompact.effective, true);
  assert.equal(byKey.modelOptions.value, 'none');

  const configured = modelPolicyFields({ allowWrite: false, numSessions: 3, maxToolRounds: 5, turnTimeoutSeconds: 900, autoCompact: false, modelOptions: { temperature: 0.2 } });
  const byConfigured = Object.fromEntries(configured.map(field => [field.key, field]));
  assert.equal(byConfigured.allowWrite.value, 'false');
  assert.equal(byConfigured.allowWrite.effective, false);
  assert.equal(byConfigured.allowShell.effective, true, 'allowShell stays at its default unless set');
  assert.equal(byConfigured.numSessions.value, '3');
  assert.equal(byConfigured.numSessions.effective, false);
  assert.equal(byConfigured.maxToolRounds.value, '5');
  assert.equal(byConfigured.turnTimeoutSeconds.value, '900');
  assert.equal(byConfigured.autoCompact.value, 'false');
  assert.equal(byConfigured.autoCompact.effective, false);
  assert.equal(byConfigured.modelOptions.value, 'configured');
});

function makeTree() {
  let fires = 0;
  fired = () => fires;
  const tree = new ModelsTree();
  tree.onDidChangeTreeData(() => { fires += 1; });
  return tree;
}

test('the tree lists configured models in pool order and expands each into readable fields', async () => {
  inspected = { 'pool/b': { allowWrite: false }, 'pool/a': { numSessions: 2, modelOptions: { temperature: 0.5, nested: { deep: 'value' } } } };
  catalog = async () => [{ id: 'pool/a', name: 'Model A (vscode)' }, { id: 'pool/b', name: 'Model B (vscode)' }];
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map(node => node.id), ['pool/b', 'pool/a']);
  const first = tree.getTreeItem(roots[0]);
  assert.equal(first.label, 'Model B (vscode)', 'root labels show the VS Code model name, not the ID');
  assert.ok(first.tooltip.includes('pool/b'), 'the exact configured ID stays in the tooltip');
  assert.equal(first.description, undefined, 'pool order is position, so no explicit priority description');
  assert.equal(first.id, 'model:pool/b', 'the stable TreeItem identity keeps the exact ID');
  assert.equal(first.contextValue, 'modelEntry');
  assert.equal(first.command.command, 'codexSubagent.configureModel');
  assert.deepEqual(first.command.arguments, ['pool/b']);

  const children = await tree.getChildren(roots[1]);
  const labels = children.map(node => node.field ? node.field.label : node.key);
  assert.deepEqual(labels, ['allowWrite', 'allowShell', 'numSessions', 'maxToolRounds', 'turnTimeoutSeconds', 'autoCompact', 'modelOptions', 'temperature', 'nested']);
  const sessions = tree.getTreeItem(children[2]);
  assert.equal(sessions.label, 'numSessions');
  assert.equal(sessions.description, '2', 'configured values are not marked as defaults');
  const timeout = tree.getTreeItem(children[4]);
  assert.equal(timeout.description, 'default 600');
  assert.match(timeout.tooltip, /built-in default/);
  const option = tree.getTreeItem(children[7]);
  assert.equal(option.label, 'temperature', 'option items are labelled by key, not the value');
  assert.equal(option.description, '0.5');
  assert.equal(option.tooltip, '0.5');
  const nested = tree.getTreeItem(children[8]);
  assert.equal(nested.label, 'nested');
  assert.equal(nested.description, '{"deep":"value"}');
  assert.ok(nested.tooltip.includes('\n'), 'nested JSON stays multiline in the tooltip');
  assert.deepEqual(JSON.parse(nested.tooltip), { deep: 'value' });
  assert.equal((await tree.getChildren(children[7])).length, 0);
});

test('an empty global pool yields no roots, and workspace settings never enable models', async () => {
  // Only the global (User) value is read; the mock reports workspace-only config.
  const original = inspectImpl;
  inspectImpl = key => ({ key, globalValue: undefined, workspaceValue: { 'workspace/only': {} } });
  const tree = makeTree();
  tree.refresh();
  assert.deepEqual(await tree.getChildren(), []);
  assert.equal(tree.pool.empty, true);
  inspectImpl = original;
});

test('a malformed pool renders a visible error with recovery access instead of crashing', async () => {
  inspected = { 'pool/a': { nope: true } };
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kind, 'status');
  const item = tree.getTreeItem(roots[0]);
  assert.match(item.tooltip, /codexSubagent\.models is invalid/);
  assert.equal(item.command.command, 'codexSubagent.openModelSettings');
});

test('root labels use catalog names matched by exact ID, with pool order kept over catalog order', async () => {
  inspected = { 'pool/b': {}, 'pool/a': {} };
  catalog = async () => [{ id: 'pool/a', name: 'Alpha' }, { id: 'pool/b', name: 'Beta' }];
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  assert.deepEqual(roots.map(node => node.id), ['pool/b', 'pool/a'], 'configured pool order, not catalog order');
  assert.deepEqual(roots.map(node => node.name), ['Beta', 'Alpha'], 'names are matched by exact ID, not by order');
  const items = roots.map(node => tree.getTreeItem(node));
  assert.deepEqual(items.map(item => item.label), ['Beta', 'Alpha']);
  assert.ok(items[0].tooltip.includes('pool/b'));
  assert.ok(items[1].tooltip.includes('pool/a'));
  assert.deepEqual(items.map(item => item.id), ['model:pool/b', 'model:pool/a']);
});

test('duplicate display names keep ID-based stable identities and command arguments', async () => {
  inspected = { 'vendor/one': {}, 'vendor/two': {} };
  catalog = async () => [{ id: 'vendor/one', name: 'Same Name' }, { id: 'vendor/two', name: 'Same Name' }];
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  const items = roots.map(node => tree.getTreeItem(node));
  assert.deepEqual(items.map(item => item.label), ['Same Name', 'Same Name']);
  assert.deepEqual(items.map(item => item.id), ['model:vendor/one', 'model:vendor/two'], 'identities stay unique by exact ID');
  assert.deepEqual(items.map(item => item.command.arguments[0]), ['vendor/one', 'vendor/two']);
});

test('missing catalog entries fall back to a neutral label while keeping the ID in the tooltip', async () => {
  inspected = { 'pool/known': {}, 'pool/unknown': {} };
  catalog = async () => [{ id: 'pool/known', name: 'Known' }];
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  assert.deepEqual(roots.map(node => node.id), ['pool/known', 'pool/unknown']);
  const [knownItem, unknownItem] = roots.map(node => tree.getTreeItem(node));
  assert.equal(knownItem.label, 'Known');
  assert.equal(unknownItem.label, 'Unavailable model');
  assert.ok(unknownItem.tooltip.includes('pool/unknown'), 'the exact ID remains visible in the tooltip');
  assert.equal(unknownItem.id, 'model:pool/unknown');
  assert.deepEqual(unknownItem.command.arguments, ['pool/unknown']);
  assert.ok((await tree.getChildren(roots[1])).length > 0, 'the unavailable entry still expands to its settings');
});

test('a failed catalog query still lists every configured model with the neutral label', async () => {
  inspected = { 'pool/a': {} };
  catalog = async () => { throw new Error('catalog rejected'); };
  const tree = makeTree();
  tree.refresh();
  const roots = await tree.getChildren();
  assert.deepEqual(roots.map(node => node.id), ['pool/a']);
  const item = tree.getTreeItem(roots[0]);
  assert.equal(item.label, 'Unavailable model');
  assert.ok(item.tooltip.includes('pool/a'));
});

test('catalog names are re-read on every root request and refresh', async () => {
  inspected = { 'pool/a': {} };
  let reads = 0;
  let name = 'First Name';
  catalog = async () => { reads += 1; return [{ id: 'pool/a', name }]; };
  const tree = makeTree();
  tree.refresh();
  assert.equal((await tree.getChildren()).map(node => node.name)[0], 'First Name');
  name = 'Renamed';
  tree.refresh();
  assert.equal((await tree.getChildren()).map(node => node.name)[0], 'Renamed', 'a catalog change is picked up by the next request');
  assert.equal(reads, 2, 'metadata is fetched per root request, not cached');
});

test('refresh re-reads the setting and notifies; dispose releases the emitter', () => {
  inspected = { 'pool/a': {} };
  const tree = makeTree();
  tree.refresh();
  const before = fired();
  assert.ok(before >= 1);
  inspected = { 'pool/a': {}, 'pool/b': {} };
  tree.refresh();
  assert.equal(fired(), before + 1);
  assert.deepEqual(tree.pool.modelIds, ['pool/a', 'pool/b']);
  tree.dispose();
  const beforeDispose = fired();
  inspected = { 'pool/c': {} };
  tree.refresh();
  assert.equal(fired(), beforeDispose, 'a disposed tree must not fire listeners');
});

test('disposing one listener keeps other listeners subscribed', () => {
  inspected = { 'pool/a': {} };
  const tree = makeTree();
  let other = 0;
  const sub = tree.onDidChangeTreeData(() => { other += 1; });
  tree.refresh();
  assert.equal(other, 1);
  sub.dispose();
  tree.refresh();
  assert.equal(other, 1, 'the disposed listener must not fire');
  assert.ok(fired() >= 2, 'remaining listeners keep firing');
});

test('package.json wires the container, both views, welcome and Models title actions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const containers = manifest.contributes.viewsContainers.activitybar;
  assert.ok(containers.some(container => container.id === 'codexSubagent' && container.title === 'Codex Subagent' && container.icon.endsWith('.svg')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', containers.find(container => container.id === 'codexSubagent').icon)));
  assert.ok(!manifest.contributes.views.explorer, 'the workers view must leave the explorer');
  const views = manifest.contributes.views.codexSubagent;
  const byId = Object.fromEntries(views.map(view => [view.id, view]));
  assert.ok(byId['codexSubagent.workers'], 'existing workers view ID is preserved');
  assert.ok(byId['codexSubagent.models']);
  const welcome = manifest.contributes.viewsWelcome.find(entry => entry.view === 'codexSubagent.models');
  assert.match(welcome.contents, /Enable Model/);
  assert.match(welcome.contents, /codexSubagent\.openModelSettings/);
  const title = manifest.contributes.menus['view/title'].filter(entry => entry.when === 'view == codexSubagent.models');
  const titleCommands = title.map(entry => entry.command);
  assert.deepEqual(titleCommands.sort(), ['codexSubagent.configureModel', 'codexSubagent.enableModel', 'codexSubagent.openModelSettings']);
  const context = manifest.contributes.menus['view/item/context'].find(entry => entry.command === 'codexSubagent.configureModel' && entry.when.includes('viewItem == modelEntry'));
  assert.ok(context, 'per-model Configure Model Options context action');
});
