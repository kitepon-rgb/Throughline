import { buildCodexRolloutTrimSource } from './codex-rollout-memory.mjs';
import { defaultCodexHome } from './codex-thread-index.mjs';

export function inspectCodexVsCodeRollbackSmoke({
  threadId,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  afterVsCodeRestart = false,
} = {}) {
  assertNonEmptyString(threadId, 'threadId');

  const trimSource = buildCodexRolloutTrimSource({
    threadId,
    codexHome,
    projectPath,
    sourceReason: 'vscode_rollback_nonresurrection_smoke',
  });

  if (!trimSource) {
    return {
      status: 'refused',
      reason: 'codex_rollout_source_required',
      proofScope: 'none',
      restartSafe: false,
      threadId,
    };
  }

  const stats = trimSource.stats ?? {};
  const restoreSafety = trimSource.restoreSafety ?? null;
  const base = {
    threadId,
    rolloutPath: trimSource.rolloutPath,
    afterVsCodeRestart: Boolean(afterVsCodeRestart),
    stats,
    restoreSafety,
  };

  if ((stats.rollbackEvents ?? 0) < 1) {
    return pending(base, 'no_rollback_event_observed');
  }
  if ((stats.rolledBackUserMessages ?? 0) < 1) {
    return pending(base, 'no_rolled_back_user_message_observed');
  }
  if ((stats.userMessagesAfterRollback ?? 0) < 1) {
    return pending(base, 'no_user_message_after_rollback_observed');
  }
  if (restoreSafety?.status !== 'ok') {
    return {
      ...base,
      status: 'risk',
      reason: 'restore_safety_risk',
      proofScope: 'codex_rollout_restore_safety_only',
      restartSafe: false,
    };
  }
  if (!afterVsCodeRestart) {
    return {
      ...base,
      status: 'rollback-nonresurrection-visible-restart-unacknowledged',
      reason: 'rollback_user_text_absent_after_rollback_without_restart_ack',
      proofScope: 'codex_rollout_restore_safety_only',
      restartSafe: false,
    };
  }

  return {
    ...base,
    status: 'vscode-restart-rollback-nonresurrection-visible',
    reason: 'rollback_user_text_absent_after_restart_ack',
    proofScope: 'manual_vscode_reload_plus_rollout_restore_safety',
    restartSafe: true,
  };
}

function pending(base, reason) {
  return {
    ...base,
    status: 'pending',
    reason,
    proofScope: 'codex_rollout_restore_safety_only',
    restartSafe: false,
  };
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
