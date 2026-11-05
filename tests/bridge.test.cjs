const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { BridgeHost, discover, forward } = require('../.test-build/bridge');
const { invoke } = require('../.test-build/api');
const { fixture } = require('./helpers.cjs');

async function hostFixture(t) {
  const f = await fixture(t);
  const registry = path.join(f.root, 'bridges');
  const host = new BridgeHost();
  await host.start(registry, [f.root], (name, args, signal) => invoke(f.engine, name, args, signal));
  t.after(() => host.close());
  return { ...f, registry, host };
}
function status(descriptor, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: descriptor.port, path: '/invoke', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end('{}');
  });
}

test('bridge rejects missing credentials and browser origins', async t => {
  const { root, registry } = await hostFixture(t);
  const d = await discover(registry, root);
  assert.equal(await status(d, {}), 401);
  assert.equal(await status(d, { Authorization: `Bearer ${d.token}`, Origin: 'http://untrusted.example' }), 403);
  const result = await forward(registry, root, 'subagent_models', {});
  assert.equal(JSON.parse(result.content[0].text).models[0].id, 'byok/qwen');
  if (process.platform !== 'win32') {
    const entries = await fs.readdir(registry);
    assert.equal((await fs.stat(path.join(registry, entries[0]))).mode % 0o1000, 0o600);
  }
});

test('relay uses the correct workspace and reconnects after host restart', async t => {
  const { root, registry, host, engine } = await hostFixture(t);
  const models = await forward(registry, root, 'subagent_models', {});
  assert.equal(models.isError, undefined);
  await assert.rejects(discover(registry, path.dirname(root)), { code: 'host_unavailable' });
  await host.close();
  await host.start(registry, [root], (name, args, signal) => invoke(engine, name, args, signal));
  const reconnected = await forward(registry, root, 'subagent_list', {});
  assert.deepEqual(JSON.parse(reconnected.content[0].text).workers, []);
});

test('real MCP stdio client initializes, discovers tools, spawns and reads a worker', async t => {
  const { root, registry, engine } = await hostFixture(t);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/relay.js'), '--registry', registry], cwd: root, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'subagent_spawn'));
  const spawned = await client.callTool({ name: 'subagent_spawn', arguments: { requestId: 'stdio-spawn', task: 'Test the full bridge' } });
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  const worker = JSON.parse(spawned.content[0].text);
  assert.equal(engine.store.all().length, 1);
  const retried = await client.callTool({ name: 'subagent_spawn', arguments: { requestId: 'stdio-spawn', task: 'Test the full bridge' } });
  assert.equal(JSON.parse(retried.content[0].text).id, worker.id);
  const waited = await client.callTool({ name: 'subagent_wait', arguments: { ids: [worker.id], timeoutMs: 1000 } });
  assert.equal(JSON.parse(waited.content[0].text).workers[0].state, 'completed');
  const result = await client.callTool({ name: 'subagent_status', arguments: { id: worker.id, messageLimit: 20 } });
  assert.equal(JSON.parse(result.content[0].text).output, 'done');
  assert.equal(JSON.parse(result.content[0].text).messages.length, 2);
});

test('MCP can initialize before VS Code starts and reports a recoverable missing host', async t => {
  const { root } = await fixture(t);
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/relay.js'), '--registry', path.join(root, 'missing')], cwd: root, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length > 0);
  const result = await client.callTool({ name: 'subagent_list', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /host_unavailable/);
});
