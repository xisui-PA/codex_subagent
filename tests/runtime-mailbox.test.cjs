const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// Focused runtime tests run against an explicitly chosen compiled build. The
// default is the shared .test-build; a parallel worker compiles the same sources
// into its own ignored directory and points CODEX_TEST_BUILD at it, so these
// assertions never depend on another worker's in-flight build.
const build = path.resolve(__dirname, '..', process.env.CODEX_TEST_BUILD || '.test-build');
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults } = require(path.join(build, 'engine'));
const { failure } = require(path.join(build, 'types'));
const { workspaceDirectory } = require(path.join(build, 'workspaces'));
const { SessionStore } = require(path.join(build, 'storage'));
const { workerMailboxTools } = require(path.join(build, 'mailbox-tools'));
const { resourceDefaults, storageUsage } = require(path.join(build, 'resource-governor'));

/**
 * Opt-in durable team mail through the broker runtime.
 *  - RuntimeOptions.messagingEnabled is a separate live opt-in on top of
 *    taskBoardEnabled and defaults off: every mailbox call fails closed, no
 *    mailbox storage is created and health keeps its legacy shape.
 *  - Coordinator mailbox calls take the trusted ownerId; a forged actor field,
 *    a missing ownerId or another coordinator is refused.
 *  - A worker's mailbox identity is its scoped session: owner/actor fields are
 *    stripped from its strict schema and rejected as invalid_arguments.
 *  - Live team membership is rechecked on every call, and a message addressed
 *    to a stopped worker is only persisted: nothing is started or resumed.
 */

const model = { id: 'byok/qwen', name: 'Qwen', vendor: 'test', family: 'qwen', version: '1', maxInputTokens: 100_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Condition timed out');
    }
    await sleep(5);
  }
};

const OWNER = 'mail-owner';
const OTHER_OWNER = 'intruder-owner';
const TEAM_FALLBACK = 'a'.repeat(32);
const TASK_FALLBACK = '1'.repeat(32);

const entity = (value, key) => value && typeof value === 'object' && value[key] && typeof value[key] === 'object' ? value[key] : value;
const taskOf = value => entity(value, 'task');
const teamOf = value => entity(value, 'team');
const safe = text => { try { return JSON.parse(text); } catch { return undefined; } };
const listOf = value => Array.isArray(value?.messages) ? value.messages : [];
const unreadOf = value => value?.unread ?? {};

async function fixture(t, stream = async function* () { yield { type: 'text', text: 'idle' }; }) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-mailbox-')));
  const root = path.join(temporary, 'repo');
  await fs.mkdir(root);
  const requests = [];
  const provider = {
    models: async () => [model],
    countTokens: async () => 10,
    async *stream(selected, messages, tools, signal) {
      requests.push({ model: selected, messages, tools });
      yield* stream(selected, messages, tools, signal);
    }
  };
  // Real resource governance is opt-in per test and off by default, exactly like
  // the runtime's own switch: a test can enable it after setup and tighten the
  // storage policy without changing any other test in this file.
  const state = { governed: false, config: { ...resourceDefaults, enabled: false } };
  const options = {
    storage: path.join(temporary, 'storage'), registry: path.join(temporary, 'registry'), roots: [root], identity: `folder:${root}`,
    provider,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, numSessions: 2 } } }),
    files: { canWrite: () => true, allowShell: () => false },
    resourcesEnabled: () => state.governed,
    resources: () => state.config,
    resourceDirectory: path.join(temporary, 'resources'),
    onChange() {}, onError() {}
  };
  const brokers = [];
  const create = async extra => {
    const broker = new WorkerBroker({ ...options, ...extra });
    brokers.push(broker);
    await broker.start();
    return broker;
  };
  t.after(async () => {
    for (const broker of brokers.reverse()) {
      await broker.close();
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { root, temporary, options, create, requests, state };
}

const done = async (broker, root, id) => {
  await until(async () => !['queued', 'running'].includes((await broker.session(root, id)).state));
  return broker.session(root, id);
};
const call = async (broker, root, name, args) => unpack(await broker.invoke(root, name, args));
const errorOf = async (broker, root, name, args) => {
  try {
    await call(broker, root, name, args);
    return undefined;
  } catch (error) {
    return failure(error);
  }
};

/** Team, one live member worker and one task in that team. */
async function seed(broker, root, members = []) {
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'seed-team', name: 'Mail team', description: 'Shared work' }));
  const joined = members.length
    ? teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'seed-members', teamId: team.id, expectedRevision: team.revision, addMembers: members }))
    : team;
  const task = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'seed-task', teamId: team.id, title: 'Mail task', description: 'Mail work item' }));
  return { team: joined, task };
}

/** A second team with its own requestId prefix, so one member can belong to both. */
async function seedAnother(broker, root, prefix, members = []) {
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: `${prefix}-team`, name: 'Second team', description: 'Second work' }));
  const joined = members.length
    ? teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: `${prefix}-members`, teamId: team.id, expectedRevision: team.revision, addMembers: members }))
    : team;
  const task = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: `${prefix}-task`, teamId: team.id, title: 'Second task', description: 'Second work item' }));
  return { team: joined, task };
}

const sendArgs = (teamId, taskId, extra = {}) => ({ ownerId: OWNER, teamId, taskId, requestId: 'send-1', kind: 'question', body: 'please check the seam', ...extra });

async function findMailboxFiles(directory) {
  const found = [];
  const walk = async at => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const next = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.name.startsWith('mailbox')) {
        found.push(next);
      }
    }
  };
  if (await fs.stat(directory).then(stat => stat.isDirectory(), () => false)) {
    await walk(directory);
  }
  return found;
}

