import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureVsCodeSnapshot } from '../adapter/capture';
import { restoreVsCodeSnapshot } from '../adapter/restore';
import { runtimeStatePath } from '../adapter/state';
import { savedHostForApp, terminalMatchesSaved } from '../adapter/terminal-restore';
import { planWorkspaceRestore } from '../adapter/workspace-restore';
import { isValidRestoreRequest } from '../bridge/restore-queue';
import type { VsCodeSnapshot } from '../adapter/types';

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

  test('restoring an already-open editor reuses it instead of opening another tab', async () => {
    const filePath = path.join(os.tmpdir(), `context-capsule-reuse-${randomUUID()}.txt`);
    await writeFile(filePath, 'reuse me', 'utf8');
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const uri = document.uri.toString(true);
      const before = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString(true) === uri).length;

      const snapshot = captureVsCodeSnapshot();
      const focusedSnapshot: VsCodeSnapshot = {
        ...snapshot,
        tabGroups: snapshot.tabGroups.map(group => ({
          ...group,
          tabs: group.tabs.filter(tab => tab.uri === uri),
        })).filter(group => group.tabs.length > 0),
        visibleEditorSelections: [{
          uri,
          viewColumn: editor.viewColumn,
          selections: [{ anchor: [0, 0], active: [0, 0] }],
        }],
        activeEditorUri: uri,
      };

      const report = await restoreVsCodeSnapshot(focusedSnapshot);
      const after = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString(true) === uri).length;
      assert.equal(after, before, 'restore must not duplicate an already-open editor in the saved group');
      assert.ok(report.reused >= 1, `expected a reused tab, got ${JSON.stringify(report)}`);
      assert.equal(report.opened, 0);
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

  test('workspace planner is convergent and changes only mismatched workspace state', () => {
    const base: VsCodeSnapshot = {
      schemaVersion: 1,
      capturedAtUnixMs: 1,
      appName: 'Visual Studio Code',
      appHost: 'desktop',
      workspaceTrusted: true,
      workspaceFolders: [{ uri: 'file:///c%3A/work', name: 'work', index: 0 }],
      tabGroups: [],
      visibleEditorSelections: [],
    };
    assert.deepEqual(
      planWorkspaceRestore(base, { folders: ['file:///c%3A/work'] }),
      { kind: 'ready' },
    );
    assert.equal(
      planWorkspaceRestore(base, { folders: ['file:///c%3A/other'] }).kind,
      'replace-folders',
    );

    const workspaceSnapshot: VsCodeSnapshot = {
      ...base,
      workspaceFile: 'file:///c%3A/work/project.code-workspace',
    };
    assert.deepEqual(
      planWorkspaceRestore(workspaceSnapshot, {
        workspaceFile: 'file:///c%3A/work/project.code-workspace',
        folders: ['file:///c%3A/work'],
      }),
      { kind: 'ready' },
    );
    assert.equal(
      planWorkspaceRestore(workspaceSnapshot, { folders: ['file:///c%3A/work'] }).kind,
      'open',
    );
  });

  test('integrated terminal matching prevents duplicate shells', () => {
    const saved = {
      host: 'visual-studio-code',
      shell: 'PowerShell',
      shell_executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      title: null,
      profile: null,
      working_directory: null,
      restart: null,
    };
    assert.ok(terminalMatchesSaved(saved, {
      name: 'pwsh',
      shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    }));
    assert.ok(!terminalMatchesSaved(saved, {
      name: 'bash',
      shellPath: '/usr/bin/bash',
    }));
    assert.equal(savedHostForApp('Visual Studio Code'), 'visual-studio-code');
    assert.equal(savedHostForApp('Cursor'), 'cursor');
  });

  test('restore queue validates adapter and request shape', () => {
    assert.ok(isValidRestoreRequest({
      schema_version: 1,
      request_id: '123-abc',
      adapter: 'vscode',
      capsule_name: 'demo',
      created_at_unix_ms: Date.now(),
    }));
    assert.ok(!isValidRestoreRequest({
      schema_version: 1,
      request_id: '../bad',
      adapter: 'vscode',
      capsule_name: 'demo',
      created_at_unix_ms: Date.now(),
    }));
    assert.ok(!isValidRestoreRequest({
      schema_version: 1,
      request_id: 'good',
      adapter: 'firefox',
      capsule_name: 'demo',
      created_at_unix_ms: Date.now(),
    }));
  });

  test('manual sync writes a producer-compatible runtime envelope', async () => {
    const statePath = path.join(os.tmpdir(), `context-capsule-vscode-state-${randomUUID()}.json`);
    const previous = process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
    process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = statePath;
    try {
      await vscode.commands.executeCommand('context-capsule.sync');
      const envelope = JSON.parse(await readFile(statePath, 'utf8')) as { updatedAtUnixMs: number; snapshot: { schemaVersion: number } };
      assert.equal(envelope.snapshot.schemaVersion, 1);
      assert.ok(envelope.updatedAtUnixMs > 0);
      assert.equal(runtimeStatePath(), statePath);
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
      else process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = previous;
      await rm(statePath, { force: true });
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
