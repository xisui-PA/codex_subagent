import * as vscode from 'vscode';
import { isDeepStrictEqual } from 'node:util';
import { parse, ParseError } from 'jsonc-parser';
import { profileStateUri, userSettingsResource } from './user-settings-resource';

export interface UserModelSettings {
  read(): unknown;
  update(value: unknown): Promise<void>;
}

/** Only User settings may enable models or grant model permissions. */
export const userModelSettings: UserModelSettings = {
  read: () => vscode.workspace.getConfiguration('codexSubagent').inspect<unknown>('models')?.globalValue,
  update: async value => {
    await vscode.workspace.getConfiguration('codexSubagent').update('models', value, vscode.ConfigurationTarget.Global);
  }
};

/**
 * VS Code compares configuration objects without considering property order.
 * Keep a shared, order-sensitive snapshot and recover priority from the saved
 * JSONC file even when no configuration event (or new API snapshot) is sent.
 * Values still come from inspect().globalValue: a file from another settings
 * scope must never enable models or expand their permissions.
 */
export class UserModelSettingsCache implements UserModelSettings, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChange = this.change.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private settingsUri: vscode.Uri | undefined;
  private settingsWatch: vscode.Disposable | undefined;
  private raw: unknown = userModelSettings.read();
  private saved: unknown;
  private committed: unknown;
  private revision = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const reload = (): void => {
      void this.reload();
    };
    if (!vscode.env.remoteName) {
      this.subscriptions.push(this.watch(profileStateUri(context), reload));
    }
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === this.settingsUri?.toString()) {
          reload();
        }
      }), vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('codexSubagent.models')) {
          this.refresh();
          reload();
        } else if (event.affectsConfiguration('workbench.settings.applyToAllProfiles')) {
          reload();
        }
      }), vscode.workspace.onDidChangeWorkspaceFolders(reload));
  }

  private watch(uri: vscode.Uri, reload: () => void): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()!));
    const subscriptions = [watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload)];
    return { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) };
  }

  private watchSettings(uri: vscode.Uri | undefined): void {
    if (uri?.toString() === this.settingsUri?.toString()) {
      return;
    }
    this.settingsWatch?.dispose();
    // An association change must not reuse the previous profile's priority.
    this.saved = undefined;
    this.committed = undefined;
    this.settingsUri = uri;
    this.settingsWatch = uri ? this.watch(uri, () => {
      void this.reload();
    }) : undefined;
  }

  read(): unknown {
    return this.raw;
  }

  private refresh(): void {
    const configured = userModelSettings.read();
    // Compare values without order before accepting the file's order. This
    // also handles delayed API publication and profile/remote overrides.
    const ordered = [this.saved, this.committed].find(value => value !== null && typeof value === 'object'
      && !Array.isArray(value) && isDeepStrictEqual(configured, value));
    const next = ordered ?? configured;
    if (!this.disposed && JSON.stringify(next) !== JSON.stringify(this.raw)) {
      this.raw = next;
      this.change.fire();
    }
  }

  async reload(): Promise<void> {
    const revision = ++this.revision;
    const uri = await userSettingsResource(this.context);
    if (this.disposed || revision !== this.revision) {
      return;
    }
    this.watchSettings(uri);
    let saved: unknown;
    try {
      const text = uri ? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').replace(/^\uFEFF/, '') : '';
      const errors: ParseError[] = [];
      const settings = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
      if (!errors.length && settings && typeof settings === 'object' && !Array.isArray(settings)) {
        saved = settings['codexSubagent.models'];
      }
    } catch {
      // Missing/unreadable files and incomplete JSONC fall back to VS Code's
      // User snapshot; never adopt partially parsed policies.
    }
    if (this.disposed || revision !== this.revision) {
      return;
    }
    this.saved = saved;
    this.refresh();
  }

  async update(value: unknown): Promise<void> {
    await userModelSettings.update(value);
    if (!this.disposed) {
      // Do not depend on configuration/file events arriving before update()
      // resolves. Invalidate older reads and preserve this committed order.
      this.revision++;
      this.saved = value;
      // Keep successful writes when profile metadata or a settings read is
      // unavailable. refresh() still requires the API's exact policy values.
      this.committed = value;
      this.refresh();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.settingsWatch?.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.change.dispose();
  }
}
