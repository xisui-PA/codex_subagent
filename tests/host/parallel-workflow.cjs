// Real VS Code host: integrated governed parallel workflow.
//
// WHAT IS ACTUALLY REAL HERE
//   * This module runs inside the real VS Code extension host launched by
//     tests/run-host-tests.cjs and requires the real `vscode` module.
//   * EXTENSION API WIRING is the activated extension: User Settings are written
//     with vscode.workspace.getConfiguration(...).update(..., Global) and
//     observed live through `api.invoke('subagent_health')`, plus
//     `api.invoke('subagent_team_create'/'subagent_snapshot_create')` on the
//     extension's own broker.
//   * The BROKER is the compiled production WorkerBroker from `.test-build`
//     (real task board, real private views, real resource governor, real
//     physical runner, real publication journal) driven in this host process
//     against real VS Code APIs:
//       - snapshots capture REAL unsaved editor buffers through the real
//         `vscode.workspace.textDocuments` inventory passed to the broker
//         (`openDocuments`, which filters to dirty file documents);
//       - the PUBLICATION port receives the extension's REAL inventory, exactly
//         as src/extension.ts wires it: every file-scheme document plus every
//         absolute-path untitled document, mapped to `{ path, text: '', version }`
//         with NO isDirty filter. A CLEAN editor therefore still guards
//         publication, and that guard is exercised below;
//       - the intervening user edit is a real TextEdit plus a real disk write;
//       - one editor conflict is produced by the real publication guard, and one
//         precondition conflict by the production `applyEditorChange` helper.
//   * PHYSICAL RUNNER EVIDENCE is real: `node check-add.cjs`,
//     `node check-multiply.cjs` and `node verify.cjs` really execute in
//     materialized private copies and produce the succeeded/drained/unchanged
//     results that are bound to exact revisions and then composed.
// WHAT IS SCRIPTED
//   * Only the MODEL and the approval POLICY: the in-memory provider returns the
//     tool call registered for the exact coordinator-sent turn tag, and the
//     fixture `approveCommand` callback approves only the three known test
//     commands, and only when the runner cwd is inside this test's own storage
//     root. Approval is decided by that scripted fixture policy; there is NO real
//     approval UI interaction in this scenario and none is claimed.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const vscode = require('vscode');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Bounded EVENT/poll gate: never a fixed sleep assumption. */
async function until(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`host flow timed out waiting for ${label}`);
    }
    await sleep(50);
  }
}
/**
 * The scripted action tag of one provider request. The engine appends its OWN
 * labelled peer-mailbox delivery block as a trailing user message after the
 * coordinator turn input, so the newest user message is not reliably the
 * coordinator's turn. Only a message made purely of TEXT parts whose trimmed
 * text is EXACTLY one of the registered tags can be a scripted turn;
 * peer-delivery blocks, tool-result messages and any other content are ignored,
 * and no raw token is ever scanned out of content.
 */
const resolveTag = (messages, tags) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || !Array.isArray(message.parts)) {
      continue;
    }
    if (message.parts.some(part => part.type !== 'text')) {
      continue;
    }
    const text = message.parts.map(part => part.text).join('').trim();
    if (text && tags.has(text)) {
      return text;
    }
  }
  return undefined;
};

// The three known test commands: the ONLY commands this fixture policy approves.
const CHECK_ADD = 'node check-add.cjs';
const CHECK_MULTIPLY = 'node check-multiply.cjs';
const AGREED = 'node verify.cjs';
const KNOWN_COMMANDS = new Set([CHECK_ADD, CHECK_MULTIPLY, AGREED]);

const ADD_BASE = 'module.exports = value => value + 1;\n';
const ADD_CHANGED = 'module.exports = value => value + 2;\n';
const MULTIPLY_BASE = 'module.exports = value => value * 2;\n';
const MULTIPLY_CHANGED = 'module.exports = value => value * 3;\n';
const RELEASE = 'module.exports = { version: 1 };\n';
const NOTES_BASE = 'host notes: nothing yet\n';
const NOTES_USER = 'host notes: edited by the user while the workers ran\n';
const CHECK_ADD_SCRIPT = [
  "const add = require('./add.cjs');",
  'const value = add(3);',
  'if (value !== 5) {',
  "  process.stdout.write('add(3) is ' + value);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('add(3)=5');",
  ''
].join('\n');
const CHECK_MULTIPLY_SCRIPT = [
  "const multiply = require('./multiply.cjs');",
  'const value = multiply(4);',
  'if (value !== 12) {',
  "  process.stdout.write('multiply(4) is ' + value);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('multiply(4)=12');",
  ''
].join('\n');
const VERIFY = [
  "const add = require('./add.cjs');",
  "const multiply = require('./multiply.cjs');",
  "const release = require('./release.cjs');",
  'const combined = multiply(add(3));',
  'if (combined !== 15 || release.version !== 1) {',
  "  process.stdout.write('combined ' + combined + ' release ' + release.version);",
  '  process.exit(1);',
  '}',
  "process.stdout.write('combined ' + combined);",
  ''
].join('\n');
const INTERFACE = { id: 'host.interface.add-multiply', version: 1, uri: 'urn:host-interface:add-multiply:1' };

