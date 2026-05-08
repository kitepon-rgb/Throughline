/**
 * Codex-facing projection for Throughline handoff records.
 *
 * This is a plain JSON context block. It does not call codex-sidecar and does
 * not infer host capabilities; Phase 5 diagnostics decide whether a sidecar
 * can consume it.
 */

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

function uniqueDetailRefsByCommand(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = ref.detailCommand;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function renderCodexActiveWorkContext(record) {
  if (!record) {
    throw new Error('renderCodexActiveWorkContext: record is required');
  }

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
    lines.push('');
    lines.push('### L1 Summaries');
    for (const row of record.memory.l1Summaries) {
      if (!row.summary || row.summary === '(no content)') continue;
      lines.push(`[${row.time}] [${row.role}] ${row.summary.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    lines.push('');
    lines.push('### Active Work Thread (L2)');
    lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
    for (const row of record.memory.recentBodies) {
      if (!row.text) continue;
      lines.push(`[${row.time}] [${row.role}] ${row.text}`);
    }
  }

  if (record.references.l3.length > 0) {
    lines.push('');
    lines.push('### Detail References');
    lines.push(
      'Use these only when L1/L2 are insufficient. Run the command locally; do not guess missing tool output.',
    );
    for (const ref of record.references.l3) {
      lines.push(`- ${ref.kind}:${ref.toolName} turn ${ref.turnNumber}: ${ref.detailCommand}`);
    }
  }

  lines.push('');
  lines.push('### Continuation Instruction');
  lines.push(
    'Continue from the latest actionable state represented above. Preserve user instructions and repository constraints. ' +
      'If details are missing, inspect local files or Throughline detail references before acting.',
  );

  return lines.join('\n');
}

export function renderCodexNewThreadHandoff(
  record,
  {
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

  if (record.memory.l1Summaries.length > 0) {
    lines.push('');
    lines.push('### L1 Memory Summaries');
    lines.push('Oldest-to-newest; use later entries when summaries disagree.');
    for (const row of record.memory.l1Summaries) {
      if (!row.summary || row.summary === '(no content)') continue;
      lines.push(`[${row.time}] [${row.role}] ${singleLine(row.summary)}`);
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
    if (shownBodies.length === 0) {
      lines.push(`${bodies.length} active L2 entries available; omitted from this fresh-thread handoff.`);
    } else if (omittedBodies > 0) {
      lines.push(`Showing latest ${shownBodies.length} of ${bodies.length} active L2 entries; ${omittedBodies} older omitted.`);
    }
    for (const row of shownBodies) {
      if (!row.text) continue;
      const body = truncateText(row.text, maxBodyChars);
      lines.push(`[${row.time}] [${row.role}] ${body.text}`);
      if (body.truncated) {
        lines.push(`[entry truncated to ${maxBodyChars} chars]`);
      }
    }
  }

  if (record.references.l3.length > 0) {
    const refs = uniqueDetailRefsByCommand(record.references.l3);
    const shown = maxDetailRefs === 0 ? [] : refs.slice(-maxDetailRefs);
    const omitted = refs.length - shown.length;
    lines.push('');
    lines.push('### Detail References');
    lines.push('L3 bodies are not pasted here. Use local detail commands only when L1/L2 are insufficient.');
    if (shown.length === 0) {
      lines.push(`${refs.length} detail commands available; omitted from this fresh-thread handoff.`);
    } else {
      if (omitted > 0) {
        lines.push(`Showing latest ${shown.length} of ${refs.length} detail commands; ${omitted} older omitted.`);
      }
      for (const ref of shown) {
        lines.push(`- ${ref.kind}:${ref.toolName} turn ${ref.turnNumber}: ${ref.detailCommand}`);
      }
    }
  }

  lines.push('');
  lines.push('### Start Instruction');
  lines.push(
    'Continue from the latest actionable state above. Preserve user instructions and repository constraints. ' +
      'Do not mutate the original Codex thread; inspect local files or detail references before acting when context is missing.',
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
