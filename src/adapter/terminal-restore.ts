import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureIntegratedTerminal } from './capture';
import type { IntegratedTerminalSnapshot } from './types';
import type { TerminalRestoreSession } from '../bridge/restore-bus';

export interface TerminalRestoreReport {
  opened: number;
  revealed: number;
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
