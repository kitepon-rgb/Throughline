import { runCodexTrimExecution } from './codex-app-server.mjs';
import { buildCodexRolloutTrimSource } from './codex-rollout-memory.mjs';
import { buildTrimPlan } from './trim-model.mjs';

export const CODEX_AUTO_REFRESH_THRESHOLD = 0.9;

export function evaluateCodexAutoRefreshUsage(usage, { threshold = CODEX_AUTO_REFRESH_THRESHOLD } = {}) {
  if (!usage) {
    return {
      shouldRefresh: false,
      reason: 'usage_unavailable',
      threshold,
      ratio: null,
    };
  }

  if (usage.estimated) {
    return {
      shouldRefresh: false,
      reason: 'estimated_usage_not_allowed',
      threshold,
      ratio: null,
    };
  }

  if (usage.contextWindowEstimated) {
    return {
      shouldRefresh: false,
      reason: 'estimated_context_window_not_allowed',
      threshold,
      ratio: null,
    };
  }

  const tokens = Number(usage.tokens);
  const contextWindowSize = Number(usage.contextWindowSize);
  if (!Number.isFinite(tokens) || tokens < 0) {
    return {
      shouldRefresh: false,
      reason: 'invalid_usage_tokens',
      threshold,
      ratio: null,
    };
  }
  if (!Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    return {
      shouldRefresh: false,
      reason: 'invalid_context_window',
      threshold,
      ratio: null,
    };
  }

  const ratio = tokens / contextWindowSize;
  return {
    shouldRefresh: ratio >= threshold,
    reason: ratio >= threshold ? 'threshold_reached' : 'below_threshold',
    threshold,
    ratio,
    tokens,
    contextWindowSize,
  };
}

export async function runCodexAutoRefresh({
  db,
  threadId,
  codexThreadIdSource = null,
  codexHome = undefined,
  projectPath = process.cwd(),
  sessionId = null,
  usage = null,
  threshold = CODEX_AUTO_REFRESH_THRESHOLD,
  command = process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex',
  deps = {},
} = {}) {
  if (!db) throw new Error('runCodexAutoRefresh: db is required');
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('runCodexAutoRefresh: threadId is required');
  }
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    throw new Error('runCodexAutoRefresh: projectPath is required');
  }

  const decision = evaluateCodexAutoRefreshUsage(usage, { threshold });
  if (!decision.shouldRefresh) {
    return {
      status: 'skipped',
      reason: decision.reason,
      decision,
    };
  }

  const buildTrimSource = deps.buildTrimSource ?? buildCodexRolloutTrimSource;
  const buildPlan = deps.buildTrimPlan ?? buildTrimPlan;
  const executeTrim = deps.runTrimExecution ?? runCodexTrimExecution;
  const trimSource = buildTrimSource({
    threadId,
    codexHome,
    projectPath,
    sourceReason:
      codexThreadIdSource && codexThreadIdSource.startsWith('payload:')
        ? 'payload_codex_thread_rollout'
        : 'auto_refresh_codex_thread_rollout',
  });
  if (!trimSource) {
    return {
      status: 'skipped',
      reason: 'codex_rollout_unavailable',
      decision,
    };
  }

  const plan = buildPlan(db, {
    sessionId: sessionId ?? `codex:${threadId}`,
    projectPath,
    host: 'codex',
    trimAll: true,
    codexThreadId: threadId,
    codexThreadIdSource,
    trimSource,
  });
  if (plan.status === 'unavailable') {
    return {
      status: 'skipped',
      reason: plan.reason,
      decision,
      plan,
    };
  }
  if (plan.trim.rollbackTurns < 1) {
    return {
      status: 'skipped',
      reason: 'nothing_to_trim',
      decision,
      plan,
    };
  }
  if (!hasInjectableMemory(plan.memoryPreview)) {
    return {
      status: 'skipped',
      reason: 'injectable_memory_required',
      decision,
      plan,
    };
  }

  const execution = await executeTrim({
    threadId,
    cwd: projectPath,
    rollbackTurns: plan.trim.rollbackTurns,
    memoryText: plan.memoryPreview.text,
    expectedTurns: plan.trim.source === 'codex-rollout' ? plan.trim.capturedTurns : null,
    command,
  });
  if (execution.status === 'refused') {
    return {
      status: 'refused',
      reason: execution.reason,
      decision,
      plan,
      execution,
    };
  }

  const postInjectVisibilityStatus = execution.postInjectVisibilityCheck?.status ?? 'unchecked';
  if (postInjectVisibilityStatus !== 'match') {
    return {
      status: 'unverified',
      reason: execution.postInjectVisibilityCheck?.reason ?? 'post_inject_visibility_unverified',
      decision,
      plan,
      execution,
    };
  }

  return {
    status: 'refreshed-live',
    reason: 'rollback_and_inject_sent_live',
    decision,
    plan,
    execution,
  };
}

function hasInjectableMemory(memoryPreview) {
  const text = memoryPreview?.text;
  return (
    memoryPreview?.stats?.source === 'throughline-db' &&
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text !== '(no captured memory available)'
  );
}
