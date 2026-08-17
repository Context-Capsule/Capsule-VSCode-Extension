import type { ExtensionRuntimeMode, VsCodeSnapshot } from '../adapter/types';

export interface ExtensionHostIdentity {
  extensionMode?: ExtensionRuntimeMode;
  extensionPath?: string;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const normalized = value.trim().replaceAll('/', '\\').replace(/\\+$/, '');
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function snapshotTargetsHost(
  saved: VsCodeSnapshot | null | undefined,
  current: ExtensionHostIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!saved) {
    return true;
  }

  if (saved.extensionMode && current.extensionMode && saved.extensionMode !== current.extensionMode) {
    return false;
  }
  if (saved.extensionPath) {
    if (!current.extensionPath) {
      return false;
    }
    if (normalizedPath(saved.extensionPath, platform) !== normalizedPath(current.extensionPath, platform)) {
      return false;
    }
  }
  return true;
}
