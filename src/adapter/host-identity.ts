import * as os from 'node:os';
import * as vscode from 'vscode';
import type { CaptureMetadata, ExtensionRuntimeMode, HostDetection } from './types';

export interface ExtensionLocation {
  id: string;
  scheme: string;
  fsPath: string;
  hasInstallMetadata?: boolean;
}

interface DevelopmentPathSelection {
  path: string;
  detection: HostDetection;
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

function pathInside(value: string, root: string, platform: NodeJS.Platform): boolean {
  const candidate = normalizedFsPath(value, platform);
  const normalizedRoot = normalizedFsPath(root, platform);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function standardExtensionRoots(appRoot: string, home: string): string[] {
  return [
    `${appRoot}/extensions`,
    `${home}/.vscode/extensions`,
    `${home}/.vscode-insiders/extensions`,
    `${home}/.vscode-oss/extensions`,
  ];
}

/**
 * Highest-confidence public-API signal: a file-backed extension is loaded from
 * the current workspace rather than an installed extension directory.
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

/**
 * ExtensionContext.extensionMode describes Context Capsule itself. When Context
 * Capsule is installed normally inside another extension's Development Host it
 * remains Production, so that value alone cannot identify the window. As a
 * second public-API-only signal, look for exactly one file extension that is
 * neither a built-in/installed extension nor stamped with VS Code installation
 * metadata. A development extension launched with --extensionDevelopmentPath
 * normally has that shape even when its path is outside the opened workspace.
 */
export function selectLikelyDevelopmentPath(
  workspacePaths: readonly string[],
  extensions: readonly ExtensionLocation[],
  selfExtensionId: string,
  appRoot: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): DevelopmentPathSelection | undefined {
  const workspacePath = selectWorkspaceDevelopmentPath(
    workspacePaths,
    extensions,
    selfExtensionId,
    platform,
  );
  if (workspacePath) {
    return { path: workspacePath, detection: 'workspace-development-extension' };
  }

  const roots = standardExtensionRoots(appRoot, home);
  const unmanaged = extensions.filter(extension =>
    extension.id !== selfExtensionId
    && extension.scheme === 'file'
    && !extension.hasInstallMetadata
    && !roots.some(root => pathInside(extension.fsPath, root, platform)));

  if (unmanaged.length !== 1) {
    return undefined;
  }
  return { path: unmanaged[0]!.fsPath, detection: 'unmanaged-development-extension' };
}

function diagnosticLines(
  ownMode: ExtensionRuntimeMode,
  workspacePaths: readonly string[],
  extensions: readonly ExtensionLocation[],
  selfExtensionId: string,
  appRoot: string,
  selected: DevelopmentPathSelection | undefined,
): string[] {
  const candidates = extensions
    .filter(extension => extension.id !== selfExtensionId && extension.scheme === 'file')
    .map(extension => `${extension.id}=${extension.fsPath}${extension.hasInstallMetadata ? ' [installed]' : ' [unmanaged]'}`)
    .sort();
  return [
    `self extension mode=${ownMode}`,
    `app root=${appRoot}`,
    `workspace roots=${workspacePaths.length > 0 ? workspacePaths.join(' | ') : '(none)'}`,
    `development selection=${selected ? `${selected.detection}:${selected.path}` : '(none)'}`,
    `file extension locations=${candidates.length > 0 ? candidates.join(' | ') : '(none)'}`,
  ];
}

export function captureMetadataForContext(
  context: vscode.ExtensionContext,
  platform: NodeJS.Platform = process.platform,
): CaptureMetadata {
  const ownMode = runtimeMode(context.extensionMode);
  const workspacePaths = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath);
  const extensionLocations = vscode.extensions.all.map(extension => ({
    id: extension.id,
    scheme: extension.extensionUri.scheme,
    fsPath: extension.extensionUri.fsPath,
    hasInstallMetadata: Boolean((extension.packageJSON as { __metadata?: unknown }).__metadata),
  }));

  if (ownMode === 'development') {
    return {
      extensionMode: 'development',
      extensionPath: context.extensionPath,
      hostDetection: 'self-development',
      hostDiagnostics: diagnosticLines(ownMode, workspacePaths, extensionLocations, context.extension.id, vscode.env.appRoot, {
        path: context.extensionPath,
        detection: 'self-development',
      }),
    };
  }
  if (ownMode === 'test') {
    return {
      extensionMode: 'test',
      hostDetection: 'test',
      hostDiagnostics: diagnosticLines(ownMode, workspacePaths, extensionLocations, context.extension.id, vscode.env.appRoot, undefined),
    };
  }

  const selected = selectLikelyDevelopmentPath(
    workspacePaths,
    extensionLocations,
    context.extension.id,
    vscode.env.appRoot,
    os.homedir(),
    platform,
  );
  if (selected) {
    return {
      extensionMode: 'development',
      extensionPath: selected.path,
      hostDetection: selected.detection,
      hostDiagnostics: diagnosticLines(ownMode, workspacePaths, extensionLocations, context.extension.id, vscode.env.appRoot, selected),
    };
  }

  return {
    extensionMode: 'production',
    hostDetection: 'production',
    hostDiagnostics: diagnosticLines(ownMode, workspacePaths, extensionLocations, context.extension.id, vscode.env.appRoot, undefined),
  };
}
