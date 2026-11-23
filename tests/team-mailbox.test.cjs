const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const buildDir = path.join(__dirname, '..', String(process.env.CODEX_TEST_BUILD || '.test-build').trim());
const { TeamMailbox, mailboxLimits } = require(path.join(buildDir, 'team-mailbox'));
const { MAX_PEER_NOTICE_BYTES } = require(path.join(buildDir, 'engine'));
const storage = require(path.join(buildDir, 'storage'));

const coordinator = ownerId => ({ kind: 'coordinator', ownerId });
const workerActor = workerId => ({ kind: 'worker', workerId });
const pad = (n, width) => BigInt(n).toString(16).padStart(width, '0');
const w = n => pad(n, 32);
const h64 = n => pad(n, 64);
const coded = (code, message) => Object.assign(new Error(message), { code });

let requestCounter = 0;
const send = (mailbox, actor, teamId, taskId, extra = {}) => mailbox.send(actor, {
  teamId,
  taskId,
  kind: 'question',
  body: 'hello',
  requestId: `req-${++requestCounter}`,
  ...extra
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mailbox-test-'));
  const mailboxDir = path.join(root, 'mailbox');
  const teams = new Map();
  const tasks = new Map();
  // Mirrors the board: a deleted worker has no session and cannot authorize a
  // read, while a revoked worker stays a live session but loses membership.
  const liveWorkers = new Set([w(1), w(2), w(3), w(4), w(5), w(9)]);
  let now = 1_000_000;
  const access = {
    team(actor, teamId) {
      const team = teams.get(teamId);
      if (!team) {
        throw coded('not_found', `missing team ${teamId}`);
      }
      if (actor.kind === 'coordinator') {
        if (actor.ownerId !== team.coordinatorOwnerId) {
          throw coded('forbidden', 'coordinator does not own this team');
        }
        return team;
      }
      if (!liveWorkers.has(actor.workerId)) {
        throw coded('not_found', `worker ${actor.workerId} was deleted`);
      }
      if (!team.memberWorkerIds.includes(actor.workerId)) {
        throw coded('forbidden', `worker ${actor.workerId} is not a member of ${teamId}`);
      }
      return team;
    },
    task(actor, taskId) {
      const task = tasks.get(taskId);
      if (!task) {
        throw coded('not_found', `missing task ${taskId}`);
      }
      return task;
    }
  };
  let counter = 0;
  const addTeam = (members = [w(1), w(2), w(3)]) => {
    const id = w(9000 + counter++);
    teams.set(id, { coordinatorOwnerId: 'co-1', memberWorkerIds: [...members] });
    return id;
  };
  const addTask = teamId => {
    const id = w(7000 + counter++);
    tasks.set(id, { teamId });
    return id;
  };
  const create = async () => {
    const mailbox = new TeamMailbox(mailboxDir, access, () => now);
    await mailbox.open();
    return mailbox;
  };
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    mailboxDir,
    teams,
    tasks,
    access,
    liveWorkers,
    file: path.join(mailboxDir, 'mailbox.json'),
    namespace: path.join(mailboxDir, 'mailbox.namespace.json'),
    now: () => now,
    advance: ms => {
      now += ms;
    },
    addTeam,
    addTask,
    deleteWorker: id => liveWorkers.delete(id),
    create
  };
}

test('orders messages, pages with an exclusive cursor, and reports a bounded unread summary', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  const first = await send(mailbox, co, teamId, taskId, { body: 'one', recipients: [w(1)] });
  const second = await send(mailbox, co, teamId, taskId, { kind: 'discovery', body: 'two', recipients: [w(1), w(2)] });
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(first.sender, co);
  assert.deepEqual(first.recipients, [workerActor(w(1))]);
  assert.equal(first.retention.payload, 'unretained');
  assert.equal(first.retention.refs, 'opaque-unretained');
  assert.equal(first.retention.expired, false);

  const page1 = mailbox.list(workerActor(w(1)), { teamId, limit: 1 });
  assert.deepEqual(page1.messages.map(message => message.sequence), [1]);
  assert.equal(page1.nextCursor, 1);
  assert.equal(page1.prunedThrough, 0);
  assert.equal(page1.direction, 'all');
  assert.equal(page1.unread.addressed, 2);
  assert.equal(page1.unread.undelivered, 2);
  assert.equal(page1.unread.pendingAck, 2);
  assert.equal(page1.unread.byKind.question, 1);

  const page2 = mailbox.list(workerActor(w(1)), { teamId, after: page1.nextCursor, limit: 1 });
  assert.deepEqual(page2.messages.map(message => message.sequence), [2]);
  const page3 = mailbox.list(workerActor(w(1)), { teamId, after: page2.nextCursor });
  assert.deepEqual(page3.messages, []);
  assert.equal(page3.nextCursor, 2);

  const outbound = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'discovery', recipients: [w(2)], toCoordinator: true });
  assert.deepEqual(outbound.recipients, [workerActor(w(2)), co]);
  assert.deepEqual(mailbox.list(workerActor(w(1)), { teamId, direction: 'outbox' }).messages.map(message => message.id), [outbound.id]);
  assert.deepEqual(mailbox.list(co, { teamId, direction: 'all', limit: 20 }).messages.map(message => message.id),
    [first.id, second.id, outbound.id]);

  assert.throws(() => mailbox.list(workerActor(w(9)), { teamId }), { code: 'forbidden' });
  assert.throws(() => mailbox.list(co, { teamId, limit: 21 }), { code: 'invalid_arguments' });
  assert.throws(() => mailbox.list(co, { teamId, after: -1 }), { code: 'invalid_arguments' });
  assert.throws(() => mailbox.list(co, { teamId, unknown: true }), { code: 'invalid_arguments' });
});

test('replays an identical request once and rejects changed arguments after reload', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const input = { teamId, taskId, kind: 'discovery', body: 'stable', recipients: [w(1)], requestId: 'fixed-1' };

  const one = await mailbox.send(co, input);
  const reordered = { recipients: [w(1)], body: 'stable', kind: 'discovery', taskId, teamId, requestId: 'fixed-1' };
  const two = await mailbox.send(co, reordered);
  assert.equal(two.id, one.id);
  const concurrent = await Promise.all([mailbox.send(co, { ...input }), mailbox.send(co, { ...input })]);
  assert.equal(concurrent[0].id, one.id);
  assert.equal(concurrent[1].id, one.id);
  assert.equal(mailbox.list(co, { teamId }).messages.length, 1);
  await assert.rejects(mailbox.send(co, { ...input, body: 'changed' }), { code: 'request_reuse_conflict' });

  await mailbox.close();
  const reloaded = await fx.create();
  const replay = await reloaded.send(co, { ...input });
  assert.equal(replay.id, one.id);
  assert.equal(replay.sequence, 1);
  assert.equal(reloaded.list(co, { teamId }).messages.length, 1);
});

test('allows concurrent replies from distinct addressed workers and only one per recipient', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2), w(3)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const question = await send(mailbox, co, teamId, taskId, { body: 'decide', recipients: [w(1), w(2)] });

  const [replyOne, replyTwo] = await Promise.all([
    send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'a' }),
    send(mailbox, workerActor(w(2)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'b' })
  ]);
  assert.equal(replyOne.sequence, 2);
  assert.equal(replyTwo.sequence, 3);
  assert.deepEqual(replyOne.recipients, [co]);
  assert.deepEqual(replyTwo.recipients, [co]);
  assert.equal(replyOne.toCoordinator, true);
  assert.equal(replyOne.expiresAt, question.expiresAt);
  assert.equal(replyTwo.expiresAt, question.expiresAt);
  assert.equal(mailbox.list(co, { teamId, direction: 'inbox' }).messages.filter(message => message.replyTo === question.id).length, 2);

  await assert.rejects(
    send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'again', requestId: 'dup-reply' }),
    { code: 'reply_conflict' }
  );
  await assert.rejects(
    send(mailbox, workerActor(w(3)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'intruder', requestId: 'intruder' }),
    { code: 'forbidden' }
  );
  await assert.rejects(
    send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'interface_response', replyTo: question.id, body: 'x', requestId: 'wrong-kind' }),
    { code: 'reply_invalid' }
  );
  await assert.rejects(
    mailbox.send(workerActor(w(1)), { teamId, taskId, kind: 'reply', replyTo: question.id, body: 'x', recipients: [w(2)], requestId: 'explicit' }),
    { code: 'invalid_arguments' }
  );
});

