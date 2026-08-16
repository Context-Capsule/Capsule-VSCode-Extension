import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from '../adapter/capture';
import { runtimeStatePath } from '../adapter/state';

suite('Context Capsule VS Code adapter', () => {
  test('captures workspace and a real text editor tab', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'context capsule integration test' });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(0, 2), new vscode.Position(0, 7));

    const snapshot = captureVsCodeSnapshot();
    assert.equal(snapshot.schemaVersion, 1);
    assert.ok(snapshot.tabGroups.some(group => group.tabs.some(tab => tab.uri === document.uri.toString(true) && tab.restorable)));
    assert.ok(snapshot.visibleEditorSelections.some(item => item.uri === document.uri.toString(true)));
  });

  test('runtime state path is deterministic and named vscode.json', () => {
    assert.match(runtimeStatePath(), /vscode\.json$/i);
  });

  test('extension contributes production commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['context-capsule.inspect', 'context-capsule.sync', 'context-capsule.restore', 'context-capsule.diagnostics']) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });
});