test('team mail is off by default: every mailbox call is refused and no mailbox storage is created', async t => {
  const { root, options, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true });
  const probes = [
    ['subagent_mailbox_send', sendArgs(TEAM_FALLBACK, TASK_FALLBACK)],
    ['subagent_mailbox_list', { ownerId: OWNER, teamId: TEAM_FALLBACK }],
    ['subagent_mailbox_ack', { ownerId: OWNER, teamId: TEAM_FALLBACK, ids: [TASK_FALLBACK] }]
  ];
  for (const [name, args] of probes) {
    assert.equal((await errorOf(broker, root, name, args))?.code, 'feature_disabled', `${name} must be refused while team mail is disabled`);
  }
  // The separate opt-in can never enable mail without the board, and a refused
  // call never opens a store.
  const boardOff = await create({ messagingEnabled: () => true });
  assert.equal((await errorOf(boardOff, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: TEAM_FALLBACK }))?.code, 'feature_disabled');
  assert.deepEqual(await findMailboxFiles(options.storage), [], 'a disabled mailbox writes no mailbox file');

  const health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.ready, true);
  assert.equal(health.taskBoard.enabled, true);
  assert.equal('messaging' in health, false, 'legacy health responses keep their exact shape');

  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'solo', task: 'standalone work', ownerId: OWNER }));
  assert.equal((await done(broker, root, worker.id)).state, 'completed', 'legacy workers stay usable');
  assert.equal(requests[0].tools.some(tool => tool.name.startsWith('subagent_mailbox_')), false, 'a disabled feature advertises no mailbox tool');
});

test('enabled: coordinator mail is durable and reaches a stopped worker without starting it', async t => {
  const { root, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'wait for mail', ownerId: OWNER }));
  await done(broker, root, worker.id);
  const { team, task } = await seed(broker, root, [worker.id]);
  const before = requests.length;

  const sent = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [worker.id] })), 'message');
  assert.match(sent.id, /^[a-f0-9]{32}$/);
  assert.equal(sent.teamId, team.id);
  // A message to a stopped recipient is only persisted: nothing starts it.
  const stopped = await broker.session(root, worker.id);
  assert.equal(stopped.state, 'completed');
  assert.equal(requests.length, before, 'sending starts no inference');
  assert.equal(stopped.turns.length, 1, 'no new turn was created for the recipient');

  const page = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id });
  assert.deepEqual(listOf(page).map(message => message.id), [sent.id], 'the message is durable and listed for its coordinator');
  assert.ok(listOf(page).some(message => message.deliveries?.some(delivery => delivery.recipient.workerId === worker.id && !delivery.deliveredAt)), 'the durable record still shows the message as not yet delivered');
  const unread = unreadOf(page);
  assert.deepEqual([typeof unread.addressed, typeof unread.undelivered, typeof unread.pendingAck], ['number', 'number', 'number'], 'the page carries unread metadata for the caller inbox');

  const ack = await call(broker, root, 'subagent_mailbox_ack', { ownerId: OWNER, teamId: team.id, ids: [sent.id] });
  assert.deepEqual(ack.ignored, [sent.id], 'acknowledgement is receiver-only, so a sender cannot acknowledge its own message');
  const after = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id });
  assert.equal(listOf(after).length, 1, 'acknowledging keeps the message');

  const health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.messaging.enabled, true, 'health reports the opt-in only when it is enabled');
});

test('coordinator identity is trusted: missing, forged or foreign actors are refused', async t => {
  const { root, create } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  const outsider = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'outsider', task: 'outsider work', ownerId: OWNER }));
  await done(broker, root, outsider.id);
  const { team, task } = await seed(broker, root, [member.id]);

  const missing = sendArgs(team.id, task.id, { recipients: [member.id] });
  delete missing.ownerId;
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', missing))?.code, 'invalid_arguments', 'ownerId is required');
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id], workerId: member.id })))?.code, 'invalid_arguments', 'a worker actor field is never accepted');
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id], actor: { kind: 'coordinator', ownerId: OTHER_OWNER } })))?.code, 'invalid_arguments', 'an actor object is never accepted');

  assert.equal((await errorOf(broker, root, 'subagent_mailbox_list', { ownerId: OTHER_OWNER, teamId: team.id }))?.code, 'forbidden', 'another coordinator cannot read the team');
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', { ...sendArgs(team.id, task.id, { recipients: [member.id] }), ownerId: OTHER_OWNER }))?.code, 'forbidden', 'another coordinator cannot write to the team');

  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [outsider.id] })))?.code, 'recipient_invalid', 'a non-member recipient is refused');
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id], toCoordinator: true })))?.code, 'recipient_invalid', 'a coordinator cannot address itself');
});

test('live revocation: a removed member can no longer be addressed or read for', async t => {
  const { root, create } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  const { team, task } = await seed(broker, root, [member.id]);
  const sent = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id] })), 'message');
  assert.equal(sent.id.length, 32);

  const revoked = teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'revoke', teamId: team.id, expectedRevision: team.revision, removeMembers: [member.id] }));
  assert.deepEqual(revoked.memberWorkerIds, []);
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { requestId: 'send-2', recipients: [member.id] })))?.code, 'recipient_invalid', 'the mailbox rechecks live membership on every call');
  const page = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id });
  assert.deepEqual(listOf(page).map(message => message.id), [sent.id], 'already durable messages stay readable');
});