test('prevents reply loops and replies to replies', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  const proposal = await send(mailbox, co, teamId, taskId, { kind: 'interface_proposal', body: 'p', recipients: [w(1)] });
  const response = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'interface_response', replyTo: proposal.id, body: 'ok' });
  await assert.rejects(
    send(mailbox, co, teamId, taskId, { kind: 'reply', replyTo: response.id, body: 'loop', requestId: 'loop-1' }),
    { code: 'reply_invalid' }
  );

  const own = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'question', body: 'own', recipients: [w(2)] });
  await assert.rejects(
    send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'reply', replyTo: own.id, body: 'self', requestId: 'self-1' }),
    { code: 'forbidden' }
  );

  const otherTeam = fx.addTeam([w(1), w(2)]);
  const otherTask = fx.addTask(otherTeam);
  await assert.rejects(
    send(mailbox, workerActor(w(1)), otherTeam, otherTask, { kind: 'reply', replyTo: proposal.id, body: 'x', requestId: 'cross-1' }),
    { code: 'reply_invalid' }
  );
});

test('replyState follows live counterparts and expiry', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const asked = workerActor(w(1));

  const question = await send(mailbox, asked, teamId, taskId, { body: 'q', toCoordinator: true });
  assert.equal(mailbox.replyState(asked, teamId, question.id), 'waiting');
  assert.equal(mailbox.replyState(workerActor(w(2)), teamId, question.id), 'unavailable');
  const reply = await send(mailbox, co, teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'a', requestId: 'co-reply' });
  assert.equal(mailbox.replyState(asked, teamId, question.id), 'ready');
  assert.equal(mailbox.replyState(asked, teamId, reply.id), 'unavailable');

  fx.teams.set(teamId, { coordinatorOwnerId: 'co-2', memberWorkerIds: [w(1), w(2)] });
  assert.equal(mailbox.replyState(asked, teamId, question.id), 'unavailable');
  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(1), w(2)] });

  fx.advance(mailboxLimits.ttlMs);
  assert.equal(mailbox.replyState(asked, teamId, question.id), 'unavailable');
});

test('pending selects oldest undelivered unacknowledged messages and acknowledgement is separate', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const one = await send(mailbox, co, teamId, taskId, { body: 'one', recipients: [w(1)] });
  const two = await send(mailbox, co, teamId, taskId, { body: 'two', recipients: [w(1)] });
  const asked = workerActor(w(1));

  assert.deepEqual(mailbox.pending(asked, teamId, 10).map(message => message.id), [one.id, two.id]);
  assert.deepEqual(mailbox.pending(workerActor(w(2)), teamId, 10), []);
  await mailbox.delivered(asked, teamId, [one.id]);
  assert.deepEqual(mailbox.pending(asked, teamId, 10).map(message => message.id), [two.id]);
  const afterDelivery = mailbox.list(asked, { teamId, direction: 'inbox' }).messages.find(message => message.id === one.id);
  assert.equal(afterDelivery.deliveries[0].deliveredAt, fx.now());
  assert.equal(afterDelivery.deliveries[0].acknowledgedAt, undefined);

  const ack = await mailbox.acknowledge(asked, { teamId, ids: [two.id] });
  assert.deepEqual(ack.acknowledged, [two.id]);
  const afterAck = mailbox.list(asked, { teamId, direction: 'inbox' }).messages.find(message => message.id === two.id);
  assert.equal(afterAck.deliveries[0].acknowledgedAt, fx.now());
  assert.equal(afterAck.deliveries[0].deliveredAt, undefined);
  assert.deepEqual(mailbox.pending(asked, teamId, 10), []);

  const again = await mailbox.acknowledge(asked, { teamId, ids: [two.id] });
  assert.deepEqual(again.alreadyAcknowledged, [two.id]);
  const ignored = await mailbox.acknowledge(workerActor(w(2)), { teamId, ids: [one.id] });
  assert.deepEqual(ignored.ignored, [one.id]);
  await assert.rejects(mailbox.delivered(workerActor(w(9)), teamId, [one.id]), { code: 'forbidden' });
  await assert.rejects(mailbox.acknowledge(workerActor(w(9)), { teamId, ids: [one.id] }), { code: 'forbidden' });
  await assert.rejects(mailbox.delivered(asked, teamId, []), { code: 'invalid_arguments' });
});

test('the internal pending scan covers the retained-message bound while public list stays at 20', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  for (let index = 0; index < 25; index++) {
    await send(mailbox, co, teamId, taskId, { recipients: [w(1)], body: 'pending ' + index });
  }
  const asked = workerActor(w(1));
  assert.equal(mailbox.pending(asked, teamId, 200).length, 25, 'the scan is not truncated at the public list limit');
  assert.equal(mailbox.pending(asked, teamId, 1000).length, 25, 'the scan stays inside the mailbox retention bound');
  assert.throws(() => mailbox.list(co, { teamId, limit: 21 }), { code: 'invalid_arguments' }, 'the public list limit is unchanged');
  assert.equal(mailbox.list(co, { teamId, limit: 20 }).messages.length, 20);
});

test('revoked workers lose reads and delivery while the coordinator keeps dispute visibility', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const revoked = workerActor(w(1));
  const remaining = workerActor(w(2));

  const fromRevoked = await send(mailbox, revoked, teamId, taskId, { body: 'from w1', recipients: [w(2)] });
  const toRevoked = await send(mailbox, co, teamId, taskId, { body: 'to w1', recipients: [w(1), w(2)] });
  assert.equal(mailbox.pending(remaining, teamId, 10).length, 2);

  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(2)] });
  assert.throws(() => mailbox.list(revoked, { teamId }), { code: 'forbidden' });
  assert.throws(() => mailbox.pending(revoked, teamId, 10), { code: 'forbidden' });
  assert.equal(mailbox.replyState(revoked, teamId, '0'.repeat(32)), 'unavailable');
  assert.deepEqual(mailbox.pending(remaining, teamId, 10).map(message => message.id), [toRevoked.id]);
  assert.deepEqual(mailbox.list(co, { teamId, direction: 'all' }).messages.map(message => message.id),
    [fromRevoked.id, toRevoked.id]);
  await assert.rejects(send(mailbox, revoked, teamId, taskId, { body: 'nope', recipients: [w(2)] }), { code: 'forbidden' });
});

test('expiry preserves the cursor watermark and capacity rejects without evicting live entries', async t => {
  const original = mailboxLimits.messages;
  mailboxLimits.messages = 2;
  t.after(() => {
    mailboxLimits.messages = original;
  });
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  const one = await send(mailbox, co, teamId, taskId, { body: 'one', recipients: [w(1)] });
  const two = await send(mailbox, co, teamId, taskId, { body: 'two', recipients: [w(1)] });
  await assert.rejects(send(mailbox, co, teamId, taskId, { body: 'three', recipients: [w(1)] }), { code: 'capacity_exceeded' });
  assert.deepEqual(mailbox.list(co, { teamId }).messages.map(message => message.id), [one.id, two.id]);

  fx.advance(mailboxLimits.ttlMs);
  const expired = mailbox.list(co, { teamId });
  assert.deepEqual(expired.messages, []);
  assert.equal(expired.prunedThrough, 2);

  const three = await send(mailbox, co, teamId, taskId, { body: 'three', recipients: [w(1)] });
  assert.equal(three.sequence, 3);
  const after = mailbox.list(co, { teamId, after: 0 });
  assert.deepEqual(after.messages.map(message => message.sequence), [3]);
  assert.equal(after.prunedThrough, 2);

  await mailbox.close();
  const reloaded = await fx.create();
  const reloadPage = reloaded.list(co, { teamId, after: 0 });
  assert.deepEqual(reloadPage.messages.map(message => message.sequence), [3]);
  assert.equal(reloadPage.prunedThrough, 2);
});

