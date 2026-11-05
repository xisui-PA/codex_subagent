import * as vscode from 'vscode';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChangeContent, WorkerError } from './types';

export function openText(file: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && path.resolve(doc.uri.fsPath) === path.resolve(file));
}
export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** WorkspaceEdit supplies native editor undo and keeps pre-existing dirty buffers dirty. */
export async function applyEditorChange(change: ChangeContent, expectedHash: string): Promise<void> {
  const uri = vscode.Uri.file(change.path);
  const document = change.before === null ? undefined : await vscode.workspace.openTextDocument(uri);
  if (document && textHash(document.getText()) !== expectedHash) {
    throw new WorkerError('file_conflict', 'The editor changed while the worker prepared its edit. Read the file again.');
  }
  const edit = new vscode.WorkspaceEdit();
  const dirty = document?.isDirty || false;
  if (change.kind === 'write') {
    if (!document) {
      edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), change.after!);
    } else {
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.after!);
    }
  } else if (change.kind === 'delete') {
    edit.deleteFile(uri, { ignoreIfNotExists: false });
  } else {
    edit.renameFile(uri, vscode.Uri.file(change.target!), { overwrite: false });
  }
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new WorkerError('editor_rejected', 'VS Code could not apply this edit. No success was recorded; inspect the file before retrying.');
  }
  if (change.kind === 'write' && !dirty) {
    const updated = await vscode.workspace.openTextDocument(uri);
    if (!await updated.save()) {
      throw new WorkerError('save_failed', 'The edit is in the editor but saving failed. Save it manually; inspect state before retrying.');
    }
  }
}
