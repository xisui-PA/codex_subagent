const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileTools } = require('../.test-build/workspace-tools');
const { fixture } = require('./helpers.cjs');
const signal = () => new AbortController().signal;

test('file pages, optimistic writes, permission checks and exclusive creation', async t => {
  const { root } = await fixture(t);
  let enabled = true;
  const tools = await FileTools.create([root], { canWrite: () => enabled, allowShell: () => false });
  await fs.writeFile(path.join(root, 'a.txt'), 'hello world');
  const first = JSON.parse(await tools.execute('read_file', { path: 'a.txt', limit: 5 }, 'read-only', signal()));
  assert.equal(first.content, 'hello');
  assert.equal(first.nextOffset, 5);
  await tools.execute('write_file', { path: 'a.txt', content: 'changed', expectedHash: first.hash }, 'workspace-write', signal());
  await assert.rejects(tools.execute('write_file', { path: 'a.txt', content: 'lost', expectedHash: first.hash }, 'workspace-write', signal()), { code: 'file_conflict' });
  await tools.execute('write_file', { path: 'new.txt', content: 'new', expectedHash: 'new' }, 'workspace-write', signal());
  await assert.rejects(tools.execute('write_file', { path: 'new.txt', content: 'overwrite', expectedHash: 'new' }, 'workspace-write', signal()), { code: 'file_conflict' });
  enabled = false;
  await assert.rejects(tools.execute('write_file', { path: 'b.txt', content: '', expectedHash: 'new' }, 'workspace-write', signal()), { code: 'permission_denied' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'changed');
});

test('path traversal, symlinks and protected config writes are rejected', async t => {
  const { root } = await fixture(t);
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false });
  await assert.rejects(tools.execute('read_file', { path: '../outside' }, 'read-only', signal()), { code: 'outside_workspace' });
  await fs.symlink(root, path.join(root, 'link'));
  await assert.rejects(tools.execute('list_files', { path: 'link' }, 'read-only', signal()), { code: 'symlink' });
  await fs.mkdir(path.join(root, '.vscode'));
  await assert.rejects(tools.execute('write_file', { path: '.vscode/settings.json', content: '{}', expectedHash: 'new' }, 'workspace-write', signal()), { code: 'protected_path' });
});

test('search is bounded, literal and skips symlinks/dependencies', async t => {
  const { root } = await fixture(t);
  const tools = await FileTools.create([root], { canWrite: () => false, allowShell: () => false });
  await fs.writeFile(path.join(root, 'a.txt'), 'literal.*\nliteral.*');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'literal.*');
  const result = JSON.parse(await tools.execute('search_files', { query: 'literal.*', limit: 1 }, 'read-only', signal()));
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.results[0].line, 1);
});

test('dirty document hook blocks worker writes', async t => {
  const { root } = await fixture(t);
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false, checkDocument() { throw new Error('unsaved'); } });
  await assert.rejects(tools.execute('write_file', { path: 'new.txt', content: 'new', expectedHash: 'new' }, 'workspace-write', signal()), /unsaved/);
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

test('shell never starts without approval; approved command captures exit status', async t => {
  const { root } = await fixture(t);
  let approved = false;
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: async () => approved });
  await assert.rejects(tools.execute('run_command', { command: 'echo test' }, 'workspace-write', signal()), { code: 'command_denied' });
  approved = true;
  const result = JSON.parse(await tools.execute('run_command', { command: 'echo test' }, 'workspace-write', signal()));
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /test/);
});

test('approval callback receives the canonical owner root, not the command cwd', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'child'));
  const captured = [];
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: async (...args) => { captured.push(args); return false; } });
  await assert.rejects(tools.execute('run_command', { command: 'echo test', path: 'child' }, 'workspace-write', signal()), { code: 'command_denied' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0][0], 'echo test');
  assert.equal(captured[0][1], await fs.realpath(path.join(root, 'child')), 'The command cwd must be the resolved child directory');
  assert.equal(captured[0][3], await fs.realpath(root), 'The fourth argument must be the canonical owner root, not the child cwd');
});

test('permission gates block run_command before the approval callback', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  let tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => true, approveCommand: async () => { calls++; return true; } });
  await assert.rejects(tools.execute('run_command', { command: 'echo test' }, 'read-only', signal()), { code: 'permission_denied' });
  tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false, approveCommand: async () => { calls++; return true; } });
  await assert.rejects(tools.execute('run_command', { command: 'echo test' }, 'workspace-write', signal()), { code: 'permission_denied' });
  assert.equal(calls, 0, 'The approver must never be consulted when permission or allowShell is off');
});

test('workers can create directory trees without shell access', async t => {
  const { root } = await fixture(t);
  const tools = await FileTools.create([root], { canWrite: () => true, allowShell: () => false });
  await tools.execute('create_directory', { path: 'src' }, 'workspace-write', signal());
  await tools.execute('create_directory', { path: 'src' }, 'workspace-write', signal());
  await tools.execute('create_directory', { path: 'src/feature' }, 'workspace-write', signal());
  await tools.execute('write_file', { path: 'src/feature/a.txt', content: 'created', expectedHash: 'new' }, 'workspace-write', signal());
  assert.equal(await fs.readFile(path.join(root, 'src/feature/a.txt'), 'utf8'), 'created');
  await assert.rejects(tools.execute('create_directory', { path: 'another' }, 'read-only', signal()), { code: 'permission_denied' });
});
