import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import {
  OBSERVER_WAIT_SCHEMA,
  ObserverWaitCancelledError,
  waitForObserverTurnChange,
} from './observer-turn-wait.mjs';

const AFTER = 'tlc1.after';

function virtualDependencies(states, { pollIntervalMs = 1000 } = {}) {
  let nowMs = 0;
  let resolveCalls = 0;
  let sleepCalls = 0;
  return {
    dependencies: {
      now: () => nowMs,
      pollIntervalMs,
      resolve: () => states[Math.min(resolveCalls++, states.length - 1)],
      sleep: async (delayMs) => { sleepCalls++; nowMs += delayMs; },
    },
    counts: () => ({ resolveCalls, sleepCalls, nowMs }),
  };
}

test('observer wait returns immediate and polled changes without exposing resolver details', async () => {
  const immediate = virtualDependencies([{ status: 'append', throughCursor: 'tlc1.changed', chain: [{ secret: 'body' }] }]);
  assert.deepEqual(await waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER }, immediate.dependencies), {
    schema: OBSERVER_WAIT_SCHEMA,
    status: 'changed',
    afterCursor: AFTER,
    throughCursor: 'tlc1.changed',
  });
  assert.deepEqual(immediate.counts(), { resolveCalls: 1, sleepCalls: 0, nowMs: 0 });

  const polled = virtualDependencies([
    { status: 'unchanged', throughCursor: AFTER },
    { status: 'host_switched', throughCursor: 'tlc1.host' },
  ]);
  assert.equal((await waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 1 }, polled.dependencies)).throughCursor, 'tlc1.host');
  assert.deepEqual(polled.counts(), { resolveCalls: 2, sleepCalls: 1, nowMs: 1000 });
});

test('observer wait polls once at the deadline before returning timeout', async () => {
  const timeout = virtualDependencies([{ status: 'unchanged' }]);
  assert.deepEqual(await waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 1 }, timeout.dependencies), {
    schema: OBSERVER_WAIT_SCHEMA,
    status: 'timeout',
    afterCursor: AFTER,
    throughCursor: AFTER,
  });
  assert.deepEqual(timeout.counts(), { resolveCalls: 2, sleepCalls: 1, nowMs: 1000 });

  const boundary = virtualDependencies([
    { status: 'unchanged' },
    { status: 'thread_switched', throughCursor: 'tlc1.boundary' },
  ]);
  assert.equal((await waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 1 }, boundary.dependencies)).status, 'changed');
  assert.deepEqual(boundary.counts(), { resolveCalls: 2, sleepCalls: 1, nowMs: 1000 });
});

test('observer wait preserves fail-closed cursor states', async () => {
  for (const status of ['resync_required', 'ambiguous_parent']) {
    const box = virtualDependencies([{ status }]);
    assert.deepEqual(await waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER }, box.dependencies), {
      schema: OBSERVER_WAIT_SCHEMA,
      status,
      afterCursor: AFTER,
      throughCursor: null,
    });
  }
});

test('observer wait aborts before start and between polls without starting another resolver', async () => {
  const already = new AbortController();
  already.abort();
  let called = 0;
  await assert.rejects(
    waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER, signal: already.signal }, { resolve: () => { called++; } }),
    (error) => error instanceof ObserverWaitCancelledError && error.code === 'E_OBSERVER_WAIT_CANCELLED',
  );
  assert.equal(called, 0);

  const during = new AbortController();
  const box = virtualDependencies([{ status: 'unchanged' }]);
  box.dependencies.sleep = async () => { during.abort(); };
  await assert.rejects(
    waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER, signal: during.signal }, box.dependencies),
    { code: 'E_OBSERVER_WAIT_CANCELLED' },
  );
  assert.equal(box.counts().resolveCalls, 1);
});

test('observer wait removes its abort listener after a pending timer is cancelled', async () => {
  const controller = new AbortController();
  const pending = waitForObserverTurnChange(
    { projectPath: '/repo', afterCursor: AFTER, signal: controller.signal },
    { resolve: () => ({ status: 'unchanged' }), pollIntervalMs: 50 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(pending, { code: 'E_OBSERVER_WAIT_CANCELLED' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('observer wait rejects invalid public inputs and resolver states', async () => {
  for (const input of [
    { projectPath: '/repo' },
    { projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 0 },
    { projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 3601 },
    { projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 1.5 },
    { projectPath: '/repo', afterCursor: AFTER, signal: {} },
  ]) {
    await assert.rejects(waitForObserverTurnChange(input, { resolve: () => ({ status: 'unchanged' }) }), TypeError);
  }
  await assert.rejects(
    waitForObserverTurnChange({ projectPath: '/repo', afterCursor: AFTER }, { resolve: () => ({ status: 'projection_pending' }) }),
    /invalid state/,
  );
});
