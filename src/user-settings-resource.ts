import * as vscode from 'vscode';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** VS Code keeps extension storage in the default profile, not the active one. */
export function profileStateUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, '..', 'storage.json');
}

/**
 * There is no public active-profile URI API. Resolve the persisted workspace
 * association using VS Code's profile metadata; never infer profile identity
 * from matching model policies, since profiles can differ only in priority.
 * Unknown/corrupt metadata returns no file, leaving the API authoritative.
 */
export async function userSettingsResource(context: vscode.ExtensionContext, setting = 'codexSubagent.models'): Promise<vscode.Uri | undefined> {
  const userHome = vscode.Uri.joinPath(context.globalStorageUri, '..', '..');
  if (vscode.env.remoteName) {
    // Machine-scoped settings in a remote extension host are shared across
    // client profiles and are stored on the server, beside its User directory.
    return vscode.Uri.joinPath(userHome, '..', 'Machine', 'settings.json');
  }
  const defaultSettings = vscode.Uri.joinPath(userHome, 'settings.json');
  const shared = vscode.workspace.getConfiguration('workbench.settings').inspect<unknown>('applyToAllProfiles')?.globalValue;
  if (Array.isArray(shared) && shared.includes(setting)) {
    return defaultSettings;
  }
  let state: Record<string, unknown> | undefined;
  try {
    state = record(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(profileStateUri(context))).toString('utf8')));
  } catch {
    // Missing metadata cannot distinguish a fresh default profile from a
    // temporary profile, whose identity is never persisted.
    return undefined;
  }
  if (!state) {
    return undefined;
  }
  const associations = record(state.profileAssociations);
  if ((state.profileAssociations !== undefined && !associations)
    || (associations?.workspaces !== undefined && !record(associations.workspaces))) {
    return undefined;
  }
  const workspace = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  let profileId: unknown;
  if (workspace) {
    const workspaces = record(associations?.workspaces);
    // VS Code's Windows URI identity is case-insensitive, including drive letters.
    const identity = (uri: string): string => process.platform === 'win32' && workspace.scheme === 'file' ? uri.toLowerCase() : uri;
    const key = Object.keys(workspaces ?? {}).find(value => identity(value) === identity(workspace.toString()));
    profileId = key === undefined ? undefined : workspaces?.[key];
  } else if (context.storageUri) {
    const workspaceId = vscode.Uri.joinPath(context.storageUri, '..').path.split('/').pop()!;
    profileId = record(associations?.emptyWindows)?.[workspaceId];
  } else {
    // Empty windows do not expose their window/workspace identity through the
    // public API. Do not borrow another profile's order when identity is unknown.
    return undefined;
  }
  if (profileId === '__default__profile__') {
    return defaultSettings;
  }
  if (typeof profileId !== 'string' || !Array.isArray(state.userDataProfiles)) {
    return undefined;
  }
  for (const value of state.userDataProfiles) {
    const profile = record(value);
    const location = profile?.location;
    let directory: vscode.Uri | undefined;
    if (typeof location === 'string' && /^[\w-]+(?:\/[\w-]+)*$/.test(location)) {
      directory = vscode.Uri.joinPath(userHome, 'profiles', location);
    } else {
      // Older VS Code versions persisted a URI object instead of a relative ID.
      const storedUri = record(location);
      if (typeof storedUri?.path === 'string') {
        directory = userHome.with({ path: storedUri.path });
      }
    }
    if (directory?.path.split('/').pop() === profileId) {
      return record(profile?.useDefaultFlags)?.settings === true ? defaultSettings : vscode.Uri.joinPath(directory, 'settings.json');
    }
  }
  return undefined;
}