test('accepts only exact sealed references and marks every payload unretained', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const artifact = { id: h64(7), version: 2, uri: `codex-subagent://submission/${h64(9)}/${h64(7)}/2` };
  const evidence = { id: w(5), version: 1, uri: `urn:codex-runner-result:${h64(3)}:${w(5)}` };
  const attempt = { id: h64(4), revision: 0 };

  const ready = await send(mailbox, co, teamId, taskId, {
    kind: 'artifact_ready', body: 'ready', recipients: [w(1)], artifact, evidence, attempt
  });
  assert.deepEqual(ready.artifact, artifact);
  assert.deepEqual(ready.evidence, evidence);
  assert.deepEqual(ready.attempt, attempt);
  assert.equal(ready.retention.payload, 'unretained');
  assert.equal(ready.retention.refs, 'opaque-unretained');
  assert.equal(ready.retention.expired, false);

  await assert.rejects(send(mailbox, co, teamId, taskId, { kind: 'artifact_ready', body: 'no ref', recipients: [w(1)] }), { code: 'invalid_arguments' });
  const overlay = { id: h64(7), version: 1, uri: `codex-subagent://overlay/${h64(9)}/${h64(7)}/1` };
  await assert.rejects(send(mailbox, co, teamId, taskId, { kind: 'artifact_ready', body: 'overlay', recipients: [w(1)], artifact: overlay }), { code: 'invalid_arguments' });
  const mismatched = { id: h64(7), version: 1, uri: `codex-subagent://submission/${h64(9)}/${h64(8)}/1` };
  await assert.rejects(send(mailbox, co, teamId, taskId, { kind: 'artifact_ready', body: 'mismatch', recipients: [w(1)], artifact: mismatched }), { code: 'invalid_arguments' });
  const wrongEvidence = { id: w(5), version: 2, uri: `urn:codex-runner-result:${h64(3)}:${w(5)}` };
  await assert.rejects(send(mailbox, co, teamId, taskId, { kind: 'discovery', body: 'evidence', recipients: [w(1)], evidence: wrongEvidence }), { code: 'invalid_arguments' });
  const wrongAttempt = { id: w(4), revision: -1 };
  await assert.rejects(send(mailbox, co, teamId, taskId, { kind: 'discovery', body: 'attempt', recipients: [w(1)], attempt: wrongAttempt }), { code: 'invalid_arguments' });

  await assert.rejects(send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'escalation', body: 'help', recipients: [w(9)] }), { code: 'invalid_arguments' });
  const escalation = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'escalation', body: 'help', toCoordinator: true });
  assert.deepEqual(escalation.recipients, [co]);
  assert.equal(escalation.toCoordinator, true);

  await assert.rejects(send(mailbox, co, teamId, taskId, { body: 'é'.repeat(600), recipients: [w(1)] }), { code: 'invalid_arguments' });
});

test('fails closed on malformed data and never resets a missing document', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  assert.deepEqual(mailbox.list(co, { teamId }).messages, []);
  await assert.rejects(fs.readFile(fx.file, 'utf8'));
  const sent = await send(mailbox, co, teamId, taskId, { recipients: [w(1)] });
  const pristine = await fs.readFile(fx.file, 'utf8');
  const namespace = await fs.readFile(fx.namespace, 'utf8');
  await mailbox.close();
  assert.throws(() => mailbox.list(co, { teamId }), { code: 'host_stopping' });

  await fs.writeFile(fx.file, '{ bad json', { mode: 0o600 });
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
  assert.equal(await fs.readFile(fx.file, 'utf8'), '{ bad json');

  await fs.writeFile(fx.file, pristine, { mode: 0o600 });
  await fs.writeFile(fx.namespace, JSON.stringify({ schema: 1, root: path.join(fx.root, 'other') }), { mode: 0o600 });
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
  assert.equal(await fs.readFile(fx.file, 'utf8'), pristine);

  await fs.writeFile(fx.namespace, namespace, { mode: 0o600 });
  const reopened = await fx.create();
  assert.equal(reopened.list(co, { teamId }).messages[0].id, sent.id);

  await fs.rm(fx.file);
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
});

test('rechecks the live guard at publication and publishes nothing when it refuses', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  let calls = 0;
  fx.access.guard = () => {
    calls += 1;
    if (calls >= 3) {
      throw new Error('feature closed');
    }
  };
  await assert.rejects(
    mailbox.send(co, { teamId, taskId, kind: 'discovery', body: 'gated', recipients: [w(1)], requestId: 'guarded' }),
    /feature closed/
  );
  fx.access.guard = undefined;
  assert.deepEqual(mailbox.list(co, { teamId }).messages, []);
  const after = await send(mailbox, co, teamId, taskId, { body: 'after', recipients: [w(1)] });
  assert.equal(after.sequence, 1);
  const retry = await mailbox.send(co, { teamId, taskId, kind: 'discovery', body: 'gated', recipients: [w(1)], requestId: 'guarded' });
  assert.equal(retry.sequence, 2);
});

test('reloads sequence, cursor and per-recipient delivery metadata', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const asked = workerActor(w(1));

  const question = await send(mailbox, co, teamId, taskId, { body: 'question', recipients: [w(1), w(2)] });
  await mailbox.delivered(asked, teamId, [question.id]);
  await mailbox.acknowledge(asked, { teamId, ids: [question.id] });
  const page = mailbox.list(asked, { teamId, after: 0 });
  assert.equal(page.nextCursor, 1);
  await mailbox.close();

  const reloaded = await fx.create();
  const reloadPage = reloaded.list(asked, { teamId, after: 0 });
  assert.equal(reloadPage.messages.length, 1);
  const delivery = reloadPage.messages[0].deliveries.find(entry => entry.recipient.workerId === w(1));
  assert.equal(typeof delivery.deliveredAt, 'number');
  assert.equal(typeof delivery.acknowledgedAt, 'number');
  assert.equal(delivery.deliveredAt, delivery.acknowledgedAt);
  assert.deepEqual(reloaded.pending(workerActor(w(2)), teamId, 10).map(message => message.id), [question.id]);

  const next = await send(reloaded, co, teamId, taskId, { body: 'next', recipients: [w(1)] });
  assert.equal(next.sequence, 2);
  assert.equal(reloaded.list(asked, { teamId, after: reloadPage.nextCursor }).messages[0].id, next.id);
});

test('a refused first publication leaves no marker and the next open still writes sequence 1', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const real = storage.atomicWrite;
  t.after(() => {
    storage.atomicWrite = real;
  });
  // Abort at the final document publication: the guard and the exact
  // authorization run, then no rename happens.
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    beforeRename?.();
    throw new Error('aborted at publication');
  };
  await assert.rejects(
    mailbox.send(co, { teamId, taskId, kind: 'discovery', body: 'first', recipients: [w(1)], requestId: 'first' }),
    /aborted at publication/
  );
  storage.atomicWrite = real;
  await assert.rejects(fs.readFile(fx.file, 'utf8'));
  await assert.rejects(fs.readFile(fx.namespace, 'utf8'));

  // Reopen immediately, before any successful write: this is a fresh root, not
  // a namespace that lost its data.
  await mailbox.close();
  const reopened = await fx.create();
  assert.deepEqual(reopened.list(co, { teamId }).messages, []);
  const sent = await send(reopened, co, teamId, taskId, { recipients: [w(1)] });
  assert.equal(sent.sequence, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(fx.namespace, 'utf8')), { schema: 1, root: path.resolve(fx.mailboxDir) });
  assert.equal(JSON.parse(await fs.readFile(fx.file, 'utf8')).lastSequence, 1);
  assert.equal(reopened.list(co, { teamId }).messages.length, 1);
});

