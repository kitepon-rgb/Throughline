/**
 * Codex-facing projection for Throughline handoff records.
 *
 * This is a plain JSON context block. It does not call codex-sidecar and does
 * not infer host capabilities; Phase 5 diagnostics decide whether a sidecar
 * can consume it.
 */

export const THROUGHLINE_HANDOFF_SCHEMA_VERSION = 1;

function firstNonEmptyLine(text) {
  if (!text) return null;
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function summarizeRecord(record) {
  const memoLine = firstNonEmptyLine(record.memory?.inflightMemo);
  if (memoLine) return `In-flight handoff: ${memoLine}`;

  const thinkingLine = firstNonEmptyLine(record.memory?.latestThinking?.[0]?.text);
  if (thinkingLine) return `Latest thinking: ${thinkingLine}`;

  const l1Line = firstNonEmptyLine(record.memory?.l1Summaries?.[0]?.summary);
  if (l1Line) return `Prior context summary: ${l1Line}`;

  return `Throughline handoff for ${record.stats?.preservedContextRows ?? 0} preserved memory rows.`;
}

function toDetailReference(ref) {
  return {
    type: 'throughline_detail',
    label: `${ref.kind}:${ref.toolName}`,
    command: ref.detailCommand,
    sourceId: ref.sourceId,
    detailKind: ref.kind,
    originSessionId: ref.originSessionId,
    turnNumber: ref.turnNumber,
  };
}

/**
 * @param {ReturnType<import('./handoff-record.mjs').buildHandoffRecord>} record
 * @param {{ hostMode?: 'claude-primary' | 'codex-primary' | 'unknown' }} [options]
 */
export function toThroughlineHandoffBlock(record, { hostMode = 'claude-primary' } = {}) {
  if (!record) {
    throw new Error('toThroughlineHandoffBlock: record is required');
  }

  return {
    kind: 'throughline_handoff',
    source: 'throughline',
    trust: 'local',
    summary: summarizeRecord(record),
    data: {
      throughlineHandoffSchemaVersion: THROUGHLINE_HANDOFF_SCHEMA_VERSION,
      handoffRecordVersion: record.version,
      sessionId: record.session.id,
      projectPath: record.session.projectPath,
      sourceAgent: record.source.adapter,
      hostMode,
      intent: record.intent,
      constraints: record.constraints,
      originSessionIds: record.source.originSessionIds,
      stats: record.stats,
      memory: record.memory,
      detailReferences: record.references.l3.map(toDetailReference),
    },
  };
}
