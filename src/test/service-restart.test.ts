import * as assert from 'node:assert/strict';
import {
  reconcileObservedRunningShellPids,
  validateRestartCommand,
} from '../adapter/service-restart';

suite('Context Capsule terminal service restart safety', () => {
  test('ignores nested/helper Code descendant shell PIDs', () => {
    const coverage = reconcileObservedRunningShellPids(
      [100, 200, 300],
      [100],
      [100],
    );
    assert.deepEqual(coverage, {
      matched: [100],
      missing: [],
      ignored: [200, 300],
    });
  });

  test('flags an actual integrated terminal that shell integration does not track', () => {
    const coverage = reconcileObservedRunningShellPids(
      [100, 200],
      [100, 200],
      [100],
    );
    assert.deepEqual(coverage, {
      matched: [100],
      missing: [200],
      ignored: [],
    });
  });

  test('excludes the terminal that launched capsule', () => {
    const coverage = reconcileObservedRunningShellPids([100], [100], [], 100);
    assert.deepEqual(coverage, {
      matched: [],
      missing: [],
      ignored: [],
    });
  });

  test('deduplicates observed PIDs and rejects invalid identifiers', () => {
    const coverage = reconcileObservedRunningShellPids(
      [100, 100, 0, -1, Number.NaN, 200.5],
      [100],
      [100],
    );
    assert.deepEqual(coverage, {
      matched: [100],
      missing: [],
      ignored: [],
    });
  });

  test('continues to reject secret-bearing service commands', () => {
    assert.equal(validateRestartCommand('npm run dev --token secret').ok, false);
  });
});
