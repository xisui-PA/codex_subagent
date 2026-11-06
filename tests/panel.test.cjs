const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const vm = require('node:vm');
const { WorkerComposer } = require('../.test-build/composer');
const { deferred, until, sleep } = require('./helpers.cjs');
let createPanel;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') { return { window: { createWebviewPanel: () => createPanel() }, ViewColumn: { Active: 1 } }; }
  return originalLoad.call(this, name, ...args);
};
const { WorkerPanel } = require('../.test-build/panel');
Module._load = originalLoad;
function fixture(action, composer) {
  let hostMessage; let pageMessage; let dispose;
  const nodes = new Map(); const timers = new Set();
  const element = () => ({ value: '', textContent: '', disabled: false, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = [...children]; } });
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
  const now = new Date().toISOString();
  panel.update({ id: 'worker', title: 'Test', revision: 0, state: 'completed', activity: 'Done', model: { id: 'model', name: 'Model' }, permission: 'read-only', createdAt: now, updatedAt: now, turns: [{ id: 'turn', state: 'completed', input: 'Task', output: 'done', tools: [] }], messages: [] }, []);
  return { node, panel, hostMessage: message => hostMessage(message), close: () => { for (const timer of timers) { clearTimeout(timer); } panel.dispose(); } };
}

test('webview keeps failed follow-up text and retries its persisted request after reopening', async () => {
  let saved; const disk = { load: () => saved, save: async value => { saved = structuredClone(value); } };
  let composer = new WorkerComposer(disk); let request;
  const first = fixture(async message => { request = message; throw new Error('Connection lost'); }, composer);
  try {
    first.node('message').value = 'Keep these instructions'; first.node('send').onclick();
    await until(() => !!composer.state().error && !composer.state().busy);
    assert.equal(first.node('message').value, 'Keep these instructions');
    assert.equal(first.node('pendingRequest').hidden, false);
    assert.equal(first.node('retry').disabled, false);
    assert.equal(first.node('send').disabled, true);
  } finally { first.close(); }
  composer = new WorkerComposer(disk);
  const reopened = fixture(async message => { assert.equal(message.requestId, request.requestId); assert.equal(message.message, request.message); }, composer);
  try {
    assert.equal(reopened.node('message').value, 'Keep these instructions');
    reopened.node('retry').onclick();
    await until(() => !composer.state().pending && !composer.state().busy);
    assert.equal(reopened.node('message').value, '');
    assert.equal(reopened.node('pendingRequest').hidden, true);
  } finally { reopened.close(); }
});

test('a slow draft save cannot overwrite text typed after that save began', async () => {
  const started = deferred(); const release = deferred();
  const composer = new WorkerComposer({ load: () => undefined, save: async () => { started.resolve(); await release.promise; } });
  const view = fixture(async () => {}, composer);
  try {
    view.node('message').value = 'Earlier draft'; view.hostMessage({ action: 'draft', message: 'Earlier draft' }); await started.promise;
    view.node('message').value = 'Newer typing'; view.node('message').oninput();
    release.resolve(); await sleep(20);
    assert.equal(view.node('message').value, 'Newer typing');
  } finally { release.resolve(); view.close(); }
});

test('worker articles skip whitespace-only outputs and trim only trailing whitespace on display', async () => {
  const composer = new WorkerComposer({ load: () => undefined, save: async () => undefined });
  const view = fixture(async () => {}, composer);
  try {
    const now = new Date().toISOString();
    view.panel.update({
      id: 'worker', title: 'Test', revision: 1, state: 'completed', activity: 'Done',
      model: { id: 'model', name: 'Model' }, permission: 'read-only', createdAt: now, updatedAt: now,
      turns: [
        { id: 't1', state: 'completed', input: 'Task one', output: '  formatted code\n  line\n', tools: [] },
        { id: 't2', state: 'completed', input: 'Task two', output: '\n\n  \n', tools: [] },
        { id: 't3', state: 'completed', input: 'Task three', output: '', tools: [] }
      ],
      messages: []
    }, []);
    const conversation = view.node('conversation');
    await until(() => conversation.children.length >= 4);
    // Task 1 + trimmed Worker 1, Task 2 (no Worker article for whitespace-only
    // output), Task 3 (no Worker article for empty output).
    assert.equal(conversation.children.length, 4);
    const worker = conversation.children[1].children[1];
    assert.equal(worker.textContent, '  formatted code\n  line');
    const labels = conversation.children.map(a => a.children[0].textContent);
    assert.deepEqual(labels, ['Task · completed', 'Worker', 'Task · completed', 'Task · completed']);
  } finally { view.close(); }
});
