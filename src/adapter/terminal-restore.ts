import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureIntegratedTerminal } from './capture';
import type { IntegratedTerminalSnapshot } from './types';
import type { SavedServiceRestart, TerminalRestoreSession } from '../bridge/restore-bus';

export interface TerminalRestoreReport {
  opened: number;
  revealed: number;
  skipped: number;
  warnings: string[];
}

export interface TerminalServiceStartReport {
  started: number;
  skipped: number;
  warnings: string[];
}

function legacyTerminalSnapshot(session: TerminalRestoreSession): IntegratedTerminalSnapshot {
  const snapshot: IntegratedTerminalSnapshot = {
    name: session.title?.trim() || session.profile?.trim() || session.shell,
    kind: 'process',
    restorable: true,
  };
  if (session.shell_executable?.trim()) {
    snapshot.shellPath = session.shell_executable;
  }
  if (session.working_directory?.trim()) {
    snapshot.cwd = session.working_directory;
    snapshot.cwdIsUri = false;
  }
  return snapshot;
}

function normalizePathLike(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function shellIdentity(value: string): string {
  return path.basename(normalizePathLike(value)).toLocaleLowerCase('en-US');
}

function terminalMatches(
  saved: IntegratedTerminalSnapshot,
  current: IntegratedTerminalSnapshot,
): boolean {
  if (saved.kind !== 'process' || current.kind !== 'process') {
    return false;
  }

  if (saved.name.trim() && normalizedName(saved.name) !== normalizedName(current.name)) {
    return false;
  }

  if (saved.shellPath) {
    if (!current.shellPath || shellIdentity(saved.shellPath) !== shellIdentity(current.shellPath)) {
      return false;
    }
  }

  if (saved.cwd) {
    if (!current.cwd || normalizePathLike(saved.cwd) !== normalizePathLike(current.cwd)) {
      return false;
    }
  }

  return true;
}

function terminalOptions(saved: IntegratedTerminalSnapshot): vscode.TerminalOptions {
  const options: vscode.TerminalOptions = {};
  if (saved.name.trim()) {
    options.name = saved.name;
  }
  if (saved.shellPath?.trim()) {
    options.shellPath = saved.shellPath;
  }
  if (typeof saved.shellArgs === 'string') {
    options.shellArgs = saved.shellArgs;
  } else if (saved.shellArgs) {
    options.shellArgs = [...saved.shellArgs];
  }
  if (saved.cwd?.trim()) {
    options.cwd = saved.cwdIsUri ? vscode.Uri.parse(saved.cwd, true) : saved.cwd;
  }
  return options;
}

function shouldRevealTerminal(session: IntegratedTerminalSnapshot, sessionCount: number): boolean {
  if (session.active !== undefined) {
    return session.active;
  }

  // Schema v1 capsules created before active-terminal capture cannot tell us
  // which terminal owned the panel. A single saved terminal is unambiguous, so
  // surface it. With multiple legacy terminals we deliberately avoid guessing.
  return sessionCount === 1;
}

export async function restoreIntegratedTerminals(
  semanticSessions: readonly IntegratedTerminalSnapshot[] | undefined,
  legacySessions: readonly TerminalRestoreSession[] = [],
): Promise<TerminalRestoreReport> {
  const report: TerminalRestoreReport = { opened: 0, revealed: 0, skipped: 0, warnings: [] };
  const sessions = semanticSessions ?? legacySessions.map(legacyTerminalSnapshot);
  if (sessions.length === 0) {
    return report;
  }

  if (!vscode.workspace.isTrusted) {
    report.skipped = sessions.length;
    report.warnings.push('Integrated terminal restore was skipped because the workspace is not trusted.');
    return report;
  }

  const currentTerminals = [...vscode.window.terminals];
  const currentSnapshots = currentTerminals.map(captureIntegratedTerminal);
  const usedCurrent = new Set<number>();
  let revealTarget: vscode.Terminal | undefined;
  let revealTargetWasOpened = false;

  for (const session of sessions) {
    if (!session.restorable || session.kind !== 'process') {
      report.skipped += 1;
      report.warnings.push(
        `Skipped integrated terminal '${session.name}' because extension-owned pseudoterminals cannot be reconstructed safely through the public VS Code API.`,
      );
      continue;
    }

    const existingIndex = currentSnapshots.findIndex((candidate, index) =>
      !usedCurrent.has(index) && terminalMatches(session, candidate));
    if (existingIndex >= 0) {
      usedCurrent.add(existingIndex);
      const existingTerminal = currentTerminals[existingIndex];
      if (existingTerminal && !revealTarget && shouldRevealTerminal(session, sessions.length)) {
        revealTarget = existingTerminal;
      } else {
        report.skipped += 1;
      }
      continue;
    }

    try {
      const createdTerminal = vscode.window.createTerminal(terminalOptions(session));
      report.opened += 1;
      currentTerminals.push(createdTerminal);
      currentSnapshots.push(session);
      usedCurrent.add(currentSnapshots.length - 1);
      if (!revealTarget && shouldRevealTerminal(session, sessions.length)) {
        revealTarget = createdTerminal;
        revealTargetWasOpened = true;
      }
    } catch (error) {
      report.skipped += 1;
      report.warnings.push(
        `Could not restore integrated terminal '${session.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (revealTarget) {
    try {
      // Showing with preserveFocus=true opens the terminal panel without stealing
      // focus back from the editor tab that semantic restore just activated.
      revealTarget.show(true);
      if (!revealTargetWasOpened) {
        report.revealed += 1;
      }
    } catch (error) {
      if (!revealTargetWasOpened) {
        report.skipped += 1;
      }
      report.warnings.push(
        `Could not show restored integrated terminal '${revealTarget.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return report;
}

export async function startSavedTerminalServices(
  semanticSessions: readonly IntegratedTerminalSnapshot[] | undefined,
  services: readonly SavedServiceRestart[],
): Promise<TerminalServiceStartReport> {
  const report: TerminalServiceStartReport = { started: 0, skipped: 0, warnings: [] };
  if (services.length === 0) {
    return report;
  }
  if (!vscode.workspace.isTrusted) {
    report.skipped = services.length;
    report.warnings.push('Saved terminal services were not started because the workspace is not trusted.');
    return report;
  }
  if (!semanticSessions) {
    report.skipped = services.length;
    report.warnings.push('Saved terminal services require semantic VS Code terminal state.');
    return report;
  }

  const currentTerminals = [...vscode.window.terminals];
  const currentSnapshots = currentTerminals.map(captureIntegratedTerminal);

  for (const service of services) {
    const terminalIndex = service.vscode_terminal_index;
    if (terminalIndex === undefined || terminalIndex === null || terminalIndex < 0) {
      report.skipped += 1;
      report.warnings.push(`Service #${service.service_index} has no saved VS Code terminal index.`);
      continue;
    }
    const saved = semanticSessions[terminalIndex];
    if (!saved || saved.kind !== 'process' || !saved.restorable) {
      report.skipped += 1;
      report.warnings.push(`Service #${service.service_index} does not target a restorable VS Code process terminal.`);
      continue;
    }
    let currentIndex = currentSnapshots.findIndex(candidate => terminalMatches(saved, candidate));
    if (currentIndex < 0) {
      try {
        const created = vscode.window.createTerminal(terminalOptions(saved));
        currentTerminals.push(created);
        currentSnapshots.push(saved);
        currentIndex = currentTerminals.length - 1;
      } catch (error) {
        report.skipped += 1;
        report.warnings.push(
          `Could not recreate terminal for service #${service.service_index}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    const terminal = currentTerminals[currentIndex];
    if (!terminal) {
      report.skipped += 1;
      report.warnings.push(`Could not resolve terminal for service #${service.service_index}.`);
      continue;
    }

    const serviceCommand = validateRestartCommand(service.command);
    if (!serviceCommand.ok) {
      report.skipped += 1;
      report.warnings.push(`Service #${service.service_index} was rejected: ${serviceCommand.error}`);
      continue;
    }
    const preStart = service.pre_start_command ? validateRestartCommand(service.pre_start_command) : undefined;
    if (preStart && !preStart.ok) {
      report.skipped += 1;
      report.warnings.push(`Service #${service.service_index} pre-start was rejected: ${preStart.error}`);
      continue;
    }

    try {
      const integration = await waitForShellIntegration(terminal, 4_000);
      if (preStart?.ok) {
        if (!integration) {
          report.skipped += 1;
          report.warnings.push(
            `Service #${service.service_index} has a pre-start command, but shell integration is unavailable; it was not started with a guessed environment.`,
          );
          continue;
        }
        const completed = await executeAndWait(terminal, integration, preStart.value, 15_000);
        if (!completed) {
          report.skipped += 1;
          report.warnings.push(`Service #${service.service_index} pre-start command did not finish successfully in time.`);
          continue;
        }
      }

      if (integration) {
        integration.executeCommand(serviceCommand.value);
      } else {
        terminal.sendText(serviceCommand.value, true);
      }
      report.started += 1;
    } catch (error) {
      report.skipped += 1;
      report.warnings.push(
        `Could not start service #${service.service_index} in '${terminal.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return report;
}

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = (integration: vscode.TerminalShellIntegration | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      listener.dispose();
      resolve(integration);
    };
    const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal && event.shellIntegration) {
        finish(event.shellIntegration);
      }
    });
    const timer = setTimeout(() => finish(terminal.shellIntegration), timeoutMs);
  });
}

async function executeAndWait(
  terminal: vscode.Terminal,
  integration: vscode.TerminalShellIntegration,
  command: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    let execution: vscode.TerminalShellExecution | undefined;
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      listener.dispose();
      resolve(value);
    };
    const listener = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.terminal === terminal && (!execution || event.execution === execution)) {
        finish(event.exitCode === undefined || event.exitCode === 0);
      }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    execution = integration.executeCommand(command);
  });
}

function validateRestartCommand(command: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = command.trim();
  if (!value) {
    return { ok: false, error: 'command is empty' };
  }
  if (value.length > 8192) {
    return { ok: false, error: 'command exceeds 8192 characters' };
  }
  if ([...value].some(character => /[\u0000-\u001f\u007f]/u.test(character))) {
    return { ok: false, error: 'command contains terminal control characters' };
  }
  const lower = value.toLocaleLowerCase('en-US');
  const sensitiveMarkers = [
    '--password', '--passwd', '--token', '--secret', '--api-key', '--apikey',
    'authorization:', 'bearer ', 'access_token', 'refresh_token', 'client_secret',
    'private_key', 'secret_key',
  ];
  if (sensitiveMarkers.some(marker => lower.includes(marker)) || containsCredentialUrl(lower)) {
    return { ok: false, error: 'command looks secret-bearing' };
  }
  return { ok: true, value };
}

function containsCredentialUrl(command: string): boolean {
  const schemeIndex = command.indexOf('://');
  if (schemeIndex < 0) {
    return false;
  }
  const authority = command.slice(schemeIndex + 3).split(/[\/\s]/u, 1)[0] ?? '';
  const atIndex = authority.indexOf('@');
  return atIndex >= 0 && authority.slice(0, atIndex).includes(':');
}
