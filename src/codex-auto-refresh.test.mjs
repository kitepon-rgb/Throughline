import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCodexAutoRefreshFingerprint,
  CODEX_AUTO_REFRESH_THRESHOLD,
  evaluateCodexAutoRefreshUsage,
  runCodexAutoRefresh,
} from './codex-auto-refresh.mjs';

test('evaluateCodexAutoRefreshUsage: default threshold is 75%', () => {
  assert.equal(CODEX_AUTO_REFRESH_THRESHOLD, 0.75);
  const below = evaluateCodexAutoRefreshUsage({
    tokens: 193_799,
    contextWindowSize: 258_400,
    estimated: false,
    contextWindowEstimated: false,
  });
  assert.equal(below.shouldRefresh, false);
  assert.equal(below.reason, 'below_threshold');

  const atThreshold = evaluateCodexAutoRefreshUsage({
    tokens: 193_800,
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

test('runCodexAutoRefresh: disabled by default and does not inspect trim source', async () => {
  let buildTrimSourceCalled = false;
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
      buildTrimSource: () => {
        buildTrimSourceCalled = true;
        return null;
      },
    },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'codex_auto_refresh_disabled');
  assert.equal(buildTrimSourceCalled, false);
});

test('runCodexAutoRefresh: below threshold skips before building trim source', async () => {
  let buildTrimSourceCalled = false;
  const result = await runCodexAutoRefresh({
    db: {},
    threadId: '019dfaba-thread',
    projectPath: '/repo',
    enabled: true,
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
    enabled: true,
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

test('runCodexAutoRefresh: suppresses repeated execution for the same rollout and usage epoch', async () => {
  let executionCalls = 0;
  const stateStore = makeMemoryAutoRefreshStateStore();
  const baseArgs = {
    db: {},
    threadId: '019dfaba-thread',
    codexThreadIdSource: 'payload:session_id',
    projectPath: '/repo',
    sessionId: 'codex:019dfaba-thread',
    enabled: true,
    usage: {
      tokens: 240_000,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    autoRefreshStateStore: stateStore,
    deps: {
      buildTrimSource: () => ({
        source: 'codex-rollout',
        capturedTurns: 4,
        memoryPreview: { text: 'rollout preview' },
        stats: {
          rollbackEvents: 0,
          injectedDeveloperMessages: 0,
          userMessagesAfterRollback: 0,
        },
      }),
      buildTrimPlan: () => ({
        status: 'ready',
        trim: {
          source: 'codex-rollout',
          capturedTurns: 4,
          rollbackTurns: 4,
          rolloutPath: '/repo/rollout.jsonl',
          rolloutStats: {
            rollbackEvents: 0,
            injectedDeveloperMessages: 0,
            userMessagesAfterRollback: 0,
          },
        },
        memoryPreview: {
          text: '## Throughline: Active Work Context\n\nrecent work',
          stats: { source: 'throughline-db' },
        },
      }),
      runTrimExecution: async () => {
        executionCalls++;
        return {
          rollbackSent: true,
          injectSent: true,
          postInjectVisibilityCheck: { status: 'match' },
        };
      },
    },
  };

  const first = await runCodexAutoRefresh(baseArgs);
  const second = await runCodexAutoRefresh(baseArgs);

  assert.equal(first.status, 'refreshed-live');
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'auto_refresh_backoff');
  assert.equal(executionCalls, 1);
});

test('runCodexAutoRefresh: durable success keeps the thread quiet after injection until a new user turn', async () => {
  let executionCalls = 0;
  const stateStore = makeMemoryAutoRefreshStateStore();
  const makeArgs = ({ tokens, rollbackEvents, injectedDeveloperMessages, userMessagesAfterRollback }) => ({
    db: {},
    threadId: '019dfaba-thread',
    projectPath: '/repo',
    sessionId: 'codex:019dfaba-thread',
    enabled: true,
    usage: {
      tokens,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    autoRefreshStateStore: stateStore,
    deps: {
      buildTrimSource: () => ({
        source: 'codex-rollout',
        capturedTurns: 1,
        memoryPreview: { text: 'rollout preview' },
        stats: { rollbackEvents, injectedDeveloperMessages, userMessagesAfterRollback },
      }),
      buildTrimPlan: () => ({
        status: 'ready',
        trim: {
          source: 'codex-rollout',
          capturedTurns: 1,
          rollbackTurns: 1,
          rolloutPath: '/repo/rollout.jsonl',
          rolloutStats: { rollbackEvents, injectedDeveloperMessages, userMessagesAfterRollback },
        },
        memoryPreview: {
          text: '## Throughline: Active Work Context\n\nrecent work',
          stats: { source: 'throughline-db' },
        },
      }),
      runTrimExecution: async () => {
        executionCalls++;
        return {
          rollbackSent: true,
          injectSent: true,
          postInjectVisibilityCheck: { status: 'match' },
        };
      },
    },
  });

  const first = await runCodexAutoRefresh(
    makeArgs({
      tokens: 240_000,
      rollbackEvents: 0,
      injectedDeveloperMessages: 0,
      userMessagesAfterRollback: 0,
    }),
  );
  const afterInjection = await runCodexAutoRefresh(
    makeArgs({
      tokens: 252_000,
      rollbackEvents: 1,
      injectedDeveloperMessages: 1,
      userMessagesAfterRollback: 0,
    }),
  );
  const afterNewUserTurn = await runCodexAutoRefresh(
    makeArgs({
      tokens: 252_000,
      rollbackEvents: 1,
      injectedDeveloperMessages: 1,
      userMessagesAfterRollback: 1,
    }),
  );

  assert.equal(first.status, 'refreshed-live');
  assert.equal(afterInjection.status, 'skipped');
  assert.equal(afterInjection.reason, 'auto_refresh_backoff');
  assert.equal(afterNewUserTurn.status, 'refreshed-live');
  assert.equal(executionCalls, 2);
});

test('runCodexAutoRefresh: threshold reached skips when injectable DB memory is missing', async () => {
  let runTrimExecutionCalled = false;
  const result = await runCodexAutoRefresh({
    db: {},
    threadId: '019dfaba-thread',
    projectPath: '/repo',
    enabled: true,
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

test('runCodexAutoRefresh: noop and missing injectable memory are backed off for the same state', async () => {
  const cases = [
    {
      name: 'nothing_to_trim',
      plan: {
        status: 'ready',
        trim: {
          source: 'codex-rollout',
          capturedTurns: 2,
          rollbackTurns: 0,
          rolloutPath: '/repo/rollout.jsonl',
          rolloutStats: { rollbackEvents: 0, injectedDeveloperMessages: 0, userMessagesAfterRollback: 0 },
        },
        memoryPreview: {
          text: '## Throughline: Active Work Context\n\nrecent work',
          stats: { source: 'throughline-db' },
        },
      },
    },
    {
      name: 'injectable_memory_required',
      plan: {
        status: 'ready',
        trim: {
          source: 'codex-rollout',
          capturedTurns: 2,
          rollbackTurns: 2,
          rolloutPath: '/repo/rollout.jsonl',
          rolloutStats: { rollbackEvents: 0, injectedDeveloperMessages: 0, userMessagesAfterRollback: 0 },
        },
        memoryPreview: {
          text: 'rollout preview only',
          stats: { source: 'codex-rollout' },
        },
      },
    },
  ];

  for (const fixture of cases) {
    const stateStore = makeMemoryAutoRefreshStateStore();
    const args = {
      db: {},
      threadId: `019dfaba-thread-${fixture.name}`,
      projectPath: '/repo',
      enabled: true,
      usage: {
        tokens: 240_000,
        contextWindowSize: 258_400,
        estimated: false,
        contextWindowEstimated: false,
      },
      autoRefreshStateStore: stateStore,
      deps: {
        buildTrimSource: () => ({
          source: 'codex-rollout',
          capturedTurns: 2,
          memoryPreview: { text: 'rollout preview' },
          stats: { rollbackEvents: 0, injectedDeveloperMessages: 0, userMessagesAfterRollback: 0 },
        }),
        buildTrimPlan: () => fixture.plan,
        runTrimExecution: async () => {
          throw new Error('runTrimExecution should not be called');
        },
      },
    };

    const first = await runCodexAutoRefresh(args);
    const second = await runCodexAutoRefresh(args);

    assert.equal(first.status, 'skipped', fixture.name);
    assert.equal(first.reason, fixture.name);
    assert.equal(second.status, 'skipped', fixture.name);
    assert.equal(second.reason, 'auto_refresh_backoff');
  }
});

test('runCodexAutoRefresh: backoff still allows a new usage epoch or thread', async () => {
  const stateStore = makeMemoryAutoRefreshStateStore();
  const makeArgs = ({ threadId, tokens }) => ({
    db: {},
    threadId,
    projectPath: '/repo',
    enabled: true,
    usage: {
      tokens,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
    },
    autoRefreshStateStore: stateStore,
    deps: {
      buildTrimSource: () => ({
        source: 'codex-rollout',
        capturedTurns: 2,
        memoryPreview: { text: 'rollout preview' },
        stats: { rollbackEvents: 0, injectedDeveloperMessages: 0, userMessagesAfterRollback: 0 },
      }),
      buildTrimPlan: () => ({
        status: 'ready',
        trim: {
          source: 'codex-rollout',
          capturedTurns: 2,
          rollbackTurns: 2,
          rolloutPath: '/repo/rollout.jsonl',
          rolloutStats: { rollbackEvents: 0, injectedDeveloperMessages: 0, userMessagesAfterRollback: 0 },
        },
        memoryPreview: {
          text: 'rollout preview only',
          stats: { source: 'codex-rollout' },
        },
      }),
      runTrimExecution: async () => {
        throw new Error('runTrimExecution should not be called');
      },
    },
  });

  const first = await runCodexAutoRefresh(makeArgs({ threadId: 'thread-a', tokens: 240_000 }));
  const repeated = await runCodexAutoRefresh(makeArgs({ threadId: 'thread-a', tokens: 240_000 }));
  const usageAdvanced = await runCodexAutoRefresh(makeArgs({ threadId: 'thread-a', tokens: 252_000 }));
  const newThread = await runCodexAutoRefresh(makeArgs({ threadId: 'thread-b', tokens: 240_000 }));

  assert.equal(first.reason, 'injectable_memory_required');
  assert.equal(repeated.reason, 'auto_refresh_backoff');
  assert.equal(usageAdvanced.reason, 'injectable_memory_required');
  assert.equal(newThread.reason, 'injectable_memory_required');
});

test('buildCodexAutoRefreshFingerprint: ignores live tool-loop row churn within a usage epoch', () => {
  const base = {
    threadId: 'thread-a',
    projectPath: '/repo',
    usage: {
      tokens: 196_000,
      contextWindowSize: 258_400,
      estimated: false,
      contextWindowEstimated: false,
      source: 'codex-rollout-token-count-live-turn',
    },
    rolloutState: {
      rolloutPath: '/repo/rollout.jsonl',
      capturedTurns: 1,
      rollbackTurns: null,
      capturedRows: 2,
      capturedDetails: 60,
      rollbackEvents: 1,
      rolledBackTurns: 2,
      injectedDeveloperMessages: 1,
      userMessagesAfterRollback: 0,
    },
  };

  assert.equal(
    buildCodexAutoRefreshFingerprint(base),
    buildCodexAutoRefreshFingerprint({
      ...base,
      usage: {
        ...base.usage,
        tokens: 199_000,
      },
      rolloutState: {
        ...base.rolloutState,
        capturedRows: 3,
        capturedDetails: 65,
      },
    }),
  );
});

function makeMemoryAutoRefreshStateStore() {
  const states = new Map();
  return {
    read(threadId) {
      const state = states.get(threadId);
      return state ? structuredClone(state) : null;
    },
    write(threadId, state) {
      states.set(threadId, structuredClone(state));
    },
  };
}
