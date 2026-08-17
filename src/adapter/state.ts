import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import type { RuntimeEnvelope, VsCodeSnapshot } from './types';

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
