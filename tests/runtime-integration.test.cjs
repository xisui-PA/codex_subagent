// Focused adapter checks for the single step-5 integration tool.
//
// This file owns ONLY the host/MCP adapter surface: the advertised tool schema,
// the live flag gates, the real routing into the durable integration service,
// the internal protected evidence pins and the raw publication provenance plan.
// It uses no model network: every worker turn is a stubbed provider response and
// the integration actions themselves never start inference.
//
// Run with STEP5_TEST_BUILD (or CODEX_TEST_BUILD) pointing at a private build
// directory; the default is the shared read-only .test-build.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const build = path.resolve(__dirname, '..', process.env.STEP5_TEST_BUILD?.trim()
  || process.env.CODEX_TEST_BUILD?.trim() || '.test-build');
const {
  isolatedViewMcpTools, isolatedViewSchemas, isIntegrationTool, isOfflineViewTool, integrationReservation
} = require(path.join(build, 'isolated-view-tools'));
const { publicationPlan } = require(path.join(build, 'isolated-view-host'));
const { EvidenceRetention } = require(path.join(build, 'evidence-retention'));
const { WorkerBroker, unpack } = require(path.join(build, 'runtime'));
const { defaults } = require(path.join(build, 'engine'));
const { resourceDefaults } = require(path.join(build, 'resource-governor'));
const { workspaceDirectory } = require(path.join(build, 'workspaces'));
const { integrationActionSchema } = require(path.join(build, 'integration-attempts'));
const { WorkerError } = require(path.join(build, 'types'));

if (typeof publicationPlan !== 'function') {
  throw new Error(`stale integration adapter build at ${build}; recompile it (STEP5_TEST_BUILD=<dir>)`);
}