/** One worker-scoped surface bound to a known session; base stays authoritative for files. */
function scopedTools(session, options, port) {
  const base = {
    workspaceRoot: 'C:\\repo',
    definitions: () => [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
    execute: async () => 'base'
  };
  return workerMailboxTools(port, session, options, base);
}

test('worker mailbox tools take identity from the session, strip actor fields and gate the wait tool', async () => {
  const seen = [];
  const port = {
    send: (actor, input) => { seen.push({ actor, input }); return { id: 'c'.repeat(32), teamId: input.teamId }; },
    list: (actor, input) => { seen.push({ actor, input }); return { messages: [], unread: {} }; },
    acknowledge: (actor, input) => { seen.push({ actor, input }); return { teamId: input.teamId, acknowledged: input.ids }; }
  };
  const session = { id: 'd'.repeat(32) };
  const legacy = scopedTools(session, { enabled: () => true, onChange() {} }, port);
  const names = legacy.definitions('read-only').map(tool => tool.name);
  assert.deepEqual(names, ['read_file', 'subagent_mailbox_send', 'subagent_mailbox_list', 'subagent_mailbox_ack'], 'a legacy worker sees mail but never the governed wait tool');
  assert.deepEqual(await legacy.definitions('read-only').length, 4);
  await assert.rejects(() => legacy.execute('subagent_mailbox_wait', { teamId: 'a'.repeat(32), messageId: 'b'.repeat(32) }, 'read-only', new AbortController().signal),
    error => failure(error).code === 'permission_denied', 'a legacy worker can never call the governed wait tool');
  await legacy.execute('subagent_mailbox_list', { teamId: TEAM_FALLBACK }, 'read-only', new AbortController().signal);
  assert.deepEqual(seen.at(-1).actor, { kind: 'worker', workerId: session.id }, 'the worker identity is the scoped session');
  await assert.rejects(() => legacy.execute('subagent_mailbox_send', { teamId: TEAM_FALLBACK, taskId: TASK_FALLBACK, requestId: 'r', kind: 'question', body: 'x', workerId: session.id }, 'read-only', new AbortController().signal),
    error => failure(error).code === 'invalid_arguments', 'a worker cannot name another actor');
  await assert.rejects(() => legacy.execute('subagent_mailbox_list', { teamId: TEAM_FALLBACK, ownerId: OTHER_OWNER }, 'read-only', new AbortController().signal),
    error => failure(error).code === 'invalid_arguments', 'a worker cannot name a coordinator');

  // A live nonmember never sees a mailbox tool, and an unreadable membership
  // check hides them instead of guessing.
  assert.deepEqual(scopedTools(session, { enabled: () => true, member: () => false, onChange() {} }, port).definitions('read-only').map(tool => tool.name), ['read_file']);
  assert.deepEqual(scopedTools(session, { enabled: () => true, member: () => { throw new Error('board unavailable'); }, onChange() {} }, port).definitions('read-only').map(tool => tool.name), ['read_file']);

  // A disabled feature never advertises or executes a mailbox tool.
  const off = scopedTools(session, { enabled: () => false, onChange() {} }, port);
  assert.deepEqual(off.definitions('read-only').map(tool => tool.name), ['read_file']);
  await assert.rejects(() => off.execute('subagent_mailbox_list', { teamId: TEAM_FALLBACK }, 'read-only', new AbortController().signal),
    error => failure(error).code === 'feature_disabled');

  // Only a started governed worker bound to this host gets the wait tool, and
  // its call is forwarded to the host lifecycle hook with the session identity.
  const waits = [];
  const governed = scopedTools({ id: 'e'.repeat(32), schema: 3, mode: 'governed', isolatedView: { snapshotId: 'f'.repeat(64), teamId: TEAM_FALLBACK }, startup: { phase: 'started' } },
    { enabled: () => true, onChange() {}, wait: async (teamId, messageId, signal) => { waits.push({ teamId, messageId, aborted: signal.aborted }); return { state: 'waiting' }; } }, port);
  assert.deepEqual(governed.definitions('read-only').map(tool => tool.name), ['read_file', 'subagent_mailbox_send', 'subagent_mailbox_list', 'subagent_mailbox_ack', 'subagent_mailbox_wait']);
  assert.equal(safe(await governed.execute('subagent_mailbox_wait', { teamId: TEAM_FALLBACK, messageId: 'b'.repeat(32) }, 'read-only', new AbortController().signal)).state, 'waiting');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].teamId, TEAM_FALLBACK);
  await assert.rejects(() => governed.execute('subagent_mailbox_wait', { teamId: TEAM_FALLBACK, messageId: 'b'.repeat(32), workerId: 'a'.repeat(32) }, 'read-only', new AbortController().signal),
    error => failure(error).code === 'invalid_arguments', 'the wait input carries no actor fields');

  // A governed worker is bound to ONE team, exactly like automatic delivery and
  // the host peer wait: its own tools refuse another team BEFORE forwarding, even
  // when the board lists it as a live member of both. An unbound legacy member
  // keeps access to every live team.
  const other = 'b'.repeat(32);
  const forwarded = [];
  const peerWaits = [];
  const teamPort = {
    send: (actor, input, guard) => { guard?.(); forwarded.push(['send', input.teamId]); return { id: 'c'.repeat(32), teamId: input.teamId }; },
    list: (actor, input) => { forwarded.push(['list', input.teamId]); return { messages: [], unread: {} }; },
    acknowledge: (actor, input, guard) => { guard?.(); forwarded.push(['ack', input.teamId]); return { teamId: input.teamId, acknowledged: input.ids }; }
  };
  const boundWorker = scopedTools({ id: 'e'.repeat(32), schema: 3, mode: 'governed', isolatedView: { snapshotId: 'f'.repeat(64), teamId: TEAM_FALLBACK }, startup: { phase: 'started', teamId: TEAM_FALLBACK } },
    { enabled: () => true, onChange() {}, wait: async teamId => { peerWaits.push(teamId); return { state: 'waiting' }; } }, teamPort);
  const probes = [
    ['subagent_mailbox_send', { teamId: other, taskId: TASK_FALLBACK, requestId: 'dual', kind: 'question', body: 'cross-team', recipients: ['a'.repeat(32)] }],
    ['subagent_mailbox_list', { teamId: other }],
    ['subagent_mailbox_ack', { teamId: other, ids: ['a'.repeat(32)] }]
  ];
  for (const [name, input] of probes) {
    await assert.rejects(() => boundWorker.execute(name, input, 'workspace-write', new AbortController().signal),
      error => failure(error).code === 'forbidden', `${name} must refuse a team this worker is not bound to`);
  }
  await assert.rejects(() => boundWorker.execute('subagent_mailbox_wait', { teamId: other, messageId: 'b'.repeat(32) }, 'workspace-write', new AbortController().signal),
    error => failure(error).code === 'forbidden', 'a peer wait may only reference the bound team');
  assert.deepEqual(forwarded, [], 'a refused call never reaches the mailbox port');
  assert.deepEqual(peerWaits, [], 'a refused wait is never registered');

  // The bound team itself stays fully usable, including the commit guard.
  assert.equal(safe(await boundWorker.execute('subagent_mailbox_list', { teamId: TEAM_FALLBACK }, 'workspace-write', new AbortController().signal)).messages.length, 0);
  await boundWorker.execute('subagent_mailbox_send', { teamId: TEAM_FALLBACK, taskId: TASK_FALLBACK, requestId: 'same', kind: 'question', body: 'y', recipients: ['a'.repeat(32)] }, 'workspace-write', new AbortController().signal);
  assert.deepEqual(forwarded, [['list', TEAM_FALLBACK], ['send', TEAM_FALLBACK]]);
  // An unbound legacy member is not restricted to one team.
  const legacyTeams = scopedTools(session, { enabled: () => true, onChange() {} }, teamPort);
  await legacyTeams.execute('subagent_mailbox_list', { teamId: other }, 'read-only', new AbortController().signal);
  assert.deepEqual(forwarded.at(-1), ['list', other]);
});
test('a session mode that disagrees with its binding never grants the governed wait tool', async () => {
  const port = { send: () => ({ id: 'c'.repeat(32), teamId: TEAM_FALLBACK }), list: () => ({ messages: [], unread: {} }), acknowledge: () => ({ teamId: TEAM_FALLBACK, acknowledged: [] }) };
  const view = { snapshotId: 'f'.repeat(64), teamId: TEAM_FALLBACK };
  const startup = { phase: 'started', teamId: TEAM_FALLBACK };
  const waited = { enabled: () => true, onChange() {}, wait: async () => ({ state: 'waiting' }) };
  const names = candidate => scopedTools(candidate, waited, port).definitions('read-only').map(tool => tool.name);
  assert.ok(names({ id: 'e'.repeat(32), mode: 'governed', isolatedView: view, startup }).includes('subagent_mailbox_wait'),
    'the current governed mode with its bound view keeps the wait tool');
  // Schema 3 alone is not governance: a record whose explicit mode is not
  // governed must never be granted the host-bound wait, whatever fields it
  // still carries, and an unknown mode fails closed the same way.
  for (const mode of ["standalone","isolated","unknown"]) {
    assert.ok(!names({ id: 'e'.repeat(32), schema: 3, mode, isolatedView: view, startup }).includes('subagent_mailbox_wait'),
      'mode ' + mode + ' must not receive the governed wait tool');
    await assert.rejects(() => scopedTools({ id: 'e'.repeat(32), schema: 3, mode, isolatedView: view, startup }, waited, port)
      .execute('subagent_mailbox_wait', { teamId: TEAM_FALLBACK, messageId: 'b'.repeat(32) }, 'read-only', new AbortController().signal),
      error => failure(error).code === 'permission_denied', 'mode ' + mode + ' can never call the governed wait tool');
  }
  // A governed mode still needs its permanent binding and a started startup.
  assert.ok(!names({ id: 'e'.repeat(32), mode: 'governed', startup }).includes('subagent_mailbox_wait'),
    'a governed record without its view gets no wait tool');
  assert.ok(!names({ id: 'e'.repeat(32), mode: 'governed', isolatedView: view, startup: { phase: 'created', teamId: TEAM_FALLBACK } }).includes('subagent_mailbox_wait'),
    'a governed record that is not started gets no wait tool');
});

