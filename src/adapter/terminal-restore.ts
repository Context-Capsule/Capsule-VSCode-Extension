import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SavedTerminalSession } from '../bridge/cli';

export interface IntegratedTerminalRestoreReport {
  saved: number;
  reused: number;
  created: number;
  skipped: number;
  warnings: string[];
}

export interface TerminalDescriptor {
  name: string;
  shellPath?: string;
}

export function terminalMatchesSaved(saved: SavedTerminalSession, current: TerminalDescriptor): boolean {
  const savedTitle = clean(saved.title);
  if (savedTitle && savedTitle.toLocaleLowerCase() === current.name.trim().toLocaleLowerCase()) return true;

  const savedProfile = clean(saved.profile);
  if (savedProfile && savedProfile.toLocaleLowerCase() === current.name.trim().toLocaleLowerCase()) return true;

  const executable = clean(saved.shell_executable) ?? clean(saved.restart?.executable);
  if (!executable) return false;
  const savedStem = executableStem(executable);
  if (!savedStem) return false;
  const currentStem = current.shellPath ? executableStem(current.shellPath) : undefined;
  if (currentStem && savedStem === currentStem) return true;

  const normalizedName = current.name.trim().toLocaleLowerCase();
  return normalizedName === savedStem
    || normalizedName.includes(savedStem)
    || savedStem.includes(normalizedName);
}

export function savedHostForApp(appName: string): string {
  return appName.toLocaleLowerCase().includes('cursor') ? 'cursor' : 'visual-studio-code';
}

export async function restoreIntegratedTerminals(
  sessions: SavedTerminalSession[],
  appName: string,
): Promise<IntegratedTerminalRestoreReport> {
  const expectedHost = savedHostForApp(appName);
  const saved = sessions.filter(session => session.host === expectedHost);
  const report: IntegratedTerminalRestoreReport = {
    saved: saved.length,
    reused: 0,
    created: 0,
    skipped: 0,
    warnings: [],
  };
  if (saved.length === 0) return report;

  const current = vscode.window.terminals.map(terminal => ({
    terminal,
    descriptor: describeTerminal(terminal),
  }));
  const used = new Set<vscode.Terminal>();

  for (const session of saved) {
    const existing = current.find(item => !used.has(item.terminal) && terminalMatchesSaved(session, item.descriptor));
    if (existing) {
      used.add(existing.terminal);
      report.reused += 1;
      continue;
    }

    const options = terminalOptions(session);
    if (!options) {
      report.skipped += 1;
      report.warnings.push(
        `${session.title ?? session.profile ?? session.shell}: no safe shell executable was captured`,
      );
      continue;
    }

    try {
      const terminal = vscode.window.createTerminal(options);
      used.add(terminal);
      report.created += 1;
    } catch (error) {
      report.skipped += 1;
      report.warnings.push(
        `${session.title ?? session.profile ?? session.shell}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return report;
}

function describeTerminal(terminal: vscode.Terminal): TerminalDescriptor {
  const options = terminal.creationOptions;
  let shellPath: string | undefined;
  if ('shellPath' in options && typeof options.shellPath === 'string') shellPath = options.shellPath;
  return shellPath ? { name: terminal.name, shellPath } : { name: terminal.name };
}

function terminalOptions(session: SavedTerminalSession): vscode.TerminalOptions | undefined {
  const executable = clean(session.shell_executable) ?? clean(session.restart?.executable);
  if (!executable) return undefined;

  const options: vscode.TerminalOptions = { shellPath: executable };
  const title = clean(session.title) ?? clean(session.profile);
  if (title) options.name = title;
  const directory = clean(session.working_directory) ?? clean(session.restart?.working_directory ?? undefined);
  if (directory) options.cwd = directory;
  return options;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function executableStem(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLocaleLowerCase();
  const stem = base.endsWith('.exe') ? base.slice(0, -4) : base;
  return stem || undefined;
}
