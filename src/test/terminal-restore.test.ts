import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { captureIntegratedTerminal } from '../adapter/capture';
import { restoreIntegratedTerminals } from '../adapter/terminal-restore';

suite('Context Capsule integrated terminal restore', () => {
  test('does not guess which terminal to reveal when a legacy capsule saved multiple terminals', async () => {
    const first = vscode.window.createTerminal({
      name: `Context Capsule legacy A ${randomUUID()}`,
      cwd: os.tmpdir(),
    });
    const second = vscode.window.createTerminal({
      name: `Context Capsule legacy B ${randomUUID()}`,
      cwd: os.homedir(),
    });

    try {
      const { active: _firstActive, ...firstLegacy } = captureIntegratedTerminal(first);
      const { active: _secondActive, ...secondLegacy } = captureIntegratedTerminal(second);
      const before = vscode.window.terminals.length;

      const report = await restoreIntegratedTerminals([firstLegacy, secondLegacy]);

      assert.equal(report.opened, 0);
      assert.equal(report.revealed, 0);
      assert.equal(report.skipped, 2);
      assert.equal(vscode.window.terminals.length, before);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
