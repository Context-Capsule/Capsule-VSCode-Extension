import * as vscode from 'vscode';
import type { VsCodeSnapshot, WorkspaceFolderSnapshot } from './types';

export type WorkspaceRestorePlan =
  | { kind: 'ready' }
  | { kind: 'open'; uri: string }
  | { kind: 'replace-folders'; folders: WorkspaceFolderSnapshot[] }
  | { kind: 'unsupported'; reason: string };

export interface WorkspaceState {
  workspaceFile?: string;
  folders: string[];
}

export function currentWorkspaceState(): WorkspaceState {
  const workspaceFile = vscode.workspace.workspaceFile?.toString(true);
  return {
    ...(workspaceFile ? { workspaceFile } : {}),
    folders: (vscode.workspace.workspaceFolders ?? [])
      .slice()
      .sort((left, right) => left.index - right.index)
      .map(folder => folder.uri.toString(true)),
  };
}

export function planWorkspaceRestore(snapshot: VsCodeSnapshot, current: WorkspaceState): WorkspaceRestorePlan {
  const savedWorkspace = durableWorkspaceUri(snapshot.workspaceFile);
  if (savedWorkspace) {
    if (sameUri(savedWorkspace, current.workspaceFile)) return { kind: 'ready' };
    return { kind: 'open', uri: savedWorkspace };
  }

  const savedFolders = [...snapshot.workspaceFolders].sort((left, right) => left.index - right.index);
  const savedUris = savedFolders.map(folder => folder.uri);
  if (sameUriList(savedUris, current.folders) && !durableWorkspaceUri(current.workspaceFile)) {
    return { kind: 'ready' };
  }

  if (savedFolders.length === 0) {
    if (current.folders.length === 0) return { kind: 'ready' };
    return {
      kind: 'unsupported',
      reason: 'the capsule used an empty VS Code window; Context Capsule will not close the current workspace automatically',
    };
  }

  if (durableWorkspaceUri(current.workspaceFile)) {
    return { kind: 'open', uri: savedFolders[0].uri };
  }

  if (current.folders.length === 0) {
    return { kind: 'open', uri: savedFolders[0].uri };
  }

  return { kind: 'replace-folders', folders: savedFolders };
}

export async function applyWorkspaceRestorePlan(plan: WorkspaceRestorePlan): Promise<boolean> {
  switch (plan.kind) {
    case 'ready':
      return false;
    case 'unsupported':
      throw new Error(plan.reason);
    case 'open':
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(plan.uri, true), {
        forceReuseWindow: true,
      });
      return true;
    case 'replace-folders': {
      const currentCount = vscode.workspace.workspaceFolders?.length ?? 0;
      const added = plan.folders.map(folder => ({
        uri: vscode.Uri.parse(folder.uri, true),
        name: folder.name,
      }));
      const changed = vscode.workspace.updateWorkspaceFolders(0, currentCount, ...added);
      if (!changed) throw new Error('VS Code rejected the saved workspace-folder update');
      return true;
    }
  }
}

function durableWorkspaceUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme === 'untitled' ? undefined : uri.toString(true);
  } catch {
    return undefined;
  }
}

function sameUri(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normalizeUri(left) === normalizeUri(right);
}

function sameUriList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => normalizeUri(value) === normalizeUri(right[index] ?? ''));
}

function normalizeUri(value: string): string {
  try {
    const parsed = vscode.Uri.parse(value, true);
    const rendered = parsed.toString(true);
    return parsed.scheme === 'file' && process.platform === 'win32'
      ? rendered.toLocaleLowerCase()
      : rendered;
  } catch {
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }
}
