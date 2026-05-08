import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { findCodexThreadCandidate, defaultCodexHome } from './codex-thread-index.mjs';

export function makeCodexVsCodeRestoreSmokeMarker() {
  return `TL_CODEX_VSCODE_RESTORE_${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function buildCodexVsCodeRestoreSmokeMemory({ marker }) {
  assertNonEmptyString(marker, 'marker');
  return [
    '## Throughline: Active Work Context',
    '',
    '### VS Code Restore Smoke',
    'When the user asks for the Throughline VS Code restore smoke marker after a VS Code reload or reconnect, reply exactly:',
    marker,
  ].join('\n');
}

export function buildCodexVsCodeRestoreSmokePrompt() {
  return [
    'Throughline VS Code restore smoke:',
    'Read the marker from your developer memory and reply with exactly that marker and nothing else.',
  ].join(' ');
}

export function inspectCodexVsCodeRestoreSmokeRollout({
  threadId,
  marker,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  preparedAt = null,
  afterVsCodeRestart = false,
} = {}) {
  assertNonEmptyString(threadId, 'threadId');
  assertNonEmptyString(marker, 'marker');
  if (preparedAt !== null && Number.isNaN(Date.parse(preparedAt))) {
    throw new Error('preparedAt must be an ISO timestamp when provided');
  }

  const candidate = findCodexThreadCandidate({
    threadId,
    codexHome,
    projectPath,
    requireProjectMatch: true,
  });
  if (!candidate) {
    return {
      status: 'refused',
      reason: 'codex_rollout_source_required',
      proofScope: 'none',
      restartSafe: false,
      threadId,
      marker,
    };
  }

  const inspected = inspectRolloutRows({
    path: candidate.rolloutPath,
    marker,
    preparedAt,
  });
  const promptObserved = inspected.promptMatches.length > 0;
  const assistantMarkerVisible = inspected.assistantMarkerMatches.length > 0;
  const markerLeakedInUserPrompt = inspected.userMarkerMatches.length > 0;
  let status = 'pending';
  let reason = 'marker_not_found_in_rollout';
  let restartSafe = false;
  let proofScope = 'codex_rollout_marker_search_only';

  if (markerLeakedInUserPrompt) {
    status = 'invalid';
    reason = 'marker_leaked_in_user_prompt';
  } else if (assistantMarkerVisible && !promptObserved) {
    status = 'invalid';
    reason = 'marker_answer_without_smoke_prompt';
  } else if (assistantMarkerVisible && afterVsCodeRestart) {
    status = 'vscode-restart-visible';
    reason = 'assistant_marker_found_after_restart_ack';
    restartSafe = true;
    proofScope = 'manual_vscode_reload_plus_rollout_marker';
  } else if (assistantMarkerVisible) {
    status = 'marker-visible-restart-unacknowledged';
    reason = 'assistant_marker_found_without_restart_ack';
  }

  return {
    status,
    reason,
    proofScope,
    restartSafe,
    threadId,
    marker,
    rolloutPath: candidate.rolloutPath,
    preparedAt,
    afterVsCodeRestart: Boolean(afterVsCodeRestart),
    ...inspected,
  };
}

function inspectRolloutRows({ path, marker, preparedAt }) {
  const preparedTime = preparedAt ? Date.parse(preparedAt) : null;
  const rows = {
    parsedRows: 0,
    corruptRows: 0,
    rowsAfterPreparedAt: 0,
    promptMatches: [],
    userMarkerMatches: [],
    assistantMarkerMatches: [],
    assistantMarkerMentions: [],
  };

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      rows.parsedRows++;
    } catch {
      rows.corruptRows++;
      continue;
    }
    if (!isAfterPreparedAt(row.timestamp, preparedTime)) continue;
    rows.rowsAfterPreparedAt++;

    const message = rowToMessage(row);
    if (!message) continue;
    const entry = {
      row: rows.parsedRows,
      timestamp: row.timestamp ?? null,
      role: message.role,
      textPreview: preview(message.text),
    };
    if (message.role === 'user') {
      if (message.text.includes('Throughline VS Code restore smoke')) {
        rows.promptMatches.push(entry);
      }
      if (message.text.includes(marker)) {
        rows.userMarkerMatches.push(entry);
      }
    } else if (message.role === 'assistant' && message.text.includes(marker)) {
      rows.assistantMarkerMentions.push(entry);
      if (message.text.trim() === marker) {
        rows.assistantMarkerMatches.push(entry);
      }
    }
  }

  return rows;
}

function rowToMessage(row) {
  const payload = row?.payload;
  if (row?.type === 'event_msg') {
    if (payload?.type === 'user_message') {
      return { role: 'user', text: normalizeText(payload.message) };
    }
    if (payload?.type === 'agent_message') {
      return { role: 'assistant', text: normalizeText(payload.message) };
    }
  }

  if (row?.type === 'response_item' && payload?.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
    if (!role) return null;
    return { role, text: normalizeText(messageContentToText(payload.content)) };
  }

  return null;
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.input_text === 'string') return part.input_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isAfterPreparedAt(timestamp, preparedTime) {
  if (preparedTime === null) return true;
  const time = Date.parse(timestamp ?? '');
  return !Number.isNaN(time) && time >= preparedTime;
}

function normalizeText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function preview(value) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 240)} [truncated]` : text;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
