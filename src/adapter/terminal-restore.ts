import * as vscode from 'vscode';
import type { TerminalRestoreSession } from '../bridge/restore-bus';

export interface TerminalRestoreReport {
  opened: number;
  skipped: number;
  warnings: string[];
}

function terminalName(session: TerminalRestoreSession): string | undefined {
  return session.title?.trim() || session.profile?.trim() || undefined;
}

export async function restoreIntegratedTerminals(
  sessions: TerminalRestoreSession[],
): Promise<TerminalRestoreReport> {
  const report: TerminalRestoreReport = { opened: 0, skipped: 0, warnings: [] };
  if (sessions.length === 0) {
    return report;
  }

  if (!vscode.workspace.isTrusted) {
    report.skipped = sessions.length;
    report.warnings.push('Integrated terminal restore was skipped because the workspace is not trusted.');
    return report;
  }

  // The public VS Code API intentionally does not expose the shell executable/CWD
  // of every already-open terminal. Preserve multiplicity conservatively: reuse the
  // current terminal count first and only create the deficit. This makes repeated
  // capsule restores convergent instead of spawning duplicate shells.
  const alreadyPresent = Math.min(vscode.window.terminals.length, sessions.length);
  report.skipped += alreadyPresent;

  for (const session of sessions.slice(alreadyPresent)) {
    try {
      const options: vscode.TerminalOptions = {};
      const name = terminalName(session);
      if (name) {
        options.name = name;
      }
      if (session.shell_executable?.trim()) {
        options.shellPath = session.shell_executable;
      }
      if (session.working_directory?.trim()) {
        options.cwd = session.working_directory;
      }
      vscode.window.createTerminal(options);
      report.opened += 1;
    } catch (error) {
      report.skipped += 1;
      report.warnings.push(
        `Could not restore integrated terminal '${terminalName(session) ?? session.shell}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return report;
}
