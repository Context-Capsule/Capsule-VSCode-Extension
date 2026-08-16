import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import type { RuntimeEnvelope, VsCodeSnapshot } from './types';

export function runtimeStatePath(environment = process.env): string {
  const override = environment.CONTEXT_CAPSULE_VSCODE_STATE_PATH?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    const base = environment.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is unavailable; set CONTEXT_CAPSULE_VSCODE_STATE_PATH.');
    return path.join(base, 'ContextCapsule', 'runtime', 'vscode.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ContextCapsule', 'runtime', 'vscode.json');
  }
  const base = environment.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'context-capsule', 'vscode.json');
}

export async function writeRuntimeState(snapshot: VsCodeSnapshot): Promise<string> {
  const destination = runtimeStatePath();
  await mkdir(path.dirname(destination), { recursive: true });
  const envelope: RuntimeEnvelope = { updatedAtUnixMs: Date.now(), snapshot };
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope), 'utf8');
  await rename(temporary, destination).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    await writeFile(destination, JSON.stringify(envelope), 'utf8');
  });
  return destination;
}
