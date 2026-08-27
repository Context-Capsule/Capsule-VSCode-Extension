import * as vscode from 'vscode';

export interface InterruptedTerminalService {
  terminal_index: number;
  terminal_name?: string;
  shell_path?: string;
  cwd?: string;
  command: string;
}

export interface TerminalInterruptReport {
  ok: boolean;
  interrupted: number;
  skipped: number;
  services: InterruptedTerminalService[];
  warnings: string[];
  error?: string;
}

type StartEvent = {
  terminal: vscode.Terminal;
  execution: vscode.TerminalShellExecution;
};

type EndEvent = {
  terminal: vscode.Terminal;
  execution: vscode.TerminalShellExecution;
};

const activeExecutions = new Map<vscode.Terminal, vscode.TerminalShellExecution>();

export function trackTerminalExecutionStart(event: StartEvent): void {
  activeExecutions.set(event.terminal, event.execution);
}

export function trackTerminalExecutionEnd(event: EndEvent): void {
  if (activeExecutions.get(event.terminal) === event.execution) {
    activeExecutions.delete(event.terminal);
  }
}

export function forgetTerminal(terminal: vscode.Terminal): void {
  activeExecutions.delete(terminal);
}

export async function interruptRunningTerminalServices(
  callerShellPid: number | null | undefined,
  expectedRunningServices: number | null | undefined,
): Promise<TerminalInterruptReport> {
  if (!vscode.workspace.isTrusted) {
    return {
      ok: false,
      interrupted: 0,
      skipped: activeExecutions.size,
      services: [],
      warnings: [],
      error: 'VS Code workspace is not trusted; running commands were left untouched.',
    };
  }

  const terminals = [...vscode.window.terminals];
  const candidates: Array<{
    terminal: vscode.Terminal;
    execution: vscode.TerminalShellExecution;
    service: InterruptedTerminalService;
  }> = [];
  const warnings: string[] = [];

  for (const [terminal, execution] of activeExecutions) {
    const shellPid = await terminal.processId;
    if (callerShellPid && shellPid === callerShellPid) {
      continue;
    }
    const commandLine = execution.commandLine;
    if (!commandLine.isTrusted) {
      return {
        ok: false,
        interrupted: 0,
        skipped: 1,
        services: [],
        warnings,
        error: `Running command in '${terminal.name}' is not trusted by VS Code shell integration; it was left running.`,
      };
    }
    const command = validateRestartCommand(commandLine.value);
    if (!command.ok) {
      return {
        ok: false,
        interrupted: 0,
        skipped: 1,
        services: [],
        warnings,
        error: `Running command in '${terminal.name}' cannot be persisted safely: ${command.error}; it was left running.`,
      };
    }
    const terminalIndex = terminals.indexOf(terminal);
    if (terminalIndex < 0) {
      return {
        ok: false,
        interrupted: 0,
        skipped: 1,
        services: [],
        warnings,
        error: `Running terminal '${terminal.name}' disappeared before it could be interrupted safely.`,
      };
    }

    const creationOptions = terminal.creationOptions;
    const shellPath = 'pty' in creationOptions ? undefined : creationOptions.shellPath;
    const cwd = execution.cwd?.toString(true)
      ?? terminal.shellIntegration?.cwd?.toString(true)
      ?? (!('pty' in creationOptions) && typeof creationOptions.cwd === 'string'
        ? creationOptions.cwd
        : !('pty' in creationOptions) && creationOptions.cwd
          ? creationOptions.cwd.toString(true)
          : undefined);
    candidates.push({
      terminal,
      execution,
      service: {
        terminal_index: terminalIndex,
        terminal_name: terminal.name,
        shell_path: shellPath,
        cwd,
        command: command.value,
      },
    });
  }

  if (
    typeof expectedRunningServices === 'number'
    && expectedRunningServices >= 0
    && candidates.length !== expectedRunningServices
  ) {
    return {
      ok: false,
      interrupted: 0,
      skipped: candidates.length,
      services: [],
      warnings,
      error: `VS Code shell integration can account for ${candidates.length} safely replayable running command(s), but CLI process discovery observed ${expectedRunningServices}; no VS Code command was interrupted.`,
    };
  }

  for (const candidate of candidates) {
    candidate.terminal.sendText('\x03', false);
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = candidates.filter(candidate => activeExecutions.get(candidate.terminal) === candidate.execution);
    if (remaining.length === 0) {
      return {
        ok: true,
        interrupted: candidates.length,
        skipped: 0,
        services: candidates.map(candidate => candidate.service),
        warnings,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const remaining = candidates.filter(candidate => activeExecutions.get(candidate.terminal) === candidate.execution);
  return {
    ok: false,
    interrupted: candidates.length - remaining.length,
    skipped: remaining.length,
    services: candidates
      .filter(candidate => !remaining.includes(candidate))
      .map(candidate => candidate.service),
    warnings,
    error: `${remaining.length} VS Code terminal command(s) did not return to an idle shell after Ctrl+C.`,
  };
}

export function validateRestartCommand(
  command: string,
): { ok: true; value: string } | { ok: false; error: string } {
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
