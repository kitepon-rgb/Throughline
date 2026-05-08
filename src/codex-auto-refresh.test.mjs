import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_AUTO_REFRESH_THRESHOLD,
  evaluateCodexAutoRefreshUsage,
  runCodexAutoRefresh,
} from './codex-auto-refresh.mjs';

test('evaluateCodexAutoRefreshUsage: default threshold is 80%', () => {
  assert.equal(CODEX_AUTO_REFRESH_THRESHOLD, 0.8);
  const below = evaluateCodexAutoRefreshUsage({
    tokens: 206_719,
    contextWindowSize: 258_400,
    estimated: false,
    contextWindowEstimated: false,
  });
  assert.equal(below.shouldRefresh, false);
  assert.equal(below.reason, 'below_threshold');

  const atThreshold = evaluateCodexAutoRefreshUsage({
    tokens: 206_720,
    contextWindowSize: 258_400,
    estimated: false,
    contextWindowEstimated: false,
  });
  assert.equal(atThreshold.shouldRefresh, true);
  assert.equal(atThreshold.reason, 'threshold_reached');
});

test('evaluateCodexAutoRefreshUsage: estimate does not trigger mutation', () => {
  const estimatedUsage = evaluateCodexAutoRefreshUsage({
    tokens: 250_000,
    contextWindowSize: 258_400,
    estimated: true,
    contextWindowEstimated: false,
  });
  assert.equal(estimatedUsage.shouldRefresh, false);
  assert.equal(estimatedUsage.reason, 'estimated_usage_not_allowed');

  const estimatedWindow = evaluateCodexAutoRefreshUsage({
    tokens: 250_000,
    contextWindowSize: 258_400,
    estimated: false,
    contextWindowEstimated: true,
  });
  assert.equal(estimatedWindow.shouldRefresh, false);
  assert.equal(estimatedWindow.reason, 'estimated_context_window_not_allowed');
});

test('runCodexAutoRefresh: below threshold skips before building trim source', async () => {
  let buildTrimSourceCalled = false;
  const result = await runCodexAutoRefresh({
    db: {},
    threadId: '019dfaba-thread',
    projectPath: '/repo',
    usage: {
      tokens: 100_000,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    deps: {
      buildTrimSource: () => {
        buildTrimSourceCalled = true;
        return null;
      },
    },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'below_threshold');
  assert.equal(buildTrimSourceCalled, false);
});

test('runCodexAutoRefresh: threshold reached rolls back and injects Throughline memory', async () => {
  let buildTrimSourceCalled = false;
  let runTrimExecutionArgs = null;
  const result = await runCodexAutoRefresh({
    db: {},
    threadId: '019dfaba-thread',
    codexThreadIdSource: 'payload:session_id',
    projectPath: '/repo',
    sessionId: 'codex:019dfaba-thread',
    usage: {
      tokens: 240_000,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    deps: {
      buildTrimSource: (args) => {
        buildTrimSourceCalled = true;
        assert.equal(args.threadId, '019dfaba-thread');
        assert.equal(args.sourceReason, 'payload_codex_thread_rollout');
        return {
          source: 'codex-rollout',
          capturedTurns: 2,
          memoryPreview: { text: 'rollout preview' },
        };
      },
      buildTrimPlan: (db, args) => {
        assert.equal(args.sessionId, 'codex:019dfaba-thread');
        assert.equal(args.trimAll, true);
        assert.equal(args.host, 'codex');
        return {
          status: 'ready',
          trim: {
            source: 'codex-rollout',
            capturedTurns: 2,
            rollbackTurns: 2,
          },
          memoryPreview: {
            text: '## Throughline: Active Work Context\n\nrecent work',
            stats: { source: 'throughline-db' },
          },
        };
      },
      runTrimExecution: async (args) => {
        runTrimExecutionArgs = args;
        return {
          rollbackSent: true,
          injectSent: true,
          postInjectVisibilityCheck: { status: 'match' },
        };
      },
    },
  });

  assert.equal(result.status, 'refreshed-live');
  assert.equal(result.reason, 'rollback_and_inject_sent_live');
  assert.equal(buildTrimSourceCalled, true);
  assert.equal(runTrimExecutionArgs.threadId, '019dfaba-thread');
  assert.equal(runTrimExecutionArgs.cwd, '/repo');
  assert.equal(runTrimExecutionArgs.rollbackTurns, 2);
  assert.equal(runTrimExecutionArgs.expectedTurns, 2);
  assert.match(runTrimExecutionArgs.memoryText, /Throughline: Active Work Context/);
});

test('runCodexAutoRefresh: threshold reached skips when injectable DB memory is missing', async () => {
  let runTrimExecutionCalled = false;
  const result = await runCodexAutoRefresh({
    db: {},
    threadId: '019dfaba-thread',
    projectPath: '/repo',
    usage: {
      tokens: 240_000,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    deps: {
      buildTrimSource: () => ({
        source: 'codex-rollout',
        capturedTurns: 2,
        memoryPreview: { text: 'rollout preview' },
      }),
      buildTrimPlan: () => {
        return {
          status: 'ready',
          trim: {
            source: 'codex-rollout',
            capturedTurns: 2,
            rollbackTurns: 2,
          },
          memoryPreview: {
            text: 'rollout preview only',
            stats: { source: 'codex-rollout' },
          },
        };
      },
      runTrimExecution: async () => {
        runTrimExecutionCalled = true;
        return {};
      },
    },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'injectable_memory_required');
  assert.equal(runTrimExecutionCalled, false);
});
