export const VSCODE_SNAPSHOT_SCHEMA_VERSION = 1;

export type ExtensionRuntimeMode = 'development' | 'production' | 'test';
export type HostDetection =
  | 'self-development'
  | 'workspace-development-extension'
  | 'unmanaged-development-extension'
  | 'production'
  | 'test';

export interface CaptureMetadata {
  extensionMode?: ExtensionRuntimeMode;
  extensionPath?: string;
  hostDetection?: HostDetection;
  hostDiagnostics?: string[];
}

export interface WorkspaceFolderSnapshot {
  uri: string;
  name: string;
  index: number;
}

export interface SelectionSnapshot {
  anchor: [number, number];
  active: [number, number];
}

export interface EditorSelectionSnapshot {
  uri: string;
  viewColumn?: number;
  selections: SelectionSnapshot[];
}

export interface TabSnapshot {
  label: string;
  inputKind: string;
  uri?: string;
  active: boolean;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  restorable: boolean;
}

export interface TabGroupSnapshot {
  viewColumn?: number;
  active: boolean;
  tabs: TabSnapshot[];
}

export interface IntegratedTerminalSnapshot {
  name: string;
  kind: 'process' | 'extension';
  restorable: boolean;
  shellPath?: string;
  shellArgs?: string | string[];
  cwd?: string;
  cwdIsUri?: boolean;
}

export interface VsCodeSnapshot {
  schemaVersion: number;
  capturedAtUnixMs: number;
  hostPid?: number;
  appName: string;
  appHost: string;
  remoteName?: string;
  extensionMode?: ExtensionRuntimeMode;
  extensionPath?: string;
  hostDetection?: HostDetection;
  workspaceTrusted: boolean;
  workspaceFile?: string;
  workspaceFolders: WorkspaceFolderSnapshot[];
  tabGroups: TabGroupSnapshot[];
  visibleEditorSelections: EditorSelectionSnapshot[];
  activeEditorUri?: string;
  integratedTerminals?: IntegratedTerminalSnapshot[];
}

export interface RuntimeEnvelope {
  updatedAtUnixMs: number;
  snapshot: VsCodeSnapshot;
}