test('a reply shares its target expiry and an expired retry is refused consistently', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const question = await send(mailbox, co, teamId, taskId, { body: 'q', recipients: [w(1)], requestId: 'q1' });

  fx.advance(mailboxLimits.ttlMs - 1000);
  const reply = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'a', requestId: 'r1' });
  assert.equal(reply.expiresAt, question.expiresAt);
  assert.equal(reply.retention.expired, false);

  fx.advance(1000);
  // Before any further write, both records are expired even though they are
  // still retained in memory; the same answers must survive a reload.
  await assert.rejects(
    mailbox.send(co, { teamId, taskId, kind: 'question', body: 'q', recipients: [w(1)], requestId: 'q1' }),
    { code: 'request_expired' }
  );
  await assert.rejects(
    mailbox.send(workerActor(w(1)), { teamId, taskId, kind: 'reply', replyTo: question.id, body: 'a', requestId: 'r1' }),
    { code: 'request_expired' }
  );
  const expiredPage = mailbox.list(co, { teamId });
  assert.deepEqual(expiredPage.messages, []);
  assert.equal(expiredPage.prunedThrough, 2);

  await mailbox.close();
  const reloaded = await fx.create();
  assert.deepEqual(reloaded.list(co, { teamId }).messages, []);
  assert.equal(reloaded.list(co, { teamId }).prunedThrough, 2);
  await assert.rejects(
    reloaded.send(co, { teamId, taskId, kind: 'question', body: 'q', recipients: [w(1)], requestId: 'q1' }),
    { code: 'request_expired' }
  );
  await assert.rejects(
    reloaded.send(co, { teamId, taskId, kind: 'question', body: 'changed', recipients: [w(1)], requestId: 'q1' }),
    { code: 'request_reuse_conflict' }
  );

  const fresh = await send(reloaded, co, teamId, taskId, { recipients: [w(1)], requestId: 'q2' });
  assert.equal(fresh.sequence, 3);
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(stored.lastSequence, 3);
  assert.equal(stored.prunedThrough, 2);
  assert.equal(stored.messages.length, 1);

  await reloaded.close();
  const again = await fx.create();
  assert.equal(again.list(co, { teamId }).prunedThrough, 2);
  assert.deepEqual(again.list(co, { teamId }).messages.map(message => message.sequence), [3]);
  await assert.rejects(
    again.send(co, { teamId, taskId, kind: 'question', body: 'q', recipients: [w(1)], requestId: 'q1' }),
    { code: 'request_expired' }
  );
});

test('reads are size-bounded and refuse a non-plain file', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  await send(mailbox, co, teamId, taskId, { recipients: [w(1)] });
  await mailbox.close();
  const pristine = await fs.readFile(fx.file, 'utf8');

  const huge = { schema: 1, ttlMs: mailboxLimits.ttlMs, lastSequence: 0, prunedThrough: 0, messages: [], requests: {}, pad: 'x'.repeat(mailboxLimits.documentBytes) };
  await fs.writeFile(fx.file, JSON.stringify(huge), { mode: 0o600 });
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
  assert.equal(await fs.readFile(fx.file, 'utf8'), JSON.stringify(huge));

  await fs.rm(fx.file);
  await fs.mkdir(fx.file);
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });

  await fs.rmdir(fx.file);
  await fs.writeFile(fx.file, pristine, { mode: 0o600 });
  const reopened = await fx.create();
  assert.equal(reopened.list(co, { teamId }).messages.length, 1);
});

test('a revoked multicast co-recipient never hides the message from a live recipient', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  const multicast = await send(mailbox, co, teamId, taskId, { recipients: [w(1), w(2)] });
  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(2)] });

  const inbox = mailbox.list(workerActor(w(2)), { teamId, direction: 'inbox' });
  assert.deepEqual(inbox.messages.map(message => message.id), [multicast.id]);
  assert.equal(inbox.unread.addressed, 1);
  assert.deepEqual(mailbox.pending(workerActor(w(2)), teamId, 5).map(message => message.id), [multicast.id]);
  await mailbox.delivered(workerActor(w(2)), teamId, [multicast.id]);
  assert.deepEqual((await mailbox.acknowledge(workerActor(w(2)), { teamId, ids: [multicast.id] })).acknowledged, [multicast.id]);
  assert.throws(() => mailbox.list(workerActor(w(1)), { teamId }), { code: 'forbidden' });
});

test('live participant checks cover deleted peers, stale member lists and the publication recheck', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');

  // A deleted worker that the team member list still names is not a recipient.
  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(1), w(2), w(6)] });
  await assert.rejects(send(mailbox, co, teamId, taskId, { recipients: [w(6)] }), { code: 'recipient_invalid' });
  assert.throws(() => mailbox.pending(workerActor(w(6)), teamId, 5), { code: 'not_found' });

  const fromOne = await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'discovery', body: 'hi', recipients: [w(2)] });
  fx.deleteWorker(w(1));
  // The sender is gone: workers no longer receive its event, while the
  // coordinator still inspects the retained record.
  assert.deepEqual(mailbox.pending(workerActor(w(2)), teamId, 5), []);
  assert.deepEqual(mailbox.list(workerActor(w(2)), { teamId }).messages, []);
  assert.deepEqual(mailbox.list(co, { teamId, direction: 'all' }).messages.map(message => message.id), [fromOne.id]);
  assert.throws(() => mailbox.list(workerActor(w(1)), { teamId }), { code: 'not_found' });
  await assert.rejects(send(mailbox, workerActor(w(1)), teamId, taskId, { recipients: [w(2)] }), { code: 'not_found' });
  const ignored = await mailbox.acknowledge(workerActor(w(2)), { teamId, ids: [fromOne.id] });
  assert.deepEqual(ignored.ignored, [fromOne.id]);

  // A recipient revoked between the pre-check and the rename stops publication.
  const real = storage.atomicWrite;
  t.after(() => {
    storage.atomicWrite = real;
  });
  let armed = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed) {
      armed = false;
      fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(2)] });
    }
    return real(file, text, mode, beforeRename);
  };
  const before = mailbox.list(co, { teamId }).messages.length;
  await assert.rejects(send(mailbox, co, teamId, taskId, { body: 'raced', recipients: [w(1)] }), { code: 'recipient_invalid' });
  storage.atomicWrite = real;
  assert.equal(mailbox.list(co, { teamId }).messages.length, before);
});

test('durable records must keep their receipt, an addressed replier and the target expiry', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const question = await send(mailbox, co, teamId, taskId, { recipients: [w(1)] });
  fx.advance(1000);
  await send(mailbox, workerActor(w(1)), teamId, taskId, { kind: 'reply', replyTo: question.id, body: 'a' });
  await mailbox.close();
  const pristine = await fs.readFile(fx.file, 'utf8');
  const base = () => JSON.parse(pristine);
  const rewrite = document => fs.writeFile(fx.file, JSON.stringify(document), { mode: 0o600 });

  const noReceipt = base();
  delete noReceipt.requests[noReceipt.messages[0].requestKey];
  await rewrite(noReceipt);
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
  assert.equal(await fs.readFile(fx.file, 'utf8'), JSON.stringify(noReceipt));

  const unaddressed = base();
  unaddressed.messages[0].recipients = [{ kind: 'worker', workerId: w(2) }];
  unaddressed.messages[0].deliveries = [{ recipient: { kind: 'worker', workerId: w(2) } }];
  await rewrite(unaddressed);
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });

  const laterExpiry = base();
  laterExpiry.messages[1].expiresAt = laterExpiry.messages[1].persistedAt + mailboxLimits.ttlMs;
  assert.notEqual(laterExpiry.messages[1].expiresAt, laterExpiry.messages[0].expiresAt);
  await rewrite(laterExpiry);
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });

  await fs.writeFile(fx.file, pristine, { mode: 0o600 });
  const reopened = await fx.create();
  assert.equal(reopened.list(co, { teamId }).messages.length, 2);
});

test('the serialized cap is enforced on delivery and acknowledgement commits too', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const message = await send(mailbox, co, teamId, taskId, { recipients: [w(1)] });

  const original = mailboxLimits.documentBytes;
  t.after(() => {
    mailboxLimits.documentBytes = original;
  });
  const size = Buffer.byteLength(JSON.stringify(JSON.parse(await fs.readFile(fx.file, 'utf8'))), 'utf8');
  mailboxLimits.documentBytes = size;
  await assert.rejects(mailbox.delivered(workerActor(w(1)), teamId, [message.id]), { code: 'capacity_exceeded' });
  await assert.rejects(mailbox.acknowledge(workerActor(w(1)), { teamId, ids: [message.id] }), { code: 'capacity_exceeded' });
  assert.equal(JSON.parse(await fs.readFile(fx.file, 'utf8')).messages[0].deliveries[0].deliveredAt, undefined);

  mailboxLimits.documentBytes = size + 200;
  await mailbox.delivered(workerActor(w(1)), teamId, [message.id]);
  assert.equal(typeof JSON.parse(await fs.readFile(fx.file, 'utf8')).messages[0].deliveries[0].deliveredAt, 'number');
});

