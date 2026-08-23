import { inspectCodexPlannedRollbackRestoreSafety } from './codex-rollout-memory.mjs';
import { CLAUDE_HOST, CODEX_HOST } from './hosts/identity.mjs';
import { buildHandoffRecord, N_RECENT_L2 } from './handoff-record.mjs';
import { sameProjectPath } from './project-path.mjs';
import { estimateTokens } from './token-estimator.mjs';

export const DEFAULT_TRIM_KEEP_RECENT = N_RECENT_L2;
export const DEFAULT_TRIM_PREVIEW_MAX_CHARS = 1_500;
export const TRIM_HOSTS = Object.freeze(['claude', 'codex', 'unknown']);

function assertKeepRecent(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('keepRecent must be a non-negative integer');
  }
}

function loadSession(db, sessionId) {
  try {
    return (
      db
        .prepare(
          `SELECT session_id, project_path, status, created_at, updated_at, merged_into
           FROM sessions
           WHERE session_id = ?`,
        )
        .get(sessionId) ?? null
    );
  } catch {
    return null;
  }
}

export function findLatestSessionIdForProject(db, projectPath) {
  if (!projectPath) return null;
  try {
    const rows = db
      .prepare(
        `SELECT session_id, project_path
         FROM sessions
         ORDER BY updated_at DESC`,
      )
      .all();
    const row = rows.find((candidate) => sameProjectPath(candidate.project_path, projectPath));
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

function resolveDefaultSessionId({ sessionId, host, codexThreadId, db, projectPath }) {
  if (sessionId) return sessionId;
  if (host === CODEX_HOST) {
    return codexThreadId ? `codex:${codexThreadId}` : null;
  }
  return findLatestSessionIdForProject(db, projectPath);
}

function countDistinctCapturedTurns(db, sessionId) {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT origin_session_id, turn_number
           FROM bodies
           WHERE session_id = ?
           GROUP BY origin_session_id, turn_number
           UNION
           SELECT origin_session_id, turn_number
           FROM skeletons
           WHERE session_id = ?
           GROUP BY origin_session_id, turn_number
         )`,
      )
      .get(sessionId, sessionId);
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export function describeTrimHost(host) {
  if (host === CLAUDE_HOST) {
    return {
      host,
      automaticRollback: false,
      automaticInject: false,
      status: 'manual-only',
      reason: 'claude_rewind_conversation_only_not_automated',
      manualProcedure: [
        'Run this dry-run first and review the rollback / injection plan.',
        'If acceptable, use Claude Code /rewind conversation only manually.',
        'Paste or otherwise provide the curated memory preview back to Claude after rewind.',
      ],
    };
  }

  if (host === CODEX_HOST) {
    return {
      host,
      automaticRollback: true,
      automaticInject: true,
      status: 'ready',
      reason: 'codex_rollback_inject_available',
      manualProcedure: [
        'Run this dry-run first and review the rollback / injection plan.',
        'Use --preflight for a read/resume guard; it does not send rollback or inject.',
        'Use --execute for rollback + Throughline DB memory injection into the current Codex thread.',
      ],
    };
  }

  return {
    host: 'unknown',
    automaticRollback: false,
    automaticInject: false,
    status: 'unresolved',
    reason: 'host_unknown',
    manualProcedure: [
      'Pass --host claude or --host codex to get host-specific trim guidance.',
      'Do not run automatic rollback from an unknown host.',
    ],
  };
}

function buildSafeContinuation({ host, hostIdentity }) {
  if (host !== CODEX_HOST) return null;

  const threadId = hostIdentity?.codexThreadId ?? '<thread-id>';
  const sessionId = threadId === '<thread-id>' ? 'codex:<thread-id>' : `codex:${threadId}`;
  return {
    status: 'fresh-thread-handoff-available',
    reason: 'optional_fresh_thread_continuation',
    safetyScope: 'fresh_thread_handoff_no_current_thread_mutation',
    mutatesCurrentThread: false,
    memoryCommand: `throughline codex-resume --session ${sessionId} --format handoff`,
    smokeCommand: `throughline codex-handoff-smoke --session ${sessionId}`,
    modelSmokeDryRunCommand: `throughline codex-handoff-model-smoke --session ${sessionId} --dry-run --json`,
    guidedCommand: `throughline codex-handoff-start --session ${sessionId}`,
    procedure: [
      'Use the guided command for the full read-only fresh-thread start plan, or run the individual smoke / render commands below.',
      'Validate the fresh-thread handoff prompt with the smoke command.',
      'Optionally dry-run the model smoke command to inspect the exact Codex exec boundary without starting a model turn.',
      'Render the fresh-thread handoff with the memory command.',
      'Start a new Codex thread with that handoff context only when fresh-thread continuation is explicitly desired.',
      'Use trim --execute --host codex for current-thread rollback / inject when the guarded execute inputs are present.',
    ],
  };
}

function collectMemoryPreview(record) {
  if (!record) {
    return {
      text: '(no captured memory available)',
      truncated: false,
      stats: {
        source: 'throughline-db',
        l1Summaries: 0,
        recentBodies: 0,
        latestThinking: 0,
        l3References: 0,
        recentTurnLimit: N_RECENT_L2,
      },
    };
  }

  const lines = [];
  lines.push('## Throughline: Active Work Context');
  lines.push('');
  lines.push(`Intent: ${record.intent}`);
  lines.push('');
  lines.push('### Reading Contract');
  lines.push(
    'This preview is current-task context for continuation, not a passive archive. ' +
      'Entries are oldest-to-newest; later entries may supersede earlier hypotheses.',
  );

  if (record.memory.inflightMemo) {
    lines.push('');
    lines.push('### In-flight Memo');
    lines.push(record.memory.inflightMemo);
  }

  if (record.memory.latestThinking.length > 0) {
    lines.push('');
    lines.push('### Latest Thinking');
    for (const row of record.memory.latestThinking.slice(-2)) {
      lines.push(`[${row.time}] ${row.text}`);
    }
  }

  if (record.memory.l1Summaries.length > 0) {
    lines.push('');
    lines.push('### L1 Summaries');
    for (const row of record.memory.l1Summaries) {
      lines.push(`[${row.time}] ${row.summary.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    lines.push('');
    lines.push('### Active Work Thread (Recent L2)');
    lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
    for (const row of record.memory.recentBodies) {
      lines.push(`[${row.time}] [${row.role}] ${row.text.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.references.l3.length > 0) {
    lines.push('');
    lines.push('### L3 Detail References (Bodies Not Injected)');
    for (const ref of record.references.l3) {
      lines.push(`- ${ref.kind}: ${ref.detailCommand}`);
    }
  }

  lines.push('');
  lines.push('### Continuation Instruction');
  lines.push(
    'Use the latest L2 entries, in-flight memo, and latest thinking to infer the next action. ' +
      'Do not treat every older line as still-current truth.',
  );

  const fullText = lines.join('\n');
  return {
    text: fullText,
    truncated: false,
    stats: {
      source: 'throughline-db',
      l1Summaries: record.memory.l1Summaries.length,
      recentBodies: record.memory.recentBodies.length,
      latestThinking: record.memory.latestThinking.length,
      l3References: record.references.l3.length,
      recentTurnLimit: N_RECENT_L2,
    },
  };
}

export function buildTrimPlan(
  db,
  {
    sessionId = null,
    projectPath = null,
    host = 'unknown',
    keepRecent = DEFAULT_TRIM_KEEP_RECENT,
    trimAll = false,
    inflightMemo = null,
    codexThreadId = null,
    codexThreadIdSource = null,
    trimSource = null,
    previewMaxChars = DEFAULT_TRIM_PREVIEW_MAX_CHARS,
  } = {},
) {
  const normalizedHost = TRIM_HOSTS.includes(host) ? host : 'unknown';
  const normalizedTrimSource = normalizeTrimSource(trimSource);
  const resolvedSessionId = resolveDefaultSessionId({
    sessionId,
    host: normalizedHost,
    codexThreadId,
    db,
    projectPath,
  });
  if (!resolvedSessionId && !normalizedTrimSource) {
    return {
      status: 'unavailable',
      reason: 'no_session',
      session: null,
      host: describeTrimHost(normalizedHost),
    };
  }

  const session = resolvedSessionId ? loadSession(db, resolvedSessionId) : null;
  if (resolvedSessionId && !session && !normalizedTrimSource) {
    return {
      status: 'unavailable',
      reason: 'session_not_found',
      session: { id: resolvedSessionId },
      host: describeTrimHost(normalizedHost),
    };
  }

  const effectiveKeepRecent = trimAll ? 0 : keepRecent;
  assertKeepRecent(effectiveKeepRecent);

  const capturedTurns =
    normalizedTrimSource?.capturedTurns ?? countDistinctCapturedTurns(db, resolvedSessionId);
  const rollbackTurns = Math.max(0, capturedTurns - effectiveKeepRecent);
  const keepTurns = capturedTurns - rollbackTurns;
  const record = resolvedSessionId
    ? buildHandoffRecord(db, {
        sessionId: resolvedSessionId,
        isInheritance: false,
        inflightMemo,
        recentTurnLimit: DEFAULT_TRIM_KEEP_RECENT,
      })
    : null;
  const memoryPreview = record ? collectMemoryPreview(record) : normalizedTrimSource?.memoryPreview ?? collectMemoryPreview(null);
  const contextReductionEstimate = estimateContextReduction({
    trimSource: normalizedTrimSource,
    rollbackTurns,
    memoryPreviewText: memoryPreview.text,
  });
  const plannedRollbackRestoreSafety = buildPlannedRollbackRestoreSafety({
    trimSource: normalizedTrimSource,
    rollbackTurns,
  });
  const hostInfo = describeTrimHost(normalizedHost);
  const hostIdentity = buildHostIdentity({
    host: normalizedHost,
    codexThreadId,
    codexThreadIdSource,
  });

  return {
    status: rollbackTurns === 0 ? 'noop' : hostInfo.status,
    reason: rollbackTurns === 0 ? 'nothing_to_trim' : hostInfo.reason,
    mode: 'dry-run',
    session: buildPlanSession({
      resolvedSessionId,
      session,
      trimSource: normalizedTrimSource,
      projectPath,
    }),
    host: hostInfo,
    hostIdentity,
    safeContinuation: buildSafeContinuation({ host: normalizedHost, hostIdentity }),
    display: {
      previewMaxChars,
    },
    trim: {
      source: normalizedTrimSource?.source ?? 'throughline-db',
      sourceReason: normalizedTrimSource?.sourceReason ?? 'throughline_db_session',
      rolloutPath: normalizedTrimSource?.rolloutPath ?? null,
      capturedTurns,
      keepRecent: effectiveKeepRecent,
      keepTurns,
      rollbackTurns,
      trimAll: Boolean(trimAll),
      automaticExecutionAllowed:
        rollbackTurns > 0 && hostInfo.automaticRollback && hostInfo.automaticInject,
      contextReductionEstimate,
      restoreSafety: normalizedTrimSource?.restoreSafety ?? null,
      plannedRollbackRestoreSafety,
      rolloutStats: normalizedTrimSource?.stats ?? null,
    },
    memoryPreview,
  };
}

export function renderTrimDryRunReport(plan) {
  const lines = [];
  lines.push('## Throughline Trim Dry-run');
  lines.push('');
  lines.push(`Status: ${plan.status}`);
  if (plan.reason) lines.push(`Reason: ${plan.reason}`);

  if (!plan.session) {
    lines.push('');
    lines.push('No session was found for this project. Pass --session <id> explicitly.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Session: ${plan.session.id}`);
  lines.push(`Project: ${plan.session.projectPath}`);
  lines.push(`Host: ${plan.host.host}`);
  if (plan.hostIdentity?.codexThreadId) {
    lines.push(`Codex thread: ${plan.hostIdentity.codexThreadId}`);
  }
  if (plan.trim.source) {
    lines.push(`Trim source: ${plan.trim.source}`);
  }
  lines.push(`Captured turns: ${plan.trim.capturedTurns}`);
  lines.push(`Keep recent turns: ${plan.trim.keepRecent}`);
  lines.push(`Rollback candidate turns: ${plan.trim.rollbackTurns}`);
  if (plan.trim.contextReductionEstimate) {
    const estimate = plan.trim.contextReductionEstimate;
    lines.push(`Estimated rollback tokens: ${estimate.rollbackEstimatedTokens}`);
    lines.push(`Estimated injected memory tokens: ${estimate.injectedMemoryEstimatedTokens}`);
    lines.push(
      `Estimated net token reduction: ${estimate.netEstimatedTokens} (${estimate.reductionPct}%, ${estimate.method})`,
    );
  }
  if (plan.trim.restoreSafety) {
    lines.push(...renderRestoreSafetyLines(plan.trim.restoreSafety));
  }
  if (plan.trim.plannedRollbackRestoreSafety) {
    lines.push(...renderPlannedRollbackRestoreSafetyLines(plan.trim.plannedRollbackRestoreSafety));
  }
  lines.push(`Automatic execution allowed: ${plan.trim.automaticExecutionAllowed ? 'yes' : 'no'}`);

  lines.push('');
  lines.push('### Host Boundary');
  lines.push(`- automatic rollback: ${plan.host.automaticRollback ? 'yes' : 'no'}`);
  lines.push(`- automatic inject: ${plan.host.automaticInject ? 'yes' : 'no'}`);
  lines.push(`- boundary status: ${plan.host.status}`);
  lines.push(`- boundary reason: ${plan.host.reason}`);

  if (plan.safeContinuation) {
    lines.push('');
    lines.push('### Safe Continuation Path');
    lines.push(`- status: ${plan.safeContinuation.status}`);
    lines.push(`- reason: ${plan.safeContinuation.reason}`);
    if (plan.safeContinuation.safetyScope) {
      lines.push(`- safety scope: ${plan.safeContinuation.safetyScope}`);
    }
    lines.push(`- mutates current thread: ${plan.safeContinuation.mutatesCurrentThread ? 'yes' : 'no'}`);
    if (plan.safeContinuation.guidedCommand) {
      lines.push(`- guided command: ${plan.safeContinuation.guidedCommand}`);
    }
    if (plan.safeContinuation.smokeCommand) {
      lines.push(`- smoke command: ${plan.safeContinuation.smokeCommand}`);
    }
    if (plan.safeContinuation.modelSmokeDryRunCommand) {
      lines.push(`- model smoke dry-run: ${plan.safeContinuation.modelSmokeDryRunCommand}`);
    }
    lines.push(`- memory command: ${plan.safeContinuation.memoryCommand}`);
    for (const step of plan.safeContinuation.procedure) {
      lines.push(`- ${step}`);
    }
  }

  lines.push('');
  lines.push('### Manual Procedure');
  for (const step of plan.host.manualProcedure) {
    lines.push(`- ${step}`);
  }

  lines.push('');
  lines.push('### Curated Memory Preview');
  const renderedPreview = renderMemoryPreviewForReport({
    text: plan.memoryPreview.text,
    maxChars: plan.display?.previewMaxChars,
  });
  lines.push(renderedPreview.text);
  if (renderedPreview.truncated) {
    lines.push('');
    lines.push(
      `[preview truncated to ${renderedPreview.maxChars} chars; full memory remains available in JSON memoryPreview.text]`,
    );
    if (plan.safeContinuation?.guidedCommand) {
      lines.push(`[fresh-thread Codex guided start: ${plan.safeContinuation.guidedCommand}]`);
    }
    if (plan.safeContinuation?.memoryCommand) {
      lines.push(`[fresh-thread Codex handoff: ${plan.safeContinuation.memoryCommand}]`);
    }
  }

  return lines.join('\n');
}

function renderMemoryPreviewForReport({ text, maxChars }) {
  const normalizedMaxChars = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : null;
  if (!normalizedMaxChars || text.length <= normalizedMaxChars) {
    return { text, truncated: false, maxChars: normalizedMaxChars };
  }

  return {
    text: `${text.slice(0, normalizedMaxChars).trimEnd()}\n...`,
    truncated: true,
    maxChars: normalizedMaxChars,
  };
}

function renderRestoreSafetyLines(restoreSafety) {
  const lines = [];
  lines.push(`Restore safety: ${restoreSafety.status}`);
  lines.push(`Compacted rows: ${restoreSafety.compactedRows}`);
  lines.push(`Compacted replacement user messages: ${restoreSafety.compactedReplacementUserMessages}`);
  lines.push(
    `Rollback text retained in compacted history: ${restoreSafety.rollbackTextRetainedInCompacted}`,
  );
  lines.push(`Resurrected user messages after rollback: ${restoreSafety.resurrectedUserMessages}`);
  for (const risk of restoreSafety.risks ?? []) {
    lines.push(`Restore safety risk: ${risk.type} (${risk.count})`);
  }
  return lines;
}

function renderPlannedRollbackRestoreSafetyLines(plannedSafety) {
  const lines = [];
  lines.push(`Planned rollback restore safety: ${plannedSafety.status}`);
  lines.push(
    `Planned rollback text retained in compacted history: ${plannedSafety.rollbackTextRetainedInCompacted}`,
  );
  for (const risk of plannedSafety.risks ?? []) {
    lines.push(`Planned rollback restore safety risk: ${risk.type} (${risk.count})`);
  }
  return lines;
}

function normalizeTrimSource(trimSource) {
  if (!trimSource) return null;
  if (!Number.isInteger(trimSource.capturedTurns) || trimSource.capturedTurns < 0) {
    throw new Error('trimSource.capturedTurns must be a non-negative integer');
  }
  if (!trimSource.memoryPreview || typeof trimSource.memoryPreview.text !== 'string') {
    throw new Error('trimSource.memoryPreview.text is required');
  }

  return {
    ...trimSource,
    source: trimSource.source ?? 'external',
    sourceReason: trimSource.sourceReason ?? 'external_trim_source',
  };
}

function estimateContextReduction({ trimSource, rollbackTurns, memoryPreviewText }) {
  const turnEstimates = trimSource?.contextEstimate?.turns;
  if (!Array.isArray(turnEstimates)) return null;

  const rollbackRows = rollbackTurns > 0 ? turnEstimates.slice(-rollbackTurns) : [];
  const rollbackEstimatedTokens = rollbackRows.reduce(
    (sum, row) => sum + (Number.isFinite(row.estimatedTokens) ? row.estimatedTokens : 0),
    0,
  );
  const injectedMemoryEstimatedTokens = rollbackTurns > 0 ? estimateTokens(memoryPreviewText) : 0;
  const netEstimatedTokens = Math.max(0, rollbackEstimatedTokens - injectedMemoryEstimatedTokens);
  const reductionPct =
    rollbackEstimatedTokens > 0 ? Math.max(0, Math.round((netEstimatedTokens / rollbackEstimatedTokens) * 100)) : 0;

  return {
    method: trimSource.contextEstimate.method ?? 'chars_div_4',
    scope: 'rollback_candidate_vs_injected_memory',
    rollbackTurns,
    rollbackEstimatedTokens,
    injectedMemoryEstimatedTokens,
    netEstimatedTokens,
    reductionPct,
    note: 'Heuristic estimate from rollout text length; not a host tokenizer measurement.',
  };
}

function buildPlannedRollbackRestoreSafety({ trimSource, rollbackTurns }) {
  if (trimSource?.source !== 'codex-rollout') return null;
  if (!trimSource.rolloutPath) return null;
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 1) return null;
  return inspectCodexPlannedRollbackRestoreSafety({
    rolloutPath: trimSource.rolloutPath,
    rollbackTurns,
  });
}

function buildPlanSession({ resolvedSessionId, session, trimSource, projectPath }) {
  if (session) {
    return {
      id: resolvedSessionId,
      projectPath: session.project_path,
      status: session.status,
      mergedInto: session.merged_into ?? null,
      source: 'throughline-db',
    };
  }

  return {
    id: resolvedSessionId ?? trimSource?.threadId ?? null,
    projectPath: trimSource?.projectPath ?? projectPath ?? null,
    status: 'external',
    mergedInto: null,
    source: trimSource?.source ?? 'external',
  };
}

function buildHostIdentity({ host, codexThreadId, codexThreadIdSource = null }) {
  if (host !== CODEX_HOST) {
    return {
      host,
      codexThreadId: null,
      explicit: false,
      reason: 'not_codex_host',
    };
  }

  if (typeof codexThreadId === 'string' && codexThreadId.length > 0) {
    if (typeof codexThreadIdSource === 'string' && codexThreadIdSource.startsWith('env:')) {
      return {
        host,
        codexThreadId,
        explicit: false,
        reason: 'env_codex_thread_id',
        source: codexThreadIdSource,
      };
    }

    return {
      host,
      codexThreadId,
      explicit: true,
      reason: 'explicit_codex_thread_id',
    };
  }

  return {
    host,
    codexThreadId: null,
    explicit: false,
    reason: 'codex_thread_id_not_provided',
  };
}
