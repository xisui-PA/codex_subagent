const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const Module = require('node:module');
const path = require('node:path').posix;

class EventEmitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of [...this.listeners]) { listener(value); } }
  dispose() { this.listeners.clear(); }
}
const uri = value => ({ scheme: 'file', path: value, toString: () => `file://${value}`, with: change => uri(change.path ?? value) });
let configured, file, reads, watchers, configuration, saves, folders, readFile, remoteName, profileState, sharedSettings;
const vscode = {
  EventEmitter,
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.path, ...parts)) },
  RelativePattern: class { constructor(baseUri, pattern) { Object.assign(this, { baseUri, pattern }); } },
  env: { get remoteName() { return remoteName; } },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: section => {
      if (section === 'workbench.settings') {
        return { inspect: () => ({ globalValue: sharedSettings }) };
      }
      assert.equal(section, 'codexSubagent');
      return {
        inspect: key => {
          assert.equal(key, 'models');
          return { globalValue: configured, workspaceValue: { 'untrusted/model': {} } };
        },
        update: async (key, value, target) => {
          assert.equal(key, 'models');
          assert.equal(target, 1);
          configured = value;
        }
      };
    },
    fs: { readFile: resource => {
      if (resource.path.endsWith('/globalStorage/storage.json')) {
        return profileState instanceof Error ? Promise.reject(profileState) : Promise.resolve(Buffer.from(JSON.stringify(profileState)));
      }
      reads.push(resource.toString());
      return readFile(resource);
    } },
    createFileSystemWatcher: pattern => {
      const change = new EventEmitter(), create = new EventEmitter(), remove = new EventEmitter();
      const watcher = {
        pattern, change, create, remove,
        onDidChange: change.event, onDidCreate: create.event, onDidDelete: remove.event,
        dispose() { this.disposed = true; change.dispose(); create.dispose(); remove.dispose(); }
      };
      watchers.push(watcher);
      return watcher;
    },
    onDidChangeConfiguration: listener => configuration.event(listener),
    onDidChangeWorkspaceFolders: listener => folders.event(listener),
    onDidSaveTextDocument: listener => saves.event(listener)
  },
  lm: { selectChatModels: async () => ['pool/a', 'pool/b'].map(id => ({ id, name: id })) }
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...rest); };
const { UserModelSettingsCache } = require('../.test-build/user-model-settings');
const { ModelsTree } = require('../.test-build/models-view');
const { VscodeProvider } = require('../.test-build/vscode-provider');
const { userSettingsResource } = require('../.test-build/user-settings-resource');
Module._load = originalLoad;
const { defaults } = require('../.test-build/engine');
const { parseModelSettings } = require('../.test-build/model-settings');
const { fixture: engineFixture, finished } = require('./helpers.cjs');

