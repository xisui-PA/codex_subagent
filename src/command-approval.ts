import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CommandApprovalContext } from './workspace-tools';

export type { CommandApprovalContext } from './workspace-tools';

const WARNING = 'Runs with VS Code\u2019s OS access, outside the Codex sandbox. Unsaved editor changes are not visible to the shell.';
// An isolated runner works on a recorded private view, so the legacy sentence
// about hidden unsaved editor content would be wrong. State the real limits:
// OS access is not a sandbox; the working directory holds the recorded private
// revision, and absolute OS paths are not remapped into it.
const ISOLATED_WARNING = 'Runs with VS Code\u2019s OS access. This is not a sandbox: the command can read and write anything your user account can. '
  + 'The working directory contains the recorded private revision, including editor content captured in that revision. '
  + 'Absolute paths in the command are not remapped, so the shell can still reach your logical project.';
// The legacy prompt keeps its exact inline note text and buttons unchanged.
const ISOLATED_NOTE = 'This grant covers future isolated runner commands for this logical project only. It never approves ordinary workspace shell commands. '
  + 'Session grants expire when the window reloads and can be revoked with \u201cRevoke Shell Approval\u201d.';

const ID64_RE = /^[0-9a-f]{64}$/;
const MAX_REVISION = 1024;
const MAX_FIELD_LENGTH = 8192;

/** Legacy workspace grants and isolated-runner grants are never shared. */
type GrantKind = 'workspace' | 'isolated';

interface RecordedInput {
  snapshotId: string;
  overlayId: string;
  revision: number;
}

/** Immutable isolated identity captured when the request is created. */
interface IsolatedRun {
  readonly executionRoot: string;
  readonly inputVersion: Readonly<RecordedInput>;
}

interface PendingRequest {
  command: string;
  cwd: string;
  /** Canonical logical project root; the approval scope for this kind. */
  root: string;
  kind: GrantKind;
  isolated?: IsolatedRun;
  panel: vscode.WebviewPanel;
  signal: AbortSignal;
  listeners: vscode.Disposable[];
  settled: boolean;
  resolve: (approved: boolean) => void;
  settle: (approved: boolean) => void;
}

function requireLiteral(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_LENGTH || value.includes('\0')) {
    throw new Error(`Invalid ${label} in the isolated runner approval context.`);
  }
  return value;
}

/**
 * Validate and freeze the caller's isolated identity. Anything unexpected
 * throws, so the caller fails closed: no prompt is shown and nothing is
 * granted. The context is never derived from editable model arguments.
 */
function requireIsolatedRun(context: CommandApprovalContext): IsolatedRun {
  if (!context || typeof context !== 'object' || context.kind !== 'isolated-runner') {
    throw new Error('The command approval context must be an isolated runner context.');
  }
  const executionRoot = requireLiteral(context.executionRoot, 'execution root');
  const input = context.inputVersion;
  if (!input || typeof input !== 'object') {
    throw new Error('The isolated runner context requires an input version.');
  }
  const snapshotId = requireLiteral(input.snapshotId, 'snapshot id');
  const overlayId = requireLiteral(input.overlayId, 'overlay id');
  if (!ID64_RE.test(snapshotId) || !ID64_RE.test(overlayId)) {
    throw new Error('The isolated runner input version must use 64-hex snapshot and overlay ids.');
  }
  if (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > MAX_REVISION) {
    throw new Error(`The isolated runner input revision must be an integer between 0 and ${MAX_REVISION}.`);
  }
  return Object.freeze({
    executionRoot,
    inputVersion: Object.freeze({ snapshotId, overlayId, revision: input.revision })
  });
}

/**
 * Shell command approvals rendered in a non-modal, scrollable review webview.
 *
 * A legacy workspace request shows the exact command, working directory and
 * workspace root (its approval scope). An isolated-runner request additionally
 * shows the canonical logical project, the physical execution root, the
 * physical working directory and the exact recorded input revision, and says
 * plainly that OS access is not a sandbox and that the command runs on a
 * captured private view rather than live workspace files.
 *
 * Every path, id and command is rendered as escaped literal text. Grants are
 * keyed by grant kind AND root, so a workspace-session grant never
 * auto-approves an isolated-runner request and an isolated-runner grant never
 * auto-approves a pending or future legacy workspace request. An accepted
 * isolated grant covers only later isolated commands in the SAME logical
 * project. Grants are never persisted, never read from configuration, and are
 * cleared by revoke(), dispose() and window reload. Cancel, closing the tab, an
 * aborted signal, revocation or disposing the service deny the request, and a
 * late "allow for session" message from a retained webview cannot re-grant.
 */
export class CommandApprovals implements vscode.Disposable {
  private readonly pending = new Map<vscode.WebviewPanel, PendingRequest>();
  private readonly granted = new Map<string, Set<GrantKind>>();
  private disposed = false;

