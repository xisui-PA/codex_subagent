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
import { eligibleModels, parseModelSettings, poolAllows } from './model-settings';
import { ModelsTree } from './models-view';
import { prepareRuntime, register, repairRegistration } from './registration';
import { WorkerBroker, unpack } from './runtime';
import { Mutex } from './storage';
import { ChangeContent, failure, Message, Model, ModelPolicy, Session, SessionHeader, WorkerError } from './types';
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
  const models = new ModelsTree();
  // Re-read the User-level pool, drive the welcome context key, and refresh.
  const syncModels = (): void => {
    models.refresh();
    void vscode.commands.executeCommand('setContext', 'codexSubagent.modelsEmpty', models.pool.empty);
  };
  syncModels();
  context.subscriptions.push(log, tree, models, status,
    vscode.window.registerTreeDataProvider('codexSubagent.workers', tree),
    vscode.window.registerTreeDataProvider('codexSubagent.models', models));
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
  // Only user-level (global) settings are honored for pool routing/permissions.
  const modelPool = (): Record<string, ModelPolicy> => parseModelSettings(vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue);
  const configuredPool = (): Record<string, ModelPolicy> => {
    try {
      return modelPool();
    } catch {
      return {};
    }
  };
  const configuredPoolAllows = (field: 'allowWrite' | 'allowShell'): boolean => poolAllows(configuredPool(), field);
  const refresh = async (): Promise<void> => {
    if (!broker || refreshing || !alive) {
      return;
    }
    refreshing = true;
    try {
      const sessions = await broker.list();
      tree.refresh(sessions);
      // Strict settings read once per refresh: a malformed pool must surface as
      // guidance in every panel instead of stale or invalid model choices.
      let pool: Record<string, ModelPolicy> | undefined;
      let poolError = '';
      try {
        pool = modelPool();
      } catch (error) {
        poolError = failure(error).message;
      }
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
          // Filter in this window: the webview dropdown must mirror the exact
          // pool/permission policy currently saved, not a stale list.
          let choices: ReturnType<typeof eligibleModels> = { models: [] };
          if (poolError) {
            choices = { models: [], guidance: poolError };
          } else if (!message) {
            choices = eligibleModels({ permission: s.permission, available: models, pool, previous: s.model.id });
          }
          entry.panel.update(s, choices.models, choices.guidance);
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
      const next = new WorkerBroker({
        storage: context.globalStorageUri.fsPath, registry, roots: realRoots, identity, provider,
        settings: () => ({
          ...defaults,
          models: parseModelSettings(vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue)
        }),
        files: {
          // No global write/shell switches remain. FileTools receives tools when
          // at least one configured model policy allows them; engine wrappers and
          // per-session live checks make the exact model policy authoritative.
          canWrite: () => configuredPoolAllows('allowWrite'),
          allowShell: () => configuredPoolAllows('allowShell'),
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
    await provider.enable(); broker?.settingsChanged(); await refresh();
  });
  command('disableModel', async () => {
    // provider.enabled() returns every configured models-setting key, even IDs
    // currently unavailable in VS Code, so disabling removes just that entry.
    const id = await vscode.window.showQuickPick(provider.enabled(), { title: 'Disable a worker model (removes it from codexSubagent.models)' }); if (id) {
      await provider.disable(id);
      broker?.settingsChanged();
      await refresh();
    }
  });
  command('openModelSettings', async () => {
    // Only the User-level pool is honored, so open User settings explicitly.
    // In a remote window this extension runs remotely (extensionKind
    // workspace), so the relevant user settings are the remote ones:
    // openRemoteSettings targets the remote user profile, openGlobalSettings
    // the local one; both parse query options (unlike openSettings, which
    // ignores a target option).
    const action = vscode.env.remoteName ? 'workbench.action.openRemoteSettings' : 'workbench.action.openGlobalSettings';
    await vscode.commands.executeCommand(action, { query: '@id:codexSubagent.models' });
  });
  command('configureModel', async (...args: unknown[]) => {
    const [arg] = args;
    // Offer only configured model IDs (provider.enabled()), including IDs
    // currently unavailable in VS Code; an unconfigured model has no options
    // entry and enabling it is a separate command.
    const ids = provider.enabled();
    if (!ids.length) {
      void vscode.window.showInformationMessage('No worker model is configured. Run Codex Subagent: Enable Model first; model options live at codexSubagent.models.<model-id>.modelOptions.');
      return;
    }
    // A context menu passes the tree's model node, a tree click passes its ID;
    // otherwise offer a quick pick. A cancelled pick returns quietly.
    const preselected = typeof arg === 'string' ? arg : arg && typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string' ? (arg as { id: string }).id : undefined;
    let id: string | undefined = preselected && ids.includes(preselected) ? preselected : undefined;
    if (!id) {
      id = await vscode.window.showQuickPick(ids, { title: 'Choose a configured model to edit its provider options' });
      if (!id) {
        return;
      }
    }
    const value = await vscode.window.showInputBox({ title: `Model options for ${id}`, value: JSON.stringify(provider.options(id)), prompt: 'JSON object of provider-specific options passed to sendRequest; do not include credentials.', validateInput: text => {
      try {
        const parsed: unknown = JSON.parse(text); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'Enter a JSON object.';
      } catch {
        return 'Enter valid JSON.';
      }
    } });
    if (value !== undefined) {
      // setModelOptions re-reads the latest user pool, so settings changed
      // while the dialog awaited are preserved and a model disabled meanwhile
      // is not resurrected.
      try {
        await provider.setModelOptions(id, JSON.parse(value) as Record<string, unknown>);
        broker?.settingsChanged();
        await refresh();
      } catch (error) {
        report(error);
      }
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
    // Parse the strict models setting exactly once: a malformed pool must not
    // break Diagnostics; it is reported in the JSON instead.
    let pool: Record<string, ModelPolicy> | undefined;
    let poolError: string | undefined;
    try {
      pool = modelPool();
    } catch (error) {
      poolError = failure(error).message;
    }
    const enabled = Object.keys(pool || {});
    let models: unknown = [];
    try {
      models = (await vscode.lm.selectChatModels()).map(m => ({ id: m.id, name: m.name, vendor: m.vendor, enabled: enabled.includes(m.id), access: context.languageModelAccessInformation.canSendRequest(m) ?? 'unknown' }));
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
    const content = JSON.stringify({ startupError: startupError || null, workspaceRoots: roots(), storage: context.globalStorageUri.fsPath, codexConfig: configPath(), relay, poolError, enabledModels: enabled, pool: pool ?? null, models, health, instructions: mcpInstructions }, null, 2);
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
    const pickedPermission = await vscode.window.showQuickPick(['read-only', 'workspace-write'], { title: 'Worker permissions' }); if (!pickedPermission) {
      return;
    }
    const permission: Session['permission'] = pickedPermission === 'workspace-write' ? 'workspace-write' : 'read-only';
    const models = unpack<{ models: Model[] }>(await current.invoke(root, 'subagent_models', {})).models;
    const pool = modelPool();
    const eligible = eligibleModels({ permission, available: models, pool });
    if (!eligible.models.length) {
      void vscode.window.showWarningMessage(eligible.guidance || 'No eligible worker model is available.');
      return;
    }
    const byId = new Map(models.map(m => [m.id, m]));
    const choices: { label: string; detail: string; model?: Model }[] = [{ label: 'Automatic', detail: 'first eligible configured model with a free session (pool order is priority)' }];
    for (const entry of eligible.models) {
      choices.push({ label: entry.name, detail: entry.id + (entry.policy ? ' · ' + String(entry.policy.numSessions ?? 1) + ' active session(s)' : ''), model: byId.get(entry.id)! });
    }
    const choice = await vscode.window.showQuickPick(choices, { title: 'Worker model' }); if (!choice) {
      return;
    }
    const worker = unpack<{ id: string }>(await current.invoke(root, 'subagent_spawn', { requestId: randomUUID(), ownerId: 'manual', ownerLabel: 'Manual tasks', task, permission, ...(choice.model ? { model: choice.model.id } : {}) }));
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
        if (latest.state === 'completed' && !message.model) {
          // A completed worker must never be resumed with its old, possibly
          // removed, model id: require the explicit eligible choice.
          throw new WorkerError('not_resumable', 'Choose an eligible model to continue a completed worker. Leave the message empty to switch the model only.');
        }
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
    // Completed workers may switch model (and optionally continue with one
    // follow-up turn). They always require an explicit, currently eligible model.
    const completed = s.state === 'completed';
    if (!completed && !['failed', 'cancelled', 'interrupted'].includes(s.state)) {
      throw new WorkerError('not_resumable', 'This worker is busy. Cancel it before resuming.');
    }
    if (completed && !s.turns.length) {
      throw new WorkerError('not_resumable', 'This worker has no conversation to continue. Start a new worker instead.');
    }
    const models = unpack<{ models: Model[] }>(await requireBroker().invoke(s.workspaceRoot || roots()[0], 'subagent_models', {})).models;
    const eligible = eligibleModels({ permission: s.permission, available: models, pool: modelPool(), previous: s.model.id });
    if (!eligible.models.length) {
      void vscode.window.showWarningMessage(eligible.guidance || 'No eligible worker model is available.');
      return;
    }
    const choice = await vscode.window.showQuickPick(eligible.models.map(model => ({
      label: model.name,
      description: model.id === s.model.id ? 'current' : undefined,
      detail: model.id + (model.policy ? ' · ' + String(model.policy.numSessions ?? 1) + ' active session(s)' : ''),
      model
    })), { title: completed ? 'Model for this completed worker' : 'Resume using model', placeHolder: completed ? 'The worker keeps its history; no inference runs unless you add a message.' : undefined });
    if (!choice) {
      return;
    }
    const message = await vscode.window.showInputBox({
      title: completed ? 'Optional follow-up' : 'Recovery instructions',
      prompt: completed ? 'Leave empty to switch the model only. Any text becomes one new follow-up turn; earlier turns are preserved.' : 'Optional steering message; leave empty to continue.',
      value: ''
    }); if (message === undefined) {
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
  context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => {
    // The Models view labels its roots with VS Code model names, so a catalog
    // change must re-read them (refresh keeps the strict global-only pool).
    syncModels();
  }), vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void configure().catch(report);
  }), vscode.workspace.onDidGrantWorkspaceTrust(() => {
    void configure().catch(report);
  }), vscode.workspace.onDidChangeConfiguration(event => {
    // Every window receives user-level configuration changes. Only the owning
    // window has local runtimes; the others have nothing to reschedule.
    if (!event.affectsConfiguration('codexSubagent')) {
      return;
    }
    // The Models view depends only on the User-level pool, so it refreshes in
    // every window, broker or workspace availability or not.
    syncModels();
    try {
      broker?.settingsChanged();
    } catch (error) {
      report(error);
    }
    void refresh();
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
