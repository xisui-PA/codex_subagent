const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const vm = require('node:vm');
const { WorkerComposer } = require('../.test-build/composer');
const { until } = require('./helpers.cjs');
let createPanel;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') { return { window: { createWebviewPanel: () => createPanel() }, ViewColumn: { Active: 1 } }; }
  return originalLoad.call(this, name, ...args);
};
const { WorkerPanel } = require('../.test-build/panel');
Module._load = originalLoad;

const now = new Date().toISOString();
const session = (state, modelId, turns) => ({
  id: 'worker', title: 'Test', revision: 0, state, activity: 'Done',
  model: { id: modelId, name: modelId }, permission: 'read-only', createdAt: now, updatedAt: now,
  turns: turns || [{ id: 'turn', state: 'completed', input: 'Task', output: 'done', tools: [] }],
  messages: []
});
function fixture(action, composer) {
  let hostMessage; let pageMessage; let dispose;
  const nodes = new Map(); const timers = new Set();
  const element = () => ({
    value: '', textContent: '', disabled: false, hidden: false, title: '', children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; }
  });
  const node = id => { if (!nodes.has(id)) { nodes.set(id, element()); } return nodes.get(id); };
  const webview = { cspSource: 'mock', html: '', onDidReceiveMessage: fn => { hostMessage = fn; }, postMessage: data => { pageMessage({ data }); return Promise.resolve(true); } };
  createPanel = () => ({ webview, onDidDispose: fn => { dispose = fn; }, reveal() {}, dispose: () => dispose() });
  const panel = new WorkerPanel('Test', action, () => {}, composer);
  const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: message => hostMessage(message), getState: () => undefined, setState() {} }),
    document: { getElementById: node, createElement: () => element(), body: { scrollHeight: 100 } },
    window: { addEventListener: (_name, fn) => { pageMessage = fn; }, innerHeight: 800, scrollY: 0, scrollTo() {} },
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timers.add(timer); return timer; }, clearTimeout
  });
  return { node, panel, close: () => { for (const timer of timers) { clearTimeout(timer); } panel.dispose(); } };
}

test('completed workers can switch models using only the eligible fallback list', async () => {
  const composer = new WorkerComposer({ load: () => undefined, save: async () => undefined });
  const view = fixture(async () => {}, composer);
  try {
    // The previous model was removed from the pool: the dropdown must not keep it.
    view.panel.update(session('completed', 'model/a'), [{ id: 'model/b', name: 'B' }, { id: 'model/c', name: 'C' }]);
    await until(() => view.node('model').children.length === 2);
    assert.deepEqual(view.node('model').children.map(option => option.value), ['model/b', 'model/c']);
    assert.equal(view.node('model').value, 'model/b');
    assert.equal(view.node('resume').disabled, false);
    assert.equal(view.node('resume').textContent, 'Switch model / follow up');
    assert.match(view.node('resume').title, /earlier turns preserved/);
    assert.equal(view.node('modelGuidance').textContent, '');
    // Completed workers still accept plain follow-ups.
    view.node('message').value = 'Next step';
    view.node('message').oninput();
    assert.equal(view.node('send').disabled, false);
  } finally { view.close(); }
});

test('resuming a completed worker always submits an explicit eligible model', async () => {
  const composer = new WorkerComposer({ load: () => undefined, save: async () => undefined });
  const requests = [];
  const view = fixture(async message => { requests.push(message); }, composer);
  try {
    view.panel.update(session('completed', 'model/removed'), [{ id: 'model/b', name: 'B' }]);
    await until(() => view.node('model').children.length === 1);
    view.node('message').value = '';
    view.node('resume').onclick();
    await until(() => requests.some(message => message.action === 'resume'));
    const resume = requests.find(message => message.action === 'resume');
    assert.equal(resume.model, 'model/b');
    assert.equal(resume.message, undefined);
    assert.ok(resume.requestId);
  } finally { view.close(); }
});

test('no eligible model disables resume and explains what to fix', async () => {
  const composer = new WorkerComposer({ load: () => undefined, save: async () => undefined });
  const view = fixture(async () => {}, composer);
  try {
    const hint = 'No configured model allows workspace-write. Set allowWrite: true for a configured model.';
    view.panel.update(session('failed', 'model/a', [{ id: 'turn', state: 'failed', input: 'Task', output: 'partial', tools: [] }]), [], hint);
    await until(() => view.node('modelGuidance').textContent === hint);
    assert.equal(view.node('resume').disabled, true);
    assert.equal(view.node('model').disabled, true);
    assert.equal(view.node('model').children.length, 0);
    // Recovery controls that do not need a model stay available.
    assert.equal(view.node('retry').disabled, false);
    view.panel.update(session('completed', 'model/a'), [{ id: 'model/b', name: 'B' }], '');
    await until(() => view.node('model').children.length === 1);
    assert.equal(view.node('resume').disabled, false);
    assert.equal(view.node('model').value, 'model/b');
  } finally { view.close(); }
});