test('a corrupt or unreadable mailbox never disturbs a standalone worker and stays hidden from nonmembers', async t => {
  const errors = [];
  const { root, options, create } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true, onError: message => errors.push(message) });
  // A durable but malformed mailbox record beside a healthy board.
  const directory = await workspaceDirectory(options.storage, root);
  await fs.mkdir(path.join(directory, 'mailbox'), { recursive: true });
  const corrupt = '{"schema":1,'
  await fs.writeFile(path.join(directory, 'mailbox', 'mailbox.json'), corrupt);

  // A worker with no team is a nonmember: its turn must neither open nor
  // depend on the mailbox, and it must still complete.
  const standalone = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'standalone', task: 'independent work', ownerId: OWNER }));
  assert.equal((await done(broker, root, standalone.id)).state, 'completed');
  let health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.equal(health.messaging.enabled, true);
  assert.equal(health.messaging.error, undefined, 'a nonmember turn never opened the malformed mailbox');

  // A live member is authorized, so the malformed mailbox is opened, reported
  // and cached: automatic delivery fails closed while every turn still runs.
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  const { team } = await seed(broker, root, [member.id]);
  unpack(await broker.invoke(root, 'subagent_send', { id: member.id, requestId: 'follow', message: 'continue', ownerId: OWNER }));
  assert.equal((await done(broker, root, member.id)).state, 'completed', 'a corrupt mailbox never fails a member turn');
  assert.deepEqual(errors, [], 'a corrupt mailbox is never reported as a worker failure');

  // An explicit call still surfaces the real failure for its coordinator.
  assert.equal((await errorOf(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id }))?.code, 'mailbox_malformed');
  health = unpack(await broker.invoke(root, 'subagent_health', {}));
  assert.match(health.messaging.error, /mailbox_malformed/, 'health reports the cached failure only when enabled');
  assert.equal(await fs.readFile(path.join(directory, 'mailbox', 'mailbox.json'), 'utf8'), corrupt, 'a malformed mailbox is never rewritten');
});

