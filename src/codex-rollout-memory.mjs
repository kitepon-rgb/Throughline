import { readFileSync } from 'node:fs';

import { defaultCodexHome, findCodexThreadCandidate } from './codex-thread-index.mjs';

const DEFAULT_PREVIEW_MAX_CHARS = 8_000;
const MAX_ENTRY_CHARS = 900;
const MAX_RECENT_ENTRIES = 40;

export function buildCodexRolloutTrimSource({
  threadId,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  previewMaxChars = DEFAULT_PREVIEW_MAX_CHARS,
} = {}) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('threadId is required');
  }

  const candidate = findCodexThreadCandidate({
    threadId,
    codexHome,
    projectPath,
    requireProjectMatch: true,
  });
  if (!candidate) return null;

  const parsed = parseCodexRolloutFile(candidate.rolloutPath);
  const memoryPreview = renderCodexRolloutMemoryPreview({
    candidate,
    parsed,
    previewMaxChars,
  });

  return {
    source: 'codex-rollout',
    sourceReason: 'explicit_codex_thread_rollout',
    threadId,
    projectPath: candidate.cwd ?? projectPath,
    capturedTurns: parsed.activeTurnCount,
    memoryPreview,
    stats: parsed.stats,
  };
}

export function parseCodexRolloutFile(path) {
  const activeTurns = [];
  let openTurn = null;
  let pendingMessages = [];
  const stats = {
    parsedRows: 0,
    corruptRows: 0,
    taskStarted: 0,
    taskComplete: 0,
    rollbackEvents: 0,
    rolledBackTurns: 0,
    injectedDeveloperMessages: 0,
    skippedMessages: 0,
  };

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      stats.parsedRows++;
    } catch {
      stats.corruptRows++;
      continue;
    }

    const payload = row?.payload;
    if (row?.type === 'response_item') {
      const injectedMessage = responseItemToMemoryMessage(payload, row.timestamp);
      if (injectedMessage) {
        activeTurns.push({
          number: `injected-${stats.injectedDeveloperMessages + 1}`,
          messages: [injectedMessage],
        });
        stats.injectedDeveloperMessages++;
      }
      continue;
    }

    if (row?.type !== 'event_msg' || !payload?.type) continue;

    if (payload.type === 'task_started') {
      const turn = {
        number: stats.taskStarted + 1,
        messages: pendingMessages,
      };
      pendingMessages = [];
      activeTurns.push(turn);
      openTurn = turn;
      stats.taskStarted++;
      continue;
    }

    if (payload.type === 'task_complete') {
      stats.taskComplete++;
      openTurn = null;
      continue;
    }

    if (payload.type === 'thread_rolled_back') {
      const count = Math.max(0, Number(payload.num_turns) || 0);
      stats.rollbackEvents++;
      stats.rolledBackTurns += count;
      activeTurns.splice(Math.max(0, activeTurns.length - count), count);
      if (openTurn && !activeTurns.includes(openTurn)) {
        openTurn = null;
      }
      continue;
    }

    const message = eventPayloadToMemoryMessage(payload, row.timestamp);
    if (!message) {
      if (payload.type === 'user_message' || payload.type === 'agent_message') {
        stats.skippedMessages++;
      }
      continue;
    }

    if (openTurn) {
      openTurn.messages.push(message);
    } else {
      pendingMessages.push(message);
    }
  }

  return {
    activeTurnCount: activeTurns.length,
    activeTurns,
    entries: activeTurns.flatMap((turn) =>
      turn.messages.map((message) => ({
        ...message,
        turn: turn.number,
      })),
    ),
    stats,
  };
}

function eventPayloadToMemoryMessage(payload, timestamp) {
  if (payload.type === 'user_message') {
    const text = normalizeMessageText(payload.message);
    if (!text || shouldSkipUserMessage(text)) return null;
    return {
      time: timestamp ?? null,
      role: 'user',
      text,
    };
  }

  if (payload.type === 'agent_message') {
    const text = normalizeMessageText(payload.message);
    if (!text) return null;
    return {
      time: timestamp ?? null,
      role: 'assistant',
      text,
    };
  }

  return null;
}

function responseItemToMemoryMessage(payload, timestamp) {
  if (payload?.type !== 'message' || payload.role !== 'developer') return null;
  const text = normalizeMessageText(messageContentToText(payload.content));
  if (!text.startsWith('## Throughline Trim Memory Preview')) return null;
  if (!text) return null;
  return {
    time: timestamp ?? null,
    role: 'developer',
    text,
  };
}

function messageContentToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.input_text === 'string') return item.input_text;
      if (typeof item?.output_text === 'string') return item.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function shouldSkipUserMessage(text) {
  return text.startsWith('# AGENTS.md instructions') || text.startsWith('<hook_prompt');
}

function normalizeMessageText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function renderCodexRolloutMemoryPreview({ candidate, parsed, previewMaxChars }) {
  const lines = [];
  lines.push('## Throughline Trim Memory Preview');
  lines.push('');
  lines.push('Intent: Continue the active Codex work thread after rollback.');
  lines.push('');
  lines.push('### Reading Contract');
  lines.push(
    'This preview is current-task context for continuation, not a passive archive. ' +
      'Entries are oldest-to-newest; later entries may supersede earlier hypotheses.',
  );
  lines.push(
    'The source is the active Codex rollout after applying thread_rolled_back events; ' +
      'rolled-back tail turns are not included as current work.',
  );
  lines.push('');
  lines.push('### Source');
  lines.push(`Codex thread: ${candidate.id}`);
  lines.push(`Project: ${candidate.cwd ?? 'unknown'}`);
  lines.push(`Rollout: ${candidate.rolloutPath}`);
  lines.push(`Active turns: ${parsed.activeTurnCount}`);

  const recentEntries = parsed.entries.slice(-MAX_RECENT_ENTRIES);
  if (recentEntries.length > 0) {
    lines.push('');
    lines.push('### Active Work Thread (Codex Rollout)');
    lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
    for (const entry of recentEntries) {
      const time = entry.time ?? 'unknown-time';
      lines.push(`[${time}] [turn ${entry.turn}] [${entry.role}] ${clipEntry(entry.text)}`);
    }
  }

  lines.push('');
  lines.push('### Continuation Instruction');
  lines.push(
    'Use these Codex rollout entries as the active work thread. Continue from the latest actionable state, ' +
      'and do not resurrect rolled-back turns or obsolete earlier hypotheses.',
  );

  const fullText = lines.join('\n');
  const truncated = fullText.length > previewMaxChars;
  return {
    text: truncated
      ? `${fullText.slice(0, previewMaxChars).trimEnd()}\n\n[truncated for dry-run preview]`
      : fullText,
    truncated,
    stats: {
      source: 'codex-rollout',
      activeTurns: parsed.activeTurnCount,
      recentEntries: parsed.entries.length,
      rollbackEvents: parsed.stats.rollbackEvents,
      rolledBackTurns: parsed.stats.rolledBackTurns,
      injectedDeveloperMessages: parsed.stats.injectedDeveloperMessages,
      skippedMessages: parsed.stats.skippedMessages,
    },
  };
}

function clipEntry(text) {
  if (text.length <= MAX_ENTRY_CHARS) return text;
  return `${text.slice(0, MAX_ENTRY_CHARS).trimEnd()} [entry truncated]`;
}
