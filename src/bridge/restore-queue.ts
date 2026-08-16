import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const RESTORE_BRIDGE_SCHEMA_VERSION = 1;
const POLL_INTERVAL_MS = 250;

export interface RestoreQueueRequest {
  schema_version: number;
  request_id: string;
  adapter: string;
  capsule_name: string;
  created_at_unix_ms: number;
}

export interface RestoreQueueResult {
  ok: boolean;
  summary?: string;
  error?: string;
  deferred?: boolean;
}

export interface RestoreQueueClaim {
  request: RestoreQueueRequest;
  processingPath: string;
}

type Handler = (claim: RestoreQueueClaim) => Promise<RestoreQueueResult>;

export class RestoreQueueWatcher {
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(private readonly handler: Handler) {}

  start(): void {
    if (this.timer) return;
    void this.scan().catch(() => undefined);
    this.timer = setInterval(() => void this.scan().catch(() => undefined), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const requestDir = requestsDirectory();
      let names: string[];
      try {
        names = (await readdir(requestDir))
          .filter(name => name.endsWith('.json'))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }

      for (const name of names) {
        const claim = await claimRequest(path.join(requestDir, name));
        if (!claim) continue;
        await processClaim(claim, this.handler);
        return;
      }
    } finally {
      this.scanning = false;
    }
  }
}

export function restoreRoot(): string {
  const explicit = process.env.CONTEXT_CAPSULE_RESTORE_DIR?.trim();
  if (explicit) return explicit;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error('LOCALAPPDATA is not available');
    return path.join(localAppData, 'ContextCapsule', 'restore');
  }

  const home = process.env.HOME?.trim();
  if (process.platform === 'darwin') {
    if (!home) throw new Error('HOME is not available');
    return path.join(home, 'Library', 'Application Support', 'ContextCapsule', 'restore');
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return path.join(xdgStateHome, 'context-capsule', 'restore');
  if (!home) throw new Error('HOME is not available');
  return path.join(home, '.local', 'state', 'context-capsule', 'restore');
}

export async function completeClaim(
  claim: RestoreQueueClaim,
  result: RestoreQueueResult,
): Promise<void> {
  const response = {
    schema_version: RESTORE_BRIDGE_SCHEMA_VERSION,
    request_id: claim.request.request_id,
    adapter: 'vscode',
    ok: result.ok,
    completed_at_unix_ms: Date.now(),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  const resultDir = path.join(restoreRoot(), 'results');
  await mkdir(resultDir, { recursive: true });
  const destination = path.join(resultDir, `${claim.request.request_id}.json`);
  const temporary = path.join(resultDir, `.${claim.request.request_id}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(response), 'utf8');
  await rename(temporary, destination);
  await rm(claim.processingPath, { force: true });
}

export function isValidRestoreRequest(value: unknown): value is RestoreQueueRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RestoreQueueRequest>;
  return request.schema_version === RESTORE_BRIDGE_SCHEMA_VERSION
    && request.adapter === 'vscode'
    && typeof request.request_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(request.request_id)
    && typeof request.capsule_name === 'string'
    && request.capsule_name.trim().length > 0
    && typeof request.created_at_unix_ms === 'number';
}

async function claimRequest(pendingPath: string): Promise<RestoreQueueClaim | undefined> {
  const processingPath = pendingPath.replace(/\.json$/i, '.processing');
  try {
    await rename(pendingPath, processingPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') return undefined;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(processingPath, 'utf8'));
    if (!isValidRestoreRequest(parsed)) {
      throw new Error(`Invalid Context Capsule restore request '${path.basename(pendingPath)}'`);
    }
    return { request: parsed, processingPath };
  } catch (error) {
    await rm(processingPath, { force: true });
    throw error;
  }
}

async function processClaim(claim: RestoreQueueClaim, handler: Handler): Promise<void> {
  try {
    const result = await handler(claim);
    if (result.deferred) return;
    await completeClaim(claim, result);
  } catch (error) {
    await completeClaim(claim, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requestsDirectory(): string {
  return path.join(restoreRoot(), 'requests', 'vscode');
}