test('a live member receives durable mail on its next turn, records delivery once, and keeps it across compaction and reload', async t => {
  const { root, options, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, worker.id);
  const { team, task } = await seed(broker, root, [worker.id]);
  const sent = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [worker.id] })), 'message');
  assert.equal(listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id }))[0].deliveries[0].deliveredAt, undefined, 'a send alone delivers nothing');

  // The member is already running here, so its own prompt receives the durable
  // message: nothing was started to make that happen.
  unpack(await broker.invoke(root, 'subagent_send', { id: worker.id, requestId: 'follow', message: 'continue', ownerId: OWNER }));
  assert.equal((await done(broker, root, worker.id)).state, 'completed');
  const prompt = JSON.stringify(requests.at(-1).messages);
  assert.match(prompt, /Peer mailbox delivery/, 'the running worker received the peer block');
  assert.ok(prompt.includes(sent.id), 'the notice carries the durable message identity');

  let page = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id });
  const [deliveredMessage] = listOf(page);
  assert.equal(typeof deliveredMessage.deliveries[0].deliveredAt, 'number', 'the provider-received message is recorded delivered');
  assert.equal(deliveredMessage.deliveries[0].acknowledgedAt, undefined, 'delivery never acknowledges the message');

  // The receipt is durable, so a later turn REPLAYS the one retained block from
  // history instead of injecting the notice again.
  unpack(await broker.invoke(root, 'subagent_send', { id: worker.id, requestId: 'again', message: 'continue', ownerId: OWNER }));
  await done(broker, root, worker.id);
  const replay = JSON.stringify(requests.at(-1).messages);
  assert.equal(replay.split('Peer mailbox delivery').length - 1, 1, 'the retained input is replayed exactly once');
  assert.ok(replay.includes(sent.id), 'the message id stays available for a reply');
  assert.ok(replay.includes('please check the seam'), 'the message body stays available');

  // Compaction and a reload keep the record and never restart anything.
  const latest = await broker.session(root, worker.id);
  const compacted = await call(broker, root, 'subagent_compact', { id: worker.id, ownerId: OWNER, revision: latest.revision, summary: 'worker continued twice' });
  assert.equal(compacted.id, worker.id);
  const archived = await broker.session(root, worker.id);
  assert.equal(archived.messages.length, 0, 'the live transcript is archived');
  await broker.close();
  // The archive holds the delivered input: compaction never drops what the worker
  // was actually shown.
  const store = new SessionStore(await workspaceDirectory(options.storage, root));
  await store.open();
  const history = await store.history(worker.id, 0, 200);
  await store.close();
  assert.match(JSON.stringify(history.messages), /Peer mailbox delivery/, 'compaction archives the delivered input');
  assert.ok(JSON.stringify(history.messages).includes(sent.id));
  const reopened = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  page = await call(reopened, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id });
  assert.deepEqual(listOf(page).map(message => message.id), [sent.id], 'the message survives compaction and reload');
  assert.equal(typeof listOf(page)[0].deliveries[0].deliveredAt, 'number', 'its delivery receipt survives too');
  assert.equal((await reopened.session(root, worker.id)).state, 'completed', 'mail never restarts a stopped worker');
});

// Regression for the fixed raw notice byte gate: the same durable message keeps
// growing as other recipients are delivered and acknowledged. With maximum
// identity strings, a 1024-NUL body and exact references it crosses the old
// 8 KiB gate while the remaining recipient has not been served yet.
test('a notice whose receipt grew past the old raw gate still reaches the remaining recipient', async t => {
  const { root, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const owner = 'p'.repeat(200);
  const ids = [];
  for (const name of ['sender', 'one', 'two', 'three']) {
    const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: name, task: name, ownerId: owner }));
    await done(broker, root, worker.id);
    ids.push(worker.id);
  }
  const [sender, one, two, three] = ids;
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: owner, requestId: 'big-team', name: 'Big team', description: '' }));
  const joined = teamOf(await call(broker, root, 'subagent_team_update', {
    ownerId: owner, requestId: 'big-members', teamId: team.id, expectedRevision: team.revision, addMembers: ids
  }));
  const task = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: owner, requestId: 'big-task', teamId: team.id, title: 'Big task', description: '' }));

  const local = broker.local.get(root);
  const senderTools = workerMailboxTools(local.mailbox, { id: sender }, { enabled: () => true, onChange() {} },
    { workspaceRoot: root, definitions: () => [], execute: async () => '' });
  const max = Number.MAX_SAFE_INTEGER;
  await senderTools.execute('subagent_mailbox_send', {
    teamId: joined.id, taskId: task.id, requestId: 'big-notice', kind: 'artifact_ready',
    body: '\u0000'.repeat(1024), recipients: [one, two, three], toCoordinator: true,
    artifact: { id: 'a'.repeat(64), version: max, uri: 'codex-subagent://submission/' + 'a'.repeat(64) + '/' + 'a'.repeat(64) + '/' + max },
    evidence: { id: 'b'.repeat(32), version: 1, uri: 'urn:codex-runner-result:' + 'c'.repeat(64) + ':' + 'b'.repeat(32) },
    attempt: { id: 'd'.repeat(64), revision: max }
  }, 'workspace-write', new AbortController().signal);

  const inbox = async () => listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: owner, teamId: joined.id }));
  const [sent] = await inbox();
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 8 * 1024, 'the untouched notice fits the old gate');

  // Two other workers are delivered and acknowledged; the coordinator acknowledges.
  for (const recipient of [one, two]) {
    await local.mailbox.delivered({ kind: 'worker', workerId: recipient }, joined.id, [sent.id]);
    await local.mailbox.acknowledge({ kind: 'worker', workerId: recipient }, { teamId: joined.id, ids: [sent.id] });
  }
  await call(broker, root, 'subagent_mailbox_ack', { ownerId: owner, teamId: joined.id, ids: [sent.id] });

  const [grown] = await inbox();
  const grownBytes = Buffer.byteLength(JSON.stringify(grown));
  assert.ok(grownBytes > 8 * 1024, 'receipt growth crosses the old 8 KiB raw gate (' + grownBytes + ' bytes)');
  assert.ok(grownBytes <= 16 * 1024, 'the whole legal notice still fits the fixed gate (' + grownBytes + ' bytes)');
  assert.equal(grown.deliveries.find(delivery => delivery.recipient.workerId === three).deliveredAt, undefined,
    'the remaining recipient is still undelivered');

  // The remaining worker's next turn receives the COMPLETE automatic envelope.
  unpack(await broker.invoke(root, 'subagent_send', { id: three, requestId: 'remaining-turn', message: 'continue', ownerId: owner }));
  await done(broker, root, three);
  const prompt = JSON.stringify(requests.at(-1).messages);
  assert.match(prompt, /Peer mailbox delivery/);
  assert.ok(prompt.includes(sent.id), 'the full notice identity reaches the remaining recipient');
  const delivered = (await inbox()).find(message => message.id === sent.id);
  assert.equal(typeof delivered.deliveries.find(delivery => delivery.recipient.workerId === three).deliveredAt, 'number',
    'the remaining recipient records delivery');
  assert.equal(delivered.deliveries.find(delivery => delivery.recipient.workerId === three).acknowledgedAt, undefined);
});

