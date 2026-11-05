import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Message, Session } from './types';
import { ComposerOperation, WorkerComposer } from './composer';

export type PanelAction = 'send' | 'cancel' | 'resume' | 'compact' | 'discard' | 'diff' | 'revert' | 'history' | 'export' | 'draft' | 'retry' | 'clearPending';
export interface PanelMessage { action: PanelAction; message?: string; changeId?: string; model?: string; requestId?: string }
export class WorkerPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private ready = false;
  private resolveReady!: () => void;
  readonly whenReady = new Promise<void>(resolve => {
    this.resolveReady = resolve;
  });
  private pending?: { session: Session; models: { id: string; name: string }[] };
  private lastSignature = '';
  constructor(title: string, private readonly action: (message: PanelMessage) => Promise<void>, onClose: () => void, private readonly composer = new WorkerComposer({ load: () => undefined, save: async () => undefined })) {
    this.panel = vscode.window.createWebviewPanel('codexSubagent.worker', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const nonce = randomBytes(18).toString('hex');
    this.panel.webview.html = html(nonce, this.panel.webview.cspSource);
    const unsubscribe = composer.subscribe(() => this.composerState());
    this.panel.webview.onDidReceiveMessage((value: unknown) => {
      if (value && typeof value === 'object' && 'action' in value && value.action === 'ready') {
        this.ready = true; this.resolveReady();
        if (this.pending) {
          this.update(this.pending.session, this.pending.models); this.pending = undefined;
        }
        this.composerState();
        return;
      }
      if (!value || typeof value !== 'object' || !('action' in value) || !['send', 'cancel', 'resume', 'compact', 'discard', 'diff', 'revert', 'history', 'export', 'draft', 'retry', 'clearPending'].includes(String(value.action))) {
        return;
      }
      const m = value as PanelMessage;
      if ((m.message !== undefined && (typeof m.message !== 'string' || m.message.length > 200_000)) || (m.model !== undefined && (typeof m.model !== 'string' || m.model.length > 500)) || (m.changeId && !/^[a-f0-9-]{36}$/.test(m.changeId))) {
        return;
      }
      const perform = (operation: ComposerOperation): Promise<void> => this.action({ action: operation.action, requestId: operation.requestId, message: operation.message, model: operation.model });
      const operation = m.action === 'draft' ? composer.draft(m.message || '')
        : m.action === 'send' || m.action === 'resume' ? composer.submit({ action: m.action, draft: m.message || '', model: m.model }, perform)
          : m.action === 'retry' ? composer.retry(perform)
            : m.action === 'clearPending' ? composer.clearPending() : this.action(m);
      void operation.catch(error => {
        this.composerState(); this.error(error instanceof Error ? error.message : String(error));
      });
    });
    this.panel.onDidDispose(() => {
      this.disposed = true; unsubscribe(); onClose();
      this.resolveReady();
    });
  }
  private composerState(): void {
    if (this.ready && !this.disposed) {
      void this.panel.webview.postMessage({ type: 'composer', composer: this.composer.state() });
    }
  }
  update(session: Session, models: { id: string; name: string }[]): void {
    if (this.disposed) {
      return;
    }
    if (!this.ready) {
      this.pending = { session, models }; return;
    }
    const signature = `${session.id}:${session.revision}:${session.state}:${session.activity}:${JSON.stringify(models)}`;
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    this.panel.title = session.title; void this.panel.webview.postMessage({ type: 'state', session, models });
  }
  history(messages: Message[], offset: number): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: 'history', messages, offset });
    }
  }
  error(message: string): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: 'error', message });
    }
  }
  reveal(): void {
    this.panel.reveal();
  }
  dispose(): void {
    this.panel.dispose();
  }
}
function html(nonce: string, source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1000px;margin:auto}h1{font-size:22px}#meta,#activity{color:var(--vscode-descriptionForeground);margin:8px 0}button,select,textarea{font:inherit}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:7px 12px;margin:4px;cursor:pointer}button:disabled{opacity:.45;cursor:default}textarea,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}textarea{width:95%;min-height:80px}pre{white-space:pre-wrap;word-break:break-word;font:inherit;line-height:1.5}article{border-bottom:1px solid var(--vscode-panel-border);padding:12px 0}.role{font-weight:600;color:var(--vscode-descriptionForeground)}#error{color:var(--vscode-errorForeground);white-space:pre-wrap}.change{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.change span{flex:1}details{margin:12px 0}#tools{padding:12px;background:var(--vscode-textCodeBlock-background)}</style></head><body>
<h1 id="title">Worker</h1><div id="meta"></div><div id="activity" role="status" aria-live="polite">Connecting…</div><div id="error" role="alert"></div>
<div><button id="cancel">Cancel</button><button id="resume">Resume</button><select id="model" aria-label="Model for resumption"></select><button id="compact">Compact history</button><button id="discard">Discard queued messages</button><button id="history">Earlier history</button><button id="export">Export transcript</button></div>
<details open><summary>Changed files</summary><div id="changes"></div></details><details><summary>Recent tool activity</summary><div id="tools"></div></details>
<details id="past"><summary>Archived conversation</summary><div id="historyContent"></div></details><div id="conversation"></div><label for="message">Follow-up or recovery instructions</label><textarea id="message" maxlength="200000" disabled placeholder="Queue a follow-up, or describe how the worker should resume…"></textarea><button id="send" disabled>Send follow-up</button><div id="composerError" role="alert"></div><div id="pendingRequest" hidden><p id="pendingText"></p><button id="retry">Retry pending request</button><button id="clearPending">Clear retry record</button><p>Clearing the retry record keeps your draft. It does not cancel work that was already accepted.</p></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let state;const el=id=>document.getElementById(id);const post=(action,extra={})=>vscode.postMessage({action,...extra});let lastModel='';let historyOffset=0;let historyLoading=false;
let composer={draft:'',busy:false};let composerReady=false;const remembered=vscode.getState();if(remembered&&typeof remembered.draft==='string')el('message').value=remembered.draft;
function composerControls(){const pending=!!composer.pending;el('message').disabled=!composerReady||composer.busy;el('send').disabled=!composerReady||composer.busy||pending||!state||!['running','queued','completed'].includes(state.state)||!!state.maintenance||state.activity==='Summarizing history'||!el('message').value.trim();el('resume').disabled=!composerReady||composer.busy||pending||!state||!['failed','interrupted','cancelled'].includes(state.state)||!state.turns.some(t=>t.state!=='completed');el('model').disabled=composer.busy||pending;el('pendingRequest').hidden=!pending;el('retry').disabled=composer.busy;el('clearPending').disabled=composer.busy;el('pendingText').textContent=pending?'This '+(composer.pending.action==='send'?'follow-up':'resumption')+' has not been acknowledged. Retry submits the original request: '+(composer.pending.message||'Continue without extra instructions').slice(0,300):'';el('composerError').textContent=composer.error||'';}
function submit(action,extra={}){post('draft',{message:el('message').value});composer.busy=true;composerControls();post(action,extra);}
el('message').oninput=()=>{vscode.setState({draft:el('message').value});post('draft',{message:el('message').value});composerControls();};
el('retry').onclick=()=>submit('retry');el('clearPending').onclick=()=>submit('clearPending');
for(const id of ['cancel','compact','discard','export'])el(id).onclick=()=>post(id);el('history').onclick=()=>{historyLoading=true;el('history').disabled=true;post('history');};
el('send').onclick=()=>{const message=el('message').value;if(message.trim())submit('send',{message});};
el('resume').onclick=()=>submit('resume',{message:el('message').value,model:el('model').value||undefined});
function article(role,text){const a=document.createElement('article');const label=document.createElement('div');label.className='role';label.textContent=role;const p=document.createElement('pre');p.textContent=text;a.append(label,p);return a;}
window.addEventListener('message',event=>{const d=event.data;if(d.type==='composer'){composer=d.composer;composerReady=true;el('message').value=composer.draft;vscode.setState({draft:composer.draft});composerControls();return;}if(d.type==='error'){el('error').textContent=d.message;historyLoading=false;el('history').disabled=!state||(state.messageBase||0)<=historyOffset;return;}if(d.type==='history'){historyLoading=false;historyOffset=d.offset;for(const message of d.messages){el('historyContent').append(article(message.role, message.parts.map(p=>p.type==='text'?p.text:JSON.stringify(p)).join('\\n')));}el('past').open=true;el('history').disabled=!state||(state.messageBase||0)<=historyOffset;return;}if(d.type!=='state')return;state=d.session;el('title').textContent=state.title;el('meta').textContent=[state.state,state.model.name,state.permission,state.ownerLabel||state.ownerId||'Ungrouped',state.workspaceRoot||''].join(' · ');el('activity').textContent=state.state==='running'?(state.activity||'Working…'):'Last updated '+new Date(state.updatedAt).toLocaleTimeString();
el('history').disabled=historyLoading||(state.messageBase||0)<=historyOffset;const running=['running','queued'].includes(state.state);el('cancel').disabled=!running;composerControls();el('compact').disabled=running;el('discard').disabled=!!state.maintenance||!state.turns.some(t=>!t.started&&t.state!=='completed');
const currentModel=el('model').value||state.model.id;const signature=JSON.stringify(d.models);if(lastModel!==signature){el('model').replaceChildren();for(const m of d.models){const o=document.createElement('option');o.value=m.id;o.textContent=m.name;el('model').append(o);}el('model').value=currentModel;lastModel=signature;}
const lastError=[...state.turns].reverse().find(t=>t.error);el('error').textContent=state.maintenanceError?state.maintenanceError.message:lastError?lastError.error.message:'';
const conversation=el('conversation');const nearBottom=window.innerHeight+window.scrollY>=document.body.scrollHeight-100;conversation.replaceChildren();if(state.summary)conversation.append(article('Earlier history summary',state.summary.text));for(const t of state.turns){conversation.append(article('Task · '+t.state,t.input));if(t.output)conversation.append(article('Worker',t.output));}if(nearBottom)window.scrollTo(0,document.body.scrollHeight);
el('tools').textContent=state.turns.flatMap(t=>t.tools).slice(-20).map(t=>t.call.name+' — '+t.state).join('\\n')||'No tools used yet.';
el('changes').replaceChildren();for(const c of state.changes||[]){const row=document.createElement('div');row.className='change';const name=document.createElement('span');name.textContent=c.kind+' · '+c.path+(c.target?' → '+c.target:'')+' · '+c.state;const diff=document.createElement('button');diff.textContent='Review diff';diff.onclick=()=>post('diff',{changeId:c.id});const revert=document.createElement('button');revert.textContent='Revert';revert.disabled=running||c.state==='reverted';revert.onclick=()=>post('revert',{changeId:c.id});row.append(name,diff,revert);el('changes').append(row);}if(!(state.changes||[]).length)el('changes').textContent='No file changes.';post('rendered',{id:state.id,revision:state.revision,title:el('title').textContent,resumeEnabled:!el('resume').disabled});
});
post('ready');
</script></body></html>`;
}
