import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from './adapter/capture';
import { restoreVsCodeSnapshot } from './adapter/restore';
import { runtimeStatePath, writeRuntimeState } from './adapter/state';
import { restoreIntegratedTerminals } from './adapter/terminal-restore';
import {
  applyWorkspaceRestorePlan,
  currentWorkspaceState,
  planWorkspaceRestore,
} from './adapter/workspace-restore';
import {
  checkCliConnection,
  fetchCapsuleRestoreContext,
  fetchCapsuleSnapshot,
  type CapsuleRestoreContext,
} from './bridge/cli';
import {
  completeClaim,
  RestoreQueueWatcher,
  type RestoreQueueClaim,
  type RestoreQueueResult,
} from './bridge/restore-queue';

const SYNC_DEBOUNCE_MS = 350;
const HEARTBEAT_MS = 30_000;
const CONTINUATION_KEY = 'contextCapsule.restoreContinuation.v1';
let syncTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let restoreWatcher: RestoreQueueWatcher | undefined;
let resumingRestore = false;
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

async function runSemanticRestore(context: CapsuleRestoreContext): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('VS Code restore is disabled while the target workspace is untrusted');
  }

  const editorReport = await restoreVsCodeSnapshot(context.vscode);
  const terminalReport = await restoreIntegratedTerminals(context.terminalSessions, context.vscode.appName);

  for (const warning of [...editorReport.warnings, ...terminalReport.warnings]) {
    output.appendLine(`restore warning: ${warning}`);
  }

  return [
    `VS Code: ${editorReport.reused} tab(s) reused`,
    `${editorReport.opened} opened`,
    `${editorReport.updated} updated`,
    `${terminalReport.reused} terminal(s) reused`,
    `${terminalReport.created} terminal(s) created`,
  ].join(', ');
}

async function handleOrchestratedClaim(
  extensionContext: vscode.ExtensionContext,
  claim: RestoreQueueClaim,
): Promise<RestoreQueueResult> {
  if (!vscode.workspace.isTrusted) {
    return { ok: false, error: 'VS Code restore is disabled while the current workspace is untrusted' };
  }

  const capsule = await fetchCapsuleRestoreContext(claim.request.capsule_name);
  const workspacePlan = planWorkspaceRestore(capsule.vscode, currentWorkspaceState());
  if (workspacePlan.kind !== 'ready') {
    if (workspacePlan.kind === 'unsupported') {
      return { ok: false, error: workspacePlan.reason };
    }

    await extensionContext.globalState.update(CONTINUATION_KEY, claim);
    output.appendLine(
      `[${new Date().toISOString()}] restore ${claim.request.request_id}: switching VS Code workspace before restoring editors`,
    );
    await applyWorkspaceRestorePlan(workspacePlan);
    setTimeout(() => void resumeOrchestratedRestore(extensionContext), 750);
    return { ok: true, deferred: true };
  }

  const summary = await runSemanticRestore(capsule);
  scheduleSync('orchestrated restore');
  return { ok: true, summary };
}

async function resumeOrchestratedRestore(extensionContext: vscode.ExtensionContext): Promise<void> {
  if (resumingRestore) return;
  const claim = extensionContext.globalState.get<RestoreQueueClaim>(CONTINUATION_KEY);
  if (!claim) return;

  resumingRestore = true;
  try {
    if (!vscode.workspace.isTrusted) {
      await completeClaim(claim, {
        ok: false,
        error: 'The restored VS Code workspace is untrusted; semantic restore stopped before opening editors or terminals',
      });
      await extensionContext.globalState.update(CONTINUATION_KEY, undefined);
      return;
    }

    const capsule = await fetchCapsuleRestoreContext(claim.request.capsule_name);
    const workspacePlan = planWorkspaceRestore(capsule.vscode, currentWorkspaceState());
    if (workspacePlan.kind !== 'ready') {
      if (workspacePlan.kind === 'unsupported') {
        await completeClaim(claim, { ok: false, error: workspacePlan.reason });
        await extensionContext.globalState.update(CONTINUATION_KEY, undefined);
        return;
      }
      await applyWorkspaceRestorePlan(workspacePlan);
      setTimeout(() => void resumeOrchestratedRestore(extensionContext), 750);
      return;
    }

    const summary = await runSemanticRestore(capsule);
    await completeClaim(claim, { ok: true, summary });
    await extensionContext.globalState.update(CONTINUATION_KEY, undefined);
    scheduleSync('continued orchestrated restore');
  } catch (error) {
    try {
      await completeClaim(claim, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await extensionContext.globalState.update(CONTINUATION_KEY, undefined);
    }
  } finally {
    resumingRestore = false;
  }
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
      const plan = planWorkspaceRestore(snapshot, currentWorkspaceState());
      if (plan.kind !== 'ready') {
        vscode.window.showInformationMessage(
          `The saved workspace differs from this window. Run "capsule restore ${name.trim()}" to restore the whole capsule and continue automatically across the workspace reload.`,
        );
        return;
      }
      const capsule = await fetchCapsuleRestoreContext(name.trim());
      const summary = await runSemanticRestore(capsule);
      vscode.window.showInformationMessage(`Context Capsule restore complete. ${summary}`);
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

  restoreWatcher = new RestoreQueueWatcher(claim => handleOrchestratedClaim(context, claim));
  restoreWatcher.start();
  context.subscriptions.push({ dispose: () => restoreWatcher?.dispose() });

  void resumeOrchestratedRestore(context);
  void syncNow('activation').catch(error => output.appendLine(`initial sync failed: ${String(error)}`));
}

export function deactivate(): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  restoreWatcher?.dispose();
  restoreWatcher = undefined;
}