test('an unrelated team\'s traffic, expiry and prune never move another team\'s cursor', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamA = fx.addTeam([w(1)]);
  const teamB = fx.addTeam([w(2)]);
  const taskA = fx.addTask(teamA);
  const taskB = fx.addTask(teamB);
  const mailbox = await fx.create();

  const fresh = mailbox.list(co, { teamId: teamA });
  assert.equal(fresh.nextCursor, 0);
  assert.equal(fresh.prunedThrough, 0);
  // No public field may carry an internal root counter.
  assert.deepEqual(Object.keys(fresh).sort(), ['direction', 'messages', 'nextCursor', 'prunedThrough', 'retention', 'teamId', 'unread']);

  // Team B's event is durable but must not move team A's cursor at all.
  await send(mailbox, co, teamB, taskB, { body: 'b one', recipients: [w(2)] });
  const afterSend = mailbox.list(co, { teamId: teamA });
  assert.deepEqual(afterSend.messages, []);
  assert.equal(afterSend.nextCursor, 0, 'another team\'s event never advances this cursor');
  assert.equal(afterSend.prunedThrough, 0, 'another team\'s event never opens a gap here');

  // Its expiry moves only team B's watermark.
  fx.advance(mailboxLimits.ttlMs);
  const afterExpiry = mailbox.list(co, { teamId: teamA });
  assert.equal(afterExpiry.nextCursor, 0);
  assert.equal(afterExpiry.prunedThrough, 0);
  assert.equal(mailbox.list(co, { teamId: teamB }).prunedThrough, 1);

  // The same answers hold after a reload and after a prune-triggering write.
  await mailbox.close();
  const reloaded = await fx.create();
  assert.equal(reloaded.list(co, { teamId: teamA }).nextCursor, 0);
  assert.equal(reloaded.list(co, { teamId: teamA }).prunedThrough, 0);
  const owned = await send(reloaded, co, teamA, taskA, { body: 'a one', recipients: [w(1)] });
  assert.equal(owned.sequence, 1, 'team A keeps its own ordinal 1');
  const page = reloaded.list(co, { teamId: teamA });
  assert.deepEqual(page.messages.map(message => message.sequence), [1]);
  assert.equal(page.prunedThrough, 0);
  assert.equal('teamSequence' in page.messages[0], false, 'the internal team ordinal is not a public field');
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(stored.lastSequence, 2, 'the internal root sequence stays durable');
  assert.deepEqual(stored.teams[teamA], { last: 1, prunedThrough: 0 });
  assert.deepEqual(stored.teams[teamB], { last: 1, prunedThrough: 1 });
  assert.equal(reloaded.list(co, { teamId: teamB }).prunedThrough, 1);
});

test('interleaved teams keep team-local sequences and root-order delivery', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamA = fx.addTeam([w(1)]);
  const teamB = fx.addTeam([w(1)]);
  const taskA = fx.addTask(teamA);
  const taskB = fx.addTask(teamB);
  const mailbox = await fx.create();
  const asked = workerActor(w(1));

  const b1 = await send(mailbox, co, teamB, taskB, { body: 'b1', recipients: [w(1)] });
  const a1 = await send(mailbox, co, teamA, taskA, { body: 'a1', recipients: [w(1)] });
  const b2 = await send(mailbox, co, teamB, taskB, { body: 'b2', recipients: [w(1)] });
  const a2 = await send(mailbox, co, teamA, taskA, { body: 'a2', recipients: [w(1)] });
  assert.deepEqual([b1.sequence, a1.sequence, b2.sequence, a2.sequence], [1, 1, 2, 2], 'public sequences are team-local and gap-free');

  const page = mailbox.list(co, { teamId: teamA, limit: 1 });
  assert.deepEqual(page.messages.map(message => message.sequence), [1]);
  assert.equal(page.nextCursor, 1);
  const second = mailbox.list(co, { teamId: teamA, after: page.nextCursor });
  assert.deepEqual(second.messages.map(message => message.sequence), [2]);
  assert.equal(second.nextCursor, 2);

  // Cross-team delivery order is the internal root order, never a public ordinal.
  assert.deepEqual(mailbox.pending(asked, [teamA, teamB], 10).map(message => message.id), [b1.id, a1.id, b2.id, a2.id]);
  assert.deepEqual(mailbox.pending(asked, [teamA, teamB], 10).map(message => message.sequence), [1, 1, 2, 2]);
  assert.deepEqual(mailbox.pending(asked, [teamA, teamB], 1).map(message => message.id), [b1.id], 'the oldest root event wins the first slot');
  assert.deepEqual(mailbox.pending(asked, [teamA], 10).map(message => message.id), [a1.id, a2.id], 'a single-team caller is unchanged');
  assert.throws(() => mailbox.pending(workerActor(w(2)), [teamA, teamB], 5), { code: 'forbidden' }, 'every named team is authorized');
  assert.deepEqual(mailbox.pending(asked, [teamA, teamA], 10).map(message => message.id), [a1.id, a2.id], 'a repeated team is authorized once and never duplicated');
  // The internal fan-out stays bounded and defensive: the raw list is capped,
  // a malformed value is invalid_arguments, and limit is validated even when
  // the team list is empty.
  assert.throws(() => mailbox.pending(asked, [], -1), { code: 'invalid_arguments' }, 'limit is validated for an empty team list');
  assert.throws(() => mailbox.pending(asked, [], 1.5), { code: 'invalid_arguments' });
  assert.deepEqual(mailbox.pending(asked, [], 5), []);
  assert.throws(() => mailbox.pending(asked, new Array(mailboxLimits.teams + 1).fill(teamA), 5), { code: 'invalid_arguments' }, 'more teams than the durable bound');
  assert.throws(() => mailbox.pending(asked, null, 5), { code: 'invalid_arguments' }, 'a non-iterable team value');
  assert.throws(() => mailbox.pending(asked, 42, 5), { code: 'invalid_arguments' }, 'a non-string, non-array team value');
  assert.throws(() => mailbox.pending(asked, [teamA, 'not-a-team'], 5), { code: 'invalid_arguments' }, 'a malformed id inside the list');

  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(stored.schema, 2);
  assert.equal(stored.lastSequence, 4, 'the internal root sequence keeps the durable cross-team order');
  assert.deepEqual(stored.messages.map(message => [message.teamId === teamA ? 'a' : 'b', message.sequence, message.teamSequence]),
    [['b', 1, 1], ['a', 2, 1], ['b', 3, 2], ['a', 4, 2]]);

  await mailbox.close();
  const reloaded = await fx.create();
  assert.equal(reloaded.list(co, { teamId: teamA, after: 1 }).messages[0].id, a2.id);
  assert.deepEqual(reloaded.list(co, { teamId: teamB }).messages.map(message => message.sequence), [1, 2]);
  assert.deepEqual(reloaded.pending(asked, [teamA, teamB], 2).map(message => message.id), [b1.id, a1.id], 'root order survives a reload');
});

test('refuses an older schema-1 document without migrating, rewriting or deleting it', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamA = fx.addTeam([w(1)]);
  const teamB = fx.addTeam([w(2)]);
  const taskA = fx.addTask(teamA);
  const taskB = fx.addTask(teamB);
  const mailbox = await fx.create();

  const inputs = [
    { teamId: teamA, taskId: taskA, kind: 'discovery', body: 'a one', recipients: [w(1)], requestId: 'legacy-a1' },
    { teamId: teamB, taskId: taskB, kind: 'discovery', body: 'b one', recipients: [w(2)], requestId: 'legacy-b1' },
    { teamId: teamA, taskId: taskA, kind: 'discovery', body: 'a two', recipients: [w(1)], requestId: 'legacy-a2' }
  ];
  const created = [];
  for (const input of inputs) created.push(await mailbox.send(co, input));
  const current = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  const before = mailbox.list(co, { teamId: teamA }).messages.map(message => [message.id, message.sequence]);
  await mailbox.close();

  // Exactly the shape an older build wrote: the same retained records without a
  // per-team ordinal and without the bounded per-team cursor map.
  const older = {
    schema: 1,
    ttlMs: current.ttlMs,
    lastSequence: current.lastSequence,
    prunedThrough: current.prunedThrough,
    messages: current.messages.map(({ teamSequence, ...rest }) => rest),
    requests: current.requests
  };
  const text = JSON.stringify(older);
  const namespaceBefore = await fs.readFile(fx.namespace, 'utf8');
  await fs.writeFile(fx.file, text, { mode: 0o600 });

  // Only the current document is read, so an older one fails closed before any
  // prune or write and keeps every byte.
  await assert.rejects(fx.create(), { code: 'mailbox_malformed' });
  assert.equal(await fs.readFile(fx.file, 'utf8'), text, 'the older document was left byte-for-byte untouched');
  assert.equal(JSON.parse(await fs.readFile(fx.file, 'utf8')).schema, 1);
  assert.equal(await fs.readFile(fx.namespace, 'utf8'), namespaceBefore, 'the namespace marker was not rewritten');

  // The refusal lost nothing: restoring the current document exposes the exact
  // retained ids, ordinals, bodies and receipts.
  await fs.writeFile(fx.file, JSON.stringify(current), { mode: 0o600 });
  const reloaded = await fx.create();
  assert.deepEqual(reloaded.list(co, { teamId: teamA }).messages.map(message => [message.id, message.sequence]), before);
  assert.deepEqual(reloaded.list(co, { teamId: teamA }).messages.map(message => message.body), ['a one', 'a two']);
  assert.deepEqual(reloaded.list(co, { teamId: teamB }).messages.map(message => message.id), [created[1].id]);
  assert.equal(reloaded.list(co, { teamId: teamA }).prunedThrough, 0);
  const replay = await reloaded.send(co, inputs[1]);
  assert.equal(replay.id, created[1].id, 'the exact receipt still replays the original event');
  assert.equal(replay.sequence, 1);
  await assert.rejects(reloaded.send(co, { ...inputs[1], body: 'changed' }), { code: 'request_reuse_conflict' });
  const published = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(published.schema, 2, 'the current document keeps its format');
  assert.deepEqual(Object.keys(current.requests).filter(key => !(key in published.requests)), [], 'every receipt and tombstone survives');
  await reloaded.close();
});

