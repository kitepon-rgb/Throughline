/**
 * Codex-facing projection for Throughline handoff records.
 *
 * This is a plain JSON context block. It does not call codex-sidecar and does
 * not infer host capabilities; Phase 5 diagnostics decide whether a sidecar
 * can consume it.
 */

import { groupL3ByTurn, buildPartsSummary } from './l3-summary.mjs';

export const THROUGHLINE_HANDOFF_SCHEMA_VERSION = 1;
export const DEFAULT_CODEX_HANDOFF_DETAIL_REF_LIMIT = 20;
export const DEFAULT_CODEX_HANDOFF_RECENT_BODY_LIMIT = 8;
export const DEFAULT_CODEX_HANDOFF_BODY_MAX_CHARS = 1_600;

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

function singleLine(text) {
  return String(text ?? '').replace(/\n+/g, ' ').trim();
}

function assertDetailRefLimit(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('maxDetailRefs must be a non-negative integer');
  }
}

function assertRecentBodyLimit(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('maxRecentBodies must be a non-negative integer');
  }
}

function assertBodyMaxChars(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('maxBodyChars must be a non-negative integer');
  }
}

function truncateText(text, maxChars) {
  const value = String(text ?? '');
  if (maxChars === 0) return { text: '', truncated: value.length > 0 };
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

/**
 * 追加: Codex 用 inline detail suffix の組み立て補助。
 * - L1: bodyTime (= 元ターン時刻) を行頭に出して `本文` 起点の詳細を案内
 * - L2: ターン内の最終 role 行 (通常 user→assistant の assistant) にだけ suffix を貼る
 *   (同じ turn_number に紐付く L3 を user / assistant 両方に貼る冗長を回避)
 */
function appendL1Lines(lines, l1Summaries, l3ByTurn) {
  const l1Lines = [];
  for (const row of l1Summaries) {
    if (!row.summary || row.summary === '(no content)') continue;
    const summary = singleLine(row.summary);
    const key = `${row.originSessionId}\x00${row.turnNumber}`;
    const displayTime = row.bodyTime ?? row.time;
    const partCounts = l3ByTurn.get(key)?.partCounts ?? new Map();
    // bodyTime が無い defensive ケース (元 body が消えている等) は detail 解決できないので
    // suffix を付けない (誤誘導しない)。
    const suffix = row.bodyTime != null
      ? buildPartsSummary(partCounts, { includeBody: true })
      : '';
    l1Lines.push(`[${displayTime}] [${row.role}] ${summary}${suffix}`);
  }
  return l1Lines;
}

function appendL2Lines(bodies, l3ByTurn) {
  const lastIdxPerTurn = new Map();
  for (let i = 0; i < bodies.length; i += 1) {
    const r = bodies[i];
    if (!r.text) continue;
    lastIdxPerTurn.set(`${r.originSessionId}\x00${r.turnNumber}`, i);
  }
  const out = [];
  for (let i = 0; i < bodies.length; i += 1) {
    const r = bodies[i];
    if (!r.text) continue;
    const key = `${r.originSessionId}\x00${r.turnNumber}`;
    const isLastOfTurn = lastIdxPerTurn.get(key) === i;
    const partCounts = isLastOfTurn ? (l3ByTurn.get(key)?.partCounts ?? new Map()) : new Map();
    const suffix = buildPartsSummary(partCounts);
    out.push({ row: r, suffix });
  }
  return out;
}

export function renderCodexActiveWorkContext(record) {
  if (!record) {
    throw new Error('renderCodexActiveWorkContext: record is required');
  }

  const l3ByTurn = groupL3ByTurn(record.references.l3);

  const lines = [];
  lines.push('## Throughline: Active Work Context');
  lines.push('');
  lines.push('Intent: Continue the current Codex work thread using persisted Throughline memory.');
  lines.push('');
  lines.push('### Reading Contract');
  lines.push(
    'This is current-task context for continuation, not a passive archive. ' +
      'Use it to infer the next action in the active work thread.',
  );
  lines.push(
    'Entries are oldest-to-newest. Later entries, in-flight memo, and latest thinking may supersede earlier hypotheses.',
  );
  lines.push(
    'Do not treat every older line as still-current truth. Prefer the latest actionable state.',
  );
  lines.push(
    'For each L1/L2 entry, the time prefix `[HH:MM:SS]` can be passed to ' +
      '`throughline detail HH:MM:SS` (run via shell) to retrieve the full body and L3 detail of that turn.',
  );
  lines.push('');
  lines.push('### Source');
  lines.push(`Throughline session: ${record.session.id}`);
  lines.push(`Project: ${record.session.projectPath ?? 'unknown'}`);
  lines.push(`Source agent: ${record.source.adapter}`);

  if (record.memory.inflightMemo) {
    lines.push('');
    lines.push('### In-flight Memo');
    lines.push(record.memory.inflightMemo);
  }

  if (record.memory.latestThinking.length > 0) {
    lines.push('');
    lines.push('### Latest Thinking');
    for (const row of record.memory.latestThinking) {
      lines.push(`[${row.time}] ${row.text}`);
    }
  }

  if (record.memory.l1Summaries.length > 0) {
    const l1Lines = appendL1Lines(lines, record.memory.l1Summaries, l3ByTurn);
    if (l1Lines.length > 0) {
      lines.push('');
      lines.push('### L1 Summaries');
      lines.push(...l1Lines);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    const l2 = appendL2Lines(record.memory.recentBodies, l3ByTurn);
    if (l2.length > 0) {
      lines.push('');
      lines.push('### Active Work Thread (L2)');
      lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
      for (const { row, suffix } of l2) {
        lines.push(`[${row.time}] [${row.role}] ${row.text}${suffix}`);
      }
    }
  }

  lines.push('');
  lines.push('### Continuation Instruction');
  lines.push(
    'Continue from the latest actionable state represented above. Preserve user instructions and repository constraints. ' +
      'If details are missing, run `throughline detail HH:MM:SS` on the relevant entry before acting.',
  );

  return lines.join('\n');
}

export function renderCodexNewThreadHandoff(
  record,
  {
    // 旧 Detail References セクション用の制限。L3 が各 L1/L2 行末尾の
    // `(詳細：…)` suffix に集約された後は描画には影響しないが、CLI flags との
    // 互換維持のためバリデーションだけ残す。
    maxDetailRefs = DEFAULT_CODEX_HANDOFF_DETAIL_REF_LIMIT,
    maxRecentBodies = DEFAULT_CODEX_HANDOFF_RECENT_BODY_LIMIT,
    maxBodyChars = DEFAULT_CODEX_HANDOFF_BODY_MAX_CHARS,
  } = {},
) {
  if (!record) {
    throw new Error('renderCodexNewThreadHandoff: record is required');
  }
  assertDetailRefLimit(maxDetailRefs);
  assertRecentBodyLimit(maxRecentBodies);
  assertBodyMaxChars(maxBodyChars);

  const lines = [];
  lines.push('## Throughline: New Codex Thread Handoff');
  lines.push('');
  lines.push(
    'Purpose: Continue this work in a fresh Codex thread without mutating the risky current thread.',
  );
  lines.push(
    'Reading contract: This is current-task context, not a passive archive. Later entries, in-flight memo, and latest thinking supersede earlier notes.',
  );
  lines.push('');
  lines.push('### Source');
  lines.push(`Throughline session: ${record.session.id}`);
  lines.push(`Project: ${record.session.projectPath ?? 'unknown'}`);
  lines.push(`Source agent: ${record.source.adapter}`);
  lines.push('');
  lines.push('### Work Boundary');
  lines.push(`Intent: ${record.intent}`);
  if (record.constraints.length > 0) {
    lines.push('Constraints:');
    for (const constraint of record.constraints) {
      lines.push(`- ${singleLine(constraint)}`);
    }
  }

  if (record.memory.inflightMemo) {
    lines.push('');
    lines.push('### In-flight Memo');
    lines.push(record.memory.inflightMemo);
  }

  if (record.memory.latestThinking.length > 0) {
    lines.push('');
    lines.push('### Latest Thinking');
    for (const row of record.memory.latestThinking) {
      lines.push(`[${row.time}] ${row.text}`);
    }
  }

  const l3ByTurn = groupL3ByTurn(record.references.l3);

  if (record.memory.l1Summaries.length > 0) {
    const l1Lines = appendL1Lines(lines, record.memory.l1Summaries, l3ByTurn);
    if (l1Lines.length > 0) {
      lines.push('');
      lines.push('### L1 Memory Summaries');
      lines.push('Oldest-to-newest; use later entries when summaries disagree.');
      lines.push(...l1Lines);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    const bodies = record.memory.recentBodies;
    const shownBodies = maxRecentBodies === 0 ? [] : bodies.slice(-maxRecentBodies);
    const omittedBodies = bodies.length - shownBodies.length;
    lines.push('');
    lines.push('### Recent Active Thread (L2)');
    lines.push('Oldest-to-newest; this is the active continuation surface.');
    lines.push(
      `Long entries are truncated for handoff; full context: throughline codex-resume --session ${record.session.id}`,
    );
    lines.push(
      'For each entry, the `[HH:MM:SS]` time prefix can be passed to ' +
        '`throughline detail HH:MM:SS` (run via shell) to retrieve full body + L3 of that turn.',
    );
    if (shownBodies.length === 0) {
      lines.push(`${bodies.length} active L2 entries available; omitted from this fresh-thread handoff.`);
    } else if (omittedBodies > 0) {
      lines.push(`Showing latest ${shownBodies.length} of ${bodies.length} active L2 entries; ${omittedBodies} older omitted.`);
    }
    const l2 = appendL2Lines(shownBodies, l3ByTurn);
    for (const { row, suffix } of l2) {
      const body = truncateText(row.text, maxBodyChars);
      lines.push(`[${row.time}] [${row.role}] ${body.text}${suffix}`);
      if (body.truncated) {
        lines.push(`[entry truncated to ${maxBodyChars} chars]`);
      }
    }
  }

  // Detail References セクションは廃止 (各 L1/L2 行末尾の `(詳細：…)` suffix で
  // 同じ情報が turn 単位に集約されるため重複)。

  lines.push('');
  lines.push('### Start Instruction');
  lines.push(
    'Continue from the latest actionable state above. Preserve user instructions and repository constraints. ' +
      'Do not mutate the original Codex thread; run `throughline detail HH:MM:SS` on the relevant entry before acting when context is missing.',
  );

  return lines.join('\n');
}

export function toCodexDeveloperMessageItem(record) {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: renderCodexActiveWorkContext(record),
      },
    ],
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
