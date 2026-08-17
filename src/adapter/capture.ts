import * as vscode from 'vscode';
import {
  VSCODE_SNAPSHOT_SCHEMA_VERSION,
  type EditorSelectionSnapshot,
  type ExtensionRuntimeMode,
  type TabSnapshot,
  type VsCodeSnapshot,
} from './types';

const RESTORABLE_TEXT_SCHEMES = new Set(['file', 'vscode-remote']);

export interface CaptureMetadata {
  extensionMode?: ExtensionRuntimeMode;
  extensionPath?: string;
}

function positionTuple(position: vscode.Position): [number, number] {
  return [position.line, position.character];
}

function selectionSnapshot(editor: vscode.TextEditor): EditorSelectionSnapshot {
  return {
    uri: editor.document.uri.toString(true),
    viewColumn: editor.viewColumn,
    selections: editor.selections.map(selection => ({
      anchor: positionTuple(selection.anchor),
      active: positionTuple(selection.active),
    })),
  };
}

function tabSnapshot(tab: vscode.Tab): TabSnapshot {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return {
      label: tab.label,
      inputKind: 'text',
      uri: input.uri.toString(true),
      active: tab.isActive,
      dirty: tab.isDirty,
      pinned: tab.isPinned,
      preview: tab.isPreview,
      restorable: RESTORABLE_TEXT_SCHEMES.has(input.uri.scheme),
    };
  }

  return {
    label: tab.label,
    inputKind: input?.constructor?.name ?? 'unknown',
    active: tab.isActive,
    dirty: tab.isDirty,
    pinned: tab.isPinned,
    preview: tab.isPreview,
    restorable: false,
  };
}

export function captureVsCodeSnapshot(metadata: CaptureMetadata = {}): VsCodeSnapshot {
  const snapshot: VsCodeSnapshot = {
    schemaVersion: VSCODE_SNAPSHOT_SCHEMA_VERSION,
    capturedAtUnixMs: Date.now(),
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    remoteName: vscode.env.remoteName,
    workspaceTrusted: vscode.workspace.isTrusted,
    workspaceFile: vscode.workspace.workspaceFile?.toString(true),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      uri: folder.uri.toString(true),
      name: folder.name,
      index: folder.index,
    })),
    tabGroups: vscode.window.tabGroups.all.map(group => ({
      viewColumn: group.viewColumn,
      active: group.isActive,
      tabs: group.tabs.map(tabSnapshot),
    })),
    visibleEditorSelections: vscode.window.visibleTextEditors.map(selectionSnapshot),
    activeEditorUri: vscode.window.activeTextEditor?.document.uri.toString(true),
  };

  if (metadata.extensionMode) {
    snapshot.extensionMode = metadata.extensionMode;
  }
  if (metadata.extensionPath) {
    snapshot.extensionPath = metadata.extensionPath;
  }
  return snapshot;
}