exports.run = async ({ api, repository }) => {
  const ownerId = 'host-parallel-owner';
  const settings = vscode.workspace.getConfiguration('codexSubagent');
  const restore = [];
  try {
    // --- extension API wiring: the User-level opt-ins are honored live -------
    for (const key of ['taskBoard.enabled', 'isolatedViews.enabled', 'resources.enabled', 'isolatedViews.integration.enabled', 'taskBoard.messaging.enabled']) {
      const before = settings.get(key);
      restore.push([key, before]);
      await settings.update(key, true, vscode.ConfigurationTarget.Global);
    }
    const health = JSON.parse((await api.invoke('subagent_health', {})).content[0].text);
    assert.equal(health.ready, true);
    assert.equal(health.taskBoard.enabled, true, 'the activated extension honors the User opt-in live');

    // --- real workspace fixture: clean publication targets, one dirty draft --
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    assert.ok(folder, 'the workspace scenario must have one folder');
    const realRoot = await fs.realpath(folder.uri.fsPath);
    const clean = {
      'add.cjs': ADD_BASE, 'multiply.cjs': MULTIPLY_BASE, 'verify.cjs': VERIFY,
      'check-add.cjs': CHECK_ADD_SCRIPT, 'check-multiply.cjs': CHECK_MULTIPLY_SCRIPT,
      'notes.txt': NOTES_BASE
    };
    for (const [name, text] of Object.entries(clean)) {
      await fs.writeFile(path.join(realRoot, name), text);
    }
    // The publication targets above stay CLOSED on disk. The only dirty editor
    // buffer is this separate draft, which is captured into the snapshot and is
    // never a publication target: a touched unsaved capture override is
    // intentionally unpublishable, so it must not overlap the applied paths.
    const draftPath = path.join(realRoot, 'host-draft.txt');
    await fs.writeFile(draftPath, 'disk draft text\n');
    const draftUri = vscode.Uri.file(draftPath);
    const draft = await vscode.workspace.openTextDocument(draftUri);
    const draftEditor = await vscode.window.showTextDocument(draft);
    await draftEditor.edit(builder => builder.insert(new vscode.Position(0, 0), 'unsaved editor draft\n'));
    assert.equal(draft.isDirty, true, 'the draft buffer really holds unsaved content');
    const unsaved = 'unsaved editor draft\ndisk draft text\n';
    assert.equal(draft.getText(), unsaved);
    const { openText, applyEditorChange } = require(path.join(repository, '.test-build', 'editor.js'));
    // The production helper compares its own path form: VS Code's Uri.fsPath
    // normalizes the Windows drive-letter case, so a raw realpath string would
    // not match the open document even though it names the same file.
    const draftFsPath = vscode.Uri.file(draftPath).fsPath;
    assert.equal(openText(draftFsPath)?.getText(), unsaved,
      `the production editor helper sees the same unsaved text (open: ${JSON.stringify(vscode.workspace.textDocuments.map(document => document.uri.fsPath).slice(0, 12))})`);

    // --- the extension's own broker captures the real workspace --------------
    const hostTeam = JSON.parse((await api.invoke('subagent_team_create', {
      ownerId, requestId: crypto.randomUUID(), name: 'Host parallel team', description: 'Host integrated flow'
    })).content[0].text);
    assert.match(hostTeam.id, /^[a-f0-9]{32}$/);
    const hostSnapshot = JSON.parse((await api.invoke('subagent_snapshot_create', {
      ownerId, teamId: hostTeam.id, requestId: crypto.randomUUID()
    })).content[0].text);
    assert.match(hostSnapshot.id, /^[a-f0-9]{64}$/, 'the extension broker captured the real project');

    // --- compiled real broker, real runners, real publication inventory ------
    const { WorkerBroker, unpack } = require(path.join(repository, '.test-build', 'runtime.js'));
    const { defaults } = require(path.join(repository, '.test-build', 'engine.js'));
    const { resourceDefaults } = require(path.join(repository, '.test-build', 'resource-governor.js'));
    const model = { id: 'host/fake', name: 'Host fixture', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100_000 };
    const storage = path.join(process.env.CODEX_HOME, 'host-parallel');
    // `errors` collects EVERY broker onChange diagnostic verbatim, so the final
    // audit can assert the complete unfiltered list instead of discarding it.
    const state = { scripts: new Map(), tags: new Set(), catalogs: [], calls: [], approvals: [], errors: [] };
    const options = {
      storage, registry: path.join(storage, 'bridges'), roots: [realRoot], identity: `folder:${realRoot}`,
      provider: {
        models: async () => [model], countTokens: async () => 10,
        async *stream(_selected, messages, tools) {
          const tag = resolveTag(messages, state.tags);
          if (tag === undefined) {
            // Unknown bootstrap, or a request whose only user text is the
            // engine's own peer-delivery block: answer plainly, consume nothing.
            yield { type: 'text', text: 'done' };
            return;
          }
          state.calls.push(tag);
          state.catalogs.push({ tag, tools: (Array.isArray(tools) ? tools : []).map(tool => tool.name) });
          const script = state.scripts.get(tag);
          if (script === undefined) {
            yield { type: 'text', text: 'done' };
            return;
          }
          state.scripts.delete(tag);
          yield { ...script.part };
        }
      },
      settings: () => ({ ...defaults, autoCompact: false, retries: 0, models: { [model.id]: { allowWrite: true, allowShell: true, numSessions: 8 } } }),
      taskBoardEnabled: () => true, isolatedViewsEnabled: () => true, integrationEnabled: () => true, messagingEnabled: () => true,
      resourcesEnabled: () => true, resources: () => ({ ...resourceDefaults, enabled: true }), resourceDirectory: path.join(storage, 'resources'),
      // Real physical runners: one slot, so nothing can silently run in parallel.
      runners: () => ({ enabled: true, capacity: 1, maxQueue: 4 }),
      files: {
        canWrite: () => true, allowShell: () => true,
        // Fixture-scoped approval POLICY (no UI): only the three known test
        // commands, and only inside this test's own storage root.
        approveCommand: async (command, cwd, _signal, _workspaceRoot, context) => {
          const allowed = KNOWN_COMMANDS.has(command) && inside(storage, cwd);
          state.approvals.push({ command, cwd, executionRoot: context?.executionRoot, allowed });
          return allowed;
        },
        applyChange: applyEditorChange
      },
      // The real editor enumeration: dirty file documents of this host window.
      openDocuments: () => vscode.workspace.textDocuments
        .filter(document => document.isDirty && document.uri.scheme === 'file')
        .map(document => ({ path: document.uri.fsPath, text: document.getText(), version: document.version })),
      // The REAL publication inventory, identical to src/extension.ts: EVERY
      // file-scheme document plus every absolute-path untitled document, mapped
      // to `{ path, text: '', version }`. There is deliberately NO isDirty
      // filter, so a clean open editor still guards publication.
      publicationDocuments: () => vscode.workspace.textDocuments
        .filter(document => document.uri.scheme === 'file' || (document.isUntitled && path.isAbsolute(document.uri.fsPath)))
        .map(document => ({ path: document.uri.fsPath, text: '', version: document.version })),
      // Every broker diagnostic is recorded verbatim (never swallowed) and is
      // asserted as an exact empty list at the final audit below.
      onChange: () => {}, onError: message => state.errors.push(message)
    };
    const brokers = [];
    const open = async () => { const broker = new WorkerBroker(options); brokers.push(broker); await broker.start(); return broker; };
    let broker = await open();
    const call = async (name, args) => unpack(await broker.invoke(realRoot, name, args));
    try {
      // The publication inventory really is the live editor state. Earlier host
      // assertions may leave unrelated documents open, so nothing here assumes a
      // count: the draft is inspected by path, the publication targets are proved
      // ABSENT until this scenario opens one, and every entry keeps the exact
      // production shape.
      const inventory = options.publicationDocuments();
      assert.ok(Array.isArray(inventory));
      const draftEntries = inventory.filter(entry => entry.path === draftUri.fsPath);
      assert.equal(draftEntries.length, 1, 'the dirty draft is in the real inventory exactly once');
      assert.equal(draftEntries[0].text, '', 'the production inventory shape carries no document text');
      assert.equal(typeof draftEntries[0].version, 'number');
      assert.deepEqual(inventory.filter(entry => entry.text !== ''), [], 'no inventory entry carries text');
      assert.deepEqual(inventory.filter(entry => !path.isAbsolute(entry.path)), [], 'every inventory path is absolute');
      const openPaths = new Set(inventory.map(entry => entry.path));
      for (const target of [path.join(realRoot, 'add.cjs'), path.join(realRoot, 'multiply.cjs'), path.join(realRoot, 'release.cjs')]) {
        assert.equal(openPaths.has(vscode.Uri.file(target).fsPath), false, `${target} has no open editor yet`);
      }

      // --- team, shared snapshot, three tasks --------------------------------
      const team = await call('subagent_team_create', { ownerId, requestId: 'host-team', name: 'Host flow', description: '' });
      const snapshot = await call('subagent_snapshot_create', { ownerId, teamId: team.id, requestId: 'host-snapshot' });
      assert.match(snapshot.id, /^[a-f0-9]{64}$/);
      const createTask = (requestId, title, dependencies = []) => call('subagent_task_create', {
        ownerId, requestId, teamId: team.id, title, description: `Host task ${title}`,
        acceptanceCriteria: [`${AGREED} passes on the combined result`], dependencies
      });
      const taskA = await createTask('host-task-add', 'add');
      const taskP = await createTask('host-task-multiply', 'multiply');
      const taskB = await createTask('host-task-consumer', 'consumer', [
        { taskId: taskA.id, kind: 'artifact' }, { taskId: taskA.id, kind: 'contract' },
        { taskId: taskP.id, kind: 'artifact' }, { taskId: taskP.id, kind: 'contract' }
      ]);

      const spawnGoverned = async (requestId, taskId, lane, snapshotId, prompt, first) => {
        if (first !== undefined) {
          state.tags.add(prompt);
          state.scripts.set(prompt, { part: first });
        }
        const currentTeam = await call('subagent_team_get', { ownerId, id: team.id });
        const currentTask = await call('subagent_task_get', { ownerId, id: taskId });
        return call('subagent_isolated_spawn', {
          ownerId, requestId, task: prompt, model: model.id, permission: 'workspace-write',
          setup: { teamId: team.id, taskId, snapshotId, teamRevision: currentTeam.revision, taskRevision: currentTask.revision, lane }
        });
      };
      // OMIT timeoutMs: the derived production default is
      // max(60s, effective turn timeout / 10) and a larger explicit value is
      // rejected outright. A single wait can elapse while the worker is still
      // queued or running, so the state is re-read and waited again.
      const settled = async (id, allowed) => {
        for (let round = 0; round < 40; round += 1) {
          if (allowed.includes((await broker.session(realRoot, id)).state)) {
            return;
          }
          await call('subagent_wait', { ids: [id] });
        }
        throw new Error(`worker ${id} never reached ${allowed.join('/')}`);
      };
      const stopped = async id => {
        await settled(id, ['completed', 'failed', 'cancelled', 'interrupted']);
        const session = await broker.session(realRoot, id);
        assert.equal(session.state, 'completed', `worker ${id} did not stop: ${JSON.stringify(session.turns.at(-1)?.error)}`);
        return session;
      };
      const turn = async (id, tag, part) => {
        state.tags.add(tag);
        state.scripts.set(tag, { part });
        await call('subagent_send', { ownerId, id, requestId: tag, message: tag });
        return stopped(id);
      };
      /**
       * Parse one tool result and FAIL with the product's own bounded error
       * diagnostic when the call was refused, so a future invalid call reports
       * its error code instead of an `undefined` field of the expected shape.
       */
      const toolResult = (session, name) => {
        const entry = session.turns.at(-1).tools.find(tool => tool.call.name === name);
        assert.ok(entry, `the last turn must contain a ${name} call`);
        const parsed = JSON.parse(entry.result);
        if (parsed !== null && typeof parsed === 'object' && parsed.error !== undefined) {
          assert.fail(`${name} was refused instead of answering: ${JSON.stringify(parsed.error).slice(0, 2000)}`);
        }
        return parsed;
      };
      const readFile = path0 => ({ type: 'call', id: 'read', name: 'read_file', input: { path: path0 } });
      const writeFile = (path0, expectedHash, content) => ({ type: 'call', id: 'edit', name: 'write_file', input: { path: path0, expectedHash, content } });
      const runCommand = command => ({ type: 'call', id: 'run', name: 'run_command', input: { command, path: '.' } });
      const seal = (requestId, expectedRevision) => ({ type: 'call', id: 'seal', name: 'seal_submission', input: { requestId, expectedRevision } });
      const submit = async (taskId, artifact, label) => {
        const current = await call('subagent_task_get', { ownerId, id: taskId });
        const started = await call('subagent_task_update', { ownerId, requestId: `${label}-start`, taskId, expectedRevision: current.revision, state: 'in_progress' });
        assert.equal(started.state, 'in_progress');
        const submitted = await call('subagent_task_update', { ownerId, requestId: `${label}-submit`, taskId, expectedRevision: started.revision, candidates: [artifact], state: 'submitted' });
        assert.deepEqual(submitted.candidates, [artifact]);
        return submitted;
      };
      const accept = async (taskId, artifact, evidence, label) => {
        const submitted = await submit(taskId, artifact, label);
        const validating = await call('subagent_task_update', { ownerId, requestId: `${label}-validating`, taskId, expectedRevision: submitted.revision, state: 'validating' });
        const verdict = await call('subagent_task_update', {
          ownerId, requestId: `${label}-verdict`, taskId, expectedRevision: validating.revision, state: 'validating',
          validations: [{ artifactId: artifact.id, candidateVersion: artifact.version, outcome: 'passed', resultRef: evidence, at: new Date().toISOString() }]
        });
        const accepted = await call('subagent_task_update', { ownerId, requestId: `${label}-accept`, taskId, expectedRevision: verdict.revision, state: 'accepted' });
        assert.equal(accepted.state, 'accepted');
        return accepted;
      };

      // --- TWO governed producers bound to the SAME base before any tool -----
      const peer = await spawnGoverned('host-producer-multiply', taskP.id, 'work', snapshot.id, 'host-p-first', readFile('multiply.cjs'));
      const peerFirst = await stopped(peer.id);
      assert.equal(peerFirst.mode, 'governed');
      assert.equal(peerFirst.isolatedView?.snapshotId, snapshot.id, 'the peer was bound to the shared snapshot before its first tool');
      const peerTools = state.catalogs.find(entry => entry.tag === 'host-p-first')?.tools ?? [];
      assert.ok(peerTools.includes('seal_submission'));
      assert.ok(peerTools.includes('subagent_mailbox_send'));
      assert.ok(peerTools.includes('run_command'), 'the live physical runner seam is offered');
      assert.equal(toolResult(peerFirst, 'read_file').content, MULTIPLY_BASE);
      assert.equal(toolResult(peerFirst, 'read_file').revision, 0);

      const producer = await spawnGoverned('host-producer-add', taskA.id, 'work', snapshot.id, 'host-a-proposal', {
        type: 'call', id: 'proposal', name: 'subagent_mailbox_send',
        input: {
          teamId: team.id, taskId: taskA.id, requestId: 'host-a-proposal-send', kind: 'interface_proposal',
          body: 'Proposed seam: add.cjs first, multiply.cjs consumes it, release.cjs carries the version.',
          recipients: [peer.id]
        }
      });
      const producerFirst = await stopped(producer.id);
      assert.equal(producerFirst.mode, 'governed');
      assert.equal(producerFirst.isolatedView?.snapshotId, snapshot.id, 'producer A shares the one captured snapshot');
      const producerTools = state.catalogs.find(entry => entry.tag === 'host-a-proposal')?.tools ?? [];
      assert.ok(producerTools.includes('seal_submission'));
      assert.ok(producerTools.includes('run_command'));
      const proposal = toolResult(producerFirst, 'subagent_mailbox_send');
      assert.equal(proposal.kind, 'interface_proposal');
      assert.equal(proposal.teamId, team.id);
      assert.equal(proposal.taskId, taskA.id, 'the proposal is routed on the PRODUCER task A');

      // The peer answers; A reads the agreement itself.
      const peerInbox = toolResult(await turn(peer.id, 'host-p-inbox', { type: 'call', id: 'list', name: 'subagent_mailbox_list', input: { teamId: team.id } }), 'subagent_mailbox_list');
      assert.ok(peerInbox.messages.some(message => message.id === proposal.id), 'the peer reads the proposal from the durable mailbox');
      const reply = toolResult(await turn(peer.id, 'host-p-reply', {
        type: 'call', id: 'reply', name: 'subagent_mailbox_send',
        // A reply stays in the TARGET's exact team and task - the producer task
        // the proposal was routed on - not the replying worker's own task.
        input: { teamId: proposal.teamId, taskId: proposal.taskId, requestId: 'host-p-reply-send', kind: 'interface_response', body: 'Agreed: multiply consumes add, release carries version 1.', replyTo: proposal.id }
      }), 'subagent_mailbox_send');
      assert.equal(reply.kind, 'interface_response');
      assert.equal(reply.replyTo, proposal.id);
      assert.equal(reply.teamId, proposal.teamId, 'the reply echoes the proposal team');
      assert.equal(reply.taskId, proposal.taskId, 'the reply echoes the proposal task');
      // A's own INBOX only: the default list direction is 'all', which would also
      // return A's own proposal from its outbox.
      const aInbox = toolResult(await turn(producer.id, 'host-a-inbox', { type: 'call', id: 'list', name: 'subagent_mailbox_list', input: { teamId: team.id, direction: 'inbox' } }), 'subagent_mailbox_list');
      assert.deepEqual(aInbox.messages.map(message => message.kind), ['interface_response']);

      // The coordinator records the agreed interface only now, on both tasks.
      const currentA = await call('subagent_task_get', { ownerId, id: taskA.id });
      const contractedA = await call('subagent_task_update', { ownerId, requestId: 'host-agree-a', taskId: taskA.id, expectedRevision: currentA.revision, agreedContracts: { add: [INTERFACE] } });
      const currentP = await call('subagent_task_get', { ownerId, id: taskP.id });
      const contractedP = await call('subagent_task_update', { ownerId, requestId: 'host-agree-p', taskId: taskP.id, expectedRevision: currentP.revision, agreedContracts: { add: [INTERFACE] } });
      assert.deepEqual(contractedA.agreedContracts, [INTERFACE]);
      assert.deepEqual(contractedP.agreedContracts, [INTERFACE]);

      // --- both producers implement privately --------------------------------
      assert.equal(toolResult(await turn(producer.id, 'host-a-edit', writeFile('add.cjs', hash(ADD_BASE), ADD_CHANGED)), 'write_file').revision, 1);
      assert.equal(toolResult(await turn(peer.id, 'host-p-edit', writeFile('multiply.cjs', hash(MULTIPLY_BASE), MULTIPLY_CHANGED)), 'write_file').revision, 1);
      assert.equal(await fs.readFile(path.join(realRoot, 'add.cjs'), 'utf8'), ADD_BASE, 'a private edit never reaches the live workspace');
      assert.equal(await fs.readFile(path.join(realRoot, 'multiply.cjs'), 'utf8'), MULTIPLY_BASE);
      // The REAL captured unsaved buffer is the producer revision 0 base.
      const draftLook = toolResult(await turn(producer.id, 'host-a-draft', readFile('host-draft.txt')), 'read_file');
      assert.equal(draftLook.content, unsaved, 'the snapshot really captured the unsaved editor buffer');
      assert.equal(draftLook.revision, 1);
      assert.equal(draft.getText(), unsaved, 'the private read never touched the real buffer');
      assert.equal(await fs.readFile(draftPath, 'utf8'), 'disk draft text\n', 'and never wrote the draft to disk');
      const crossLook = toolResult(await turn(peer.id, 'host-p-cross', readFile('add.cjs')), 'read_file');
      assert.equal(crossLook.content, ADD_BASE, 'the peer cannot see the other producer private edit');
      assert.equal(crossLook.revision, 1);

      // --- seals, retention, and real producer evidence ----------------------
      const sealedA = toolResult(await turn(producer.id, 'host-a-seal', seal('host-a-seal', 1)), 'seal_submission');
      const sealedP = toolResult(await turn(peer.id, 'host-p-seal', seal('host-p-seal', 1)), 'seal_submission');
      assert.equal(sealedA.snapshotId, snapshot.id);
      assert.equal(sealedP.snapshotId, snapshot.id);
      assert.notEqual(sealedA.overlayId, sealedP.overlayId, 'distinct private overlays over one shared snapshot');
      const artifactA = { id: sealedA.id, version: sealedA.version, uri: sealedA.uri };
      const artifactP = { id: sealedP.id, version: sealedP.version, uri: sealedP.uri };
      assert.ok(await call('subagent_view_pin', { ownerId, teamId: team.id, requestId: 'host-pin-a', name: 'host-add', resource: { kind: 'submission', id: sealedA.id } }));
      assert.ok(await call('subagent_view_pin', { ownerId, teamId: team.id, requestId: 'host-pin-p', name: 'host-multiply', resource: { kind: 'submission', id: sealedP.id } }));

      const runA = toolResult(await turn(producer.id, 'host-a-run', runCommand(CHECK_ADD)), 'run_command');
      assert.equal(runA.outcome, 'succeeded', JSON.stringify(runA));
      assert.equal(runA.exitCode, 0);
      assert.equal(runA.drained, true);
      assert.equal(runA.import, 'unchanged');
      assert.equal(runA.attempt.inputVersion.revision, 1);
      assert.equal(runA.attempt.inputVersion.snapshotId, snapshot.id);
      assert.match(runA.output, /add\(3\)=5/);
      const runP = toolResult(await turn(peer.id, 'host-p-run', runCommand(CHECK_MULTIPLY)), 'run_command');
      assert.equal(runP.outcome, 'succeeded', JSON.stringify(runP));
      assert.equal(runP.drained, true);
      assert.equal(runP.import, 'unchanged');
      assert.equal(runP.attempt.inputVersion.revision, 1);
      assert.equal(runP.attempt.inputVersion.snapshotId, snapshot.id);
      assert.match(runP.output, /multiply\(4\)=12/);
      const evidenceA = { id: runA.id, version: runA.version, uri: runA.uri };
      const evidenceP = { id: runP.id, version: runP.version, uri: runP.uri };
      // Each exact result is re-read so the ref actually handed to integration is
      // proved current for the revision it names; the integration begin then
      // re-pins these exact evidence refs before composition (production path).
      const retainedA = await call('subagent_runner_result', { ownerId, teamId: team.id, id: runA.id });
      assert.equal(retainedA.result.uri, evidenceA.uri);
      assert.equal(retainedA.result.attempt.inputVersion.overlayId, sealedA.overlayId);
      assert.equal(retainedA.inputIsCurrent, true);
      const retainedP = await call('subagent_runner_result', { ownerId, teamId: team.id, id: runP.id });
      assert.equal(retainedP.result.attempt.inputVersion.overlayId, sealedP.overlayId);
      assert.equal(retainedP.inputIsCurrent, true);
      assert.equal(state.approvals.filter(entry => !entry.allowed).length, 0, 'both producer commands were approved by the fixture policy only');

      // --- board settles each producer by its own exact verdict --------------
      const acceptedA = await accept(taskA.id, artifactA, evidenceA, 'host-accept-a');
      const acceptedP = await accept(taskP.id, artifactP, evidenceP, 'host-accept-p');

      // --- consumer B starts directly on the exact composed seed ------------
      const consumerTask = await call('subagent_task_get', { ownerId, id: taskB.id });
      const seed = await call('subagent_integration', {
        action: 'begin', ownerId, teamId: team.id, requestId: 'host-seed',
        sources: [
          { taskId: taskA.id, taskRevision: acceptedA.revision, artifact: artifactA, evidence: [evidenceA] },
          { taskId: taskP.id, taskRevision: acceptedP.revision, artifact: artifactP, evidence: [evidenceP] }
        ],
        contracts: [
          { taskId: taskA.id, taskRevision: acceptedA.revision, ref: INTERFACE },
          { taskId: taskP.id, taskRevision: acceptedP.revision, ref: INTERFACE }
        ],
        consumer: { taskId: taskB.id, taskRevision: consumerTask.revision }
      });
      assert.equal(seed.status, 'ready', JSON.stringify(seed.failure));
      assert.equal(seed.seedOnly, true);
      assert.equal(seed.baseSnapshotId, snapshot.id);
      assert.match(seed.derivedSnapshotId, /^[a-f0-9]{64}$/);
      assert.notEqual(seed.derivedSnapshotId, snapshot.id);

      const consumer = await spawnGoverned('host-consumer', taskB.id, 'work', seed.derivedSnapshotId, 'host-b-add', readFile('add.cjs'));
      const consumerFirst = await stopped(consumer.id);
      assert.equal(consumerFirst.isolatedView?.snapshotId, seed.derivedSnapshotId, 'the consumer started on the exact composed seed');
      assert.equal(consumerFirst.startup?.snapshotId, seed.derivedSnapshotId);
      assert.equal(toolResult(consumerFirst, 'read_file').content, ADD_CHANGED, 'the consumer proves the producer bytes at revision 0');
      assert.equal(toolResult(consumerFirst, 'read_file').revision, 0);
      const multiplyLook = toolResult(await turn(consumer.id, 'host-b-multiply', readFile('multiply.cjs')), 'read_file');
      assert.equal(multiplyLook.content, MULTIPLY_CHANGED);
      assert.equal(multiplyLook.revision, 0);
      assert.equal(toolResult(await turn(consumer.id, 'host-b-release', writeFile('release.cjs', 'new', RELEASE)), 'write_file').revision, 1);
      const sealedB = toolResult(await turn(consumer.id, 'host-b-seal', seal('host-b-seal', 1)), 'seal_submission');
      assert.equal(sealedB.snapshotId, seed.derivedSnapshotId);
      const runB = toolResult(await turn(consumer.id, 'host-b-run', runCommand(AGREED)), 'run_command');
      assert.equal(runB.outcome, 'succeeded', JSON.stringify(runB));
      assert.equal(runB.drained, true);
      assert.equal(runB.import, 'unchanged');
      assert.equal(runB.attempt.inputVersion.revision, 1);
      assert.equal(runB.attempt.inputVersion.snapshotId, seed.derivedSnapshotId);
      assert.match(runB.output, /combined 15/);
      const artifactB = { id: sealedB.id, version: sealedB.version, uri: sealedB.uri };
      const evidenceB = { id: runB.id, version: runB.version, uri: runB.uri };
      const submittedB = await submit(taskB.id, artifactB, 'host-submit-consumer');

      // --- publishing integration over the selected consumer output ---------
      const publishing = await call('subagent_integration', {
        action: 'begin', ownerId, teamId: team.id, requestId: 'host-publish',
        sources: [{ taskId: taskB.id, taskRevision: submittedB.revision, artifact: artifactB, evidence: [evidenceB] }],
        contracts: [
          { taskId: taskA.id, taskRevision: acceptedA.revision, ref: INTERFACE },
          { taskId: taskP.id, taskRevision: acceptedP.revision, ref: INTERFACE }
        ],
        validationCommands: [AGREED]
      });
      assert.equal(publishing.status, 'ready', JSON.stringify(publishing.failure));
      assert.equal(publishing.seedOnly, false);
      assert.deepEqual(publishing.requirements.sources.map(source => source.evidence), [[evidenceB]]);
      assert.equal(publishing.baseSnapshotId, seed.derivedSnapshotId);
      assert.deepEqual(publishing.conflictPaths, []);
      for (const [name, text] of Object.entries(clean)) {
        assert.equal(await fs.readFile(path.join(realRoot, name), 'utf8'), text, `nothing publishes before apply (${name})`);
      }

      // --- the combined candidate is really executed ------------------------
      const validationTask = await createTask('host-task-validation', 'validation');
      const validationWorker = await spawnGoverned('host-validation', validationTask.id, 'validation', publishing.derivedSnapshotId, 'host-validation-seed', seal('host-seed-seal', 0));
      const validationSession = await stopped(validationWorker.id);
      const seedSeal = toolResult(validationSession, 'seal_submission');
      assert.equal(seedSeal.revision, 0);
      assert.equal(seedSeal.snapshotId, publishing.derivedSnapshotId);
      const seedRun = toolResult(await turn(validationWorker.id, 'host-validation-run', runCommand(AGREED)), 'run_command');
      assert.equal(seedRun.outcome, 'succeeded', JSON.stringify(seedRun));
      assert.equal(seedRun.drained, true);
      assert.equal(seedRun.import, 'unchanged');
      assert.equal(seedRun.attempt.inputVersion.revision, 0);
      assert.match(seedRun.output, /combined 15/);

      const candidate = await call('subagent_integration', {
        action: 'candidate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: publishing.revision, requestId: 'host-candidate',
        artifact: { id: seedSeal.id, version: seedSeal.version, uri: seedSeal.uri }
      });
      assert.equal(candidate.status, 'candidate');
      assert.equal(candidate.candidate.lane, 'validation');
      assert.equal(candidate.candidate.submission.revision, 0);
      // Producer evidence proves a DIFFERENT revision and is refused.
      await assert.rejects(call('subagent_integration', {
        action: 'validate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: candidate.revision, requestId: 'host-validate-stale', evidence: [evidenceA]
      }), error => error.code === 'evidence_invalid');
      const refused = await call('subagent_integration', { action: 'status', ownerId, teamId: team.id, attemptId: publishing.attemptId });
      assert.equal(refused.status, 'candidate');
      assert.deepEqual(refused.validations, []);
      const validated = await call('subagent_integration', {
        action: 'validate', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: refused.revision, requestId: 'host-validate',
        evidence: [{ id: seedRun.id, version: seedRun.version, uri: seedRun.uri }]
      });
      assert.equal(validated.status, 'validated');
      assert.deepEqual(validated.validations.map(entry => entry.result.id), [seedRun.id]);
      const accepted = await call('subagent_integration', {
        action: 'accept', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: validated.revision, requestId: 'host-accept'
      });
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.canPublish, true);

      // --- intervening user edit, then a REAL editor conflict ----------------
      await fs.writeFile(path.join(realRoot, 'notes.txt'), NOTES_USER);
      await draftEditor.edit(builder => builder.insert(new vscode.Position(0, 0), 'user typed meanwhile\n'));
      const userDraft = `user typed meanwhile\n${unsaved}`;
      assert.equal(draft.getText(), userDraft);
      assert.equal(await fs.readFile(draftPath, 'utf8'), 'disk draft text\n', 'the user edit is still unsaved in the real editor');
      // Adapter-level precondition: the production `applyEditorChange` helper
      // refuses a stale expectedHash on a live document. This is a separate
      // adapter check, NOT the publication guard exercised below.
      await assert.rejects(
        applyEditorChange({ id: crypto.randomUUID(), path: draftPath, kind: 'write', state: 'pending', createdAt: new Date().toISOString(), before: 'disk draft text\n', after: 'overwritten\n' }, hash('a stale document text')),
        { code: 'file_conflict' }
      );
      assert.equal(draft.getText(), userDraft, 'the refused editor write changed nothing');

      // --- the REAL publication guard: a CLEAN open editor on a target -------
      // add.cjs is a clean, touched (private-edited) publication target with no
      // unsaved content. Because the production inventory has no isDirty filter,
      // merely HAVING it open must refuse the publication with a structured
      // per-path conflict and no workspace effect.
      const addPath = path.join(realRoot, 'add.cjs');
      const addUri = vscode.Uri.file(addPath);
      // Open the target through the WORKBENCH (a real editor tab), so the
      // document the production inventory enumerates is owned by that editor and
      // closing the tab really releases it again.
      await vscode.commands.executeCommand('vscode.open', addUri);
      const tabFor = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === addUri.toString());
      await until(() => tabFor().length >= 1, 20_000, 'the real editor tab for the publication target');
      const addDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === addUri.toString());
      assert.ok(addDocument, 'the opened publication target is a real text document');
      assert.equal(addDocument.isDirty, false, 'the opened publication target is a CLEAN document');
      await until(() => options.publicationDocuments().some(entry => entry.path === addUri.fsPath), 20_000,
        'the clean target to enter the real publication inventory');

      const blocked = await call('subagent_integration', {
        action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: accepted.revision, requestId: 'host-apply-blocked'
      });
      assert.equal(blocked.apply.state, 'conflict', JSON.stringify(blocked.apply));
      assert.deepEqual(blocked.apply.applied, [], 'a refused publication applies no path');
      assert.equal(blocked.status, 'accepted', 'the attempt stays accepted; the refusal is not accepted work');
      assert.equal(blocked.canPublish, true, 'the editor conflict is retryable');
      const editorConflict = blocked.apply.conflicts.find(entry => /open editor/i.test(entry.reason) && entry.reason.includes('add.cjs'));
      assert.ok(editorConflict, `a structured per-path editor conflict is required: ${JSON.stringify(blocked.apply.conflicts)}`);
      // No false success: every target is still exactly the pre-apply disk state.
      assert.equal(await fs.readFile(addPath, 'utf8'), ADD_BASE, 'the clean-but-open target is untouched');
      assert.equal(await fs.readFile(path.join(realRoot, 'multiply.cjs'), 'utf8'), MULTIPLY_BASE, 'nothing else was written either');
      assert.equal(await fs.readFile(path.join(realRoot, 'notes.txt'), 'utf8'), NOTES_USER, 'the user edit is preserved');
      assert.equal(await fs.readFile(draftPath, 'utf8'), 'disk draft text\n', 'the dirty draft on disk is untouched');
      assert.equal(draft.getText(), userDraft);

      // Close exactly that fixture editor and wait for the real inventory to drop
      // it, so the retry can complete.
      const targetTabs = tabFor();
      assert.equal(targetTabs.length >= 1, true, 'the fixture editor has a real tab');
      const closed = await vscode.window.tabGroups.close(targetTabs, true);
      const listed = () => options.publicationDocuments().filter(entry => entry.path === addUri.fsPath);
      await until(() => listed().length === 0, 20_000,
        `the closed editor to leave the real publication inventory (close resolved ${String(closed)} for ${targetTabs.length} tab(s); still listed ${JSON.stringify(listed())}; documents ${JSON.stringify(vscode.workspace.textDocuments.map(document => document.uri.fsPath).slice(0, 12))})`);

      // A NEW publication decision now completes. A fresh requestId is required:
      // an exact replay would return the recorded conflict instead of publishing.
      const applied = await call('subagent_integration', {
        action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: blocked.revision, requestId: 'host-apply'
      });
      assert.equal(applied.status, 'applied', JSON.stringify(applied.apply));
      assert.equal(applied.apply.state, 'applied');
      assert.deepEqual([...applied.apply.applied].sort(), ['add.cjs', 'multiply.cjs', 'release.cjs']);
      assert.deepEqual(applied.apply.conflicts, []);
      assert.equal(applied.apply.applied.includes('host-draft.txt'), false, 'a touched unsaved capture override is never published');
      assert.equal(await fs.readFile(path.join(realRoot, 'add.cjs'), 'utf8'), ADD_CHANGED);
      assert.equal(await fs.readFile(path.join(realRoot, 'multiply.cjs'), 'utf8'), MULTIPLY_CHANGED);
      assert.equal(await fs.readFile(path.join(realRoot, 'release.cjs'), 'utf8'), RELEASE);
      assert.equal(await fs.readFile(path.join(realRoot, 'verify.cjs'), 'utf8'), VERIFY, 'the agreed oracle is never rewritten');
      assert.equal(await fs.readFile(path.join(realRoot, 'notes.txt'), 'utf8'), NOTES_USER, 'the intervening user edit survives publication');
      assert.equal(await fs.readFile(draftPath, 'utf8'), 'disk draft text\n', 'the dirty draft on disk is untouched');
      assert.equal(draft.getText(), userDraft, 'and the real editor buffer still holds the user text');
      assert.equal(draft.isDirty, true);
      // A later user edit of a published path, then the exact replay of the
      // SUCCESSFUL request: it repeats no effect and never rewrites the path.
      await fs.writeFile(addPath, `${ADD_CHANGED}// user follow-up\n`);
      const replay = await call('subagent_integration', {
        action: 'apply', ownerId, teamId: team.id, attemptId: publishing.attemptId,
        expectedRevision: blocked.revision, requestId: 'host-apply'
      });
      assert.equal(replay.replayed, true);
      assert.equal(await fs.readFile(addPath, 'utf8'), `${ADD_CHANGED}// user follow-up\n`, 'an applied path is never rewritten');
      assert.equal(await fs.readFile(path.join(realRoot, 'notes.txt'), 'utf8'), NOTES_USER, 'an exact apply replay repeats no effect');

      // --- final audit: real commands only, real results only ----------------
      const results = await call('subagent_runner_status', { ownerId, teamId: team.id, kind: 'results' });
      const succeeded = results.items.filter(item => item.outcome === 'succeeded');
      assert.equal(succeeded.length >= 4, true, `four real succeeded commands: ${succeeded.length}`);
      assert.deepEqual(succeeded.filter(item => item.drained !== true || item.import !== 'unchanged'), [],
        'every composed/producer command drained and imported nothing');
      assert.deepEqual([...new Set(state.approvals.map(entry => entry.command))].sort(), [AGREED, CHECK_ADD, CHECK_MULTIPLY].sort());
      assert.equal(state.approvals.every(entry => entry.allowed), true);
      assert.equal((await call('subagent_task_get', { ownerId, id: taskB.id })).state, 'submitted', 'integration never rewrites the board');
      assert.equal((await call('subagent_task_get', { ownerId, id: taskA.id })).state, 'accepted');
      assert.equal((await call('subagent_task_get', { ownerId, id: taskP.id })).state, 'accepted');
      // Host-level diagnostics: the complete collected list must be empty. Nothing
      // is filtered and no broad exception is allowed, so a storage, accounting,
      // checkpoint, permission or model diagnostic fails this audit and is printed
      // in full instead of being discarded.
      assert.deepEqual(state.errors, [],
        `unexpected host diagnostics: ${JSON.stringify(state.errors)}`);
    } finally {
      for (const created of brokers.reverse()) {
        await created.close().catch(() => undefined);
      }
    }
  } finally {
    for (const [key, value] of restore.reverse()) {
      await settings.update(key, value === undefined ? false : value, vscode.ConfigurationTarget.Global).catch(() => undefined);
    }
    await draftEditorCleanup();
  }
};

/** Best-effort: leave no dirty buffer behind for later host assertions. */
async function draftEditorCleanup() {
  try {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  } catch {
    // A host without that command simply keeps the buffer; nothing is asserted.
  }
}
