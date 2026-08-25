import * as os from 'node:os';
import * as path from 'node:path';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { RuntimeEnvelope, VsCodeSnapshot } from './types';

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_MESSAGE_CHARS = 4096;
let runtimeLogQueue: Promise<void> = Promise.resolve();

export function runtimeStatePath(environment = process.env): string {
  const override = environment.CONTEXT_CAPSULE_VSCODE_STATE_PATH?.trim();
  if (override) {
    return override;
  }

  if (process.platform === 'win32') {
    const base = environment.LOCALAPPDATA;
    if (!base) {
      throw new Error('LOCALAPPDATA is unavailable; set CONTEXT_CAPSULE_VSCODE_STATE_PATH.');
    }
    return path.join(base, 'ContextCapsule', 'runtime', 'vscode.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ContextCapsule', 'runtime', 'vscode.json');
  }
  const base = environment.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'context-capsule', 'vscode.json');
}

export function runtimeHostStatePath(environment = process.env, pid = process.pid): string {
  const canonical = runtimeStatePath(environment);
  return path.join(path.dirname(canonical), `vscode-host-${pid}.json`);
}

export function runtimeHostLogPath(environment = process.env, pid = process.pid): string {
  const canonical = runtimeStatePath(environment);
  const runtimeDirectory = path.dirname(canonical);
  const contextDirectory = path.basename(runtimeDirectory).toLocaleLowerCase('en-US') === 'runtime'
    ? path.dirname(runtimeDirectory)
    : runtimeDirectory;
  return path.join(contextDirectory, 'logs', `vscode-host-${pid}.log`);
}

function sanitizeLogMessage(message: string): string {
  const singleLine = [...message]
    .slice(0, MAX_LOG_MESSAGE_CHARS)
    .map(character => /[\r\n\0]/u.test(character) || (character.charCodeAt(0) < 32 && character !== '\t') ? ' ' : character)
    .join('');
  return [...message].length > MAX_LOG_MESSAGE_CHARS
    ? `${singleLine} …[truncated]`
    : singleLine;
}

export async function appendRuntimeLogTo(
  destination: string,
  message: string,
  maxBytes = DEFAULT_MAX_LOG_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive safe integer');
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const line = `${sanitizeLogMessage(message)}\n`;
  const incomingBytes = Buffer.byteLength(line, 'utf8');
  let currentBytes = 0;
  try {
    currentBytes = (await stat(destination)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (currentBytes > 0 && currentBytes + incomingBytes > maxBytes) {
    const rotated = `${destination}.1`;
    await rm(rotated, { force: true });
    await rename(destination, rotated);
  }

  await appendFile(destination, line, 'utf8');
  return destination;
}

export function appendRuntimeLog(message: string): Promise<string> {
  const task = runtimeLogQueue.then(() => appendRuntimeLogTo(runtimeHostLogPath(), message));
  // Keep future writes moving even if one filesystem operation fails. The
  // caller still receives this task's rejection and can surface diagnostics.
  runtimeLogQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function writeEnvelope(destination: string, envelope: RuntimeEnvelope): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const serialized = JSON.stringify(envelope);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, 'utf8');
  await rename(temporary, destination).catch(async error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error;
    }
    await writeFile(destination, serialized, 'utf8');
  });
}

export async function writeRuntimeState(snapshot: VsCodeSnapshot): Promise<string> {
  const destination = runtimeStatePath();
  const hostDestination = runtimeHostStatePath();
  const envelope: RuntimeEnvelope = { updatedAtUnixMs: Date.now(), snapshot };

  // The canonical file keeps backward compatibility. The per-process sidecar is
  // the durable source when multiple VS Code extension hosts are alive at once
  // (for example a normal window plus an Extension Development Host) and would
  // otherwise race to overwrite vscode.json.
  await writeEnvelope(hostDestination, envelope);
  await writeEnvelope(destination, envelope);
  return destination;
}
