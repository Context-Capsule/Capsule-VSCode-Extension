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
  reused: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

interface CurrentTextTab {
  tab: vscode.Tab;
  uri: string;
  viewColumn: vscode.ViewColumn;
}

export function openTextTabs(): CurrentTextTab[] {
  return vscode.window.tabGroups.all.flatMap(group =>
    group.tabs.flatMap(tab => {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText)) return [];
      return [{ tab, uri: input.uri.toString(true), viewColumn: group.viewColumn }];
    }),
  );
}

export function reusableTextTab(
  uri: string,
  viewColumn: vscode.ViewColumn | undefined,
  tabs: CurrentTextTab[],
): CurrentTextTab | undefined {
  const normalized = normalizeUri(uri);
  return tabs.find(item =>
    normalizeUri(item.uri) === normalized
    && (viewColumn === undefined || item.viewColumn === viewColumn),
  );
}

export async function restoreVsCodeSnapshot(snapshot: VsCodeSnapshot): Promise<RestoreReport> {
  const report: RestoreReport = { opened: 0, reused: 0, updated: 0, skipped: 0, warnings: [] };
  const selectionByUri = new Map(snapshot.visibleEditorSelections.map(item => [normalizeUri(item.uri), item]));
  const currentTabs = openTextTabs();

  for (const group of snapshot.tabGroups) {
    for (const tab of group.tabs) {
      if (!tab.restorable || !tab.uri) {
        report.skipped += 1;
        continue;
      }

      const existing = reusableTextTab(tab.uri, group.viewColumn, currentTabs);
      try {
        const uri = vscode.Uri.parse(tab.uri, true);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: group.viewColumn,
          preview: tab.preview,
          preserveFocus: !tab.active,
        });

        if (existing) report.reused += 1;
        else report.opened += 1;

        const savedSelection = selectionByUri.get(normalizeUri(tab.uri));
        if (savedSelection?.selections.length) {
          const desired = savedSelection.selections.map(selectionFromSnapshot);
          if (!sameSelections(editor.selections, desired)) {
            editor.selections = desired;
            editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
            report.updated += 1;
          }
        }

        const currentPinned = existing?.tab.isPinned ?? false;
        if (tab.pinned && !currentPinned) {
          await vscode.commands.executeCommand('workbench.action.keepEditor');
          report.updated += 1;
        }
      } catch (error) {
        report.skipped += 1;
        report.warnings.push(`${tab.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (snapshot.activeEditorUri) {
    const active = snapshot.tabGroups
      .flatMap(group => group.tabs.map(tab => ({ group, tab })))
      .find(item => item.tab.uri && normalizeUri(item.tab.uri) === normalizeUri(snapshot.activeEditorUri!));
    if (active?.tab.uri) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(active.tab.uri, true));
        await vscode.window.showTextDocument(document, {
          viewColumn: active.group.viewColumn,
          preview: false,
          preserveFocus: false,
        });
      } catch {
        // Any durable open failure for this tab was already reported during the main pass.
      }
    }
  }

  return report;
}

function sameSelections(current: readonly vscode.Selection[], desired: readonly vscode.Selection[]): boolean {
  return current.length === desired.length && current.every((selection, index) => {
    const target = desired[index];
    return target !== undefined
      && selection.anchor.isEqual(target.anchor)
      && selection.active.isEqual(target.active);
  });
}

function normalizeUri(value: string): string {
  try {
    const uri = vscode.Uri.parse(value, true);
    const rendered = uri.toString(true);
    return uri.scheme === 'file' && process.platform === 'win32'
      ? rendered.toLocaleLowerCase()
      : rendered;
  } catch {
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  }
}