const offeredMailTools = tools => tools.map(tool => tool.name).filter(name => name.startsWith('subagent_mailbox_')).sort();

test('only a live member is offered mailbox tools, and a cancelled coordinator write persists nothing', async t => {
  const { root, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  const { team, task } = await seed(broker, root, [member.id]);
  assert.deepEqual(offeredMailTools(requests[0].tools), [], 'a nonmember turn is offered no mailbox tool');

  unpack(await broker.invoke(root, 'subagent_send', { id: member.id, requestId: 'turn', message: 'go', ownerId: OWNER }));
  await done(broker, root, member.id);
  assert.deepEqual(offeredMailTools(requests.at(-1).tools), ['subagent_mailbox_ack', 'subagent_mailbox_list', 'subagent_mailbox_send'], 'a live member is offered the member tools and never the governed wait');

  // A cancellation that arrives before the publication is honored by the same
  // live guard the domain calls immediately before its durable rename.
  const cancelled = new AbortController();
  cancelled.abort();
  const refused = await broker.invoke(root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { requestId: 'cancelled', recipients: [member.id] }), cancelled.signal);
  assert.equal(refused.isError, true, 'a cancelled send is refused');
  assert.deepEqual(listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id })), [], 'a refused send persists nothing');

  // Revoking membership hides the definitions again on the very next turn.
  await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'revoke', teamId: team.id, expectedRevision: team.revision, removeMembers: [member.id] });
  unpack(await broker.invoke(root, 'subagent_send', { id: member.id, requestId: 'turn-2', message: 'go', ownerId: OWNER }));
  await done(broker, root, member.id);
  assert.deepEqual(offeredMailTools(requests.at(-1).tools), [], 'a revoked member is offered no mailbox tool');
});

test('an idempotent retry takes no write reservation while a new write still needs one', async t => {
  const { root, create, state } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  const { team, task } = await seed(broker, root, [member.id]);

  const sent = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id] })), 'message');
  assert.equal(sent.sequence, 1);
  // Setup only: the member's own tool surface addresses the coordinator, so the
  // coordinator really owns a first acknowledgement to make later.
  const local = broker.local.get(root);
  const memberTools = workerMailboxTools(local.mailbox, { id: member.id }, { enabled: () => true, onChange() {} },
    { workspaceRoot: root, definitions: () => [], execute: async () => '' });
  await memberTools.execute('subagent_mailbox_send', {
    teamId: team.id, taskId: task.id, requestId: 'member-to-coordinator', kind: 'discovery', body: 'from the member', toCoordinator: true
  }, 'workspace-write', new AbortController().signal);
  const inboxOf = async () => listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id, direction: 'inbox' }));
  const [fromMember] = await inboxOf();
  assert.equal(fromMember.sender.kind, 'worker');

  // Exhaust the REAL governed budget after setup: the store is accounted with a
  // ballast file, so even the 4 MiB service reservation no longer fits inside the
  // 64 MiB ceiling and a call that must write is refused instead of queueing.
  const directory = local.store.directory;
  await fs.writeFile(path.join(directory, 'retained.bin'), Buffer.alloc(60 * 1024 ** 2));
  state.governed = true;
  state.config = { ...resourceDefaults, enabled: true, storageBytes: 64 * 1024 ** 2 };
  const usage = await storageUsage(directory);
  assert.ok(usage <= state.config.storageBytes, 'retained bytes stay inside the ceiling');
  assert.ok(usage + 4 * 1024 ** 2 > state.config.storageBytes * 0.875, 'no service reservation fits the work lane');
  const realAcquire = broker.resources.acquire.bind(broker.resources);
  let admissions = 0;
  broker.resources.acquire = (...args) => {
    if (args[0]?.kind === 'storage') {
      admissions += 1;
    }
    return realAcquire(...args);
  };
  t.after(() => {
    broker.resources.acquire = realAcquire;
  });
  // The store write fence is the other half of "no write": a no-op retry must not
  // even take it, while the admitted write must.
  const realFence = local.store.withStorageWrite.bind(local.store);
  let fences = 0;
  local.store.withStorageWrite = action => {
    fences += 1;
    return realFence(action);
  };
  t.after(() => {
    local.store.withStorageWrite = realFence;
  });
  const sendReplay = () => call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { recipients: [member.id] }));
  const listBytes = async () => JSON.stringify(listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id })));

  // An exact replay of an already persisted send returns untouched, with no
  // reservation and no new event or sequence.
  const before = await listBytes();
  const replay = entity(await sendReplay(), 'message');
  assert.equal(replay.id, sent.id);
  assert.equal(replay.sequence, sent.sequence);
  assert.equal(admissions, 0, 'an exact replay takes no storage reservation');
  assert.equal(fences, 0, 'an exact replay takes no store write fence');

  // An acknowledgement that records nothing returns too.
  const noop = await call(broker, root, 'subagent_mailbox_ack', { ownerId: OWNER, teamId: team.id, ids: [sent.id] });
  assert.deepEqual(noop.ignored, [sent.id], 'a sender cannot acknowledge its own message');
  assert.equal(admissions, 0, 'a no-op acknowledgement takes no storage reservation');
  assert.equal(fences, 0, 'a no-op acknowledgement takes no store write fence');
  assert.equal(await listBytes(), before, 'neither retry changed the durable mailbox');

  // A NEW event still needs admission, and so does a FIRST acknowledgement.
  const refusedSend = await errorOf(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { requestId: 'send-2', recipients: [member.id] }));
  assert.equal(refusedSend?.code, 'storage_exhausted');
  const refusedAck = await errorOf(broker, root, 'subagent_mailbox_ack', { ownerId: OWNER, teamId: team.id, ids: [fromMember.id] });
  assert.equal(refusedAck?.code, 'storage_exhausted');
  assert.ok(admissions >= 2, 'both real writes asked for a governed reservation');
  assert.equal(fences, 0, 'a refused reservation never entered the store write fence');
  assert.equal(await listBytes(), before, 'nothing was persisted while admission was refused');
  const [stillUnacked] = await inboxOf();
  assert.equal(stillUnacked.deliveries.find(delivery => delivery.recipient.kind === 'coordinator').acknowledgedAt, undefined, 'no acknowledgement was recorded');

  // Restoring the budget admits exactly the same requests.
  state.config = { ...resourceDefaults, enabled: true, storageBytes: 512 * 1024 ** 2 };
  const created = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, task.id, { requestId: 'send-2', recipients: [member.id] })), 'message');
  assert.equal(created.sequence, 3, 'the member-authored event already held team ordinal 2');
  assert.ok(fences > 0, 'the admitted write took the store write fence');
  const acked = await call(broker, root, 'subagent_mailbox_ack', { ownerId: OWNER, teamId: team.id, ids: [fromMember.id] });
  assert.deepEqual(acked.acknowledged, [fromMember.id]);

  // The retries stay reservation-free while the budget is tight again, and the
  // acknowledged event keeps its exact public sequence.
  state.config = { ...resourceDefaults, enabled: true, storageBytes: 64 * 1024 ** 2 };
  const admissionsBefore = admissions;
  const replayAgain = entity(await sendReplay(), 'message');
  assert.equal(replayAgain.id, sent.id);
  assert.equal(replayAgain.sequence, 1);
  const ackAgain = await call(broker, root, 'subagent_mailbox_ack', { ownerId: OWNER, teamId: team.id, ids: [fromMember.id] });
  assert.deepEqual(ackAgain.alreadyAcknowledged, [fromMember.id]);
  assert.equal(admissions, admissionsBefore, 'both idempotent retries stayed reservation-free');
  assert.equal(listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id })).length, 3);
});