const model = { id: 'test/integration', name: 'Fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
const ownerId = 'integration-owner';
const teamId = 'b'.repeat(32);
const unknownAttempt = 'a'.repeat(64);
const hex = value => crypto.createHash('sha256').update(value).digest('hex');

const file = (text, mode) => ({ type: 'file', hash: hex(text), size: Buffer.byteLength(text), ...(mode === undefined ? {} : { mode }) });
const manifest = (entries, extra = {}) => ({ schema: 1, root: '/repo', capturedAt: '2024-01-01T00:00:00.000Z', fingerprint: hex('fingerprint'), fileCount: 1, totalBytes: 4, entries, ...extra });
const candidate = entries => ({ tree: { entries }, revision: 3, read: async () => ({ path: '', bytes: Buffer.alloc(0), hash: hex('') }) });

test('the advertised tool is one strict union with a root object schema and integration hints', () => {
  const tool = isolatedViewMcpTools.find(entry => entry.name === 'subagent_integration');
  assert.ok(tool, 'subagent_integration must be advertised');
  // The MCP ToolSchema requires an object at the ROOT of inputSchema, even when
  // the strict discriminated union is expressed with oneOf.
  assert.equal(tool.inputSchema.type, 'object');
  assert.ok(Array.isArray(tool.inputSchema.oneOf) && tool.inputSchema.oneOf.length >= 7);
  // ONE read-only details branch joins the lifecycle branches, so a coordinator
  // can page the complete view a bounded summary replaced.
  const detailsBranch = tool.inputSchema.oneOf.find(branch => (branch.properties.action ?? {}).const === 'details');
  assert.ok(detailsBranch, 'the union advertises the details action');
  for (const field of ['ownerId', 'teamId', 'attemptId', 'expectedRevision', 'offset', 'limit']) {
    assert.ok(detailsBranch.properties[field], `details requires and advertises ${field}`);
  }
  for (const field of ['attemptId', 'expectedRevision', 'ownerId', 'teamId']) {
    assert.ok(detailsBranch.required.includes(field), `details requires ${field}`);
  }
  // The page window is advertised with its defaults and its hard maximum.
  assert.equal(detailsBranch.properties.offset.default, 0);
  assert.equal(detailsBranch.properties.limit.default, 16384);
  assert.equal(detailsBranch.properties.limit.maximum, 65536);
  for (const branch of tool.inputSchema.oneOf) {
    assert.equal(branch.type, 'object');
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.properties.workspaceRoot, 'every branch advertises the root scope field');
  }
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /integration\.enabled/);
  // The description advertises the bounded summary and the details paging that
  // returns the complete view, including the restart-after-revision rule.
  assert.match(tool.description, /truncated summary/);
  assert.match(tool.description, /details/);
  assert.match(tool.description, /nextOffset/);
  // The description names the two paging fences and the mandatory continuation
  // field, so a client is never told a half-true reassembly contract.
  assert.match(tool.description, /expectedContentDigest/);
  assert.match(tool.description, /content_changed/);
  assert.match(tool.description, /revision_conflict/);
  // A summary's details object is advertised as a ready-to-send call.
  assert.match(tool.description, /summary\.details/);
  // The integration note names EVERY live prerequisite, including resources,
  // while every legacy tool keeps the byte-identical original note.
  assert.match(tool.description, /codexSubagent\.resources\.enabled/);
  const legacyNote = ' Opt-in: requires User Settings codexSubagent.taskBoard.enabled and codexSubagent.isolatedViews.enabled. Isolated shell execution additionally requires codexSubagent.isolatedViews.runners.enabled and explicit per-command approval.';
  for (const entry of isolatedViewMcpTools.filter(candidate => candidate.name !== 'subagent_integration')) {
    assert.ok(entry.description.endsWith(legacyNote), `${entry.name} keeps its original opt-in note`);
    assert.doesNotMatch(entry.description, /integration\.enabled/);
  }

  // The bridge treats it as a slow tool and NEVER as an offline/saved fallback.
  assert.equal(isIntegrationTool('subagent_integration'), true);
  assert.equal(isOfflineViewTool('subagent_integration'), false);
  assert.equal(isOfflineViewTool('subagent_runner_status'), true);

  // begin composes a derived snapshot (up to 512 MiB of Git data copied to CAS);
  // every other action writes bounded metadata, and status/release never queue.
  assert.deepEqual(integrationReservation({ action: 'begin' }), { bytes: 600 * 1024 ** 2, reclaim: false });
  assert.deepEqual(integrationReservation({ action: 'apply' }), { bytes: 32 * 1024 ** 2, reclaim: false });
  assert.deepEqual(integrationReservation({ action: 'status' }), { bytes: 32 * 1024 ** 2, reclaim: true });
  assert.deepEqual(integrationReservation({ action: 'details' }), { bytes: 32 * 1024 ** 2, reclaim: true });
  assert.deepEqual(integrationReservation({ action: 'release' }), { bytes: 32 * 1024 ** 2, reclaim: true });
  assert.deepEqual(integrationReservation(undefined), { bytes: 32 * 1024 ** 2, reclaim: false });

  // The wire schema is the service's strict union, not a relaxed copy.
  assert.equal(isolatedViewSchemas.subagent_integration, integrationActionSchema);
  assert.throws(() => integrationActionSchema.parse({ action: 'status', ownerId, teamId, attemptId: unknownAttempt, extra: 1 }));
  assert.throws(() => integrationActionSchema.parse({ action: 'apply', ownerId, teamId }));
  // The details read is a strict, revision-bound, receipt-free page request.
  const details = integrationActionSchema.parse({
    action: 'details', ownerId, teamId, attemptId: unknownAttempt, expectedRevision: 4
  });
  assert.equal(details.offset, 0);
  assert.equal(details.limit, 16384);
  assert.equal(integrationActionSchema.parse({ ...details, offset: 32, limit: 65536 }).limit, 65536);
  assert.throws(() => integrationActionSchema.parse({ ...details, expectedRevision: undefined }));
  assert.throws(() => integrationActionSchema.parse({ ...details, limit: 0 }));
  assert.throws(() => integrationActionSchema.parse({ ...details, limit: 65537 }));
  assert.throws(() => integrationActionSchema.parse({ ...details, offset: -1 }));
  assert.throws(() => integrationActionSchema.parse({ ...details, requestId: 'details-1' }));
  // The content guard is optional in the schema (an offset-0 read may omit it,
  // and the service then reports the current value) but strictly a 64-hex
  // digest, and a continuation page requires it at the service boundary.
  assert.equal(detailsBranch.properties.expectedContentDigest.type, 'string');
  assert.equal(detailsBranch.required.includes('expectedContentDigest'), false);
  assert.equal(integrationActionSchema.parse({
    ...details, expectedContentDigest: 'a'.repeat(64)
  }).expectedContentDigest, 'a'.repeat(64));
  assert.throws(() => integrationActionSchema.parse({ ...details, expectedContentDigest: 'abc' }));
  assert.throws(() => integrationActionSchema.parse({ ...details, expectedContentDigest: 7 }));
});

