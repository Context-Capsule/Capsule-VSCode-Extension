import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from '../adapter/capture';
import { runtimeHostStatePath, runtimeStatePath } from '../adapter/state';

suite('Context Capsule VS Code adapter', () => {
  test('captures a durable text editor and its selection as restorable', async () => {
    const filePath = path.join(os.tmpdir(), `context-capsule-${randomUUID()}.txt`);
    await writeFile(filePath, 'context capsule integration test', 'utf8');
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(new vscode.Position(0, 2), new vscode.Position(0, 7));

      const snapshot = captureVsCodeSnapshot();
      assert.equal(snapshot.schemaVersion, 1);
      assert.ok(snapshot.tabGroups.some(group => group.tabs.some(tab => tab.uri === document.uri.toString(true) && tab.restorable)));
      assert.ok(snapshot.visibleEditorSelections.some(item => item.uri === document.uri.toString(true)));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await rm(filePath, { force: true });
    }
  });

  test('does not claim an untitled editor can be restored without its contents', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'unsaved secret-free test content' });
    await vscode.window.showTextDocument(document, { preview: false });
    try {
      const snapshot = captureVsCodeSnapshot();
      const tab = snapshot.tabGroups.flatMap(group => group.tabs).find(item => item.uri === document.uri.toString(true));
      assert.ok(tab, 'untitled editor should still be represented as context');
      assert.equal(tab.restorable, false);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('manual sync writes development-host identity into canonical and per-host runtime envelopes', async () => {
    const statePath = path.join(os.tmpdir(), `context-capsule-vscode-state-${randomUUID()}.json`);
    const previous = process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
    process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = statePath;
    const hostStatePath = runtimeHostStatePath();
    try {
      await vscode.commands.executeCommand('context-capsule.sync');
      const canonicalEnvelope = JSON.parse(await readFile(statePath, 'utf8')) as {
        updatedAtUnixMs: number;
        snapshot: { schemaVersion: number; extensionMode?: string; extensionPath?: string };
      };
      const hostEnvelope = JSON.parse(await readFile(hostStatePath, 'utf8')) as typeof canonicalEnvelope;

      for (const envelope of [canonicalEnvelope, hostEnvelope]) {
        assert.equal(envelope.snapshot.schemaVersion, 1);
        assert.ok(envelope.updatedAtUnixMs > 0);
        assert.equal(envelope.snapshot.extensionMode, 'development');
        assert.ok(envelope.snapshot.extensionPath, 'Extension Development Host must persist its development extension path');
      }
      assert.equal(runtimeStatePath(), statePath);
      assert.match(hostStatePath, /vscode-host-\d+\.json$/i);
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
      else process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = previous;
      await Promise.all([
        rm(statePath, { force: true }),
        rm(hostStatePath, { force: true }),
      ]);
    }
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
