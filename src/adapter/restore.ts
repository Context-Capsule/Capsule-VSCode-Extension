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

export async function restoreVsCodeSnapshot(snapshot: VsCodeSnapshot): Promise<RestoreReport> {
  const report: RestoreReport = { opened: 0, skipped: 0, warnings: [] };
  const selectionByUri = new Map(snapshot.visibleEditorSelections.map(item => [item.uri, item]));

  for (const group of snapshot.tabGroups) {
    for (const tab of group.tabs) {
      if (!tab.restorable || !tab.uri) {
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
        const savedSelection = selectionByUri.get(tab.uri);
        if (savedSelection?.selections.length) {
          editor.selections = savedSelection.selections.map(selectionFromSnapshot);
          editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
        }
        if (tab.pinned) {
          await vscode.commands.executeCommand('workbench.action.keepEditor');
        }
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
        await vscode.window.showTextDocument(document, { viewColumn: active.group.viewColumn, preview: false, preserveFocus: false });
      } catch { /* already reported during the main pass when applicable */ }
    }
  }

  return report;
}
