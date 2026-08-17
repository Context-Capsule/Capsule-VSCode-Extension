import * as vscode from 'vscode';
import type { CaptureMetadata, ExtensionRuntimeMode } from './types';

export interface ExtensionLocation {
  id: string;
  scheme: string;
  fsPath: string;
}

function runtimeMode(mode: vscode.ExtensionMode): ExtensionRuntimeMode {
  switch (mode) {
    case vscode.ExtensionMode.Development:
      return 'development';
    case vscode.ExtensionMode.Test:
      return 'test';
    case vscode.ExtensionMode.Production:
    default:
      return 'production';
  }
}

function normalizedFsPath(value: string, platform: NodeJS.Platform): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathsOverlap(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = normalizedFsPath(left, platform);
  const b = normalizedFsPath(right, platform);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Installed extensions in a normal VS Code window live outside the opened
 * workspace. An extension loaded through --extensionDevelopmentPath normally
 * lives at the workspace root (or in a workspace subdirectory in a monorepo).
 * That gives an installed Context Capsule extension a stable, public-API-only
 * way to identify a Development Host belonging to another extension.
 */
export function selectWorkspaceDevelopmentPath(
  workspacePaths: readonly string[],
  extensions: readonly ExtensionLocation[],
  selfExtensionId: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const candidates = extensions
    .filter(extension => extension.id !== selfExtensionId && extension.scheme === 'file')
    .filter(extension => workspacePaths.some(workspace => pathsOverlap(workspace, extension.fsPath, platform)))
    .map(extension => extension.fsPath);

  if (candidates.length === 0) {
    return undefined;
  }

  // Prefer the candidate closest to a workspace root. This handles monorepos
  // deterministically while avoiding arbitrary extension enumeration order.
  return candidates
    .map(candidate => ({
      candidate,
      distance: Math.min(...workspacePaths.map(workspace =>
        Math.abs(normalizedFsPath(candidate, platform).length - normalizedFsPath(workspace, platform).length))),
    }))
    .sort((left, right) => left.distance - right.distance
      || normalizedFsPath(left.candidate, platform).localeCompare(normalizedFsPath(right.candidate, platform)))[0]
    ?.candidate;
}

export function captureMetadataForContext(
  context: vscode.ExtensionContext,
  platform: NodeJS.Platform = process.platform,
): CaptureMetadata {
  const ownMode = runtimeMode(context.extensionMode);
  if (ownMode === 'development') {
    return {
      extensionMode: 'development',
      extensionPath: context.extensionPath,
      hostDetection: 'self-development',
    };
  }
  if (ownMode === 'test') {
    return { extensionMode: 'test', hostDetection: 'test' };
  }

  const workspacePaths = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath);
  const extensionLocations = vscode.extensions.all.map(extension => ({
    id: extension.id,
    scheme: extension.extensionUri.scheme,
    fsPath: extension.extensionUri.fsPath,
  }));
  const developmentPath = selectWorkspaceDevelopmentPath(
    workspacePaths,
    extensionLocations,
    context.extension.id,
    platform,
  );
  if (developmentPath) {
    return {
      extensionMode: 'development',
      extensionPath: developmentPath,
      hostDetection: 'workspace-development-extension',
    };
  }

  return { extensionMode: 'production', hostDetection: 'production' };
}