test('a legacy member receives interleaved teams oldest-first, not team by team', async t => {
  const { root, create, requests } = await fixture(t);
  const broker = await create({ taskBoardEnabled: () => true, messagingEnabled: () => true });
  const member = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'member', task: 'member work', ownerId: OWNER }));
  await done(broker, root, member.id);
  // One legacy (unbound) member of two teams, each with its own task.
  const first = await seed(broker, root, [member.id]);
  const second = await seedAnother(broker, root, 'second', [member.id]);

  const sendTo = async (seeded, requestId, body) => entity(await call(broker, root, 'subagent_mailbox_send', {
    ownerId: OWNER, teamId: seeded.team.id, taskId: seeded.task.id, requestId, kind: 'discovery', body, recipients: [member.id]
  }), 'message');
  const otherOne = await sendTo(second, 'other-1', 'other one');
  const firstOne = await sendTo(first, 'first-1', 'first one');
  const otherTwo = await sendTo(second, 'other-2', 'other two');
  assert.deepEqual([otherOne.sequence, firstOne.sequence, otherTwo.sequence], [1, 1, 2], 'the public sequences stay team-local');

  // The member is already running, so its own prompt receives one batch in the
  // durable root order; grouping by team would put the later team's traffic last.
  unpack(await broker.invoke(root, 'subagent_send', { id: member.id, requestId: 'follow', message: 'continue', ownerId: OWNER }));
  await done(broker, root, member.id);
  const prompt = JSON.stringify(requests.at(-1).messages);
  assert.match(prompt, /Peer mailbox delivery/);
  const positions = [otherOne.id, firstOne.id, otherTwo.id].map(id => prompt.indexOf(id));
  assert.ok(positions.every(index => index >= 0), 'every pending event reached the prompt');
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'the batch keeps root (oldest-first) order across teams');
  assert.equal(prompt.includes('"sequence":3'), false, 'the internal root counter never reaches a worker prompt');

  // Delivery receipts are recorded per team, so both teams agree.
  const firstPage = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: first.team.id });
  const secondPage = await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: second.team.id });
  assert.equal(listOf(firstPage)[0].deliveries[0].deliveredAt !== undefined, true);
  assert.equal(listOf(secondPage).every(message => message.deliveries[0].deliveredAt !== undefined), true);
});

/**
 * A standalone team member has no admission queue, so the engine itself rebuilds
 * and counts its peer prompt inside the stream iterator. That count awaits real
 * mailbox work, and the settings closure may change meanwhile: the live model
 * policy must be re-proved for the CURRENT session immediately before the
 * provider request, exactly like the governed boundary does.
 */