test('publication compares raw effective entries against the captured base only', () => {
  const base = manifest({ 'src/a.txt': file('base'), 'src/b.txt': file('base'), 'lib/old.txt': file('base') }, { editorPaths: [] });
  const plan = publicationPlan(base, candidate({
    'src/a.txt': file('changed'),
    'src/b.txt': file('base'),
    'lib/old.txt': file('base')
  }));
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0], {
    path: 'src/a.txt',
    before: { type: 'file', hash: hex('base'), size: 4, mode: 0o644 },
    after: { type: 'file', hash: hex('changed'), size: 7, mode: 0o644 }
  });
  // A mode-only edit is a real raw change, and an identical entry is not.
  const modePlan = publicationPlan(manifest({ 'run.sh': file('x') }, { editorPaths: [] }), candidate({ 'run.sh': file('x', 0o755) }));
  assert.equal(modePlan.conflicts.length, 0);
  assert.equal(modePlan.changes.length, 1);
  assert.equal(modePlan.changes[0].after.mode, 0o755);

  // Deleting a captured file is a change; a directory/type transition is an
  // explicit conflict instead.
  const deletion = publicationPlan(manifest({ 'gone.txt': file('base') }, { editorPaths: [] }), candidate({}));
  assert.deepEqual(deletion.conflicts, []);
  assert.equal(deletion.changes[0].after, null);
  const typeChange = publicationPlan(manifest({ src: { type: 'directory' }, 'a.txt': file('base') }, { editorPaths: [] }),
    candidate({ src: file('now a file'), 'a.txt': file('base') }));
  assert.equal(typeChange.conflicts.length, 1);
  assert.match(typeChange.conflicts[0].reason, /unsupported change/);
  assert.equal(typeChange.changes.length, 0);

  // Protected configuration directories and case-only aliases never publish.
  const protectedPlan = publicationPlan(manifest({ '.git/config': file('base') }, { editorPaths: [] }), candidate({ '.git/config': file('changed') }));
  assert.equal(protectedPlan.conflicts.length, 1);
  assert.match(protectedPlan.conflicts[0].reason, /protected path/);
  // Adding a case alias of an UNCHANGED captured file is caught against the
  // resolved namespace, not only among the changed keys.
  const aliasPlan = publicationPlan(manifest({ 'A.txt': file('base') }, { editorPaths: [] }),
    candidate({ 'A.txt': file('base'), 'a.txt': file('added') }));
  assert.ok(aliasPlan.conflicts.length >= 1);
  assert.match(aliasPlan.conflicts[0].reason, /case-only alias/);
  assert.equal(aliasPlan.changes.length, 0);

  // Provenance: an absent editor-override set is UNKNOWN (old or derived), so a
  // changed raw path is refused; a listed editor path is refused even when known.
  const unknown = publicationPlan(manifest({ 'src/a.txt': file('base') }), candidate({ 'src/a.txt': file('changed') }));
  assert.equal(unknown.conflicts.length, 1);
  assert.match(unknown.conflicts[0].reason, /unknown provenance/);
  assert.equal(unknown.changes.length, 0);
  const fromEditor = publicationPlan(manifest({ 'src/a.txt': file('base') }, { editorPaths: ['src/a.txt'] }), candidate({ 'src/a.txt': file('changed') }));
  assert.equal(fromEditor.conflicts.length, 1);
  assert.match(fromEditor.conflicts[0].reason, /editor override/);
  // An UNCHANGED path is never a conflict, even with unknown provenance.
  const untouched = publicationPlan(manifest({ 'src/a.txt': file('base') }), candidate({ 'src/a.txt': file('base') }));
  assert.deepEqual(untouched, { changes: [], conflicts: [] });
});

test('publication planning passes every conflict to the ledger for bounded reporting', () => {
  const before = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
    `file-${String(index).padStart(3, '0')}.txt`, file('before')
  ]));
  const after = Object.fromEntries(Object.keys(before).map(key => [key, file('after')]));
  const plan = publicationPlan(manifest(before), candidate(after));
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.conflicts.length, 257);
  assert.equal(plan.conflicts.at(-1).path, 'file-256.txt');
});

