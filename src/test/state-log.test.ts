import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendRuntimeLogTo } from '../adapter/state';

suite('Context Capsule persistent VS Code diagnostics', () => {
  test('rotates before a diagnostic line would exceed the configured bound', async () => {
    const directory = path.join(os.tmpdir(), `context-capsule-log-${randomUUID()}`);
    const destination = path.join(directory, 'vscode-host-test.log');
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(destination, '12345678', 'utf8');
      await appendRuntimeLogTo(destination, 'next', 10);

      assert.equal(await readFile(`${destination}.1`, 'utf8'), '12345678');
      assert.equal(await readFile(destination, 'utf8'), 'next\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('normalizes control characters so one event cannot forge extra log records', async () => {
    const directory = path.join(os.tmpdir(), `context-capsule-log-${randomUUID()}`);
    const destination = path.join(directory, 'vscode-host-test.log');
    try {
      await appendRuntimeLogTo(destination, 'first\nsecond\rthird\0tail', 1024);
      assert.equal(await readFile(destination, 'utf8'), 'first second third tail\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects invalid rotation bounds', async () => {
    const destination = path.join(os.tmpdir(), `context-capsule-log-${randomUUID()}.log`);
    await assert.rejects(() => appendRuntimeLogTo(destination, 'message', 0), /positive safe integer/);
  });
});
