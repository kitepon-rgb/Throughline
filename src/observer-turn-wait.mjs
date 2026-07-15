import { performance } from 'node:perf_hooks';
import { resolveObserverTurnFeed } from './observer-turn-feed.mjs';

export const OBSERVER_WAIT_SCHEMA = 'throughline.observer_wait.v1';
export const DEFAULT_OBSERVER_WAIT_TIMEOUT_SECONDS = 3600;
export const MAX_OBSERVER_WAIT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export class ObserverWaitCancelledError extends Error {
  constructor() {
    super('observer wait was cancelled');
    this.name = 'ObserverWaitCancelledError';
    this.code = 'E_OBSERVER_WAIT_CANCELLED';
  }
}

/**
 * Waits for the completed-only Observer cursor to change. The second argument
 * is an explicit dependency boundary for deterministic tests; callers should
 * normally omit it.
 */
export async function waitForObserverTurnChange({
  projectPath,
  afterCursor,
  timeoutSeconds = DEFAULT_OBSERVER_WAIT_TIMEOUT_SECONDS,
  signal,
  codexHome,
  receiptOptions,
} = {}, dependencies = {}) {
  assertWaitInput({ afterCursor, timeoutSeconds, signal });
  const resolve = dependencies.resolve ?? resolveObserverTurnFeed;
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? abortableSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError('observer wait poll interval must be positive');
  }

  throwIfAborted(signal);
  const deadline = now() + timeoutSeconds * 1000;
  for (;;) {
    throwIfAborted(signal);
    const current = await resolve({ projectPath, cursor: afterCursor, codexHome, receiptOptions });
    throwIfAborted(signal);
    const terminal = terminalWire(current, afterCursor);
    if (terminal) return terminal;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return waitWire('timeout', afterCursor, afterCursor);
    await sleep(Math.min(pollIntervalMs, remainingMs), signal);
    throwIfAborted(signal);
  }
}

function assertWaitInput({ afterCursor, timeoutSeconds, signal }) {
  if (typeof afterCursor !== 'string' || afterCursor.length === 0) {
    throw new TypeError('observer wait afterCursor is required');
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_OBSERVER_WAIT_TIMEOUT_SECONDS) {
    throw new TypeError('observer wait timeoutSeconds must be an integer between 1 and 3600');
  }
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError('observer wait signal must be an AbortSignal');
  }
}

function terminalWire(result, afterCursor) {
  if (result?.status === 'resync_required') return waitWire('resync_required', afterCursor, null);
  if (result?.status === 'ambiguous_parent') return waitWire('ambiguous_parent', afterCursor, null);
  if (result?.status === 'unchanged') return null;
  if (['append', 'thread_switched', 'host_switched'].includes(result?.status) && typeof result.throughCursor === 'string') {
    return waitWire('changed', afterCursor, result.throughCursor);
  }
  throw new TypeError('observer wait resolver returned an invalid state');
}

function waitWire(status, afterCursor, throughCursor) {
  return { schema: OBSERVER_WAIT_SCHEMA, status, afterCursor, throughCursor };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ObserverWaitCancelledError();
}

function abortableSleep(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(new ObserverWaitCancelledError()));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
