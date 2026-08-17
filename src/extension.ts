import * as vscode from 'vscode';
import { captureVsCodeSnapshot, type CaptureMetadata } from './adapter/capture';
import { restoreVsCodeSnapshot } from './adapter/restore';
import { restoreIntegratedTerminals } from './adapter/terminal-restore';
import { runtimeStatePath, writeRuntimeState } from './adapter/state';
import { checkCliConnection, fetchCapsuleSnapshot } from './bridge/cli';
import { snapshotTargetsHost } from './bridge/host-target';
import { completeRestore, watchRestoreRequests, type RestoreRequest } from './bridge/restore-bus';

const SYNC_DEBOUNCE_MS = 350;
const HEARTBEAT_MS = 30_000;
let syncTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let captureMetadata: CaptureMetadata = {};

function extensionModeName(mode: vscode.ExtensionMode): CaptureMetadata['extensionMode'] {
  switch (mode) {
    case vscode.ExtensionMode.Development:
      return 'development';
    case vscode.ExtensionMode.Test:
      return 'test';
    case vscode.ExtensionMode.Production:
    default:
      return 'production';
  }
}

function metadataForContext(context: vscode.ExtensionContext): CaptureMetadata {
  const metadata: CaptureMetadata = { extensionMode: extensionModeName(context.extensionMode) };
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    metadata.extensionPath = context.extensionPath;
  }
  return metadata;
}

async function syncNow(reason: string): Promise<void> {
  const snapshot = captureVsCodeSnapshot(captureMetadata);
  const destination = await writeRuntimeState(snapshot);
  output.appendLine(`[${new Date().toISOString()}] synchronized (${reason}) -> ${destination}`);
}

function scheduleSync(reason: string): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncNow(reason).catch(error => output.appendLine(`sync failed: ${String(error)}`)), SYNC_DEBOUNCE_MS);
}

async function handleRestoreRequest(request: RestoreRequest): Promise<void> {
  if (!snapshotTargetsHost(request.payload.editor, captureMetadata)) {
    output.appendLine(`restore ${request.request_id}: request targets another VS Code extension host; leaving it for that host`);
    return;
  }

  let changed = 0;
  let skipped = 0;
  const warnings: string[] = [];

  try {
    if (request.payload.editor) {
      if (!vscode.workspace.isTrusted) {
        throw new Error('VS Code semantic restore is disabled while this workspace is untrusted.');
      }
      const editorReport = await restoreVsCodeSnapshot(request.payload.editor);
      changed += editorReport.opened;
      skipped += editorReport.skipped;
      warnings.push(...editorReport.warnings);
    }

    const terminalReport = await restoreIntegratedTerminals(request.payload.terminals ?? []);
    changed += terminalReport.opened;
    skipped += terminalReport.skipped;
    warnings.push(...terminalReport.warnings);

    await syncNow(`restore ${request.request_id}`);
    await completeRestore(request, { ok: true, changed, skipped, warnings });
    output.appendLine(`restore ${request.request_id}: changed ${changed}, skipped ${skipped}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`restore ${request.request_id} failed: ${message}`);
    await completeRestore(request, {
      ok: false,
      changed,
      skipped,
      warnings,
      error: message,
    }).catch(completionError => output.appendLine(`restore completion write failed: ${String(completionError)}`));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Context Capsule');
  captureMetadata = metadataForContext(context);
  context.subscriptions.push(output);

  output.appendLine(`extension mode: ${captureMetadata.extensionMode ?? 'unknown'}`);
  if (captureMetadata.extensionPath) output.appendLine(`extension development path: ${captureMetadata.extensionPath}`);

  const register = (id: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('context-capsule.sync', async () => {
    await syncNow('manual command');
    vscode.window.setStatusBarMessage('Context Capsule: VS Code context synchronized', 2500);
  });

  register('context-capsule.inspect', async () => {
    const snapshot = captureVsCodeSnapshot(captureMetadata);
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

  try {
    const restoreWatcher = await watchRestoreRequests(handleRestoreRequest);
    context.subscriptions.push(restoreWatcher);
    output.appendLine('CLI restore request watcher active.');
  } catch (error) {
    output.appendLine(`Could not start CLI restore request watcher: ${String(error)}`);
  }

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
