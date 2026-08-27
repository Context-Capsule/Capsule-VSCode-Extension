import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from './adapter/capture';
import { captureMetadataForContext } from './adapter/host-identity';
import { restoreVsCodeSnapshot } from './adapter/restore';
import {
  forgetTerminal,
  interruptRunningTerminalServices,
  trackTerminalExecutionEnd,
  trackTerminalExecutionStart,
} from './adapter/service-restart';
import { restoreIntegratedTerminals, startSavedTerminalServices } from './adapter/terminal-restore';
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

function logHostIdentityDetails(): void {
  log(
    `host identity: mode=${captureMetadata.extensionMode ?? 'unknown'} detection=${captureMetadata.hostDetection ?? 'unknown'} path=${captureMetadata.extensionPath ?? '(none)'}`,
  );
  for (const diagnostic of captureMetadata.hostDiagnostics ?? []) {
    log(`host probe: ${diagnostic}`);
  }
}

function fallbackMetadata(context: vscode.ExtensionContext, error: unknown): CaptureMetadata {
  const extensionMode = context.extensionMode === vscode.ExtensionMode.Development
    ? 'development'
    : context.extensionMode === vscode.ExtensionMode.Test
      ? 'test'
      : 'production';
  return {
    extensionMode,
    extensionPath: extensionMode === 'development' ? context.extensionPath : undefined,
    hostDetection: extensionMode === 'development' ? 'self-development' : extensionMode,
    hostDiagnostics: [`host identity probe failed: ${String(error)}`],
  };
}

async function syncNow(reason: string): Promise<void> {
  const snapshot = captureVsCodeSnapshot(captureMetadata);
  const destination = await writeRuntimeState(snapshot);
  const tabCount = snapshot.tabGroups.reduce((count, group) => count + group.tabs.length, 0);
  const terminalCount = snapshot.integratedTerminals?.length ?? 0;
  log(
    `synchronized (${reason}); pid=${snapshot.hostPid ?? process.pid} host=${snapshot.extensionMode ?? 'unknown'} detection=${snapshot.hostDetection ?? 'unknown'} tabs=${tabCount} terminals=${terminalCount} workspaces=${snapshot.workspaceFolders.length} -> ${destination}`,
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
      `restore ${request.request_id}: request targets another VS Code host; current mode=${captureMetadata.extensionMode ?? 'unknown'} detection=${captureMetadata.hostDetection ?? 'unknown'} path=${captureMetadata.extensionPath ?? '(none)'}`,
    );
    return;
  }

  if (request.payload.terminal_control?.action === 'interrupt-running-services') {
    try {
      const report = await interruptRunningTerminalServices(
        request.payload.terminal_control.caller_shell_pid,
        request.payload.terminal_control.expected_running_services,
      );
      await syncNow(`terminal interrupt ${request.request_id}`);
      await completeRestore(request, {
        ok: report.ok,
        changed: report.interrupted,
        skipped: report.skipped,
        warnings: report.warnings,
        error: report.error,
        data: { services: report.services },
      });
      log(
        `terminal interrupt ${request.request_id}: interrupted ${report.interrupted}, skipped ${report.skipped}${report.error ? `; ${report.error}` : ''}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`terminal interrupt ${request.request_id} failed: ${message}`);
      await completeRestore(request, {
        ok: false,
        changed: 0,
        skipped: 0,
        warnings: [],
        error: message,
      }).catch(completionError => log(`terminal interrupt completion write failed: ${String(completionError)}`));
    }
    return;
  }

  if (request.payload.terminal_service_start) {
    try {
      const report = await startSavedTerminalServices(
        request.payload.editor?.integratedTerminals,
        request.payload.terminal_service_start.services,
      );
      await syncNow(`service restart ${request.request_id}`);
      await completeRestore(request, {
        ok: true,
        changed: report.started,
        skipped: report.skipped,
        warnings: report.warnings,
      });
      log(`service restart ${request.request_id}: started ${report.started}, skipped ${report.skipped}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`service restart ${request.request_id} failed: ${message}`);
      await completeRestore(request, {
        ok: false,
        changed: 0,
        skipped: request.payload.terminal_service_start.services.length,
        warnings: [],
        error: message,
      }).catch(completionError => log(`service restart completion write failed: ${String(completionError)}`));
    }
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

    const terminalReport = await restoreIntegratedTerminals(
      request.payload.editor?.integratedTerminals,
      request.payload.terminals ?? [],
    );
    changed += terminalReport.opened + terminalReport.revealed;
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
  context.subscriptions.push(output);

  // Persist an activation marker before host-identity probing. If this file is
  // absent after an Extension Development Host starts, Context Capsule itself
  // was not loaded in that host (for example because installed extensions were
  // disabled); a metadata heuristic cannot fix a host it never runs inside.
  const activationLine = `[${new Date().toISOString()}] activation entered; pid=${process.pid} extension=${context.extension.id} extensionPath=${context.extensionPath} app=${vscode.env.appName} remote=${vscode.env.remoteName ?? '(local)'}`;
  output.appendLine(activationLine);
  try {
    const activationLog = await appendRuntimeLog(activationLine);
    output.appendLine(`[${new Date().toISOString()}] activation diagnostic log: ${activationLog}`);
  } catch (error) {
    output.appendLine(`[${new Date().toISOString()}] activation diagnostic log write failed: ${String(error)}`);
  }

  try {
    captureMetadata = captureMetadataForContext(context);
  } catch (error) {
    captureMetadata = fallbackMetadata(context, error);
    log(`host identity probing failed; continuing with conservative metadata: ${String(error)}`);
  }

  log(`extension host PID: ${process.pid}`);
  logHostIdentityDetails();
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
      logHostIdentityDetails();
      output.show(true);
      vscode.window.showInformationMessage('Context Capsule CLI connection is healthy.');
    } catch (error) {
      log(`Diagnostics failed: ${String(error)}`);
      log(`Canonical runtime state: ${runtimeStatePath()}`);
      log(`This host diagnostic log: ${runtimeHostLogPath()}`);
      logHostIdentityDetails();
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
      const editorReport = await restoreVsCodeSnapshot(snapshot);
      const terminalReport = await restoreIntegratedTerminals(snapshot.integratedTerminals);
      const warnings = [...editorReport.warnings, ...terminalReport.warnings];
      const suffix = warnings.length ? ` ${warnings.length} warning(s); see Context Capsule output.` : '';
      warnings.forEach(warning => log(`restore warning: ${warning}`));
      vscode.window.showInformationMessage(
        `Context Capsule restored ${editorReport.opened} VS Code tab(s) and ${terminalReport.opened + terminalReport.revealed} terminal(s); skipped ${editorReport.skipped + terminalReport.skipped}.${suffix}`,
      );
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
    vscode.window.onDidOpenTerminal(() => scheduleSync('terminal opened')),
    vscode.window.onDidCloseTerminal(terminal => {
      forgetTerminal(terminal);
      scheduleSync('terminal closed');
    }),
    vscode.window.onDidChangeActiveTerminal(() => scheduleSync('active terminal changed')),
    vscode.window.onDidChangeTerminalState(() => scheduleSync('terminal state changed')),
    vscode.window.onDidChangeTerminalShellIntegration(() => scheduleSync('terminal shell integration changed')),
    vscode.window.onDidStartTerminalShellExecution(event => {
      trackTerminalExecutionStart(event);
      scheduleSync('terminal shell execution started');
    }),
    vscode.window.onDidEndTerminalShellExecution(event => {
      trackTerminalExecutionEnd(event);
      scheduleSync('terminal shell execution ended');
    }),
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
