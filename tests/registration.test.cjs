const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('smol-toml');
const { configuration, register } = require('../.test-build/registration');
const { fixture } = require('./helpers.cjs');

test('registration preserves comments/unrelated settings and is repeatable', () => {
  const original = '# keep comment\nmodel = "unchanged"\n[mcp_servers.other]\ncommand = "other"\n';
  const updated = configuration(original, '/Code App/bin/node', '/ext/relay.js', '/private/data');
  assert.equal(configuration(updated, '/Code App/bin/node', '/ext/relay.js', '/private/data'), updated, 'Activation repair must not rewrite unchanged config or accumulate blank lines');
  assert.ok(updated.startsWith(original));
  assert.equal(parse(updated).mcp_servers.codex_subagent.command, '/Code App/bin/node');
  const again = configuration(updated, '/new/node', '/ext/relay.js', '/private/data');
  assert.equal((again.match(/\[mcp_servers.codex_subagent\]/g) || []).length, 1);
  assert.equal(parse(again).model, 'unchanged');
  assert.equal(configuration(again, '', '', '', true).trim(), original.trim());
});

test('unmanaged tables, malformed TOML and damaged markers are not overwritten', () => {
  assert.throws(() => configuration('[mcp_servers.codex_subagent]\ncommand="mine"', 'a', 'b', 'c'), { code: 'config_conflict' });
  assert.throws(() => configuration('broken [', 'a', 'b', 'c'));
  assert.throws(() => configuration('# BEGIN codex-subagent managed MCP\n', 'a', 'b', 'c'), { code: 'config_conflict' });
});

test('config updates are backed up and do not leak bridge/model credentials', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'config.toml');
  await fs.writeFile(file, '# original\nmodel="keep"\n');
  await register(file, 'node', '/extension/relay.js', '/extension/bridges');
  assert.equal(await fs.readFile(file + '.codex-subagent.bak', 'utf8'), '# original\nmodel="keep"\n');
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /token|apiKey|authorization/i);
  await register(file, '', '', '', true);
  assert.equal(parse(await fs.readFile(file, 'utf8')).model, 'keep');
});