test('the durable team map is bounded and refuses instead of evicting a cursor', async t => {
  const original = mailboxLimits.teams;
  mailboxLimits.teams = 2;
  t.after(() => {
    mailboxLimits.teams = original;
  });
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamA = fx.addTeam([w(1)]);
  const teamB = fx.addTeam([w(1)]);
  const teamC = fx.addTeam([w(1)]);
  const taskA = fx.addTask(teamA);
  const taskB = fx.addTask(teamB);
  const taskC = fx.addTask(teamC);
  const mailbox = await fx.create();

  await send(mailbox, co, teamA, taskA, { recipients: [w(1)] });
  await send(mailbox, co, teamB, taskB, { recipients: [w(1)] });
  const input = { teamId: teamC, taskId: taskC, kind: 'discovery', body: 'c one', recipients: [w(1)], requestId: 'bounded-c1' };
  await assert.rejects(mailbox.send(co, input), { code: 'capacity_exceeded' });
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.deepEqual(Object.keys(stored.teams).sort(), [teamA, teamB].sort(), 'no existing counter was evicted');
  assert.equal(mailbox.list(co, { teamId: teamA }).messages.length, 1);
  assert.equal(mailbox.list(co, { teamId: teamB }).messages.length, 1);
  assert.equal(mailbox.list(co, { teamId: teamC }).nextCursor, 0);
  // The refused event consumed nothing, so the same requestId still works once a slot is free.
  mailboxLimits.teams = original;
  const accepted = await mailbox.send(co, input);
  assert.equal(accepted.sequence, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(fx.file, 'utf8')).teams[teamC], { last: 1, prunedThrough: 0 });
});

test('refuses malformed per-team schemas without repairing or rewriting them', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamA = fx.addTeam([w(1)]);
  const teamB = fx.addTeam([w(1)]);
  const taskA = fx.addTask(teamA);
  const taskB = fx.addTask(teamB);
  const mailbox = await fx.create();
  await send(mailbox, co, teamA, taskA, { recipients: [w(1)] });
  await send(mailbox, co, teamB, taskB, { recipients: [w(1)] });
  await send(mailbox, co, teamA, taskA, { recipients: [w(1)] });
  await mailbox.close();
  const pristine = JSON.parse(await fs.readFile(fx.file, 'utf8'));

  const refuses = async (label, document, code = 'mailbox_malformed') => {
    const text = JSON.stringify(document);
    await fs.writeFile(fx.file, text, { mode: 0o600 });
    await assert.rejects(fx.create(), { code }, label);
    assert.equal(await fs.readFile(fx.file, 'utf8'), text, `${label}: the document was left untouched`);
  };
  const base = () => structuredClone(pristine);

  await refuses('an unknown schema version', { ...base(), schema: 3 });
  const duplicate = base();
  duplicate.messages[2].teamSequence = 1;
  await refuses('a repeated per-team ordinal', duplicate);
  const beyond = base();
  beyond.messages[0].teamSequence = 9;
  await refuses('an ordinal beyond its counter', beyond);
  const drifted = base();
  drifted.teams[teamA].last = 5;
  await refuses('a counter that does not match its records', drifted);
  const missing = base();
  delete missing.teams[teamA];
  await refuses('a message without a team counter', missing);
  const extra = base();
  extra.teams[w(20000)] = { last: 1, prunedThrough: 0 };
  await refuses('a counter without records', extra);
  const watermark = base();
  watermark.teams[teamA].prunedThrough = 9;
  await refuses('a watermark beyond the last ordinal', watermark);
  const unbounded = base();
  for (let index = 0; index < mailboxLimits.teams; index += 1) {
    unbounded.teams[w(20100 + index)] = { last: 1, prunedThrough: 0 };
  }
  await refuses('more teams than the bound allows', unbounded);
  const stamped = base();
  delete stamped.messages[0].teamSequence;
  await refuses('a schema-2 record without its team ordinal', stamped);
  const legacyWithTeams = { ...base(), schema: 1, messages: base().messages.map(({ teamSequence, ...rest }) => rest) };
  await refuses('a schema-1 document carrying schema-2 counters', legacyWithTeams);

  // A counter must be reachable from the internal root history: no per-team
  // ordinal or watermark can exceed the root counters, and the assigned total
  // must equal the root sequence exactly.
  const orphanCounter = base();
  orphanCounter.messages = [];
  orphanCounter.requests = {};
  orphanCounter.lastSequence = 0;
  orphanCounter.prunedThrough = 0;
  orphanCounter.teams = { [teamA]: { last: 1, prunedThrough: 0 } };
  await refuses('a counter that the root sequence never allowed', orphanCounter);

  const beyondRoot = base();
  beyondRoot.messages = [];
  beyondRoot.requests = {};
  beyondRoot.teams = { [teamA]: { last: 50, prunedThrough: 50 } };
  await refuses('a team last sequence beyond the root sequence', beyondRoot);

  const beyondRootWatermark = base();
  beyondRootWatermark.messages = [];
  beyondRootWatermark.requests = {};
  beyondRootWatermark.teams = { [teamA]: { last: 2, prunedThrough: 2 } };
  await refuses('a team watermark beyond the root watermark', beyondRootWatermark);

  const summed = base();
  summed.messages = [];
  summed.requests = {};
  summed.lastSequence = 3;
  summed.prunedThrough = 3;
  summed.teams = { [teamA]: { last: 2, prunedThrough: 2 }, [teamB]: { last: 2, prunedThrough: 2 } };
  await refuses('per-team sequences that exceed the root sequence in total', summed);

  // This build assigns exactly one root sequence per team ordinal and never
  // drops a team counter, so a short total is only the shape older rebasing
  // produced: it is refused instead of accepted as an under-accounted history.
  const underAccounted = base();
  underAccounted.messages = [];
  underAccounted.requests = {};
  underAccounted.lastSequence = 3;
  underAccounted.prunedThrough = 3;
  underAccounted.teams = { [teamA]: { last: 2, prunedThrough: 2 } };
  await refuses('per-team sequences that do not account for the whole root sequence', underAccounted);

  // The fully accounted shape is accepted exactly as written.
  const reachable = base();
  reachable.messages = [];
  reachable.requests = {};
  reachable.lastSequence = 2;
  reachable.prunedThrough = 2;
  reachable.teams = { [teamA]: { last: 2, prunedThrough: 2 } };
  await fs.writeFile(fx.file, JSON.stringify(reachable), { mode: 0o600 });
  const reopened = await fx.create();
  assert.equal(reopened.list(co, { teamId: teamA }).prunedThrough, 2, 'reachable per-team watermarks are not trimmed');
  assert.equal(reopened.list(co, { teamId: teamA }).nextCursor, 2);
  assert.deepEqual(reopened.list(co, { teamId: teamA }).messages, []);
  assert.deepEqual(JSON.parse(await fs.readFile(fx.file, 'utf8')), reachable, 'a valid document is never rewritten on open');
});