beforeEach(() => {
  configured = { 'pool/a': {}, 'pool/b': { allowWrite: false } };
  file = JSON.stringify({ 'codexSubagent.models': configured });
  reads = []; watchers = []; configuration = new EventEmitter(); saves = new EventEmitter(); remoteName = undefined;
  folders = new EventEmitter();
  profileState = { profileAssociations: { workspaces: { 'file:///repo': '__default__profile__' } } };
  sharedSettings = [];
  vscode.workspace.workspaceFolders = [{ uri: uri('/repo') }];
  vscode.workspace.workspaceFile = undefined;
  readFile = async () => Buffer.from(file);
});
function fixture(t, storage = '/data/User/globalStorage/extension') {
  const cache = new UserModelSettingsCache({ globalStorageUri: uri(storage) });
  t.after(() => cache.dispose());
  return cache;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const changed = () => configuration.fire({ affectsConfiguration: key => key === 'codexSubagent.models' });
const settingsWatcher = () => [...watchers].reverse().find(watcher => watcher.pattern.pattern === 'settings.json');
const stateWatcher = () => watchers.find(watcher => watcher.pattern.pattern === 'storage.json');
const reorder = () => { file = '\uFEFF{ // model priority\n "codexSubagent.models": { "pool/b": { "allowWrite": false, }, "pool/a": {}, }, }'; };

test('file-only reorder refreshes the tree, provider, and shared routing settings despite a stale API snapshot', async t => {
  const cache = fixture(t);
  await cache.reload();
  const tree = new ModelsTree(cache);
  t.after(() => tree.dispose());
  const provider = new VscodeProvider({ languageModelAccessInformation: { canSendRequest: () => true } }, cache);
  let changes = 0;
  cache.onDidChange(() => { changes++; tree.refresh(); });
  tree.refresh();
  assert.deepEqual((await tree.getChildren()).map(node => node.id), ['pool/a', 'pool/b']);
  reorder();
  settingsWatcher().change.fire();
  await flush();
  assert.equal(changes, 1);
  assert.deepEqual(Object.keys(configured), ['pool/a', 'pool/b'], 'VS Code never publishes a new snapshot');
  assert.deepEqual((await tree.getChildren()).map(node => node.id), ['pool/b', 'pool/a']);
  assert.deepEqual((await provider.models()).map(model => model.id), ['pool/b', 'pool/a']);
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a'], 'runtime settings consume the same snapshot');
  // Duplicate file notifications and unrelated settings edits do not refresh.
  settingsWatcher().change.fire();
  await flush();
  file = file.replace('{ // model priority', '{ "editor.fontSize": 16, // model priority');
  settingsWatcher().change.fire();
  await flush();
  assert.equal(changes, 1);
});

test('initial file read recovers priority and retains strict policies', async t => {
  reorder();
  const cache = fixture(t);
  await cache.reload();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  assert.equal(cache.read()['pool/b'].allowWrite, false);
  assert.equal(reads[0], 'file:///data/User/settings.json');
  assert.equal(settingsWatcher().pattern.baseUri.toString(), 'file:///data/User');
  assert.equal(settingsWatcher().pattern.pattern, 'settings.json');
});

test('automatic worker selection follows a file-only priority change', async t => {
  const cache = fixture(t);
  await cache.reload();
  const { engine } = await engineFixture(t, {
    settingsFn: () => ({ ...defaults, autoCompact: false, retries: 0, models: parseModelSettings(cache.read()) }),
    provider: { models: async () => ['pool/a', 'pool/b'].map(id => ({ id, name: id, maxInputTokens: 100_000 })) }
  });
  const before = await engine.spawn({ requestId: 'before-reorder', task: 'First worker', permission: 'read-only' });
  assert.equal(before.model.id, 'pool/a');
  await finished(engine, before.id);
  reorder();
  settingsWatcher().change.fire();
  await flush();
  const after = await engine.spawn({ requestId: 'after-reorder', task: 'Next worker', permission: 'read-only' });
  assert.equal(after.model.id, 'pool/b');
  await finished(engine, after.id);
});

test('normal configuration changes update policies immediately and retain saved priority on later events', async t => {
  const cache = fixture(t);
  await cache.reload();
  configured = { 'pool/a': { numSessions: 3 }, 'pool/b': { allowWrite: false } };
  changed();
  assert.equal(cache.read()['pool/a'].numSessions, 3);
  await flush();
  file = JSON.stringify({ 'codexSubagent.models': { 'pool/b': configured['pool/b'], 'pool/a': configured['pool/a'] } });
  settingsWatcher().change.fire();
  await flush();
  changed();
  await flush();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
});

test('saved files cannot introduce models or override User-level permissions', async t => {
  const cache = fixture(t);
  file = '{ "codexSubagent.models": { "untrusted/model": {}, "pool/b": { "allowWrite": true } } }';
  await cache.reload();
  assert.deepEqual(cache.read(), configured);
  assert.equal(cache.read()['pool/b'].allowWrite, false);
  assert.equal(Object.hasOwn(cache.read(), 'untrusted/model'), false);
});

test('create/delete notifications handle absent settings and recovery', async t => {
  const cache = fixture(t);
  readFile = async () => { throw new Error('ENOENT'); };
  await cache.reload();
  assert.deepEqual(cache.read(), configured);
  reorder();
  readFile = async () => Buffer.from(file);
  settingsWatcher().create.fire();
  await flush();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  configured = undefined;
  readFile = async () => { throw new Error('ENOENT'); };
  settingsWatcher().remove.fire();
  await flush();
  assert.equal(cache.read(), undefined);
});

test('invalid JSONC never supplies partially parsed model policies', async t => {
  const cache = fixture(t);
  for (const text of ['{ "codexSubagent.models": { "pool/b": {},', '[]', 'null', '{"codexSubagent.models": {"pool/b": {}}} trailing']) {
    file = text;
    await cache.reload();
    assert.deepEqual(cache.read(), configured);
  }
  configured = 'invalid pool';
  changed();
  assert.equal(cache.read(), 'invalid pool', 'strict parser errors must reach consumers');
});

test('only the watched User settings save triggers a file reload', async t => {
  const cache = fixture(t);
  await cache.reload();
  reorder();
  saves.fire({ uri: uri('/repo/.vscode/settings.json') });
  await flush();
  assert.equal(reads.length, 1);
  saves.fire({ uri: uri('/data/User/settings.json') });
  await flush();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
});

test('named profiles resolve the workspace association while extension storage stays in the default profile', async t => {
  profileState = {
    userDataProfiles: [{ location: 'work', name: 'Work' }],
    profileAssociations: { workspaces: { 'file:///repo': 'work' } }
  };
  configured = { 'pool/b': { allowWrite: false }, 'pool/a': {} };
  const profileFile = JSON.stringify({ 'codexSubagent.models': configured });
  const files = new Map([['/data/User/settings.json', file], ['/data/User/profiles/work/settings.json', profileFile]]);
  readFile = async resource => Buffer.from(files.get(resource.path));
  const cache = fixture(t);
  await cache.reload();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a'], 'default profile must never replace the active priority');
  assert.deepEqual(reads, ['file:///data/User/profiles/work/settings.json']);
  assert.equal(settingsWatcher().pattern.baseUri.toString(), 'file:///data/User/profiles/work');
  files.set('/data/User/profiles/work/settings.json', file);
  settingsWatcher().change.fire();
  await flush();
  assert.deepEqual(Object.keys(cache.read()), ['pool/a', 'pool/b'], 'order-only profile edits are watched');
  assert.deepEqual(Object.keys(configured), ['pool/b', 'pool/a'], 'API snapshot remains stale');
});

test('remote hosts watch machine settings independently of local profile associations', async t => {
  remoteName = 'ssh-remote';
  profileState = new Error('Local profile metadata is unavailable on the server');
  const remote = fixture(t);
  await remote.reload();
  assert.equal(reads.at(-1), 'file:///data/Machine/settings.json');
  assert.equal(stateWatcher(), undefined);
});

test('profile changes rebind the settings watcher and dispose the previous one', async t => {
  const cache = fixture(t);
  await cache.reload();
  const old = settingsWatcher();
  profileState = {
    userDataProfiles: [{ location: 'work', name: 'Work' }],
    profileAssociations: { workspaces: { 'file:///repo': 'work' } }
  };
  reorder();
  stateWatcher().change.fire();
  await flush();
  assert.equal(old.disposed, true);
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User/profiles/work');
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  profileState.profileAssociations.workspaces = { 'file:///repo': '__default__profile__' };
  stateWatcher().change.fire();
  await flush();
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User');
});

test('workspace files take precedence over folder associations and folder changes re-resolve profiles', async t => {
  vscode.workspace.workspaceFile = uri('/team.code-workspace');
  profileState = {
    userDataProfiles: [{ location: 'team', name: 'Team' }, { location: 'folder', name: 'Folder' }],
    profileAssociations: { workspaces: { 'file:///team.code-workspace': 'team', 'file:///repo': 'folder' } }
  };
  const cache = fixture(t);
  await cache.reload();
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User/profiles/team');
  vscode.workspace.workspaceFile = undefined;
  folders.fire();
  await flush();
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User/profiles/folder');
});

test('profiles inheriting default settings and legacy profile URI locations resolve correctly', async () => {
  const context = { globalStorageUri: uri('/data/User/globalStorage/extension') };
  profileState = {
    userDataProfiles: [{ location: { scheme: 'file', path: '/data/User/profiles/work' }, name: 'Work' }],
    profileAssociations: { workspaces: { 'file:///repo': 'work' } }
  };
  assert.equal((await userSettingsResource(context)).path, '/data/User/profiles/work/settings.json');
  profileState.userDataProfiles[0].useDefaultFlags = { settings: true };
  assert.equal((await userSettingsResource(context)).path, '/data/User/settings.json');
});

test('models applied to all profiles watch default settings and rebind when sharing is disabled', async t => {
  profileState = {
    userDataProfiles: [{ location: 'work', name: 'Work' }],
    profileAssociations: { workspaces: { 'file:///repo': 'work' } }
  };
  sharedSettings = ['codexSubagent.models'];
  const cache = fixture(t);
  await cache.reload();
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User');
  sharedSettings = [];
  configuration.fire({ affectsConfiguration: key => key === 'workbench.settings.applyToAllProfiles' });
  await flush();
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User/profiles/work');
});

test('unknown or malformed profile metadata never borrows the default profile priority', async t => {
  configured = { 'pool/b': { allowWrite: false }, 'pool/a': {} };
  const cache = fixture(t);
  for (const state of [
    new Error('Metadata cannot be read'),
    {},
    { profileAssociations: { workspaces: {} } },
    { userDataProfiles: [], profileAssociations: { workspaces: { 'file:///repo': 'missing' } } },
    { profileAssociations: { workspaces: [] } },
    { profileAssociations: false },
    null
  ]) {
    profileState = state;
    await cache.reload();
    assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  }
  assert.deepEqual(reads, [], 'unresolved identity must not read another settings file');
  assert.equal(settingsWatcher(), undefined);
});

test('a temporary profile with no persisted association keeps its API priority', async t => {
  // Temporary profiles are absent from both the profile list and associations.
  // The default file has identical policies in the opposite order.
  profileState = {};
  configured = { 'pool/b': { allowWrite: false }, 'pool/a': {} };
  const cache = fixture(t);
  await cache.reload();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  assert.deepEqual(reads, []);
  assert.equal(settingsWatcher(), undefined);
  sharedSettings = ['codexSubagent.models'];
  configuration.fire({ affectsConfiguration: key => key === 'workbench.settings.applyToAllProfiles' });
  await flush();
  assert.deepEqual(Object.keys(cache.read()), ['pool/a', 'pool/b'], 'explicitly shared settings may supply default priority');
  assert.equal(settingsWatcher().pattern.baseUri.path, '/data/User');
});

test('losing a profile association discards its file priority and settings watcher', async t => {
  const cache = fixture(t);
  reorder();
  await cache.reload();
  const old = settingsWatcher();
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  await cache.update(cache.read());
  configured = { 'pool/a': {}, 'pool/b': { allowWrite: false } };
  profileState = {};
  stateWatcher().change.fire();
  await flush();
  assert.equal(old.disposed, true);
  assert.deepEqual(Object.keys(cache.read()), ['pool/a', 'pool/b'], 'neither saved nor committed priority crosses a known association change');
});

test('empty windows use their workspace ID when available and avoid guessing otherwise', async () => {
  vscode.workspace.workspaceFolders = undefined;
  profileState = {
    userDataProfiles: [{ location: 'work', name: 'Work' }],
    profileAssociations: { emptyWindows: { empty123: 'work' } }
  };
  const context = { globalStorageUri: uri('/data/User/globalStorage/extension') };
  assert.equal(await userSettingsResource(context), undefined);
  context.storageUri = uri('/data/User/workspaceStorage/empty123/extension');
  assert.equal((await userSettingsResource(context)).path, '/data/User/profiles/work/settings.json');
  profileState.profileAssociations.emptyWindows = {};
  assert.equal(await userSettingsResource(context), undefined);
});

test('missing profile metadata does not assume the default profile', async () => {
  profileState = Object.assign(new Error('Not found'), { code: 'FileNotFound' });
  const context = { globalStorageUri: uri('/data/User/globalStorage/extension') };
  assert.equal(await userSettingsResource(context), undefined);
});

test('newer file reads win when filesystem events overlap', async t => {
  const cache = fixture(t);
  let resolve;
  const old = file;
  readFile = () => new Promise(done => { resolve = done; });
  const pending = cache.reload();
  await flush();
  reorder();
  readFile = async () => Buffer.from(file);
  await cache.reload();
  resolve(Buffer.from(old));
  await pending;
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
});

test('committed updates preserve priority without waiting for events or pending reads', async t => {
  const cache = fixture(t);
  let resolve;
  readFile = () => new Promise(done => { resolve = done; });
  const pending = cache.reload();
  await flush();
  const next = { 'pool/b': { allowWrite: false }, 'pool/a': { numSessions: 2 } };
  await cache.update(next);
  assert.deepEqual(cache.read(), next);
  resolve(Buffer.from(file));
  await pending;
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  assert.equal(cache.read()['pool/a'].numSessions, 2);
});

test('provider mutations use cached priority and publish their committed changes to the shared cache', async t => {
  const cache = fixture(t);
  reorder();
  await cache.reload();
  const provider = new VscodeProvider({}, cache);
  await provider.setModelOptions('pool/a', { reasoning: 'high' });
  assert.deepEqual(Object.keys(configured), ['pool/b', 'pool/a']);
  assert.deepEqual(provider.options('pool/a'), { reasoning: 'high' });
  await provider.disable('pool/b');
  assert.deepEqual(Object.keys(cache.read()), ['pool/a']);
});

test('drag ordering persists and is recovered by a fresh cache when the API keeps its old order', async t => {
  const getConfiguration = vscode.workspace.getConfiguration;
  t.after(() => { vscode.workspace.getConfiguration = getConfiguration; });
  vscode.workspace.getConfiguration = section => ({
    ...getConfiguration(section),
    update: async (key, value, target) => {
      assert.equal(key, 'models');
      assert.equal(target, vscode.ConfigurationTarget.Global);
      file = JSON.stringify({ 'codexSubagent.models': value });
      // VS Code does not publish a changed snapshot for an order-only write.
    }
  });
  const cache = fixture(t);
  await cache.reload();
  const provider = new VscodeProvider({}, cache);
  await provider.moveModels(['pool/b'], 'pool/a');
  assert.deepEqual(Object.keys(configured), ['pool/a', 'pool/b']);
  assert.deepEqual(Object.keys(JSON.parse(file)['codexSubagent.models']), ['pool/b', 'pool/a']);
  assert.deepEqual(Object.keys(cache.read()), ['pool/b', 'pool/a']);
  const fresh = fixture(t);
  await fresh.reload();
  assert.deepEqual(Object.keys(fresh.read()), ['pool/b', 'pool/a']);
});

test('an unresolved empty-window profile retains a committed drag across metadata refreshes', async t => {
  vscode.workspace.workspaceFolders = undefined;
  profileState = { userDataProfiles: [{ location: 'work', name: 'Work' }] };
  const getConfiguration = vscode.workspace.getConfiguration;
  t.after(() => { vscode.workspace.getConfiguration = getConfiguration; });
  vscode.workspace.getConfiguration = section => ({
    ...getConfiguration(section),
    update: async (key, value, target) => {
      assert.equal(key, 'models');
      assert.equal(target, vscode.ConfigurationTarget.Global);
      file = JSON.stringify({ 'codexSubagent.models': value });
      // An order-only write leaves the API mirror unchanged.
    }
  });
  const cache = fixture(t);
  await cache.reload();
  const provider = new VscodeProvider({}, cache);
  await provider.moveModels(['pool/b'], 'pool/a');
  assert.deepEqual(Object.keys(configured), ['pool/a', 'pool/b']);
  assert.deepEqual(Object.keys(JSON.parse(file)['codexSubagent.models']), ['pool/b', 'pool/a']);
  for (let i = 0; i < 2; i++) {
    stateWatcher().change.fire();
    await flush();
    assert.deepEqual(provider.enabled(), ['pool/b', 'pool/a']);
  }
  assert.deepEqual(reads, [], 'metadata refreshes never read another profile');
  assert.equal(settingsWatcher(), undefined);
  configured = { 'pool/a': { allowWrite: false } };
  changed();
  await flush();
  assert.deepEqual(cache.read(), configured, 'committed ordering cannot restore removed models or older permissions');
});

test('dispose releases listeners and ignores pending file reads', async t => {
  const cache = fixture(t);
  let resolve;
  readFile = () => new Promise(done => { resolve = done; });
  const pending = cache.reload();
  await flush();
  let changes = 0;
  cache.onDidChange(() => changes++);
  cache.dispose();
  reorder();
  resolve(Buffer.from(file));
  await pending;
  assert.equal(changes, 0);
  assert.deepEqual(Object.keys(cache.read()), ['pool/a', 'pool/b']);
  assert.equal(configuration.listeners.size, 0);
  assert.equal(saves.listeners.size, 0);
  assert.equal(folders.listeners.size, 0);
  assert.equal(settingsWatcher().disposed, true);
  assert.equal(stateWatcher().disposed, true);
});
