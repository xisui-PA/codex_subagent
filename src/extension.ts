import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CommandApprovals } from './command-approval';
import { WorkerComposer } from './composer';
import { promises as fs } from 'node:fs';
import { mcpInstructions } from './api';
import { checkConnection } from './connection';
import { defaults } from './engine';
import { exportTranscript } from './exporter';
import { applyEditorChange, openText } from './editor';
import { WorkerPanel, PanelMessage } from './panel';
import { prepareRuntime, register, repairRegistration } from './registration';
import { WorkerBroker, unpack } from './runtime';
import { Mutex } from './storage';
import { ChangeContent, failure, Message, Model, Session, SessionHeader, WorkerError } from './types';
import { VscodeProvider } from './vscode-provider';

let cleanup: (() => Promise<void>) | undefined;
interface WorkerNode { kind: 'worker'; session: SessionHeader }
interface GroupNode { kind: 'group'; id: string; label: string; workers: WorkerNode[] }
type TreeNode = WorkerNode | GroupNode;
class WorkerTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  sessions: SessionHeader[] = [];
  refresh(sessions = this.sessions): void {
    this.sessions = sessions; this.change.fire();
  }
  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded); item.id = node.id; item.iconPath = new vscode.ThemeIcon('comment-discussion'); return item;
    }
    const s = node.session;
    const item = new vscode.TreeItem(s.title);
    item.id = `${s.workspaceRoot}:${s.id}`;
    item.description = `${s.state} · ${s.model.name}`;
    item.tooltip = `${s.activity || s.state}\n${s.workspaceRoot || ''}\n${s.permission}`;
    item.contextValue = ['queued', 'running'].includes(s.state) ? 'workerRunning' : s.state === 'completed' ? 'workerCompleted' : 'workerResumable';
    item.iconPath = new vscode.ThemeIcon(s.state === 'running' ? 'sync~spin' : s.state === 'completed' ? 'pass' : s.state === 'queued' ? 'clock' : 'warning');
    item.command = { command: 'codexSubagent.openWorker', title: 'Open Worker', arguments: [node] };
    return item;
  }
  getChildren(node?: TreeNode): TreeNode[] {
    if (node) {
      return node.kind === 'group' ? node.workers : [];
    }
    const groups = new Map<string, GroupNode>();
    for (const s of this.sessions) {
      const id = `${s.workspaceRoot}:${s.ownerId || 'ungrouped'}`;
      if (!groups.has(id)) {
        groups.set(id, { kind: 'group', id, label: `${s.ownerLabel || s.ownerId || 'Ungrouped'} · ${path.basename(s.workspaceRoot || 'workspace')}`, workers: [] });
      }
      groups.get(id)!.workers.push({ kind: 'worker', session: s });
    }
    return [...groups.values()];
  }
  dispose(): void {
    this.change.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<{ invoke: (name: string, args: unknown) => Promise<unknown> }> {
  const log = vscode.window.createOutputChannel('Codex Subagent');
  const tree = new WorkerTree();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'codexSubagent.workers.focus'; status.text = '$(hubot) Workers'; status.show();
  context.subscriptions.push(log, tree, status, vscode.window.registerTreeDataProvider('codexSubagent.workers', tree));
  const provider = new VscodeProvider(context);
  const approvals = new CommandApprovals();
  context.subscriptions.push(approvals);
  const registry = path.join(context.globalStorageUri.fsPath, 'bridges');
  const configPath = (): string => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let relay = context.asAbsolutePath('dist/relay.js');
  let broker: WorkerBroker | undefined;
  let startupError = '';
  let refreshing = false;
  let alive = true;
  const activatedAt = Date.now();
  const lifecycle = new Mutex();
  const panels = new Map<string, { panel: WorkerPanel; root: string; id: string }>();
  const composers = new Map<string, WorkerComposer>();
  const previous = new Map<string, string>();
  const snapshots = new Map<string, string>();
  const report = (error: unknown): void => {
    const problem = failure(error); log.appendLine(`${new Date().toISOString()} ${problem.code}: ${problem.message}`);
    void vscode.window.showErrorMessage(`Codex Subagent: ${problem.message}`);
  };
  const command = (name: string, action: (...args: unknown[]) => Promise<unknown>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`codexSubagent.${name}`, async (...args: unknown[]) => {
      try {
        return await action(...args);
      } catch (error) {
        report(error); return undefined;
      }
    }));
  };
  const roots = (): string[] => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  const requireBroker = (): WorkerBroker => {
    if (!broker || startupError) {
      throw new WorkerError('workspace_unavailable', startupError || 'Open a trusted filesystem workspace, then run Retry Worker Host.');
    }
    return broker;
  };
  const refresh = async (): Promise<void> => {
    if (!broker || refreshing || !alive) {
      return;
    }
    refreshing = true;
    try {
      const sessions = await broker.list();
      tree.refresh(sessions);
      const active = sessions.filter(s => ['running', 'queued'].includes(s.state)).length;
      status.text = `$(hubot) Workers${active ? `: ${active}` : ''}`;
      status.tooltip = `${sessions.length} saved workers · ${active} active`;
      for (const s of sessions) {
        const key = `${s.workspaceRoot}:${s.id}`;
        const old = previous.get(key);
        const signature = `${s.state}:${s.lastTurnId}:${s.lastAttempt}`;
        previous.set(key, signature);
        if (((old && old !== signature) || (!old && Date.parse(s.createdAt) >= activatedAt)) && ['completed', 'failed'].includes(s.state) && vscode.workspace.getConfiguration('codexSubagent').get('notifyOnCompletion', true)) {
          const notify = s.state === 'failed' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
          void notify(`Worker “${s.title}” ${s.state}.`, 'Open Worker').then(choice => {
            if (choice) {
              void vscode.commands.executeCommand('codexSubagent.openWorker', { kind: 'worker', session: s });
            }
          });
        }
      }
      for (const entry of panels.values()) {
        try {
          const s = await broker.session(entry.root, entry.id);
          let models: Model[] = [];
          let message = '';
          try {
            models = unpack<{ models: Model[] }>(await broker.invoke(entry.root, 'subagent_health', {})).models;
          } catch (error) {
            message = failure(error).code === 'outside_workspace' || (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'This folder is not open. Restore it to continue work; saved history remains available.' : failure(error).message;
          }
          entry.panel.update(s, models);
          if (message) {
            entry.panel.error(message);
          }
        } catch (error) {
          entry.panel.error(failure(error).message);
        }
      }
    } catch (error) {
      status.text = '$(warning) Workers'; status.tooltip = failure(error).message; log.appendLine(`Host refresh: ${failure(error).message}`);
    } finally {
      refreshing = false;
    }
  };
  const configure = async (): Promise<void> => lifecycle.run(async () => {
    const old = broker; broker = undefined; if (old) {
      await old.close();
    }
    startupError = '';
    if (!alive) {
      return;
    }
    if (!vscode.workspace.isTrusted || !roots().length || roots().length !== vscode.workspace.workspaceFolders?.length) {
      startupError = 'Open a trusted filesystem workspace to run workers. Setup, logs and diagnostics remain available.';
      status.tooltip = startupError; tree.refresh([]); return;
    }
    try {
      const realRoots = await Promise.all(roots().map(root => fs.realpath(root)));
      const identity = vscode.workspace.workspaceFile ? `workspace:${vscode.workspace.workspaceFile.toString()}` : `folder:${realRoots[0]}`;
      const userBoolean = (name: string): boolean => vscode.workspace.getConfiguration('codexSubagent').inspect<boolean>(name)?.globalValue === true;
      const next = new WorkerBroker({
        storage: context.globalStorageUri.fsPath, registry, roots: realRoots, identity, provider,
        settings: () => {
          const c = vscode.workspace.getConfiguration('codexSubagent');
          const integer = (name: string, fallback: number, min: number, max: number): number => {
            const value = c.get<unknown>(name, fallback); return typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
          };
          return { ...defaults, maxConcurrent: integer('maxConcurrentWorkers', 2, 1, 8), maxToolRounds: integer('maxToolRounds', 40, 1, 200), turnTimeoutMs: integer('turnTimeoutSeconds', 600, 10, 3600) * 1000, autoCompact: c.get('autoCompact', true) };
        }, defaultModel: () => provider.defaultModel(),
        files: {
          canWrite: () => userBoolean('allowWrites'), allowShell: () => userBoolean('allowShell'),
          readOpenText: file => openText(file)?.getText(), applyChange: applyEditorChange,
          approveCommand: async (text, cwd, signal, workspaceRoot) => approvals.request(text, cwd, signal, workspaceRoot)
        }, onChange: () => {
          void refresh();
        }, onError: message => report(new WorkerError('checkpoint_failed', message))
      });
      try {
        await next.start();
      } catch (error) {
        await next.close(); throw error;
      }
      broker = next;
      log.appendLine(`Host ready for ${realRoots.join(', ')}. Other windows share the existing owner; registered Git worktrees are isolated automatically.`);
      await refresh();
    } catch (error) {
      startupError = failure(error).message; status.text = '$(warning) Workers'; status.tooltip = startupError; log.appendLine(startupError);
    }
  });
  const selected = async (arg?: unknown): Promise<Session | undefined> => {
    const current = requireBroker();
    if (arg && typeof arg === 'object' && 'kind' in arg && arg.kind === 'worker') {
      const header = (arg as WorkerNode).session; return current.session(header.workspaceRoot || roots()[0], header.id);
    }
    const all = await current.list();
    const choice = await vscode.window.showQuickPick(all.map(s => ({ label: s.title, description: `${s.state} · ${s.ownerLabel || s.ownerId || 'Ungrouped'}`, detail: s.workspaceRoot, session: s })), { title: 'Choose a worker' });
    return choice ? current.session(choice.session.workspaceRoot || roots()[0], choice.session.id) : undefined;
  };
  const control = async (session: Session, name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = unpack(await requireBroker().invoke(session.workspaceRoot || roots()[0], name, { id: session.id, ownerId: session.ownerId, ...args }));
    await refresh(); return result;
  };
  const exportSession = async (s: Session): Promise<void> => {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(roots()[0], `${s.id}-transcript.json`)), filters: { JSON: ['json'] } });
    if (!target) {
      return;
    }
    if (target.scheme !== 'file') {
      throw new WorkerError('unsupported_location', 'Choose a filesystem location for the transcript export.');
    }
    if (!s.storeDirectory) {
      throw new WorkerError('export_unavailable', 'Reopen the worker before exporting its archives.');
    }
    await exportTranscript(s, s.storeDirectory, target.fsPath);
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('codex-worker-diff', { provideTextDocumentContent: uri => snapshots.get(uri.toString()) || '' }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.scheme === 'codex-worker-diff') {
      snapshots.delete(document.uri.toString());
    }
  }));
  const diff = async (s: Session, changeId: string): Promise<void> => {
    const c = unpack<ChangeContent>(await requireBroker().invoke(s.workspaceRoot || roots()[0], 'ui_change', { id: s.id, changeId }));
    const before = vscode.Uri.parse(`codex-worker-diff:/${randomUUID()}/${encodeURIComponent(path.basename(c.path))}?before`);
    const after = vscode.Uri.parse(`codex-worker-diff:/${randomUUID()}/${encodeURIComponent(path.basename(c.target || c.path))}?after`);
    snapshots.set(before.toString(), c.before || ''); snapshots.set(after.toString(), c.after || '');
    await vscode.commands.executeCommand('vscode.diff', before, after, `Worker change: ${path.basename(c.path)}`);
  };

  // Commands are registered before any host startup or model-provider access.
  command('showLog', async () => log.show());
  command('refresh', refresh);
  command('retryHost', configure);
  command('enableModel', async () => {
    await provider.enable(); await refresh();
  });
  command('setDefaultModel', async () => {
    const models = await provider.models();
    const picked = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, detail: model.id, model })), { title: 'Default worker model' });
    if (picked) {
      await provider.setDefault(picked.model.id); void vscode.window.showInformationMessage(`Default worker model: ${picked.model.name}`);
    }
  });
  command('disableModel', async () => {
    const id = await vscode.window.showQuickPick(provider.enabled(), { title: 'Disable a worker model' }); if (id) {
      const wasDefault = provider.defaultModel() === id;
      await provider.disable(id);
      if (wasDefault && (await provider.models()).length) {
        await vscode.commands.executeCommand('codexSubagent.setDefaultModel');
      }
      await refresh();
    }
  });
  command('configureModel', async () => {
    const models = await vscode.lm.selectChatModels();
    const choice = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, detail: model.id, model })), { title: 'Model options profile' });
    if (!choice) {
      return;
    }
    const c = vscode.workspace.getConfiguration('codexSubagent');
    const profiles = c.get<Record<string, Record<string, unknown>>>('modelProfiles', {});
    const value = await vscode.window.showInputBox({ title: `Options for ${choice.model.name}`, value: JSON.stringify(profiles[choice.model.id] || {}), prompt: 'JSON object of provider-specific options; do not include credentials.', validateInput: text => {
      try {
        const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? null : 'Enter a JSON object.';
      } catch {
        return 'Enter valid JSON.';
      }
    } });
    if (value !== undefined) {
      await c.update('modelProfiles', { ...profiles, [choice.model.id]: JSON.parse(value) as Record<string, unknown> }, vscode.ConfigurationTarget.Global);
    }
  });
  const registerMcp = async (): Promise<void> => {
    relay = await prepareRuntime(context.globalStorageUri.fsPath, context.asAbsolutePath('dist/relay.js'));
    await register(configPath(), process.execPath, relay, registry);
    const health = await checkConnection(process.execPath, relay, registry, roots()[0]);
    log.appendLine(`MCP connection check: ${JSON.stringify(health)}`);
    const connectionTest = 'List the available `codex_subagent` MCP tools, then call `subagent_health` through MCP. Do not substitute a shell command.';
    void vscode.window.showInformationMessage(
      'MCP handshake and worker host check passed. Confirm codex_subagent is enabled under Codex chat → gear → Codex Settings → MCP Servers (that page has no tool list), then run the connection test in Codex chat. If tools are unavailable or the call fails, run Developer: Reload Window and retry.',
      'Copy Connection Test'
    ).then(async choice => {
      if (choice !== 'Copy Connection Test') {
        return;
      }
      try {
        await vscode.env.clipboard.writeText(connectionTest);
        void vscode.window.showInformationMessage('Connection test copied. Paste it in Codex chat.');
      } catch (error) {
        report(error);
      }
    });
  };
  command('register', async () => {
    requireBroker(); await registerMcp();
  });
  command('setup', async () => {
    if (!broker) {
      await configure();
    } requireBroker(); if (!(await provider.models()).length) {
      await provider.enable();
    } if (!(await provider.models()).length) {
      return;
    } await registerMcp();
  });
  command('checkConnection', async () => {
    requireBroker(); const result = await checkConnection(process.execPath, relay, registry, roots()[0]);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: 'json' }));
  });
  command('unregister', async () => {
    await register(configPath(), process.execPath, relay, registry, true); void vscode.window.showInformationMessage('MCP unregistered. Run Developer: Reload Window to disconnect. Saved workers remain available.');
  });
  command('diagnostics', async () => {
    let models: unknown = [];
    try {
      models = (await vscode.lm.selectChatModels()).map(m => ({ id: m.id, name: m.name, vendor: m.vendor, enabled: provider.enabled().includes(m.id), access: context.languageModelAccessInformation.canSendRequest(m) ?? 'unknown' }));
    } catch (error) {
      models = { error: failure(error) };
    }
    let health: unknown;
    try {
      if (broker && roots()[0]) {
        health = unpack(await broker.invoke(roots()[0], 'subagent_health', {}));
      }
    } catch (error) {
      health = { error: failure(error) };
    }
    const content = JSON.stringify({ startupError: startupError || null, workspaceRoots: roots(), storage: context.globalStorageUri.fsPath, codexConfig: configPath(), relay, defaultModel: provider.defaultModel(), models, health, instructions: mcpInstructions }, null, 2);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'json' }));
  });
  command('newWorker', async () => {
    const current = requireBroker();
    let root = roots()[0];
    if (roots().length > 1) {
      const folder = await vscode.window.showQuickPick(roots().map(root => ({ label: path.basename(root), detail: root })), { title: 'Worker workspace folder' });
      if (!folder) {
        return;
      }
      root = folder.detail;
    }
    const task = await vscode.window.showInputBox({ title: 'New worker task', prompt: 'Describe the task and supply relevant paths/context.' }); if (!task?.trim()) {
      return;
    }
    const permission = await vscode.window.showQuickPick(['read-only', 'workspace-write'], { title: 'Worker permissions' }); if (!permission) {
      return;
    }
    const models = unpack<{ models: Model[] }>(await current.invoke(root, 'subagent_models', {})).models;
    const model = await vscode.window.showQuickPick(models.map(m => ({ label: m.name, detail: m.id, model: m })), { title: 'Worker model' }); if (!model) {
      return;
    }
    const worker = unpack<{ id: string }>(await current.invoke(root, 'subagent_spawn', { requestId: randomUUID(), ownerId: 'manual', ownerLabel: 'Manual tasks', task, permission, model: model.model.id }));
    const session = await current.session(root, worker.id); await vscode.commands.executeCommand('codexSubagent.openWorker', { kind: 'worker', session });
  });
  command('openWorker', async arg => {
    const s = await selected(arg); if (!s) {
      return;
    }
    const root = s.workspaceRoot || roots()[0]; const key = `${root}:${s.id}`;
    const existing = panels.get(key); if (existing) {
      existing.panel.reveal(); return;
    }
    let historyOffset = 0;
    const action = async (message: PanelMessage): Promise<void> => {
      if ((message.action === 'send' || message.action === 'resume') && !message.requestId) {
        throw new WorkerError('invalid_arguments', 'A persistent request key is required for panel messages.');
      }
      const latest = await requireBroker().session(root, s.id);
      if (message.action === 'send' && message.message) {
        await control(latest, 'subagent_send', { requestId: message.requestId, message: message.message });
      }
      if (message.action === 'cancel') {
        await control(latest, 'subagent_cancel');
      }
      if (message.action === 'resume') {
        await control(latest, 'subagent_resume', { requestId: message.requestId, model: message.model, message: message.message });
      }
      if (message.action === 'compact') {
        await vscode.commands.executeCommand('codexSubagent.compactWorker', { kind: 'worker', session: latest });
      }
      if (message.action === 'discard') {
        await control(latest, 'subagent_discard_queued');
      }
      if (message.action === 'diff' && message.changeId) {
        await diff(latest, message.changeId);
      }
      if (message.action === 'revert' && message.changeId) {
        unpack(await requireBroker().invoke(root, 'ui_revert', { id: latest.id, changeId: message.changeId })); await refresh();
      }
      if (message.action === 'export') {
        await exportSession(latest);
      }
      if (message.action === 'history') {
        const page = unpack<{ messages: Message[] }>(await requireBroker().invoke(root, 'subagent_status', { id: latest.id, afterMessage: historyOffset, messageLimit: 20 }));
        const messages = page.messages.slice(0, Math.max(0, (latest.messageBase || 0) - historyOffset));
        historyOffset += messages.length; panel.history(messages, historyOffset);
      }
    };
    let composer = composers.get(key);
    if (!composer) {
      const storageKey = `composer:${key}`;
      composer = new WorkerComposer({ load: () => context.globalState.get(storageKey), save: async value => {
        await context.globalState.update(storageKey, value);
      } });
      composers.set(key, composer);
    }
    const panel = new WorkerPanel(s.title, action, () => panels.delete(key), composer);
    panels.set(key, { panel, root, id: s.id }); await refresh();
  });
  command('sendMessage', async arg => {
    const s = await selected(arg); if (!s) {
      return;
    } const message = await vscode.window.showInputBox({ title: 'Worker follow-up' }); if (message) {
      await control(s, 'subagent_send', { requestId: randomUUID(), message });
    }
  });
  command('cancelWorker', async arg => {
    const s = await selected(arg); if (s) {
      await control(s, 'subagent_cancel');
    }
  });
  command('resumeWorker', async arg => {
    const s = await selected(arg); if (!s) {
      return;
    }
    if (!['failed', 'cancelled', 'interrupted'].includes(s.state)) {
      throw new WorkerError('not_resumable', 'This worker is complete. Send a follow-up instead.');
    }
    const models = unpack<{ models: Model[] }>(await requireBroker().invoke(s.workspaceRoot || roots()[0], 'subagent_models', {})).models;
    const choice = await vscode.window.showQuickPick(models.map(m => ({ label: m.name, detail: m.id, picked: m.id === s.model.id, model: m })), { title: 'Resume using model' }); if (!choice) {
      return;
    }
    const message = await vscode.window.showInputBox({ title: 'Recovery instructions', prompt: 'Optional steering message; leave empty to continue.', value: '' }); if (message === undefined) {
      return;
    }
    await control(s, 'subagent_resume', { requestId: randomUUID(), model: choice.model.id, message: message || undefined });
  });
  command('compactWorker', async arg => {
    const s = await selected(arg); if (!s) {
      return;
    }
    const choice = await vscode.window.showQuickPick(['Summarize automatically', 'Supply a manual summary'], { title: 'Compact worker history; full archives are retained' }); if (!choice) {
      return;
    }
    let summary: string | undefined;
    if (choice === 'Supply a manual summary') {
      summary = await vscode.window.showInputBox({ title: 'Continuation summary', prompt: 'Include remaining work, decisions, paths, completed/uncertain effects and validation.' }); if (!summary) {
        return;
      }
    }
    await control(s, 'subagent_compact', { revision: s.revision, summary });
  });
  command('discardQueued', async arg => {
    const s = await selected(arg); if (s) {
      await control(s, 'subagent_discard_queued');
    }
  });
  command('exportWorker', async arg => {
    const s = await selected(arg); if (s) {
      await exportSession(s);
    }
  });
  command('deleteWorker', async arg => {
    const s = await selected(arg); if (s && await vscode.window.showWarningMessage(`Delete “${s.title}” and its archived history?`, { modal: true }, 'Delete') === 'Delete') {
      await control(s, 'subagent_delete');
    }
  });
  command('cleanupWorkers', async () => {
    const all = (await requireBroker().list()).filter(s => !['running', 'queued'].includes(s.state));
    const picked = await vscode.window.showQuickPick(all.map(s => ({ label: s.title, description: `${s.state} · ${s.updatedAt.slice(0, 10)}`, session: s })), { title: 'Delete saved workers and archives', canPickMany: true });
    if (!picked?.length || await vscode.window.showWarningMessage(`Permanently delete ${picked.length} saved workers?`, { modal: true }, 'Delete') !== 'Delete') {
      return;
    }
    for (const choice of picked) {
      await control(await requireBroker().session(choice.session.workspaceRoot || roots()[0], choice.session.id), 'subagent_delete');
    }
  });
  command('revokeShellApproval', async () => {
    const granted = approvals.getGrantedRoots();
    if (!granted.length) {
      void vscode.window.showInformationMessage('No active workspace shell approvals.');
      return;
    }
    const choice = await vscode.window.showQuickPick([
      ...granted.map(root => ({ label: path.basename(root), description: root, root })),
      { label: 'All workspaces', description: 'Revoke every active session grant', root: undefined as string | undefined }
    ], { title: 'Revoke shell approval' });
    if (!choice) {
      return;
    }
    approvals.revoke(choice.root);
    void vscode.window.showInformationMessage('Shell approval revoked. Future commands will ask for approval.');
  });
  command('savedWorkspaces', async () => {
    const current = requireBroker();
    const entries = await current.catalog();
    const choice = await vscode.window.showQuickPick(entries.map(e => ({ label: e.roots.join(', '), description: e.identity, detail: e.directory, entry: e })), { title: 'Saved worker workspaces' });
    if (choice) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(choice.entry.directory));
    }
  });

  try {
    relay = await prepareRuntime(context.globalStorageUri.fsPath, context.asAbsolutePath('dist/relay.js'));
    await repairRegistration(configPath(), process.execPath, relay, registry);
  } catch (error) {
    log.appendLine(`Registration repair: ${failure(error).message}`);
  }
  await configure();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void configure().catch(report);
  }), vscode.workspace.onDidGrantWorkspaceTrust(() => {
    void configure().catch(report);
  }));
  const timer = setInterval(() => {
    void refresh();
  }, 1000);
  timer.unref();
  cleanup = async () => {
    alive = false; clearInterval(timer); await lifecycle.run(async () => {
      await broker?.close(); broker = undefined;
    }); for (const p of panels.values()) {
      p.panel.dispose();
    } cleanup = undefined;
  };
  return { invoke: async (name, args) => requireBroker().invoke(roots()[0], name, args) };
}
export async function deactivate(): Promise<void> {
  await cleanup?.();
}
