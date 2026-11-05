const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const vscode = require('vscode');

exports.run = async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(process.env.CODEX_TEST_REPOSITORY, 'package.json'), 'utf8'));
  const extensionId = (manifest.publisher + '.' + manifest.name).toLowerCase();
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, 'Development extension must be loaded');
  const api = await extension.activate();
  await vscode.commands.executeCommand('codexSubagent.diagnostics');
  const diagnostic = JSON.parse(vscode.window.activeTextEditor.document.getText());
  assert.ok(diagnostic.codexConfig.startsWith(process.env.CODEX_HOME), 'Must use the isolated test config');
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['setup', 'checkConnection', 'diagnostics', 'retryHost', 'sendMessage', 'resumeWorker', 'cleanupWorkers', 'revokeShellApproval']) { assert.ok(commands.includes('codexSubagent.' + name), name); }
  if (process.env.CODEX_TEST_SCENARIO !== 'workspace') {
    assert.ok(diagnostic.startupError, 'Empty-window diagnostics must remain available');
    await assert.rejects(api.invoke('subagent_health', {}), /trusted|workspace|host/i);
  } else {
    assert.equal(diagnostic.startupError, null);
    const health = JSON.parse((await api.invoke('subagent_health', {})).content[0].text);
    assert.equal(health.ready, true); assert.ok(health.capabilities.includes('read_file'));
    assert.ok(!health.capabilities.includes('write_file'));
    await vscode.workspace.getConfiguration('codexSubagent').update('allowWrites', true, vscode.ConfigurationTarget.Global);
    assert.ok(JSON.parse((await api.invoke('subagent_health', {})).content[0].text).capabilities.includes('write_file'));
    await vscode.commands.executeCommand('codexSubagent.register');
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(config.includes('mcp_servers.codex_subagent'));
    await vscode.commands.executeCommand('codexSubagent.checkConnection');
    const connection = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.equal(connection.handshake, 'passed'); assert.equal(connection.host.ready, true);
    const { WorkerPanel } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'panel.js'));
    const panel = new WorkerPanel('Render test', async () => {}, () => {});
    const rendered = new Promise(resolve => {
      const disposable = panel.panel.webview.onDidReceiveMessage(message => { if (message.action === 'rendered') { disposable.dispose(); resolve(message); } });
    });
    const now = new Date().toISOString();
    panel.update({ id: 'example', title: '<script>literal title</script>', model: { id: 'fake', name: 'Fake' }, state: 'completed', permission: 'read-only', revision: 1, createdAt: now, updatedAt: now, turns: [{ id: 'turn', input: 'Task', output: 'Result', state: 'completed', tools: [] }], messages: [] }, []);
    let timeout;
    try {
      const renderedState = await Promise.race([rendered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Worker webview did not render')), 20_000); })]);
      assert.equal(renderedState.title, '<script>literal title</script>');
      assert.equal(renderedState.resumeEnabled, false, 'Completed workers must not offer Resume');
    } finally { clearTimeout(timeout); panel.dispose(); }
    {
      // Command approval layout inspection in a real webview. The command is
      // never executed; the request is always aborted and the service disposed.
      const { CommandApprovals } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'command-approval.js'));
      const approvals = new CommandApprovals();
      const controller = new AbortController();
      const hostile = '<script>window.__pwned=true</script><img src=x onerror=window.__pwned=true>&amp;';
      const command = '\n' + '$ ls -la\n' + [hostile, 'echo hostile', 'printf "a" && printf "b" || true; sleep 0\n'].concat(Array.from({ length: 200 }, (_, i) => `echo line-${i}`)).join('\n');
      const cwd = '/tmp/' + 'approval-depth/'.repeat(200) + 'nested/very/long/working/directory/with/a/rather/long/terminal/segment';
      const promise = approvals.request(command, cwd, controller.signal);
      try {
        const entry = approvals['pending'].values().next().value;
        const webviewPanel = entry.panel;
        const inspected = new Promise((resolve, reject) => {
          const disposable = webviewPanel.webview.onDidReceiveMessage(message => { if (message.action === 'approval-layout-test') { disposable.dispose(); resolve(message); } else if (message.action === 'run' || message.action === 'cancel') { reject(new Error('Unexpected approval decision message: ' + message.action)); } });
        });
        const injection = `\nconst s=document.createElement('div');s.id='__approvalLayoutSentinel';document.body.appendChild(s);\nrequestAnimationFrame(()=>{requestAnimationFrame(()=>{\nconst body=document.body;\nbody.style.height='220px';body.style.width='280px';\nconst rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};\nconst main=document.querySelector('main');\nvscode.postMessage({action:'approval-layout-test',command:document.getElementById('command').textContent,cwd:document.getElementById('cwd').textContent,sentinel:!!document.getElementById('__approvalLayoutSentinel'),body:rect(body),header:rect(document.querySelector('header')),main:rect(main),mainClientHeight:main.clientHeight,mainScrollHeight:main.scrollHeight,runBtn:rect(document.getElementById('runBtn')),cancelBtn:rect(document.getElementById('cancelBtn')),sessionBtn:rect(document.getElementById('sessionBtn'))});\n});});\n`;
        const baseHtml = webviewPanel.webview.html;
        const lastScriptClose = baseHtml.lastIndexOf('</script>');
        assert.ok(lastScriptClose > 0, 'Approval html must contain its same-nonce script');
        webviewPanel.webview.html = baseHtml.slice(0, lastScriptClose) + injection + baseHtml.slice(lastScriptClose);
        let layout; let layoutTimeout;
        try {
          layout = await Promise.race([inspected, new Promise((_, reject) => { layoutTimeout = setTimeout(() => reject(new Error('Approval webview did not report its layout')), 20_000); })]);
        } finally { clearTimeout(layoutTimeout); controller.abort(); }
        assert.equal(layout.command, command, 'The exact command, including its leading newline, must render literally');
        assert.equal(layout.cwd, cwd, 'The full working directory must render literally');
        assert.equal(layout.sentinel, true, 'Test injection must have run in the page');
        assert.ok(!baseHtml.includes('__approvalLayoutSentinel'));
        const body = layout.body;
        assert.ok(body.width === 280 && body.height === 220, 'Bounded body size');
        assert.ok(layout.header.height <= body.height * 0.4 + 1, 'Header must stay within its 40% bound');
        assert.ok(layout.mainClientHeight > 0, 'Command area must have positive height');
        assert.ok(layout.mainScrollHeight > layout.mainClientHeight, 'Command area must scroll for long commands');
        for (const label of ['runBtn', 'cancelBtn', 'sessionBtn']) {
          const btn = layout[label];
          assert.ok(btn.width > 0 && btn.height > 0, label + ' must be visible');
          assert.ok(btn.x >= body.x - 1 && btn.y >= body.y - 1 && btn.x + btn.width <= body.x + body.width + 1 && btn.y + btn.height <= body.y + body.height + 1, label + ' must sit fully inside the bounded body');
        }
        assert.equal(await promise, false, 'Aborted approval must resolve denied');
        assert.equal(approvals['pending'].size, 0);
      } finally { controller.abort(); approvals.dispose(); }
    }
    const { applyEditorChange } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'editor.js'));
    const file = path.join(process.env.CODEX_TEST_WORKSPACE, 'editor.txt');
    await fs.writeFile(file, 'initial');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document);
    const hash = text => createHash('sha256').update(text).digest('hex');
    const change = (before, after) => ({ id: randomUUID(), path: file, kind: 'write', state: 'pending', createdAt: new Date().toISOString(), before, after });
    await applyEditorChange(change('initial', 'worker change'), hash('initial'));
    assert.equal(await fs.readFile(file, 'utf8'), 'worker change');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), 'initial', 'Worker edits must enter native undo history');
    await document.save();
    await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'user unsaved\n'));
    const before = document.getText();
    await applyEditorChange(change(before, before + '\nworker addition'), hash(before));
    assert.equal(document.isDirty, true, 'Pre-existing dirty buffers stay unsaved');
    assert.equal(await fs.readFile(file, 'utf8'), 'initial');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), before);
    await assert.rejects(applyEditorChange(change(before, 'stale'), hash('old data')), { code: 'file_conflict' });

    // Exercise the complete tool -> editor save -> durable snapshot -> revert
    // path with a real save participant, not just an editor adapter mock.
    const { WorkerBroker, unpack } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'runtime.js'));
    const { defaults } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'engine.js'));
    const { openText } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'editor.js'));
    const root = await fs.realpath(process.env.CODEX_TEST_WORKSPACE);
    const formatted = path.join(root, 'saved.txt'); await fs.writeFile(formatted, 'initial');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(formatted)));
    const participant = vscode.workspace.onWillSaveTextDocument(event => {
      if (event.document.uri.fsPath === formatted && !event.document.getText().endsWith('\nsave participant')) {
        event.waitUntil(Promise.resolve([vscode.TextEdit.insert(event.document.positionAt(event.document.getText().length), '\nsave participant')]));
      }
    });
    const fake = { id: 'fake', name: 'Fake', vendor: 'test', family: 'test', version: '1', maxInputTokens: 100000 };
    // Use real VS Code response classes with a fake transport. Modern built-in
    // BYOK providers emit these usage footers even on successful tool rounds.
    const { VscodeProvider } = require(path.join(process.env.CODEX_TEST_REPOSITORY, '.test-build', 'vscode-provider.js'));
    const adapter = new VscodeProvider({});
    adapter.resolve = async () => ({ sendRequest: async () => ({ stream: (async function* () {
      if (typeof vscode.LanguageModelThinkingPart === 'function') { yield new vscode.LanguageModelThinkingPart('internal reasoning'); }
      yield new vscode.LanguageModelToolCallPart('read', 'read_file', { path: 'AGENTS.md' });
      yield new vscode.LanguageModelDataPart(Buffer.from('private continuation'), 'stateful_marker');
      yield new vscode.LanguageModelDataPart(Buffer.from('{"completion_tokens":42}'), 'usage');
    })() }) });
    const responseParts = [];
    for await (const part of adapter.stream(fake, [], [], new AbortController().signal)) { responseParts.push(part); }
    assert.deepEqual(responseParts, [{ type: 'call', id: 'read', name: 'read_file', input: { path: 'AGENTS.md' } }]);
    const storage = path.join(process.env.CODEX_HOME, 'save-test');
    const broker = new WorkerBroker({ storage, registry: path.join(storage, 'bridges'), roots: [root], identity: 'save-test',
      provider: { models: async () => [fake], countTokens: async () => 10, async *stream(_model, messages) {
        if (messages.at(-1).parts[0].type === 'result') { yield { type: 'text', text: 'done' }; }
        else { yield { type: 'call', id: 'write', name: 'write_file', input: { path: 'saved.txt', content: 'worker text', expectedHash: hash('initial') } }; }
      } }, settings: () => defaults, defaultModel: () => fake.id,
      files: { canWrite: () => true, allowShell: () => false, readOpenText: file => openText(file)?.getText(), applyChange: applyEditorChange }, onChange() {}, onError() {} });
    try {
      await broker.start();
      const spawned = unpack(await broker.invoke(root, 'subagent_spawn', { requestId: 'saved', task: 'Write', permission: 'workspace-write' }));
      const waited = unpack(await broker.invoke(root, 'subagent_wait', { ids: [spawned.id], timeoutMs: 5000 }));
      assert.equal(waited.workers[0].state, 'completed');
      const session = await broker.session(root, spawned.id);
      const expected = 'worker text\nsave participant';
      assert.equal(await fs.readFile(formatted, 'utf8'), expected);
      assert.equal(JSON.parse(session.messages.find(m => m.parts[0].type === 'result').parts[0].text).hash, hash(expected));
      const snapshot = unpack(await broker.invoke(root, 'ui_change', { id: spawned.id, changeId: session.changes[0].id }));
      assert.equal(snapshot.after, expected); assert.equal(snapshot.state, 'applied');
      participant.dispose();
      unpack(await broker.invoke(root, 'ui_revert', { id: spawned.id, changeId: session.changes[0].id }));
      assert.equal(await fs.readFile(formatted, 'utf8'), 'initial');
    } finally { participant.dispose(); await broker.close(); }
  }
  console.log(`HOST_TEST_PASS:${process.env.CODEX_TEST_SCENARIO}`);
};