test('internal evidence pins are one exact attempt namespace, invisible to public names', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const evidence = new EvidenceRetention(directory);
  const attempt = hex('attempt-one');
  const pins = [
    { ownerId, teamId, name: 'integration/0/abc/1', uri: 'urn:codex-runner-result:ns:1' },
    { ownerId, teamId, name: 'integration/1/def/1', uri: 'urn:codex-runner-result:ns:2' }
  ];
  const writes = [];
  const publish = async commit => { writes.push(1); await commit(); };
  const adopted = await evidence.pinIntegration(attempt, async () => pins, () => undefined, publish);
  assert.deepEqual(adopted.adopted, pins.map(pin => pin.name));
  assert.equal(writes.length, 1, 'the whole batch is adopted in ONE durable write');

  // An exact replay publishes nothing and keeps one record per name.
  const replay = await evidence.pinIntegration(attempt, async () => pins, () => undefined, publish);
  assert.deepEqual(replay.replayed, pins.map(pin => pin.name));
  assert.equal(writes.length, 1);

  // The runner GC sees internal pins; a public pin/release cannot touch them.
  await evidence.withReferences(uris => {
    assert.equal(uris.has('urn:codex-runner-result:ns:1'), true);
    assert.equal(uris.has('urn:codex-runner-result:ns:2'), true);
  });
  await evidence.update({ ownerId, teamId, name: pins[0].name, uri: pins[0].uri, action: 'release' }, () => undefined);
  await evidence.withReferences(uris => assert.equal(uris.size, 2, 'a public release cannot remove a protected pin'));

  // Public and internal names are separate namespaces: a public pin may reuse the
  // spelling and stays a different record.
  await evidence.update({ ownerId, teamId, name: pins[0].name, uri: 'urn:public', action: 'pin' }, () => undefined);
  await evidence.withReferences(uris => {
    assert.equal(uris.has('urn:codex-runner-result:ns:1'), true);
    assert.equal(uris.has('urn:public'), true);
  });
  await evidence.update({ ownerId, teamId, name: pins[0].name, uri: 'urn:public', action: 'release' }, () => undefined);
  await evidence.withReferences(uris => {
    assert.equal(uris.has('urn:codex-runner-result:ns:1'), true, 'only the public pin was released');
    assert.equal(uris.has('urn:public'), false);
  });

  // A different exact resource under the same attempt is a conflict, never a
  // second truth about one name.
  await assert.rejects(evidence.pinIntegration(attempt, async () => [{ ...pins[0], uri: 'urn:other' }], () => undefined),
    error => error.code === 'retention_conflict');

  // Release is exact and idempotent: another attempt's pins survive.
  const other = hex('attempt-two');
  await evidence.pinIntegration(other, async () => [{ ...pins[0], name: 'integration/9/xyz/1', uri: 'urn:codex-runner-result:ns:9' }], () => undefined);
  const released = await evidence.releaseIntegration(attempt, () => undefined);
  assert.equal(released.released, 2);
  assert.deepEqual(await evidence.releaseIntegration(attempt, () => undefined), { released: 0, names: [] });
  await evidence.withReferences(uris => {
    assert.deepEqual([...uris], ['urn:codex-runner-result:ns:9']);
  });
});

