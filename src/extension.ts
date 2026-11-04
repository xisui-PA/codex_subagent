import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  console.log('Codex Subagent extension is active!');

  const disposable = vscode.commands.registerCommand('codexSubagent.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from Codex Subagent!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // Called when the extension is deactivated.
}
