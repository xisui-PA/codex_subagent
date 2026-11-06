const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { sleep } = require('./helpers.cjs');

let createPanel;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') { return { window: { createWebviewPanel: () => createPanel() }, ViewColumn: { Active: 1 } }; }
  return originalLoad.call(this, name, ...args);
};
const { CommandApprovals } = require('../.test-build/command-approval');
Module._load = originalLoad;

function makeSignal() {
  const handlers = new Set();
  return {
    handlers,
    aborted: false,
    addEventListener: (_name, handler) => { handlers.add(handler); },
    removeEventListener: (_name, handler) => { handlers.delete(handler); },
    abort() { this.aborted = true; for (const handler of [...handlers]) { handler(); } }
  };
}

function fixture() {
  const created = [];
  createPanel = () => {
    const panel = {
      webview: { cspSource: 'vscode-webview-resource://mock', html: '', onDidReceiveMessage: fn => { panel.hostMessage = fn; return { dispose() {} }; } },
      onDidDispose: fn => { panel.onDispose = fn; return { dispose() {} }; },
      reveal() {},
      disposed: false,
      dispose() { if (!panel.disposed) { panel.disposed = true; panel.onDispose(); } }
    };
    created.push(panel);
    return panel;
  };
  return { service: new CommandApprovals(), created };
}

const settled = promise => { let value; let done = false; promise.then(v => { value = v; done = true; }, () => { done = true; }); return () => (done ? value : undefined); };

test('explicit run approves, cancel and close deny', async () => {
  {
    const { service, created } = fixture();
    const signal = makeSignal();
    const promise = service.request('echo ok', '/tmp', signal);
    assert.equal(created.length, 1);
    const panel = created[0];
    assert.ok(service.pending.has(panel));
    panel.hostMessage({ action: 'run' });
    assert.equal(await promise, true);
    assert.equal(panel.disposed, true);
    assert.equal(service.pending.size, 0);
    assert.equal(signal.handlers.size, 0, 'Abort listener must be released');
    panel.hostMessage({ action: 'run' });
    await sleep(20);
    assert.equal(service.pending.size, 0, 'Late messages must have no effect after settling');
  }
  {
    const { service, created } = fixture();
    const promise = service.request('echo ok', '/tmp', makeSignal());
    created[0].hostMessage({ action: 'cancel' });
    assert.equal(await promise, false);
    assert.equal(created[0].disposed, true);
    assert.equal(service.pending.size, 0);
  }
  {
    const { service, created } = fixture();
    const promise = service.request('echo ok', '/tmp', makeSignal());
    const panel = created[0];
    panel.dispose();
    assert.equal(await promise, false);
    assert.equal(panel.disposed, true);
    assert.equal(service.pending.size, 0);
  }
});

test('malformed and unknown messages are ignored', async () => {
  const { service, created } = fixture();
  const signal = makeSignal();
  const promise = service.request('echo ok', '/tmp', signal);
  const panel = created[0];
  const result = settled(promise);
  panel.hostMessage(null);
  panel.hostMessage('run');
  panel.hostMessage(42);
  panel.hostMessage({});
  panel.hostMessage({ action: 'unknown' });
  panel.hostMessage({ action: 'run extra' });
  panel.hostMessage([1, 2]);
  await sleep(20);
  assert.equal(result(), undefined, 'Nothing but exact actions may settle the request');
  assert.equal(panel.disposed, false);
  assert.equal(service.pending.size, 1);
  panel.hostMessage({ action: 'cancel' });
  assert.equal(await promise, false);
  assert.equal(panel.disposed, true);
  assert.equal(signal.handlers.size, 0);
});

test('already-aborted and disposed requests create no panel', async () => {
  const signal = makeSignal();
  signal.abort();
  const { service, created } = fixture();
  assert.equal(await service.request('echo ok', '/tmp', signal), false);
  assert.equal(created.length, 0);
  const after = fixture();
  after.service.dispose();
  assert.equal(await after.service.request('echo ok', '/tmp', makeSignal()), false);
  assert.equal(after.created.length, 0);
  assert.equal(after.service.pending.size, 0);
});

test('abort while waiting denies and closes the panel', async () => {
  const { service, created } = fixture();
  const signal = makeSignal();
  const promise = service.request('echo ok', '/tmp', signal);
  assert.equal(created.length, 1);
  signal.abort();
  assert.equal(await promise, false);
  assert.equal(created[0].disposed, true);
  assert.equal(service.pending.size, 0);
  assert.equal(signal.handlers.size, 0, 'Abort listener must be released');
});