async function fixture(t, flags) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-integration-')));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'base');
  const state = { ...flags, requests: 0, errors: [] };
  state.pool = { [model.id]: { allowWrite: true, allowShell: true, numSessions: 2 } };
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'registry'), roots: [root], identity: `folder:${root}`,
    provider: {
      models: async () => [model], countTokens: async () => 10,
      async *stream() { state.requests += 1; yield { type: 'text', text: 'done' }; }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.pool }),
    files: { canWrite: () => true, allowShell: () => false, approveCommand: async () => false },
    taskBoardEnabled: () => state.board,
    isolatedViewsEnabled: () => state.views,
    integrationEnabled: () => state.integration,
    resourcesEnabled: () => state.resources,
    resources: () => ({ ...resourceDefaults, enabled: state.resources, ...(state.storageBytes === undefined ? {} : { storageBytes: state.storageBytes }) }),
    // The owning window document enumeration exists, so an apply is refused by
    // its durable admission/receipt, never by a missing publication guard.
    publicationDocuments: () => [],
    resourceDirectory: path.join(base, 'governor'),
    onChange() {}, onError(message) { state.errors.push(message); }
  };
  const broker = new WorkerBroker(options);
  t.after(async () => {
    await broker.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await broker.start();
  const directory = await workspaceDirectory(options.storage, root);
  return {
    broker, root, base, directory, state,
    call: async (name, args) => unpack(await broker.invoke(root, name, args)),
    invoke: (name, args) => broker.invoke(root, name, args),
    ledger: path.join(directory, 'integration', 'integration-attempts.json'),
    publications: path.join(directory, 'integration', 'publications')
  };
}

const exists = file => fs.lstat(file).then(() => true, () => false);

test('integration flag gates the real tool before any storage is touched', async t => {
  // Integration opt-in off (everything else on): the tool is refused and the
  // durable ledger directory is never created.
  const off = await fixture(t, { board: true, views: true, integration: false, resources: true });
  const refusal = await off.invoke('subagent_integration', { action: 'status', ownerId, teamId, attemptId: unknownAttempt });
  assert.equal(refusal.isError, true);
  assert.equal(JSON.parse(refusal.content[0].text).error.code, 'feature_disabled');
  const pageRefusal = await off.invoke('subagent_integration', {
    action: 'details', ownerId, teamId, attemptId: unknownAttempt, expectedRevision: 0
  });
  assert.equal(JSON.parse(pageRefusal.content[0].text).error.code, 'feature_disabled');
  assert.equal(await exists(off.ledger), false, 'a refused integration call must not create integration storage');

  // Resources is a prerequisite too: the composed seed is governed work.
  const noResources = await fixture(t, { board: true, views: true, integration: true, resources: false });
  const governed = await noResources.invoke('subagent_integration', { action: 'status', ownerId, teamId, attemptId: unknownAttempt });
  assert.equal(JSON.parse(governed.content[0].text).error.code, 'feature_disabled');
  assert.equal(await exists(noResources.ledger), false);
});

test('enabled integration routes real actions into the durable attempt service', async t => {
  const f = await fixture(t, { board: true, views: true, integration: true, resources: true });
  const team = await f.call('subagent_team_create', { ownerId, requestId: 'team', name: 'Integration team', description: '' });
  // A status read for an unknown attempt reaches the service and answers with its
  // own durable-scope error; nothing is composed, published or inferred.
  await assert.rejects(
    f.call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: unknownAttempt }),
    error => error.code === 'attempt_missing'
  );
  assert.equal(await exists(f.ledger), true, 'the enabled service owns its durable ledger');
  assert.equal(f.state.requests, 0, 'integration never starts inference');
  // The read-only details page routes the same way: it needs no requestId, it is
  // owner/team scoped, and an unknown attempt answers attempt_missing.
  await assert.rejects(f.call('subagent_integration', {
    action: 'details', ownerId, teamId: team.id, attemptId: unknownAttempt, expectedRevision: 0
  }), error => error.code === 'attempt_missing');
  assert.equal(f.state.requests, 0, 'details never starts inference');
  // An attempt that does not exist cannot be released either.
  await assert.rejects(f.call('subagent_integration', {
    action: 'release', ownerId, teamId: team.id, attemptId: unknownAttempt, expectedRevision: 0, requestId: 'r',
    abandon: true, releaseRetention: true
  }), error => error.code === 'attempt_missing');
  // A malformed action is rejected by the strict union before the service.
  await assert.rejects(f.call('subagent_integration', { action: 'publish', ownerId, teamId: team.id }), error => Boolean(error.code));
  // The live opt-in is re-read: turning it off refuses the very next call.
  f.state.integration = false;
  await assert.rejects(f.call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: unknownAttempt }),
    error => error.code === 'feature_disabled');
});

