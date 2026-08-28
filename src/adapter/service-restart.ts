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

export interface TerminalCoverage {
  matched: number[];
  missing: number[];
  ignored: number[];
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

export function reconcileObservedRunningShellPids(
  observedRunningShellPids: readonly number[] | null | undefined,
  terminalProcessIds: readonly number[],
  trackedProcessIds: readonly number[],
  callerShellPid?: number | null,
): TerminalCoverage {
  const normalize = (values: readonly number[]): number[] => [...new Set(values
    .filter(value => Number.isSafeInteger(value) && value > 0)
    .map(value => Math.trunc(value)))]
    .sort((left, right) => left - right);

  const observed = normalize(observedRunningShellPids ?? [])
    .filter(pid => !callerShellPid || pid !== callerShellPid);
  const actualTerminals = new Set(normalize(terminalProcessIds));
  const tracked = new Set(normalize(trackedProcessIds));
  const matched: number[] = [];
  const missing: number[] = [];
  const ignored: number[] = [];

  for (const pid of observed) {
    if (!actualTerminals.has(pid)) {
      ignored.push(pid);
    } else if (tracked.has(pid)) {
      matched.push(pid);
    } else {
      missing.push(pid);
    }
  }

  return { matched, missing, ignored };
}

async function terminalProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
  // processId can briefly be undefined while a newly created terminal is still
  // starting. Give VS Code up to roughly one second to publish the stable shell
  // PID so the safety cross-check compares identities instead of process counts.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pid = await terminal.processId;
    if (typeof pid === 'number' && pid > 0) {
      return pid;
    }
    if (attempt < 19) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return undefined;
}

export async function interruptRunningTerminalServices(
  callerShellPid: number | null | undefined,
  observedRunningShellPids: readonly number[] | null | undefined,
  legacyExpectedRunningServices?: number | null,
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
  const processIds = new Map<vscode.Terminal, number>();
  const unresolvedTerminalNames: string[] = [];
  for (const terminal of terminals) {
    const pid = await terminalProcessId(terminal);
    if (pid) {
      processIds.set(terminal, pid);
    } else {
      unresolvedTerminalNames.push(terminal.name);
    }
  }

  const candidates: Array<{
    terminal: vscode.Terminal;
    execution: vscode.TerminalShellExecution;
    shellPid?: number;
    service: InterruptedTerminalService;
  }> = [];
  const warnings: string[] = [];

  for (const [terminal, execution] of activeExecutions) {
    const shellPid = processIds.get(terminal) ?? await terminalProcessId(terminal);
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
      shellPid,
      service: {
        terminal_index: terminalIndex,
        terminal_name: terminal.name,
        shell_path: shellPath,
        cwd,
        command: command.value,
      },
    });
  }

  if (observedRunningShellPids && observedRunningShellPids.length > 0) {
    if (unresolvedTerminalNames.length > 0) {
      return {
        ok: false,
        interrupted: 0,
        skipped: candidates.length,
        services: [],
        warnings,
        error: `VS Code did not publish a stable processId for integrated terminal(s) ${unresolvedTerminalNames.map(name => `'${name}'`).join(', ')}; no command was interrupted because terminal identity coverage is incomplete.`,
      };
    }

    const coverage = reconcileObservedRunningShellPids(
      observedRunningShellPids,
      [...processIds.values()],
      candidates.flatMap(candidate => candidate.shellPid ? [candidate.shellPid] : []),
      callerShellPid,
    );
    if (coverage.ignored.length > 0) {
      warnings.push(
        `Ignored ${coverage.ignored.length} VS Code-descendant helper/nested shell process observation(s) because their PID does not belong to an actual integrated terminal.`,
      );
    }
    if (coverage.missing.length > 0) {
      return {
        ok: false,
        interrupted: 0,
        skipped: candidates.length,
        services: [],
        warnings,
        error: `CLI process discovery reports a running command in integrated terminal PID(s) ${coverage.missing.join(', ')}, but VS Code shell integration cannot identify a trusted replayable command for them; no VS Code command was interrupted.`,
      };
    }
  } else if (
    typeof legacyExpectedRunningServices === 'number'
    && legacyExpectedRunningServices > 0
  ) {
    // Backward compatibility for older CLI builds that supplied only a count.
    // A count cannot distinguish real integrated terminals from nested/helper
    // shells under Code.exe, so only fail when shell integration sees none at
    // all. Otherwise capture every trusted active execution and keep the count
    // mismatch as a diagnostic warning.
    if (candidates.length === 0) {
      return {
        ok: false,
        interrupted: 0,
        skipped: 0,
        services: [],
        warnings,
        error: `CLI process discovery observed ${legacyExpectedRunningServices} VS Code-descendant running process(es), but VS Code shell integration cannot identify any trusted replayable command; no VS Code command was interrupted.`,
      };
    }
    if (candidates.length !== legacyExpectedRunningServices) {
      warnings.push(
        `CLI process discovery observed ${legacyExpectedRunningServices} VS Code-descendant running process(es), while shell integration identified ${candidates.length} actual running command(s); using shell integration as the authoritative source.`,
      );
    }
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