test('a late retained run callback after abort stays denied', async () => {
  const { service, created } = fixture();
  const signal = makeSignal();
  const promise = service.request('echo ok', '/tmp', signal);
  const hostMessage = created[0].hostMessage;
  signal.abort();
  assert.equal(await promise, false);
  hostMessage({ action: 'run' });
  await sleep(20);
  assert.equal(service.pending.size, 0);
  assert.equal(created[0].disposed, true);
});

test('service disposal settles all pending requests', async () => {
  const { service, created } = fixture();
  const first = service.request('one', '/tmp', makeSignal());
  const second = service.request('two', '/tmp', makeSignal());
  assert.equal(created.length, 2);
  service.dispose();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.ok(created.every(panel => panel.disposed));
  assert.equal(service.pending.size, 0);
  created[0].hostMessage({ action: 'run' });
  created[1].hostMessage({ action: 'run' });
  await sleep(20);
  assert.equal(service.pending.size, 0);
});

test('independent concurrent requests do not cross-approve', async () => {
  const { service, created } = fixture();
  const a = service.request('alpha', '/tmp', makeSignal());
  const b = service.request('beta', '/tmp', makeSignal());
  await sleep(20);
  assert.equal(service.pending.size, 2);
  created[0].hostMessage({ action: 'run' });
  assert.equal(await a, true);
  let bDone = false;
  b.then(() => { bDone = true; });
  await sleep(20);
  assert.equal(bDone, false, 'Approving one request must not settle another');
  assert.equal(service.pending.size, 1);
  created[1].hostMessage({ action: 'cancel' });
  assert.equal(await b, false);
  assert.equal(service.pending.size, 0);
  assert.ok(created.every(panel => panel.disposed));
});

test('run once approves the request without granting the root', async () => {
  const { service, created } = fixture();
  const promise = service.request('cmd', '/ws/alpha', makeSignal(), '/ws/alpha');
  created[0].hostMessage({ action: 'run' });
  assert.equal(await promise, true);
  assert.deepEqual(service.getGrantedRoots(), [], 'Run once must not leave a session grant');
  const next = service.request('next', path.join('/ws/alpha', 'sub'), makeSignal(), '/ws/alpha');
  assert.equal(created.length, 2, 'A later same-root request must still open a panel');
  created[1].hostMessage({ action: 'cancel' });
  assert.equal(await next, false);
});

test('allowSession grants the exact root, settles same-root pendings, and skips the UI later', async () => {
  const alpha = '/ws/alpha';
  const beta = '/ws/beta';
  const { service, created } = fixture();
  const first = service.request('one', alpha, makeSignal(), alpha);
  const second = service.request('two', path.join(alpha, 'sub'), makeSignal(), alpha);
  const other = service.request('three', beta, makeSignal(), beta);
  await sleep(20);
  assert.equal(service.pending.size, 3);
  created[0].hostMessage({ action: 'allowSession' });
  assert.equal(await first, true);
  assert.equal(await second, true, 'All pending same-root requests must be approved at once');
  let otherDone = false;
  other.then(() => { otherDone = true; });
  await sleep(20);
  assert.equal(otherDone, false, 'Other roots must keep awaiting their own decision');
  assert.deepEqual(service.getGrantedRoots(), [alpha]);
  assert.ok(created[0].disposed && created[1].disposed, 'Approved same-root panels must close');
  assert.equal(created[2].disposed, false, 'The other root must keep its panel open');
  const next = service.request('next', path.join(alpha, 'other-child'), makeSignal(), alpha);
  assert.equal(await next, true, 'A granted root must auto-approve from any child cwd');
  assert.equal(created.length, 3, 'An approved granted request must not create a panel');
  created[2].hostMessage({ action: 'cancel' });
  assert.equal(await other, false);
});

test('a parent root grant does not cover sibling or nested worktree roots', async () => {
  const alpha = '/workspaces/alpha';
  const beta = '/workspaces/beta';
  const worktree = path.join(alpha, '.worktrees', 'branch');
  const { service, created } = fixture();
  const grant = service.request('grant', alpha, makeSignal(), alpha);
  created[0].hostMessage({ action: 'allowSession' });
  assert.equal(await grant, true);
  const sibling = service.request('other', beta, makeSignal(), beta);
  const nested = service.request('wt', worktree, makeSignal(), worktree);
  await sleep(20);
  assert.equal(created.length, 3, 'Other roots must open their own panels');
  assert.equal(service.pending.size, 2);
  created[1].hostMessage({ action: 'cancel' });
  created[2].hostMessage({ action: 'cancel' });
  assert.equal(await sibling, false);
  assert.equal(await nested, false);
  assert.deepEqual(service.getGrantedRoots(), [alpha], 'The grant must stay scoped to the exact root');
});

