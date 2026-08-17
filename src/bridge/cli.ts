import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { VsCodeSnapshot } from '../adapter/types';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function configuredCliPath(): string {
  return vscode.workspace.getConfiguration('contextCapsule').get<string>('cliPath', 'capsule').trim() || 'capsule';
}

async function runCli(args: string[]): Promise<string> {
  const executable = configuredCliPath();
  const { stdout } = await execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  });
  return stdout;
}

export async function fetchCapsuleSnapshot(name: string): Promise<VsCodeSnapshot> {
  const output = await runCli(['show', name, '--json']);
  const stored = JSON.parse(output) as { snapshot?: { editors?: { vscode?: VsCodeSnapshot | null } } };
  const snapshot = stored.snapshot?.editors?.vscode;
  if (!snapshot) {
    throw new Error(`Capsule '${name}' has no recent VS Code snapshot.`);
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported VS Code snapshot schema ${snapshot.schemaVersion}.`);
  }
  return snapshot;
}

export async function checkCliConnection(): Promise<{ cliPath: string; output: string }> {
  const output = await runCli(['--help']);
  return { cliPath: configuredCliPath(), output: output.trim() || 'Context Capsule CLI responded successfully.' };
}
