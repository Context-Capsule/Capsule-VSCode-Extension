import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { VsCodeSnapshot } from '../adapter/types';

const MAX_REQUEST_AGE_MS = 60_000;
const REQUEST_POLL_INTERVAL_MS = 100;

export interface TerminalRestoreSession {
  host: string;
  shell: string;
  shell_executable?: string | null;
  title?: string | null;
  working_directory?: string | null;
  profile?: string | null;
}

export interface SavedServiceRestart {
  service_index: number;
  source: 'external-terminal' | 'visual-studio-code';
  host: string;
  shell: string;
  captured_terminal_pid?: number | null;
  vscode_terminal_index?: number | null;
  terminal_name?: string | null;
  profile?: string | null;
  working_directory?: string | null;
  command: string;
  pre_start_command?: string | null;
  restart_policy: 'ask' | 'always';
}

export interface TerminalControlRequest {
  action: 'interrupt-running-services';
  caller_shell_pid?: number | null;
  observed_running_shell_pids?: number[];
  // Accepted for compatibility with CLI builds from before PID-based matching.
  expected_running_services?: number | null;
}

export interface RestoreRequest {
  schema_version: 1;
  request_id: string;
  adapter: 'vscode';
  created_at_unix_ms: number;
  payload: {
    editor?: VsCodeSnapshot | null;
    terminals?: TerminalRestoreSession[];
    terminal_control?: TerminalControlRequest;
    terminal_service_start?: {
      services: SavedServiceRestart[];
    };
  };
}

export interface RestoreCompletion {
  schema_version: 1;
  request_id: string;
  adapter: 'vscode';
  completed_at_unix_ms: number;
  ok: boolean;
  changed: number;
  skipped: number;
  warnings: string[];
  error?: string;
  data?: unknown;
}

export function restoreRuntimeDir(): string {
  const override = process.env.CONTEXT_CAPSULE_RESTORE_RUNTIME_DIR?.trim();
  if (override) {
    return override;
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    if (!base) {
      throw new Error('LOCALAPPDATA is unavailable');
    }
    return path.join(base, 'ContextCapsule', 'runtime', 'restore');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ContextCapsule', 'runtime', 'restore');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'context-capsule', 'restore');
}

function requestPath(): string {
  return path.join(restoreRuntimeDir(), 'vscode-request.json');
}

function resultPath(): string {
  return path.join(restoreRuntimeDir(), 'vscode-result.json');
}

async function readRequest(): Promise<RestoreRequest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(requestPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const request = JSON.parse(raw) as Partial<RestoreRequest>;
  if (
    request.schema_version !== 1
    || request.adapter !== 'vscode'
    || typeof request.request_id !== 'string'
    || typeof request.created_at_unix_ms !== 'number'
  ) {
    throw new Error('Invalid Context Capsule VS Code restore request envelope');
  }
  if (Date.now() - request.created_at_unix_ms > MAX_REQUEST_AGE_MS) {
    await fs.rm(requestPath(), { force: true });
    return undefined;
  }
  return request as RestoreRequest;
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
}

export async function completeRestore(
  request: RestoreRequest,
  result: {
    ok: boolean;
    changed: number;
    skipped: number;
    warnings: string[];
    error?: string;
    data?: unknown;
  },
): Promise<void> {
  const completion: RestoreCompletion = {
    schema_version: 1,
    request_id: request.request_id,
    adapter: 'vscode',
    completed_at_unix_ms: Date.now(),
    ok: result.ok,
    changed: result.changed,
    skipped: result.skipped,
    warnings: result.warnings,
  };
  if (result.error) {
    completion.error = result.error;
  }
  if (result.data !== undefined) {
    completion.data = result.data;
  }
  await atomicWrite(resultPath(), completion);

  const current = await readRequest().catch(() => undefined);
  if (current?.request_id === request.request_id) {
    await fs.rm(requestPath(), { force: true });
  }
}

export async function watchRestoreRequests(
  handler: (request: RestoreRequest) => Promise<void>,
): Promise<{ dispose(): void }> {
  const directory = restoreRuntimeDir();
  await fs.mkdir(directory, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  let handling = false;
  let disposed = false;
  let lastRequestId: string | undefined;

  const inspect = async (): Promise<void> => {
    if (disposed || handling) {
      return;
    }
    handling = true;
    try {
      const request = await readRequest();
      if (request && request.request_id !== lastRequestId) {
        lastRequestId = request.request_id;
        await handler(request);
      }
    } finally {
      handling = false;
    }
  };

  await inspect();
  timer = setInterval(() => {
    void inspect().catch(() => undefined);
  }, REQUEST_POLL_INTERVAL_MS);

  return {
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
      }
      timer = undefined;
    },
  };
}