test('cancel, close, abort, and dispose never create a grant; late allowSession is inert', async () => {
  for (const kind of ['cancel', 'close', 'abort']) {
    const { service, created } = fixture();
    const signal = makeSignal();
    const promise = service.request('cmd', '/ws/alpha', signal, '/ws/alpha');
    const late = created[0].hostMessage;
    if (kind === 'cancel') { created[0].hostMessage({ action: 'cancel' }); }
    else if (kind === 'close') { created[0].dispose(); }
    else { signal.abort(); }
    assert.equal(await promise, false, kind + ' must deny');
    assert.equal(created[0].disposed, true, kind + ' must close the panel');
    assert.deepEqual(service.getGrantedRoots(), [], kind + ' must not grant');
    late({ action: 'allowSession' });
    await sleep(20);
    assert.deepEqual(service.getGrantedRoots(), [], 'A retained allowSession callback after ' + kind + ' must not grant');
    const again = service.request('again', '/ws/alpha', makeSignal(), '/ws/alpha');
    assert.equal(created.length, 2, 'A denied request must still ask again');
    created[1].hostMessage({ action: 'run' });
    assert.equal(await again, true);
  }
  {
    const { service, created } = fixture();
    const promise = service.request('cmd', '/ws/alpha', makeSignal(), '/ws/alpha');
    service.dispose();
    assert.equal(await promise, false);
    created[0].hostMessage({ action: 'allowSession' });
    await sleep(20);
    assert.deepEqual(service.getGrantedRoots(), [], 'A retained allowSession after dispose must not grant');
    assert.equal(await service.request('again', '/ws/alpha', makeSignal(), '/ws/alpha'), false);
    assert.equal(created.length, 1, 'A disposed service must not create panels');
  }
});

test('an already-aborted request is denied even when its root has a grant', async () => {
  const alpha = '/ws/alpha';
  const { service, created } = fixture();
  const grant = service.request('grant', alpha, makeSignal(), alpha);
  created[0].hostMessage({ action: 'allowSession' });
  assert.equal(await grant, true);
  const aborted = makeSignal();
  aborted.abort();
  assert.equal(await service.request('cmd', alpha, aborted, alpha), false);
  assert.equal(created.length, 1, 'An aborted request must never open a panel');
});

test('revoke(root) removes only that root and denies its pending panel', async () => {
  const alpha = '/ws/alpha';
  const beta = '/ws/beta';
  const { service, created } = fixture();
  const a = service.request('a', alpha, makeSignal(), alpha);
  const b = service.request('b', beta, makeSignal(), beta);
  created[0].hostMessage({ action: 'allowSession' });
  created[1].hostMessage({ action: 'allowSession' });
  assert.equal(await a, true);
  assert.equal(await b, true);
  assert.deepEqual(service.getGrantedRoots(), [alpha, beta]);
  service.revoke(alpha);
  assert.deepEqual(service.getGrantedRoots(), [beta], 'Revoke must remove only the named root');
  const ask = service.request('a2', alpha, makeSignal(), alpha);
  assert.equal(created.length, 3, 'A revoked root must ask again');
  created[2].hostMessage({ action: 'run' });
  assert.equal(await ask, true);
  const waiting = service.request('a3', alpha, makeSignal(), alpha);
  const panel = created[3];
  assert.equal(panel.disposed, false);
  service.revoke(alpha);
  assert.equal(await waiting, false, 'Revoke must deny and close the pending same-root request');
  assert.equal(panel.disposed, true);
  panel.hostMessage({ action: 'allowSession' });
  await sleep(20);
  assert.deepEqual(service.getGrantedRoots(), [beta], 'A stale allowSession callback must not regrant');
  assert.equal(service.pending.size, 0);
});

test('revoke() clears every grant; dispose clears grants and a fresh service starts clean', async () => {
  const { service, created } = fixture();
  const a = service.request('a', '/zz', makeSignal(), '/zz');
  const b = service.request('b', '/ww', makeSignal(), '/ww');
  created[0].hostMessage({ action: 'allowSession' });
  created[1].hostMessage({ action: 'allowSession' });
  await a;
  await b;
  assert.deepEqual(service.getGrantedRoots(), ['/ww', '/zz']);
  service.revoke();
  assert.deepEqual(service.getGrantedRoots(), [], 'Revoke without a root must clear all grants');
  const again = service.request('again', '/zz', makeSignal(), '/zz');
  created[2].hostMessage({ action: 'allowSession' });
  await again;
  assert.deepEqual(service.getGrantedRoots(), ['/zz'], 'A grant issued after revoke-all must be active');
  service.dispose();
  assert.deepEqual(service.getGrantedRoots(), [], 'Dispose must clear active grants');
  const fresh = fixture();
  assert.deepEqual(fresh.service.getGrantedRoots(), [], 'A fresh service must have no grants');
  fresh.service.dispose();
});
