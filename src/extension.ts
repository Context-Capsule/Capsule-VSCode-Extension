import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from './adapter/capture';
import { restoreVsCodeSnapshot } from './adapter/restore';
import { runtimeStatePath, writeRuntimeState } from './adapter/state';
import { checkCliConnection, fetchCapsuleSnapshot } from './bridge/cli';

const SYNC_DEBOUNCE_MS = 350;
const HEARTBEAT_MS = 30_000;
let syncTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;

async function syncNow(reason: string): Promise<void> {
  const snapshot = captureVsCodeSnapshot();
  const destination = await writeRuntimeState(snapshot);
  output.appendLine(`[${new Date().toISOString()}] synchronized (${reason}) -> ${destination}`);
}

function scheduleSync(reason: string): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncNow(reason).catch(error => output.appendLine(`sync failed: ${String(error)}`)), SYNC_DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Context Capsule');
  context.subscriptions.push(output);

  const register = (id: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('context-capsule.sync', async () => {
    await syncNow('manual command');
    vscode.window.setStatusBarMessage('Context Capsule: VS Code context synchronized', 2500);
  });

  register('context-capsule.inspect', async () => {
    const snapshot = captureVsCodeSnapshot();
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(snapshot, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
  });

  register('context-capsule.diagnostics', async () => {
    try {
      const result = await checkCliConnection();
      output.appendLine(`CLI: ${result.cliPath}`);
      output.appendLine(result.output);
      output.appendLine(`Runtime state: ${runtimeStatePath()}`);
      output.show(true);
      vscode.window.showInformationMessage('Context Capsule CLI connection is healthy.');
    } catch (error) {
      output.appendLine(`Diagnostics failed: ${String(error)}`);
      output.appendLine(`Runtime state: ${runtimeStatePath()}`);
      output.show(true);
      vscode.window.showErrorMessage(`Context Capsule CLI unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  register('context-capsule.restore', async () => {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Context Capsule restore is disabled while this workspace is untrusted.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Capsule name to restore', placeHolder: 'my-workspace', ignoreFocusOut: true });
    if (!name?.trim()) return;
    try {
      const snapshot = await fetchCapsuleSnapshot(name.trim());
      const report = await restoreVsCodeSnapshot(snapshot);
      const suffix = report.warnings.length ? ` ${report.warnings.length} warning(s); see Context Capsule output.` : '';
      report.warnings.forEach(warning => output.appendLine(`restore warning: ${warning}`));
      vscode.window.showInformationMessage(`Context Capsule restored ${report.opened} VS Code tab(s); skipped ${report.skipped}.${suffix}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not restore capsule: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const subscriptions: vscode.Disposable[] = [
    vscode.window.tabGroups.onDidChangeTabs(() => scheduleSync('tabs changed')),
    vscode.window.tabGroups.onDidChangeTabGroups(() => scheduleSync('tab groups changed')),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleSync('active editor changed')),
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleSync('visible editors changed')),
    vscode.window.onDidChangeTextEditorSelection(() => scheduleSync('selection changed')),
    vscode.window.onDidChangeTextEditorViewColumn(() => scheduleSync('editor group changed')),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleSync('workspace folders changed')),
  ];
  context.subscriptions.push(...subscriptions);

  heartbeatTimer = setInterval(
    () => void syncNow('heartbeat').catch(error => output.appendLine(`heartbeat failed: ${String(error)}`)),
    HEARTBEAT_MS,
  );
  context.subscriptions.push({
    dispose: () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    },
  });

  void syncNow('activation').catch(error => output.appendLine(`initial sync failed: ${String(error)}`));
}

export function deactivate(): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}