// Admission happens BEFORE the host action. Only an apply whose action never
// entered may retry through the reclaim path with the original denial as its
// internal recovery context; the ledger proves the exact current receipt and
// throws that same denial back for every new or stale request.
test('a denied apply admission is retried exactly once with the internal recovery context', async t => {
  const f = await fixture(t, { board: true, views: true, integration: true, resources: true });
  const denial = new WorkerError('storage_exhausted', 'simulated storage admission denial', true);
  const admissions = [];
  const calls = [];
  // Only the routed local is replaced: admission, lane and reclaim semantics
  // still run through the real broker branch.
  f.broker.route = async () => ({
    root: f.root,
    workspaceRoot: f.root,
    local: {
      store: { directory: f.directory },
      lifecycle: { withStorage: async bytes => { admissions.push(bytes); throw denial; } },
      isolation: { invoke: async (...call) => { calls.push(call); throw call[4]; } }
    }
  });
  await assert.rejects(f.call('subagent_integration', {
    action: 'apply', ownerId, teamId, attemptId: unknownAttempt, expectedRevision: 0, requestId: 'current-apply'
  }), error => error.code === 'storage_exhausted' && error.retryable === true);
  assert.deepEqual(admissions, [32 * 1024 ** 2], 'the denied admission happens exactly once');
  assert.equal(calls.length, 1, 'only the reclaim path enters the apply action');
  assert.equal(calls[0][0], 'subagent_integration');
  assert.strictEqual(calls[0][4], denial, 'the original denial is the internal recovery context');
});

test('no recovery fallback after action entry or for another action or error', async t => {
  const f = await fixture(t, { board: true, views: true, integration: true, resources: true });
  const denial = new WorkerError('storage_exhausted', 'simulated storage admission denial', true);
  let current;
  f.broker.route = async () => ({
    root: f.root,
    workspaceRoot: f.root,
    local: {
      store: { directory: f.directory },
      lifecycle: { withStorage: async (bytes, action) => {
        current.admissions += 1;
        if (current.enter) { return action(); }
        throw current.denial;
      } },
      isolation: { invoke: async () => { current.calls += 1; throw current.denial; } }
    }
  });
  const attempt = async (action, options = {}) => {
    current = { admissions: 0, calls: 0, enter: false, denial, ...options };
    const expected = options.code || 'storage_exhausted';
    await assert.rejects(f.call('subagent_integration', {
      action, ownerId, teamId, attemptId: unknownAttempt, expectedRevision: 0, requestId: 'request-' + action
    }), error => error.code === expected);
    return current;
  };
  // Denied AFTER the action callback entered: never a second attempt.
  let state = await attempt('apply', { enter: true });
  assert.deepEqual({ admissions: state.admissions, calls: state.calls }, { admissions: 1, calls: 1 });
  // Non-apply actions keep their exact admission refusal.
  state = await attempt('begin');
  assert.deepEqual({ admissions: state.admissions, calls: state.calls }, { admissions: 1, calls: 0 });
  // A different admission denial is never turned into a recovery attempt.
  state = await attempt('apply', { denial: new WorkerError('permission_denied', 'simulated live refusal'), code: 'permission_denied' });
  assert.deepEqual({ admissions: state.admissions, calls: state.calls }, { admissions: 1, calls: 0 });
});

test('a fresh apply above the lane budget reports the original admission denial', async t => {
  const f = await fixture(t, { board: true, views: true, integration: true, resources: true, storageBytes: 64 * 1024 ** 2 });
  const team = await f.call('subagent_team_create', { ownerId, requestId: 'team-budget', name: 'Budget team', description: '' });
  // The governed store retains more than the 32 MiB apply headroom, so normal
  // admission is refused before the host action; the ledger must throw that SAME
  // denial back for this fresh request instead of admitting it.
  await fs.writeFile(path.join(f.directory, 'retained.bin'), Buffer.alloc(33 * 1024 ** 2));
  await assert.rejects(f.call('subagent_integration', {
    action: 'apply', ownerId, teamId: team.id, attemptId: unknownAttempt, expectedRevision: 0, requestId: 'fresh-apply'
  }), error => error.code === 'storage_exhausted' && error.retryable === true);
  assert.equal(f.state.requests, 0, 'recovery never starts inference');
});

