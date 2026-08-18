import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureIntegratedTerminal, captureVsCodeSnapshot } from '../adapter/capture';
import { selectLikelyDevelopmentPath, selectWorkspaceDevelopmentPath } from '../adapter/host-identity';
import { runtimeHostLogPath, runtimeHostStatePath, runtimeStatePath } from '../adapter/state';
import { restoreIntegratedTerminals } from '../adapter/terminal-restore';

suite('Context Capsule VS Code adapter', () => {
  test('activation creates a persistent host diagnostic before tests run', async () => {
    const log = await readFile(runtimeHostLogPath(), 'utf8');
    assert.match(log, /activation entered; pid=/);
    assert.match(log, /extension host PID:/);
  });

  test('captures a durable text editor and its selection as restorable', async () => {
    const filePath = path.join(os.tmpdir(), `context-capsule-${randomUUID()}.txt`);
    await writeFile(filePath, 'context capsule integration test', 'utf8');
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(new vscode.Position(0, 2), new vscode.Position(0, 7));

      const snapshot = captureVsCodeSnapshot();
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.hostPid, process.pid);
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

  test('captures integrated terminal launch context and treats the live terminal as already satisfied', async () => {
    const name = `Context Capsule terminal ${randomUUID()}`;
    const cwd = os.tmpdir();
    const terminal = vscode.window.createTerminal({ name, cwd });
    try {
      const captured = captureIntegratedTerminal(terminal);
      assert.equal(captured.kind, 'process');
      assert.equal(captured.restorable, true);
      assert.equal(captured.name, name);
      assert.equal(captured.cwd, cwd);
      assert.equal(captured.cwdIsUri, false);

      const snapshot = captureVsCodeSnapshot();
      assert.ok(snapshot.integratedTerminals?.some(item => item.name === name && item.cwd === cwd));

      const before = vscode.window.terminals.length;
      const report = await restoreIntegratedTerminals([captured]);
      assert.equal(report.opened, 0);
      assert.equal(report.skipped, 1);
      assert.equal(vscode.window.terminals.length, before);
    } finally {
      terminal.dispose();
    }
  });

  test('restores a missing integrated terminal without replaying command history', async () => {
    const name = `Context Capsule restored terminal ${randomUUID()}`;
    const before = new Set(vscode.window.terminals);
    const report = await restoreIntegratedTerminals([{
      name,
      kind: 'process',
      restorable: true,
      cwd: os.tmpdir(),
      cwdIsUri: false,
    }]);
    assert.equal(report.opened, 1);
    const created = vscode.window.terminals.find(terminal => !before.has(terminal) && terminal.name === name);
    assert.ok(created, 'missing semantic terminal should be created in this VS Code host');
    created.dispose();
  });

  test('detects an extension development path loaded from the current workspace', () => {
    const selected = selectWorkspaceDevelopmentPath(
      ['C:\\work\\tri-up'],
      [
        { id: 'context-capsule.context-capsule', scheme: 'file', fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\context-capsule' },
        { id: 'example.tri-up', scheme: 'file', fsPath: 'C:\\work\\tri-up' },
        { id: 'vscode.git', scheme: 'file', fsPath: 'C:\\Program Files\\Microsoft VS Code\\resources\\app\\extensions\\git' },
      ],
      'context-capsule.context-capsule',
      'win32',
    );
    assert.equal(selected, 'C:\\work\\tri-up');
  });

  test('detects a development extension nested inside a monorepo workspace', () => {
    const selected = selectWorkspaceDevelopmentPath(
      ['/work/repo'],
      [
        { id: 'example.extension', scheme: 'file', fsPath: '/work/repo/packages/extension' },
        { id: 'other.installed', scheme: 'file', fsPath: '/home/dev/.vscode/extensions/other.installed' },
      ],
      'context-capsule.context-capsule',
      'linux',
    );
    assert.equal(selected, '/work/repo/packages/extension');
  });

  test('detects a Dev Host extension outside the opened workspace without misusing Context Capsule extensionMode', () => {
    const selected = selectLikelyDevelopmentPath(
      ['C:\\work\\sample-app'],
      [
        {
          id: 'context-capsule.context-capsule',
          scheme: 'file',
          fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\context-capsule-0.1.0',
          hasInstallMetadata: true,
        },
        {
          id: 'example.extension-under-test',
          scheme: 'file',
          fsPath: 'D:\\source\\extension-under-test',
          hasInstallMetadata: false,
        },
        {
          id: 'vscode.git',
          scheme: 'file',
          fsPath: 'C:\\Program Files\\Microsoft VS Code\\resources\\app\\extensions\\git',
          hasInstallMetadata: false,
        },
      ],
      'context-capsule.context-capsule',
      'C:\\Program Files\\Microsoft VS Code\\resources\\app',
      'C:\\Users\\dev',
      'win32',
    );
    assert.deepEqual(selected, {
      path: 'D:\\source\\extension-under-test',
      detection: 'unmanaged-development-extension',
    });
  });

  test('does not classify installed extensions outside the workspace as a Dev Host', () => {
    const selected = selectLikelyDevelopmentPath(
      ['C:\\work\\ordinary-project'],
      [
        {
          id: 'context-capsule.context-capsule',
          scheme: 'file',
          fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\context-capsule-0.1.0',
          hasInstallMetadata: true,
        },
        {
          id: 'publisher.tool',
          scheme: 'file',
          fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\publisher.tool-2.0.0',
          hasInstallMetadata: true,
        },
      ],
      'context-capsule.context-capsule',
      'C:\\Program Files\\Microsoft VS Code\\resources\\app',
      'C:\\Users\\dev',
      'win32',
    );
    assert.equal(selected, undefined);
  });

  test('does not classify a normal workspace as a development host', () => {
    const selected = selectWorkspaceDevelopmentPath(
      ['C:\\work\\ordinary-project'],
      [
        { id: 'context-capsule.context-capsule', scheme: 'file', fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\context-capsule' },
        { id: 'publisher.tool', scheme: 'file', fsPath: 'C:\\Users\\dev\\.vscode\\extensions\\publisher.tool' },
      ],
      'context-capsule.context-capsule',
      'win32',
    );
    assert.equal(selected, undefined);
  });

  test('manual sync persists the current test-host identity and pid', async () => {
    const statePath = path.join(os.tmpdir(), `context-capsule-vscode-state-${randomUUID()}.json`);
    const previous = process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
    process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = statePath;
    const hostStatePath = runtimeHostStatePath();
    try {
      await vscode.commands.executeCommand('context-capsule.sync');
      const canonicalEnvelope = JSON.parse(await readFile(statePath, 'utf8')) as {
        updatedAtUnixMs: number;
        snapshot: {
          schemaVersion: number;
          hostPid?: number;
          extensionMode?: string;
          extensionPath?: string;
          hostDetection?: string;
          integratedTerminals?: unknown[];
        };
      };
      const hostEnvelope = JSON.parse(await readFile(hostStatePath, 'utf8')) as typeof canonicalEnvelope;

      for (const envelope of [canonicalEnvelope, hostEnvelope]) {
        assert.equal(envelope.snapshot.schemaVersion, 1);
        assert.ok(envelope.updatedAtUnixMs > 0);
        assert.equal(envelope.snapshot.hostPid, process.pid);
        assert.equal(envelope.snapshot.extensionMode, 'test');
        assert.equal(envelope.snapshot.hostDetection, 'test');
        assert.equal(envelope.snapshot.extensionPath, undefined);
        assert.ok(Array.isArray(envelope.snapshot.integratedTerminals));
      }
      assert.equal(runtimeStatePath(), statePath);
      assert.match(hostStatePath, /vscode-host-\d+\.json$/i);
      assert.match(runtimeHostLogPath(), /vscode-host-\d+\.log$/i);
    } finally {
      if (previous === undefined) {
        delete process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH;
      } else {
        process.env.CONTEXT_CAPSULE_VSCODE_STATE_PATH = previous;
      }
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
