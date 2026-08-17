import * as vscode from 'vscode';
import type { SelectionSnapshot, VsCodeSnapshot } from './types';

function selectionFromSnapshot(selection: SelectionSnapshot): vscode.Selection {
  return new vscode.Selection(
    new vscode.Position(selection.anchor[0], selection.anchor[1]),
    new vscode.Position(selection.active[0], selection.active[1]),
  );
}

export interface RestoreReport {
  opened: number;
  skipped: number;
  warnings: string[];
}

function tabTextUri(tab: vscode.Tab): string | undefined {
  return tab.input instanceof vscode.TabInputText ? tab.input.uri.toString(true) : undefined;
}

function existingTabsByColumn(): Map<number | undefined, Set<string>> {
  const result = new Map<number | undefined, Set<string>>();
  for (const group of vscode.window.tabGroups.all) {
    const uris = new Set<string>();
    for (const tab of group.tabs) {
      const uri = tabTextUri(tab);
      if (uri) {
        uris.add(uri);
      }
    }
    result.set(group.viewColumn, uris);
  }
  return result;
}

function applySavedSelection(editor: vscode.TextEditor, snapshot: VsCodeSnapshot, uri: string): void {
  const saved = snapshot.visibleEditorSelections.find(item => item.uri === uri);
  if (!saved?.selections.length) {
    return;
  }
  editor.selections = saved.selections.map(selectionFromSnapshot);
  editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
}

export async function restoreVsCodeSnapshot(snapshot: VsCodeSnapshot): Promise<RestoreReport> {
  const report: RestoreReport = { opened: 0, skipped: 0, warnings: [] };
  const existing = existingTabsByColumn();

  for (const group of snapshot.tabGroups) {
    const existingInGroup = existing.get(group.viewColumn) ?? new Set<string>();
    for (const tab of group.tabs) {
      if (!tab.restorable || !tab.uri) {
        report.skipped += 1;
        continue;
      }
      if (existingInGroup.has(tab.uri)) {
        report.skipped += 1;
        continue;
      }

      try {
        const uri = vscode.Uri.parse(tab.uri, true);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: group.viewColumn,
          preview: tab.preview,
          preserveFocus: !tab.active,
        });
        applySavedSelection(editor, snapshot, tab.uri);
        if (tab.pinned) {
          await vscode.commands.executeCommand('workbench.action.keepEditor');
        }
        existingInGroup.add(tab.uri);
        existing.set(group.viewColumn, existingInGroup);
        report.opened += 1;
      } catch (error) {
        report.skipped += 1;
        report.warnings.push(`${tab.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (snapshot.activeEditorUri) {
    const active = snapshot.tabGroups.flatMap(group => group.tabs.map(tab => ({ group, tab })))
      .find(item => item.tab.uri === snapshot.activeEditorUri);
    if (active?.tab.uri) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(active.tab.uri, true));
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: active.group.viewColumn,
          preview: false,
          preserveFocus: false,
        });
        applySavedSelection(editor, snapshot, active.tab.uri);
      } catch {
        // Already reported during the main pass when applicable.
      }
    }
  }

  return report;
}