// A multi-root window has ONE client CWD, but an attempt is stored in the store
// of the root that owns its team. An explicitly routed status must answer from
// that other root, and the bounded summary it returns must carry that canonical
// root in `summary.details`, so the object can be sent back EXACTLY as returned -
// from the client's default CWD - and land on the same durable attempt with the
// same content guard. Without the canonical root the same object would route to
// the default root and answer attempt_missing.
test('a legally oversized attempt in another root is routed there and paged by its own details call', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-integration-multiroot-')));
  const defaultRoot = path.join(base, 'default-root');
  const otherRoot = path.join(base, 'other-root');
  await fs.mkdir(defaultRoot);
  await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(defaultRoot, 'a.txt'), 'base');
  await fs.writeFile(path.join(otherRoot, 'b.txt'), 'base');
  const state = { board: true, views: true, integration: true, resources: true, requests: 0, errors: [] };
  state.pool = { [model.id]: { allowWrite: true, allowShell: true, numSessions: 2 } };
  const options = {
    storage: path.join(base, 'storage'), registry: path.join(base, 'registry'), roots: [defaultRoot, otherRoot],
    identity: `folder:${defaultRoot}`,
    provider: {
      models: async () => [model], countTokens: async () => 10,
      async *stream() { state.requests += 1; yield { type: 'text', text: 'done' }; }
    },
    settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: state.pool }),
    files: { canWrite: () => true, allowShell: () => false, approveCommand: async () => false },
    taskBoardEnabled: () => state.board,
    isolatedViewsEnabled: () => state.views,
    integrationEnabled: () => state.integration,
    resourcesEnabled: () => state.resources,
    resources: () => ({ ...resourceDefaults, enabled: state.resources }),
    publicationDocuments: () => [],
    resourceDirectory: path.join(base, 'governor'),
    onChange() {}, onError(message) { state.errors.push(message); }
  };
  const broker = new WorkerBroker(options);
  t.after(async () => {
    await broker.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await broker.start();
  const call = async (root, name, args) => unpack(await broker.invoke(root, name, args));

  // The team belongs to the OTHER root, and so does the attempt it owns.
  const localTeam = await call(defaultRoot, 'subagent_team_create', {
    ownerId, requestId: 'multiroot-team-default', name: 'Default root team', description: ''
  });
  const team = await call(otherRoot, 'subagent_team_create', {
    ownerId, requestId: 'multiroot-team', name: 'Other root team', description: ''
  });
  const directory = await workspaceDirectory(options.storage, otherRoot);
  const ledgerDirectory = path.join(directory, 'integration');
  await fs.mkdir(ledgerDirectory, { recursive: true });
  const taskId = hex('multiroot-source-task').slice(0, 32);
  const artifact = { id: hex('multiroot-artifact'), version: 1, uri: 'urn:codex-runner-result:seed:1' };
  const evidence = { id: hex('multiroot-evidence').slice(0, 32), version: 1, uri: 'urn:codex-runner-result:ns:1' };
  // One conflict group of 3,001 paths of 1,819 characters: a LEGAL durable record
  // (about 5.5 MiB, well under the 8 MiB metadata bound) whose status view is
  // about 10.9 M characters, above both the 4 MiB reply budget and the relay's
  // 10,000,000-character cap, so only the bounded summary can arrive.
  const hugePaths = Array.from({ length: 3000 }, (_, index) =>
    `oversized/${String(index).padStart(4, '0')}/${'p'.repeat(1800)}.txt`);
  const huge = { paths: ['source.txt', ...hugePaths], inputIds: [taskId], reason: 'divergent rename' };
  const attemptId = hex('multiroot-oversized-attempt');
  const attempt = {
    schema: 1,
    id: attemptId,
    ownerId,
    teamId: team.id,
    beginRequestId: 'multiroot-begin',
    fingerprint: hex('multiroot-fingerprint'),
    revision: 1,
    status: 'ready',
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
    dependencyOnly: false,
    seedOnly: false,
    requirements: {
      sources: [{
        taskId,
        taskRevision: 1,
        title: 'Source task',
        description: '',
        state: 'accepted',
        acceptanceCriteria: [],
        artifact,
        evidence: [evidence],
        producer: { workerId: hex('multiroot-worker').slice(0, 32), workerCreatedAt: '2024-02-01T00:00:00.000Z' }
      }]
    },
    dependencies: [],
    validationCommands: ['node --test'],
    contracts: [],
    conflicts: [huge],
    derivedSnapshotId: hex('multiroot-derived'),
    baseSnapshotId: hex('multiroot-base'),
    sourceSnapshotId: hex('multiroot-source'),
    ancestryVerified: true,
    pinState: 'artifacts',
    evidencePinned: false,
    producerSubmissions: [],
    validations: [],
    requests: []
  };
  const ledgerText = JSON.stringify({ schema: 1, attempts: [attempt] });
  assert.ok(Buffer.byteLength(ledgerText, 'utf8') < 8 * 1024 ** 2, 'the fixture ledger stays a legal durable record');
  await fs.writeFile(path.join(ledgerDirectory, 'integration-attempts.json'), ledgerText);
  await fs.writeFile(path.join(ledgerDirectory, 'integration-attempts.namespace.json'), '{"schema":1,"kind":"integration-attempts"}');

  const statusArgs = { action: 'status', ownerId, teamId: team.id, attemptId };
  // From the default CWD the attempt simply is not in THIS root's ledger.
  await assert.rejects(call(defaultRoot, 'subagent_integration', { ...statusArgs, teamId: localTeam.id }),
    error => error.code === 'attempt_missing');
  // Routed explicitly to the other root, the real service answers the oversized
  // attempt with its bounded summary instead of an unsendable complete view.
  const routed = await call(defaultRoot, 'subagent_integration', { ...statusArgs, workspaceRoot: otherRoot });
  assert.equal(routed.truncated, true);
  assert.equal(routed.attemptId, attemptId);
  assert.equal(routed.ownerId, ownerId);
  assert.equal(routed.teamId, team.id);
  assert.equal(routed.status, 'ready');
  assert.equal(routed.revision, 1);
  assert.equal(routed.summary.kind, 'bounded-integration-summary');
  assert.equal(routed.summary.counts.conflictPaths, hugePaths.length + 1);
  assert.ok(routed.summary.fullViewChars > 4 * 1024 ** 2, 'the complete status view is above the reply budget');
  assert.ok(routed.summary.actionReplyChars > 10_000_000, 'and above the relay response cap');
  assert.equal(state.requests, 0, 'integration never starts inference');

  // The ready-to-send details object names the attempt's OWN canonical root and
  // the exact content guard, never the client's CWD.
  const details = routed.summary.details;
  assert.equal(details.workspaceRoot, otherRoot);
  assert.equal(details.attemptId, attemptId);
  assert.equal(details.ownerId, ownerId);
  assert.equal(details.teamId, team.id);
  assert.equal(details.expectedRevision, 1);
  assert.equal(details.expectedContentDigest, routed.contentDigest);
  assert.equal(details.expectedContentDigest, routed.summary.guard.value);
  assert.equal(details.offset, 0);

  // Sent back EXACTLY as returned, from the default CWD, it succeeds with that
  // canonical root and the same guard.
  const page = await call(defaultRoot, 'subagent_integration', details);
  assert.equal(page.action, 'details');
  assert.equal(page.attemptId, attemptId);
  assert.equal(page.teamId, team.id);
  assert.equal(page.revision, 1);
  assert.equal(page.status, 'ready');
  assert.equal(page.payload, 'status');
  assert.equal(page.encoding, 'utf16-code-unit');
  assert.equal(page.offset, details.offset);
  assert.equal(page.limit, details.limit);
  assert.equal(page.total, routed.summary.fullViewChars);
  assert.equal(page.guard.chars, routed.summary.fullViewChars);
  assert.equal(page.guard.value, details.expectedContentDigest);
  assert.equal(page.contentDigest, details.expectedContentDigest);
  assert.equal(page.text.length, page.nextOffset);
  // A continuation page keeps routing to the same root with the same guard.
  const next = await call(defaultRoot, 'subagent_integration', { ...details, offset: page.nextOffset, limit: 65536 });
  assert.equal(next.offset, page.nextOffset);
  assert.equal(next.total, page.total);
  assert.equal(next.contentDigest, details.expectedContentDigest);
  assert.equal(next.text.length > 0, true);
  // The routing field is what makes that work: the same read aimed at the
  // client's own root still cannot see another root's ledger.
  await assert.rejects(call(defaultRoot, 'subagent_integration', { ...details, workspaceRoot: defaultRoot, teamId: localTeam.id }),
    error => error.code === 'attempt_missing');
});