async function standalonePolicy(t, revoke) {
  const { root, options, create, requests } = await fixture(t);
  const live = { allowWrite: true, enabled: true };
  let armed = false;
  const broker = await create({
    taskBoardEnabled: () => true, messagingEnabled: () => true,
    // create(extra) replaces the option wholesale: the provider keeps the real
    // requests recorder and only its token count is observed here.
    provider: {
      ...options.provider,
      countTokens: async (selected, message) => {
        if (armed && JSON.stringify(message).includes('Peer mailbox delivery')) {
          revoke(live);
        }
        return 10;
      }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0,
      models: live.enabled ? { [model.id]: { allowWrite: live.allowWrite, numSessions: 2 } } : {} })
  });
  const worker = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'solo', task: 'standalone work', ownerId: OWNER, permission: 'workspace-write' }));
  await done(broker, root, worker.id);
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'standalone-team', name: 'Standalone team', description: '' }));
  const joined = teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'standalone-members', teamId: team.id, expectedRevision: team.revision, addMembers: [worker.id] }));
  const task = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'standalone-task', teamId: team.id, title: 'Standalone task', description: '' }));
  const sent = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(joined.id, task.id, { requestId: 'standalone-notice', recipients: [worker.id] })), 'message');
  assert.equal((await broker.session(root, worker.id)).state, 'completed', 'coordinator mail never starts a stopped worker');

  const before = requests.length;
  armed = true;
  unpack(await broker.invoke(root, 'subagent_send', { id: worker.id, requestId: 'standalone-follow', message: 'continue', ownerId: OWNER }));
  const failed = await done(broker, root, worker.id);

  // The whole point: not one provider request may advertise write_file,
  // patch_file or run_command once the live policy no longer permits them.
  assert.deepEqual(requests.slice(before), [], 'no provider request is created after the live policy changed');
  assert.equal(JSON.stringify(failed.messages).includes('Peer mailbox delivery'), false, 'no peer input is checkpointed');
  const [pending] = listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: joined.id }));
  assert.equal(pending.id, sent.id);
  assert.equal(pending.deliveries[0].deliveredAt, undefined, 'no delivery receipt is recorded');
  assert.equal(pending.deliveries[0].acknowledgedAt, undefined);
  return failed;
}

test('a standalone workspace-write worker fails before any provider request when allowWrite is revoked during peer counting', async t => {
  const failed = await standalonePolicy(t, live => { live.allowWrite = false; });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.turns.at(-1).error?.code, 'permission_denied', 'the revoked write policy fails the turn');
});

test('a standalone worker fails before any provider request when its model is removed during peer counting', async t => {
  const failed = await standalonePolicy(t, live => { live.enabled = false; });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.turns.at(-1).error?.code, 'model_unavailable', 'the removed model fails the turn');
});

test('a valid policy still delivers peer mail to standalone read-only and workspace-write members', async t => {
  // Control for the two regressions above: allowWrite:false never blocks an
  // authorized read-only session, and a workspace-write session whose policy
  // permits writes still delivers its peer block normally.
  const { root, create, requests } = await fixture(t);
  const policy = { allowWrite: false };
  const broker = await create({
    taskBoardEnabled: () => true, messagingEnabled: () => true,
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: policy.allowWrite, numSessions: 2 } } })
  });
  const readOnly = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'solo-read', task: 'read-only work', ownerId: OWNER }));
  await done(broker, root, readOnly.id);
  const team = teamOf(await call(broker, root, 'subagent_team_create', { ownerId: OWNER, requestId: 'valid-team', name: 'Valid team', description: '' }));
  const withReadOnly = teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'valid-members-read', teamId: team.id, expectedRevision: team.revision, addMembers: [readOnly.id] }));
  const firstTask = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'valid-task-read', teamId: team.id, title: 'Read task', description: '' }));
  const firstNotice = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, firstTask.id, { requestId: 'valid-notice-read', recipients: [readOnly.id] })), 'message');

  const beforeRead = requests.length;
  unpack(await broker.invoke(root, 'subagent_send', { id: readOnly.id, requestId: 'valid-follow-read', message: 'continue', ownerId: OWNER }));
  assert.equal((await done(broker, root, readOnly.id)).state, 'completed', 'allowWrite:false still allows an authorized read-only turn');
  assert.equal(requests.length, beforeRead + 1, 'exactly one authorized read-only request is made');
  const readPrompt = JSON.stringify(requests.at(-1).messages);
  assert.match(readPrompt, /Peer mailbox delivery/);
  assert.ok(readPrompt.includes(firstNotice.id));
  const [readDelivered] = listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id }));
  assert.equal(typeof readDelivered.deliveries[0].deliveredAt, 'number', 'the authorized read-only delivery records its receipt');

  // The same live closure now authorizes writes, so the control member proves the
  // new boundary does not block a normal workspace-write delivery either.
  policy.allowWrite = true;
  const writer = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'solo-write', task: 'write work', ownerId: OWNER, permission: 'workspace-write' }));
  await done(broker, root, writer.id);
  const withWriter = teamOf(await call(broker, root, 'subagent_team_update', { ownerId: OWNER, requestId: 'valid-members-write', teamId: team.id, expectedRevision: withReadOnly.revision, addMembers: [writer.id] }));
  const secondTask = taskOf(await call(broker, root, 'subagent_task_create', { ownerId: OWNER, requestId: 'valid-task-write', teamId: team.id, title: 'Write task', description: '' }));
  const secondNotice = entity(await call(broker, root, 'subagent_mailbox_send', sendArgs(team.id, secondTask.id, { requestId: 'valid-notice-write', recipients: [writer.id] })), 'message');

  const beforeWrite = requests.length;
  unpack(await broker.invoke(root, 'subagent_send', { id: writer.id, requestId: 'valid-follow-write', message: 'continue', ownerId: OWNER }));
  assert.equal((await done(broker, root, writer.id)).state, 'completed', 'a valid workspace-write policy still completes the turn');
  assert.equal(requests.length, beforeWrite + 1, 'exactly one authorized workspace-write request is made');
  const writePrompt = JSON.stringify(requests.at(-1).messages);
  assert.match(writePrompt, /Peer mailbox delivery/);
  assert.ok(writePrompt.includes(secondNotice.id));
  assert.ok(requests.at(-1).tools.some(tool => tool.name === 'write_file'), 'the authorized request still advertises write tools');
  const page = listOf(await call(broker, root, 'subagent_mailbox_list', { ownerId: OWNER, teamId: team.id }));
  const writeDelivered = page.find(message => message.id === secondNotice.id);
  assert.equal(typeof writeDelivered.deliveries[0].deliveredAt, 'number', 'the authorized workspace-write delivery records its receipt');
});
