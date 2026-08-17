import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from './adapter/capture';
import { captureMetadataForContext } from './adapter/host-identity';
import { restoreVsCodeSnapshot } from './adapter/restore';
import { restoreIntegratedTerminals } from './adapter/terminal-restore';
import {
  appendRuntimeLog,
  runtimeHostLogPath,
  runtimeHostStatePath,
  runtimeStatePath,
  writeRuntimeState,
} from './adapter/state';
import type { CaptureMetadata } from './adapter/types';
import { checkCliConnection, fetchCapsuleSnapshot } from './bridge/cli';
import { snapshotTargetsHost } from './bridge/host-target';
import { completeRestore, watchRestoreRequests, type RestoreRequest } from './bridge/restore-bus';

const SYNC_DEBOUNCE_MS = 350;
const HEARTBEAT_MS = 30_000;
let syncTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let captureMetadata: CaptureMetadata = {};

function log(message: string, persist = true): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  output.appendLine(line);
  if (persist) {
    void appendRuntimeLog(line).catch(error => {
      output.appendLine(`[${new Date().toISOString()}] diagnostic log write failed: ${String(error)}`);
    });
  }
}

async function syncNow(reason: string): Promise<void> {
  const snapshot = captureVsCodeSnapshot(captureMetadata);
  const destination = await writeRuntimeState(snapshot);
  const tabCount = snapshot.tabGroups.reduce((count, group) => count + group.tabs.length, 0);
  log(
    `synchronized (${reason}); host=${snapshot.extensionMode ?? 'unknown'} detection=${snapshot.hostDetection ?? 'unknown'} tabs=${tabCount} -> ${destination}`,
    reason !== 'heartbeat',
  );
}

function scheduleSync(reason: string): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => void syncNow(reason).catch(error => log(`sync failed (${reason}): ${String(error)}`)), SYNC_DEBOUNCE_MS);
}

async function handleRestoreRequest(request: RestoreRequest): Promise<void> {
  if (!snapshotTargetsHost(request.payload.editor, captureMetadata)) {
    log(
      `restore ${request.request_id}: request targets another VS Code host; current mode=${captureMetadata.extensionMode ?? 'unknown'} path=${captureMetadata.extensionPath ?? '(none)'}`,
    );
    return;
  }

  let changed = 0;
  let skipped = 0;
  const warnings: string[] = [];

  try {
    log(`restore ${request.request_id}: accepted by this host`);
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
    log(`restore ${request.request_id}: changed ${changed}, skipped ${skipped}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`restore ${request.request_id} failed: ${message}`);
    await completeRestore(request, {
      ok: false,
      changed,
      skipped,
      warnings,
      error: message,
    }).catch(completionError => log(`restore completion write failed: ${String(completionError)}`));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Context Capsule');
  captureMetadata = captureMetadataForContext(context);
  context.subscriptions.push(output);

  log(`extension host PID: ${process.pid}`);
  log(
    `host identity: mode=${captureMetadata.extensionMode ?? 'unknown'} detection=${captureMetadata.hostDetection ?? 'unknown'} path=${captureMetadata.extensionPath ?? '(none)'}`,
  );
  log(`host runtime state: ${runtimeHostStatePath()}`);
  log(`host diagnostic log: ${runtimeHostLogPath()}`);

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
      log(`CLI: ${result.cliPath}`);
      log(result.output);
      log(`Canonical runtime state: ${runtimeStatePath()}`);
      log(`This host runtime state: ${runtimeHostStatePath()}`);
      log(`This host diagnostic log: ${runtimeHostLogPath()}`);
      log(
        `This host identity: mode=${captureMetadata.extensionMode ?? 'unknown'} detection=${captureMetadata.hostDetection ?? 'unknown'} path=${captureMetadata.extensionPath ?? '(none)'}`,
      );
      output.show(true);
      vscode.window.showInformationMessage('Context Capsule CLI connection is healthy.');
    } catch (error) {
      log(`Diagnostics failed: ${String(error)}`);
      log(`Canonical runtime state: ${runtimeStatePath()}`);
      log(`This host diagnostic log: ${runtimeHostLogPath()}`);
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
    if (!name?.trim()) {
      return;
    }
    try {
      const snapshot = await fetchCapsuleSnapshot(name.trim());
      const report = await restoreVsCodeSnapshot(snapshot);
      const suffix = report.warnings.length ? ` ${report.warnings.length} warning(s); see Context Capsule output.` : '';
      report.warnings.forEach(warning => log(`restore warning: ${warning}`));
      vscode.window.showInformationMessage(`Context Capsule restored ${report.opened} VS Code tab(s); skipped ${report.skipped}.${suffix}`);
    } catch (error) {
      log(`manual restore failed: ${String(error)}`);
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
    log('CLI restore request watcher active.');
  } catch (error) {
    log(`Could not start CLI restore request watcher: ${String(error)}`);
  }

  heartbeatTimer = setInterval(
    () => void syncNow('heartbeat').catch(error => log(`heartbeat failed: ${String(error)}`)),
    HEARTBEAT_MS,
  );
  context.subscriptions.push({
    dispose: () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      heartbeatTimer = undefined;
    },
  });

  void syncNow('activation').catch(error => log(`initial sync failed: ${String(error)}`));
}

export function deactivate(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
}
