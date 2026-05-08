import { readFileSync } from 'node:fs';

import { parseCodexRolloutFile } from './codex-rollout-memory.mjs';
import { estimateTokens } from './token-estimator.mjs';

export const DEFAULT_CODEX_CONTEXT_WINDOW_SIZE = 200_000;

export function readLatestCodexUsage(rolloutPath) {
  if (!rolloutPath) return null;

  let raw;
  try {
    raw = readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }

  let latest = null;
  let model = 'codex';
  let provider = null;
  let openTaskCount = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = row?.payload;
    if (row?.type === 'session_meta') {
      provider = payload?.model_provider ?? provider;
      model = payload?.model ?? model;
      continue;
    }

    if (row?.type === 'turn_context') {
      model = payload?.model ?? model;
      continue;
    }

    if (row?.type !== 'event_msg') continue;

    if (payload?.type === 'task_started') {
      openTaskCount++;
      continue;
    }

    if (payload?.type === 'task_complete') {
      openTaskCount = Math.max(0, openTaskCount - 1);
      continue;
    }

    if (payload?.type !== 'token_count') continue;
    const info = payload.info ?? {};
    const last = info.last_token_usage ?? {};
    const inputTokens = Number(last.input_tokens);
    if (!Number.isFinite(inputTokens) || inputTokens < 0) continue;
    const outputTokens = Number.isFinite(Number(last.output_tokens)) ? Number(last.output_tokens) : 0;
    const transientOutputTokens = openTaskCount > 0 ? outputTokens : 0;

    const windowSize = Number(info.model_context_window);
    latest = {
      tokens: inputTokens + transientOutputTokens,
      inputTokens,
      model: model === 'codex' && provider ? provider : model,
      contextWindowSize:
        Number.isFinite(windowSize) && windowSize > 0
          ? windowSize
          : DEFAULT_CODEX_CONTEXT_WINDOW_SIZE,
      contextWindowEstimated: !(Number.isFinite(windowSize) && windowSize > 0),
      outputTokens,
      transientOutputTokens,
      liveTurn: openTaskCount > 0,
      estimated: false,
      source: openTaskCount > 0
        ? 'codex-rollout-token-count-live-turn'
        : 'codex-rollout-token-count',
    };
  }

  return latest;
}

export function estimateCodexUsageFromRollout(rolloutPath) {
  if (!rolloutPath) return null;

  let parsed;
  try {
    parsed = parseCodexRolloutFile(rolloutPath);
  } catch {
    return null;
  }

  const text = activeRolloutText(parsed);
  if (!text.trim()) return null;

  return {
    tokens: estimateTokens(text),
    model: 'codex',
    contextWindowSize: DEFAULT_CODEX_CONTEXT_WINDOW_SIZE,
    contextWindowEstimated: true,
    outputTokens: 0,
    estimated: true,
    source: 'codex-rollout-chars-div-4',
  };
}

export function buildCodexMonitorUsage(rolloutPath) {
  return readLatestCodexUsage(rolloutPath) ?? estimateCodexUsageFromRollout(rolloutPath);
}

function activeRolloutText(parsed) {
  const chunks = [];
  for (const turn of parsed?.activeTurns ?? []) {
    for (const message of turn.messages ?? []) {
      if (message?.text) chunks.push(message.text);
    }
    for (const detail of turn.details ?? []) {
      if (detail?.input_text) chunks.push(detail.input_text);
      if (detail?.output_text) chunks.push(detail.output_text);
    }
  }
  return chunks.join('\n\n');
}

export const _internal = {
  activeRolloutText,
};
