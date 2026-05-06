import { buildHandoffRecord, N_RECENT_L2 } from './handoff-record.mjs';

export const DEFAULT_TRIM_KEEP_RECENT = N_RECENT_L2;
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
    const row = db
      .prepare(
        `SELECT session_id
         FROM sessions
         WHERE lower(project_path) = lower(?)
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(projectPath);
    return row?.session_id ?? null;
  } catch {
    return null;
  }
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
  if (host === 'claude') {
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

  if (host === 'codex') {
    return {
      host,
      automaticRollback: false,
      automaticInject: false,
      status: 'verified-host-primitive',
      reason: 'codex_thread_rollback_inject_verified_but_not_integrated',
      manualProcedure: [
        'Run this dry-run first and review the rollback / injection plan.',
        'Codex app-server thread/rollback and thread/inject_items are verified host primitives.',
        'Do not run automatic trim until Throughline can identify and control the intended Codex thread explicitly.',
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

function collectMemoryPreview(record, maxChars) {
  if (!record) {
    return {
      text: '(no captured memory available)',
      truncated: false,
      stats: {
        l1Summaries: 0,
        recentBodies: 0,
        latestThinking: 0,
        l3References: 0,
      },
    };
  }

  const lines = [];
  lines.push('## Throughline Trim Memory Preview');
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
    for (const row of record.memory.l1Summaries.slice(-8)) {
      lines.push(`[${row.time}] ${row.summary.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    lines.push('');
    lines.push('### Active Work Thread (Recent L2)');
    lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
    for (const row of record.memory.recentBodies.slice(-8)) {
      lines.push(`[${row.time}] [${row.role}] ${row.text.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.references.l3.length > 0) {
    lines.push('');
    lines.push('### L3 Detail References');
    for (const ref of record.references.l3.slice(-8)) {
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
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      truncated: false,
      stats: {
        l1Summaries: record.memory.l1Summaries.length,
        recentBodies: record.memory.recentBodies.length,
        latestThinking: record.memory.latestThinking.length,
        l3References: record.references.l3.length,
      },
    };
  }

  return {
    text: `${fullText.slice(0, maxChars).trimEnd()}\n\n[truncated for dry-run preview]`,
    truncated: true,
    stats: {
      l1Summaries: record.memory.l1Summaries.length,
      recentBodies: record.memory.recentBodies.length,
      latestThinking: record.memory.latestThinking.length,
      l3References: record.references.l3.length,
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
    previewMaxChars = 1_500,
  } = {},
) {
  const normalizedHost = TRIM_HOSTS.includes(host) ? host : 'unknown';
  const resolvedSessionId = sessionId ?? findLatestSessionIdForProject(db, projectPath);
  if (!resolvedSessionId) {
    return {
      status: 'unavailable',
      reason: 'no_session',
      session: null,
      host: describeTrimHost(normalizedHost),
    };
  }

  const session = loadSession(db, resolvedSessionId);
  if (!session) {
    return {
      status: 'unavailable',
      reason: 'session_not_found',
      session: { id: resolvedSessionId },
      host: describeTrimHost(normalizedHost),
    };
  }

  const effectiveKeepRecent = trimAll ? 0 : keepRecent;
  assertKeepRecent(effectiveKeepRecent);

  const capturedTurns = countDistinctCapturedTurns(db, resolvedSessionId);
  const rollbackTurns = Math.max(0, capturedTurns - effectiveKeepRecent);
  const keepTurns = capturedTurns - rollbackTurns;
  const record = buildHandoffRecord(db, {
    sessionId: resolvedSessionId,
    isInheritance: false,
    inflightMemo,
    recentTurnLimit: DEFAULT_TRIM_KEEP_RECENT,
  });
  const memoryPreview = collectMemoryPreview(record, previewMaxChars);
  const hostInfo = describeTrimHost(normalizedHost);

  return {
    status: rollbackTurns === 0 ? 'noop' : hostInfo.status,
    reason: rollbackTurns === 0 ? 'nothing_to_trim' : hostInfo.reason,
    mode: 'dry-run',
    session: {
      id: resolvedSessionId,
      projectPath: session.project_path,
      status: session.status,
      mergedInto: session.merged_into ?? null,
    },
    host: hostInfo,
    hostIdentity: buildHostIdentity({
      host: normalizedHost,
      codexThreadId,
    }),
    trim: {
      capturedTurns,
      keepRecent: effectiveKeepRecent,
      keepTurns,
      rollbackTurns,
      trimAll: Boolean(trimAll),
      automaticExecutionAllowed:
        rollbackTurns > 0 && hostInfo.automaticRollback && hostInfo.automaticInject,
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
  lines.push(`Captured turns: ${plan.trim.capturedTurns}`);
  lines.push(`Keep recent turns: ${plan.trim.keepRecent}`);
  lines.push(`Rollback candidate turns: ${plan.trim.rollbackTurns}`);
  lines.push(`Automatic execution allowed: ${plan.trim.automaticExecutionAllowed ? 'yes' : 'no'}`);

  lines.push('');
  lines.push('### Host Boundary');
  lines.push(`- automatic rollback: ${plan.host.automaticRollback ? 'yes' : 'no'}`);
  lines.push(`- automatic inject: ${plan.host.automaticInject ? 'yes' : 'no'}`);
  lines.push(`- boundary status: ${plan.host.status}`);
  lines.push(`- boundary reason: ${plan.host.reason}`);

  lines.push('');
  lines.push('### Manual Procedure');
  for (const step of plan.host.manualProcedure) {
    lines.push(`- ${step}`);
  }

  lines.push('');
  lines.push('### Curated Memory Preview');
  lines.push(plan.memoryPreview.text);

  return lines.join('\n');
}

function buildHostIdentity({ host, codexThreadId }) {
  if (host !== 'codex') {
    return {
      host,
      codexThreadId: null,
      explicit: false,
      reason: 'not_codex_host',
    };
  }

  if (typeof codexThreadId === 'string' && codexThreadId.length > 0) {
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
