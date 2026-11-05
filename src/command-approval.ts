import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const WARNING = 'Runs with VS Code\u2019s OS access, outside the Codex sandbox. Unsaved editor changes are not visible to the shell.';

interface PendingRequest {
  command: string;
  cwd: string;
  root: string;
  panel: vscode.WebviewPanel;
  signal: AbortSignal;
  listeners: vscode.Disposable[];
  settled: boolean;
  resolve: (approved: boolean) => void;
  settle: (approved: boolean) => void;
}

/**
 * Shell command approvals rendered in a non-modal, scrollable
 * "Review Worker Command" webview tab. The exact command, working
 * directory, and workspace root (the approval scope) are displayed as
 * literal text. "Run once" approves only that exact command;
 * "Allow for this workspace session" additionally remembers the exact
 * root in memory only, so later commands in that workspace auto-approve
 * until the window reloads or the user revokes it. Grants are never
 * persisted or read from configuration. Cancel, closing the tab, an
 * aborted signal, revocation, or disposing the service deny the request.
 */
export class CommandApprovals implements vscode.Disposable {
  private readonly pending = new Map<vscode.WebviewPanel, PendingRequest>();
  private readonly granted = new Set<string>();
  private disposed = false;

  request(command: string, cwd: string, signal: AbortSignal, workspaceRoot = cwd): Promise<boolean> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve(false);
    }
    if (this.granted.has(workspaceRoot)) {
      return Promise.resolve(true);
    }
    const panel = vscode.window.createWebviewPanel('codexSubagent.commandReview', 'Review Worker Command', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    const nonce = randomBytes(18).toString('hex');
    panel.webview.html = html(nonce, panel.webview.cspSource, command, cwd, workspaceRoot);
    const entry: PendingRequest = {
      command, cwd, root: workspaceRoot, panel, signal, listeners: [], settled: false, resolve: () => undefined, settle: () => undefined
    };
    entry.settle = (approved: boolean): void => {
      if (entry.settled) {
        return;
      }
      entry.settled = true;
      this.pending.delete(panel);
      for (const listener of entry.listeners) {
        listener.dispose();
      }
      entry.listeners.length = 0;
      panel.dispose();
      entry.resolve(approved && !signal.aborted && !this.disposed);
    };
    const promise = new Promise<boolean>(resolve => {
      entry.resolve = resolve;
    });
    const onAbort = (): void => entry.settle(false);
    signal.addEventListener('abort', onAbort, { once: true });
    entry.listeners.push({ dispose: () => signal.removeEventListener('abort', onAbort) });
    const live = (): boolean => !entry.settled && !this.disposed && !entry.signal.aborted;
    entry.listeners.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || !('action' in message) || !live()) {
        return;
      }
      if (message.action === 'run') {
        entry.settle(true);
      } else if (message.action === 'allowSession') {
        // A retained webview must not re-grant after cancel/close/abort.
        this.granted.add(entry.root);
        for (const other of [...this.pending.values()]) {
          if (other.root === entry.root && !other.settled && !this.disposed && !other.signal.aborted) {
            other.settle(true);
          }
        }
      } else if (message.action === 'cancel') {
        entry.settle(false);
      }
    }));
    entry.listeners.push(panel.onDidDispose(() => entry.settle(false)));
    this.pending.set(panel, entry);
    if (signal.aborted) {
      entry.settle(false);
    }
    return promise;
  }

  getGrantedRoots(): string[] {
    return [...this.granted].sort();
  }

  /**
   * Clears the session grant for one workspace root, or for every root
   * when omitted. Also denies and closes any pending requests in that
   * scope so stale "allow for this session" messages cannot re-grant.
   */
  revoke(workspaceRoot?: string): void {
    if (workspaceRoot === undefined) {
      this.granted.clear();
    } else {
      this.granted.delete(workspaceRoot);
    }
    for (const entry of [...this.pending.values()]) {
      if (workspaceRoot === undefined || entry.root === workspaceRoot) {
        entry.settle(false);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.granted.clear();
    for (const entry of [...this.pending.values()]) {
      entry.settle(false);
    }
  }
}

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function html(nonce: string, source: string, command: string, cwd: string, root: string): string {
  const safeCommand = escapeHtml(command);
  const safeCwd = escapeHtml(cwd);
  const safeRoot = escapeHtml(root);
  const safeWarning = escapeHtml(WARNING);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0;overflow:hidden}
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;min-height:0}
header{flex:0 0 auto;min-height:0;max-height:40%;min-width:0;padding:16px 20px 8px;overflow-wrap:anywhere;overflow:auto}
header h1{font-size:20px;margin:0 0 6px}
#warning{color:var(--vscode-errorForeground);margin:0 0 10px;white-space:pre-wrap;word-break:break-word}
#cwdLabel{color:var(--vscode-descriptionForeground);margin:0 0 2px}
#cwd{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
main{flex:1 1 auto;min-height:0;overflow:auto;padding:0 20px 12px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:var(--vscode-editor-font-size,13px) var(--vscode-editor-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);line-height:1.5}
footer{flex:0 0 auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 20px;border-top:1px solid var(--vscode-panel-border)}
button{font:inherit;cursor:pointer;border:0;padding:7px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{background:var(--vscode-button-hoverBackground)}
#cancelBtn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#cancelBtn:hover{background:var(--vscode-button-secondaryHoverBackground)}
#sessionBtn{grid-column:1/-1;white-space:normal}
#rootLabel{color:var(--vscode-descriptionForeground);margin:0 0 2px}
#root{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
#note{color:var(--vscode-descriptionForeground);margin:0 0 4px;font-size:var(--vscode-editor-font-size,12px);white-space:pre-wrap;word-break:break-word}
</style></head><body>
<header>
<h1>Worker command approval</h1>
<p id="warning">${safeWarning}</p>
<p id="rootLabel">Workspace (approval scope)</p>
<p id="root">${safeRoot}</p>
<p id="cwdLabel">Working directory</p>
<p id="cwd">${safeCwd}</p>
<p id="note">Session grants expire when the window reloads and can be revoked with “Revoke Shell Approval”.</p>
</header>
<main><pre id="command"><code>${safeCommand}</code></pre></main>
<footer>
<button id="runBtn" type="button">Run once</button>
<button id="cancelBtn" type="button">Cancel</button>
<button id="sessionBtn" type="button">Allow for this workspace session</button>
</footer>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const post=action=>vscode.postMessage({action});
document.getElementById('runBtn').onclick=()=>post('run');
document.getElementById('sessionBtn').onclick=()=>post('allowSession');
document.getElementById('cancelBtn').onclick=()=>post('cancel');
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();post('cancel');}});
document.getElementById('cancelBtn').focus();
</script></body></html>`;
}