test('a publication that crosses the retention horizon refuses request_expired with a fresh clock', async t => {
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const real = storage.atomicWrite;
  t.after(() => {
    storage.atomicWrite = real;
  });

  // BEFORE the rename: the clock crosses the horizon inside the last guard. The
  // event was never published, so the same requestId is still a new event.
  let armed = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    if (armed) {
      armed = false;
      fx.advance(mailboxLimits.ttlMs + 1);
    }
    return real(file, text, mode, beforeRename);
  };
  await assert.rejects(
    mailbox.send(co, { teamId, taskId, kind: 'discovery', body: 'late', recipients: [w(1)], requestId: 'late-1' }),
    { code: 'request_expired' }
  );
  storage.atomicWrite = real;
  await assert.rejects(fs.readFile(fx.file, 'utf8'), 'a refused publication leaves no document');
  const published = await mailbox.send(co, { teamId, taskId, kind: 'discovery', body: 'late', recipients: [w(1)], requestId: 'late-1' });
  assert.equal(published.sequence, 1, 'the unpublished attempt consumed no requestId');
  assert.equal(published.retention.expired, false);

  // AFTER the real durable write: the record exists but expired before the
  // response, so it is refused and never returned with expired: false.
  const question = await send(mailbox, co, teamId, taskId, { body: 'q', recipients: [w(1)], requestId: 'q-cross' });
  fx.advance(mailboxLimits.ttlMs - 1000);
  let late = true;
  storage.atomicWrite = async (file, text, mode, beforeRename) => {
    const value = await real(file, text, mode, beforeRename);
    if (late) {
      late = false;
      fx.advance(2000);
    }
    return value;
  };
  const failure = await mailbox.send(workerActor(w(1)), { teamId, taskId, kind: 'reply', replyTo: question.id, body: 'a', requestId: 'r-cross' })
    .then(() => undefined, error => error);
  storage.atomicWrite = real;
  assert.equal(failure && failure.code, 'request_expired', 'an event that expired before the response is never returned');
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  const storedReply = stored.messages.find(message => message.replyTo === question.id);
  assert.ok(storedReply, 'the durable record and its receipt remain for a consistent retry');
  assert.ok(storedReply.expiresAt <= fx.now());
  await assert.rejects(
    mailbox.send(workerActor(w(1)), { teamId, taskId, kind: 'reply', replyTo: question.id, body: 'a', requestId: 'r-cross' }),
    { code: 'request_expired' }
  );
  assert.equal(mailbox.list(co, { teamId }).messages.filter(message => message.expiresAt > fx.now()).length, 0);

  await mailbox.close();
  const reloaded = await fx.create();
  await assert.rejects(
    reloaded.send(workerActor(w(1)), { teamId, taskId, kind: 'reply', replyTo: question.id, body: 'a', requestId: 'r-cross' }),
    { code: 'request_expired' },
    'the tombstone keeps the exact retry refused after a reload'
  );
});

test('the request cap refuses a new event and only the age horizon frees an id', async t => {
  const original = mailboxLimits.requests;
  mailboxLimits.requests = 2;
  t.after(() => {
    mailboxLimits.requests = original;
  });
  const fx = await fixture(t);
  const co = coordinator('co-1');
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();

  const one = await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'cap-1' });
  await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'cap-2' });
  await assert.rejects(send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'cap-3' }), { code: 'capacity_exceeded' });
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(Object.keys(stored.requests).length, 2, 'no live request record was evicted');
  assert.equal(stored.messages.length, 2);

  fx.advance(mailboxLimits.ttlMs * 2 + 1);
  const three = await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'cap-3' });
  assert.equal(three.sequence, 3);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(fx.file, 'utf8')).requests).length, 1, 'the expired tombstones aged out');
  const reused = await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'cap-1' });
  assert.notEqual(reused.id, one.id, 'an aged-out requestId creates a new event');
  assert.equal(reused.sequence, 4);
});

test('an aged-out request tombstone frees its id without a reload or an unrelated write', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const input = { teamId, taskId, kind: 'discovery', body: 'aged', recipients: [w(1)], requestId: 'aged-1' };
  const first = await mailbox.send(co, input);
  const start = fx.now();
  const horizon = start + mailboxLimits.ttlMs * 2;

  // A no-op replay inside the live window returns the original event unchanged.
  assert.equal((await mailbox.send(co, input)).id, first.id);
  assert.equal(mailbox.list(co, { teamId }).messages.length, 1);

  // The message expires, but its tombstone is still inside the double retention
  // horizon: the exact-replay, changed-argument and expired answers are preserved.
  fx.advance(mailboxLimits.ttlMs);
  await assert.rejects(mailbox.send(co, input), { code: 'request_expired' }, 'an exact replay inside the tombstone horizon stays refused');
  await assert.rejects(mailbox.send(co, { ...input, body: 'changed' }), { code: 'request_reuse_conflict' });

  // Precise boundary: the last millisecond inside the horizon still refuses.
  fx.advance(horizon - 1 - fx.now());
  assert.equal(fx.now(), horizon - 1);
  await assert.rejects(mailbox.send(co, input), { code: 'request_expired' });

  // Exactly at the horizon the id is a NEW event. The read-only admission probe
  // refuses it as a write without publishing, pruning or changing one byte.
  fx.advance(1);
  assert.equal(fx.now(), horizon);
  const pristine = await fs.readFile(fx.file, 'utf8');
  // In-memory state is what a probe could most easily mutate without writing:
  // snapshot the loaded document itself, not just the file bytes.
  const loaded = structuredClone(mailbox.data);
  const real = storage.atomicWrite;
  let writes = 0;
  storage.atomicWrite = async (...args) => {
    writes += 1;
    return real(...args);
  };
  t.after(() => {
    storage.atomicWrite = real;
  });
  await assert.rejects(mailbox.send(co, input, undefined, { readOnly: true }), { code: 'mailbox_write_required' });
  assert.equal(writes, 0, 'the admission probe publishes nothing');
  assert.equal(await fs.readFile(fx.file, 'utf8'), pristine, 'the probe writes no bytes');
  assert.deepEqual(mailbox.data, loaded, 'the probe did not prune or mutate the loaded document');

  const reused = await mailbox.send(co, input);
  assert.notEqual(reused.id, first.id, 'the same id creates a new event at the horizon');
  assert.equal(reused.sequence, 2);
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(stored.messages.length, 1, 'the expired message was pruned from the mutation clone before the append');
  assert.equal(stored.lastSequence, 2);
  assert.deepEqual(stored.teams[teamId], { last: 2, prunedThrough: 1 });
  assert.equal(Object.keys(stored.requests).length, 1, 'only the new receipt is retained');
  assert.equal(stored.requests[Object.keys(stored.requests)[0]].messageId, reused.id);

  // A CHANGED use of an aged-out id is a governed new event too.
  const second = await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'aged-2' });
  fx.advance(mailboxLimits.ttlMs * 2);
  const changed = await mailbox.send(co, { ...input, requestId: 'aged-2', body: 'changed after the horizon' });
  assert.notEqual(changed.id, second.id);
  assert.equal(changed.sequence, 4, 'the expired event was pruned before the new sequence was assigned');

  // After a reload the same age classification holds: the aged record is gone on
  // load and its id is a new event, while a retained record keeps its exact replay.
  const retained = await send(mailbox, co, teamId, taskId, { recipients: [w(1)], requestId: 'aged-3' });
  fx.advance(mailboxLimits.ttlMs * 2);
  await mailbox.close();
  const reloaded = await fx.create();
  assert.notEqual((await reloaded.send(co, { ...input, requestId: 'aged-3', body: 'after reload' })).id, retained.id,
    'the same id is a new event after a reload past the horizon');
});