  request(command: string, cwd: string, signal: AbortSignal, workspaceRoot = cwd, context?: CommandApprovalContext): Promise<boolean> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve(false);
    }
    if (typeof command !== 'string' || command.length === 0 || typeof cwd !== 'string' || cwd.length === 0
      || typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      return Promise.resolve(false);
    }
    let isolated: IsolatedRun | undefined;
    if (context !== undefined) {
      try {
        isolated = requireIsolatedRun(context);
      } catch {
        return Promise.resolve(false);
      }
    }
    const kind: GrantKind = isolated === undefined ? 'workspace' : 'isolated';
    if (this.hasGrant(kind, workspaceRoot)) {
      return Promise.resolve(true);
    }
    const panel = vscode.window.createWebviewPanel('codexSubagent.commandReview',
      isolated === undefined ? 'Review Worker Command' : 'Review Isolated Runner Command',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    const nonce = randomBytes(18).toString('hex');
    panel.webview.html = isolated === undefined
      ? html(nonce, panel.webview.cspSource, command, cwd, workspaceRoot)
      : isolatedHtml(nonce, panel.webview.cspSource, command, cwd, workspaceRoot, isolated);
    const entry: PendingRequest = {
      command, cwd, root: workspaceRoot, kind, panel, signal, listeners: [], settled: false, resolve: () => undefined, settle: () => undefined
    };
    if (isolated !== undefined) {
      entry.isolated = isolated;
    }
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
        this.addGrant(entry.kind, entry.root);
        // Only requests of the SAME kind and root are covered: an isolated
        // grant never approves pending legacy requests, and vice versa.
        for (const other of [...this.pending.values()]) {
          if (other.kind === entry.kind && other.root === entry.root && !other.settled && !this.disposed && !other.signal.aborted) {
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

  /** Deduplicated logical roots with an active grant of either kind, sorted. */
  getGrantedRoots(): string[] {
    return [...this.granted.keys()].sort();
  }

  /**
   * Clears both grant kinds for one logical root, or for every root when
   * omitted. Also denies and closes any pending requests under that root
   * (either kind) so stale "allow for session" messages cannot re-grant.
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

  private hasGrant(kind: GrantKind, root: string): boolean {
    return this.granted.get(root)?.has(kind) === true;
  }

  private addGrant(kind: GrantKind, root: string): void {
    const kinds = this.granted.get(root);
    if (kinds === undefined) {
      this.granted.set(root, new Set<GrantKind>([kind]));
    } else {
      kinds.add(kind);
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

function isolatedHtml(nonce: string, source: string, command: string, cwd: string, logicalRoot: string, isolated: IsolatedRun): string {
  const safeCommand = escapeHtml(command);
  const safeCwd = escapeHtml(cwd);
  const safeLogical = escapeHtml(logicalRoot);
  const safeExecution = escapeHtml(isolated.executionRoot);
  const safeSnapshot = escapeHtml(isolated.inputVersion.snapshotId);
  const safeOverlay = escapeHtml(isolated.inputVersion.overlayId);
  const safeRevision = escapeHtml(String(isolated.inputVersion.revision));
  const safeWarning = escapeHtml(ISOLATED_WARNING);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0;overflow:hidden}
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;min-height:0}
header{flex:0 0 auto;min-height:0;max-height:46%;min-width:0;padding:16px 20px 8px;overflow-wrap:anywhere;overflow:auto}
header h1{font-size:20px;margin:0 0 6px}
#warning{color:var(--vscode-errorForeground);margin:0 0 10px;white-space:pre-wrap;word-break:break-word}
.label{color:var(--vscode-descriptionForeground);margin:0 0 2px}
.value{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
main{flex:1 1 auto;min-height:0;overflow:auto;padding:0 20px 12px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:var(--vscode-editor-font-size,13px) var(--vscode-editor-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);line-height:1.5}
footer{flex:0 0 auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 20px;border-top:1px solid var(--vscode-panel-border)}
button{font:inherit;cursor:pointer;border:0;padding:7px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:hover{background:var(--vscode-button-hoverBackground)}
#cancelBtn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#cancelBtn:hover{background:var(--vscode-button-secondaryHoverBackground)}
#sessionBtn{grid-column:1/-1;white-space:normal}
#note{color:var(--vscode-descriptionForeground);margin:0 0 4px;font-size:var(--vscode-editor-font-size,12px);white-space:pre-wrap;word-break:break-word}
</style></head><body>
<header>
<h1>Isolated runner command approval</h1>
<p id="warning">${safeWarning}</p>
<p class="label" id="logicalLabel">Logical project (approval scope)</p>
<p class="value" id="logical">${safeLogical}</p>
<p class="label" id="executionLabel">Execution root (physical, outside the project)</p>
<p class="value" id="execution">${safeExecution}</p>
<p class="label" id="cwdLabel">Working directory (physical)</p>
<p class="value" id="cwd">${safeCwd}</p>
<p class="label" id="inputLabel">Recorded input revision</p>
<p class="value" id="input">snapshot ${safeSnapshot}
overlay ${safeOverlay}
revision ${safeRevision}</p>
<p id="note">${escapeHtml(ISOLATED_NOTE)}</p>
</header>
<main><pre id="command"><code>${safeCommand}</code></pre></main>
<footer>
<button id="runBtn" type="button">Run once</button>
<button id="cancelBtn" type="button">Cancel</button>
<button id="sessionBtn" type="button">Allow isolated runner for this project session</button>
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