test('a read-only attempt answers replays and no-op acknowledgements and refuses only real writes', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1), w(2)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const input = { teamId, taskId, kind: 'discovery', body: 'stable', recipients: [w(1)], requestId: 'probe-1' };
  const sent = await mailbox.send(co, input);
  const pristine = await fs.readFile(fx.file, 'utf8');

  // Every durable publication from here on is counted at the file layer, so a
  // read-only attempt is proven to reach no write at all - not merely to leave
  // the loaded document alone.
  const real = storage.atomicWrite;
  let writes = 0;
  storage.atomicWrite = async (...args) => {
    writes += 1;
    return real(...args);
  };
  t.after(() => {
    storage.atomicWrite = real;
  });
  const probe = (actor, payload) => mailbox.send(actor, payload, undefined, { readOnly: true });
  const probeAck = (actor, payload) => mailbox.acknowledge(actor, payload, undefined, { readOnly: true });

  // An exact replay answers identically, with no publication and no state change.
  assert.deepEqual(await probe(co, input), sent);
  assert.equal(writes, 0, 'a read-only replay publishes nothing');
  assert.equal(await fs.readFile(fx.file, 'utf8'), pristine, 'a read-only replay writes no bytes');

  // Changed arguments, a foreign coordinator and an invalid recipient keep their
  // own domain errors instead of becoming a write request.
  await assert.rejects(probe(co, { ...input, body: 'changed' }), { code: 'request_reuse_conflict' });
  await assert.rejects(probe(coordinator('co-2'), input), { code: 'forbidden' });
  await assert.rejects(probe(workerActor(w(2)), { ...input, requestId: 'probe-x', recipients: [w(9)] }), { code: 'recipient_invalid' });
  assert.equal(writes, 0);

  // A NEW event is refused before any durable write, and nothing was staged.
  await assert.rejects(probe(co, { ...input, requestId: 'probe-2', body: 'new' }), { code: 'mailbox_write_required' });
  assert.equal(writes, 0, 'a refused read-only attempt publishes nothing');
  assert.equal(await fs.readFile(fx.file, 'utf8'), pristine, 'a refused read-only attempt writes no bytes');
  assert.deepEqual(mailbox.list(co, { teamId }).messages.map(message => message.id), [sent.id], 'no event was staged');

  // The same requestId is still a new event for the real call afterwards.
  const created = await mailbox.send(co, { ...input, requestId: 'probe-2', body: 'new' });
  assert.equal(created.sequence, 2);
  assert.ok(writes > 0, 'the real call published');
  const afterCreate = writes;
  const createdBytes = await fs.readFile(fx.file, 'utf8');

  // The internal flag is never message data: a caller cannot request it.
  await assert.rejects(mailbox.send(co, { ...input, requestId: 'probe-3', readOnly: true }), { code: 'invalid_arguments' });
  await assert.rejects(mailbox.acknowledge(co, { teamId, ids: [sent.id], readOnly: true }), { code: 'invalid_arguments' });
  assert.equal(writes, afterCreate);

  // An acknowledgement that changes nothing answers normally, like a real call.
  const ignored = await probeAck(co, { teamId, ids: [sent.id] });
  assert.deepEqual(ignored, { teamId, acknowledged: [], alreadyAcknowledged: [], ignored: [sent.id] });
  assert.deepEqual(ignored, await mailbox.acknowledge(co, { teamId, ids: [sent.id] }), 'a no-op reads identically both ways');
  assert.equal(writes, afterCreate, 'a no-op acknowledgement publishes nothing');
  assert.equal(await fs.readFile(fx.file, 'utf8'), createdBytes);

  // A first real acknowledgement is refused until it is admitted.
  await assert.rejects(probeAck(workerActor(w(1)), { teamId, ids: [sent.id] }), { code: 'mailbox_write_required' });
  assert.equal(writes, afterCreate, 'the refused probe published nothing');
  const inboxBefore = mailbox.list(workerActor(w(1)), { teamId, direction: 'inbox' }).messages[0];
  assert.equal(inboxBefore.deliveries[0].acknowledgedAt, undefined, 'no acknowledgement was staged');
  const acked = await mailbox.acknowledge(workerActor(w(1)), { teamId, ids: [sent.id] });
  assert.deepEqual(acked.acknowledged, [sent.id]);
  assert.ok(writes > afterCreate, 'the real acknowledgement published');
  const afterAck = writes;
  const ackedBytes = await fs.readFile(fx.file, 'utf8');
  assert.deepEqual(await probeAck(workerActor(w(1)), { teamId, ids: [sent.id] }),
    { teamId, acknowledged: [], alreadyAcknowledged: [sent.id], ignored: [] });
  assert.equal(writes, afterAck, 'an already-acknowledged id publishes nothing');
  assert.equal(await fs.readFile(fx.file, 'utf8'), ackedBytes);

  // Revoked membership and an expired retry keep their domain answers.
  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(2)] });
  await assert.rejects(probe(workerActor(w(1)), { ...input, requestId: 'probe-4', recipients: [w(2)] }), { code: 'forbidden' });
  fx.teams.set(teamId, { coordinatorOwnerId: 'co-1', memberWorkerIds: [w(1), w(2)] });
  fx.advance(mailboxLimits.ttlMs);
  await assert.rejects(probe(co, input), { code: 'request_expired' });
  assert.equal(writes, afterAck, 'no read-only attempt above published');
  await mailbox.close();
});

test('a read-only attempt racing the real call never creates a second event', async t => {
  const fx = await fixture(t);
  const teamId = fx.addTeam([w(1)]);
  const taskId = fx.addTask(teamId);
  const mailbox = await fx.create();
  const co = coordinator('co-1');
  const input = { teamId, taskId, kind: 'discovery', body: 'racy', recipients: [w(1)], requestId: 'race-1' };

  // Both attempts share the mailbox mutex, so the probe either sees the real
  // commit (and answers with the replay) or refuses before it and leaves the
  // single publication to the admitted call.
  const [probed, realCall] = await Promise.all([
    mailbox.send(co, input, undefined, { readOnly: true }).then(message => ({ message }), error => ({ error })),
    mailbox.send(co, input)
  ]);
  assert.equal(realCall.sequence, 1);
  assert.ok(probed.message ? probed.message.id === realCall.id : probed.error.code === 'mailbox_write_required',
    'the probe answered either the replay or the internal refusal');
  assert.deepEqual(mailbox.list(co, { teamId }).messages.map(message => message.id), [realCall.id], 'exactly one event exists');
  const stored = JSON.parse(await fs.readFile(fx.file, 'utf8'));
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.lastSequence, 1);
  assert.deepEqual(stored.teams[teamId], { last: 1, prunedThrough: 0 });
});

// The fixed per-turn raw notice gate must fit ONE worst legal MailboxMessage on
// its own, including every delivery/acknowledgement timestamp: a message keeps
// growing as other recipients are delivered and acknowledged, and a body may be
// 1024 control characters, whose JSON escaping is six bytes each.
test('the fixed raw notice gate fits the worst legal message with all receipts', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const ownerId = '\u0001'.repeat(200);
  const recipients = [
    { kind: 'worker', workerId: '3'.repeat(32) },
    { kind: 'worker', workerId: '4'.repeat(32) },
    { kind: 'worker', workerId: '5'.repeat(32) },
    { kind: 'coordinator', ownerId }
  ];
  const message = {
    id: 'f'.repeat(32),
    sequence: max,
    teamId: '0'.repeat(32),
    taskId: '1'.repeat(32),
    sender: { kind: 'worker', workerId: '2'.repeat(32) },
    recipients,
    // The longest legal original kind: six bytes longer than artifact_ready.
    kind: 'integration_feedback',
    body: '\u0000'.repeat(1024),
    toCoordinator: true,
    artifact: { id: 'a'.repeat(64), version: max, uri: 'codex-subagent://submission/' + 'a'.repeat(64) + '/' + 'a'.repeat(64) + '/' + max },
    evidence: { id: 'b'.repeat(32), version: 1, uri: 'urn:codex-runner-result:' + 'c'.repeat(64) + ':' + 'b'.repeat(32) },
    attempt: { id: 'd'.repeat(64), revision: max },
    persistedAt: max - mailboxLimits.ttlMs,
    expiresAt: max,
    // max - 1 keeps the 16-digit width while still preceding expiry.
    deliveries: recipients.map(recipient => ({ recipient, deliveredAt: max - 1, acknowledgedAt: max - 1 })),
    retention: { payload: 'unretained', refs: 'opaque-unretained', expiresAt: max, expired: false }
  };
  const bytes = Buffer.byteLength(JSON.stringify(message));
  assert.ok(bytes <= MAX_PEER_NOTICE_BYTES, 'the ' + MAX_PEER_NOTICE_BYTES + '-byte gate fits the worst legal notice (' + bytes + ' bytes)');
  assert.ok(bytes > 8 * 1024, 'the old 8 KiB gate could not fit one legal notice (' + bytes + ' bytes)');
});
