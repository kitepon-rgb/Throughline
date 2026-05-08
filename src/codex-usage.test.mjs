import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildCodexMonitorUsage,
  estimateCodexUsageFromRollout,
  readLatestCodexUsage,
} from './codex-usage.mjs';

test('readLatestCodexUsage: reads verified Codex token_count event shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        row('session_meta', {
          id: '019dfaba-thread',
          cwd: '/repo',
          model_provider: 'openai',
        }),
        row('turn_context', {
          turn_id: '019dfaba-turn',
          model: 'gpt-5.5',
        }),
        event('token_count', {
          info: {
            last_token_usage: {
              input_tokens: 151914,
              cached_input_tokens: 143744,
              output_tokens: 60,
              total_tokens: 151974,
            },
            model_context_window: 258400,
          },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    assert.deepEqual(readLatestCodexUsage(rollout), {
      tokens: 151914,
      inputTokens: 151914,
      model: 'gpt-5.5',
      contextWindowSize: 258400,
      contextWindowEstimated: false,
      outputTokens: 60,
      transientOutputTokens: 0,
      liveTurn: false,
      estimated: false,
      source: 'codex-rollout-token-count',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestCodexUsage: during an open Codex turn overlays transient output tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        row('session_meta', { id: '019dfaba-thread', cwd: '/repo' }),
        row('turn_context', { turn_id: '019dfaba-turn', model: 'gpt-5.5' }),
        event('task_started'),
        event('token_count', {
          info: {
            last_token_usage: {
              input_tokens: 151914,
              output_tokens: 1200,
            },
            model_context_window: 258400,
          },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const usage = readLatestCodexUsage(rollout);
    assert.equal(usage.tokens, 153114);
    assert.equal(usage.inputTokens, 151914);
    assert.equal(usage.outputTokens, 1200);
    assert.equal(usage.transientOutputTokens, 1200);
    assert.equal(usage.liveTurn, true);
    assert.equal(usage.source, 'codex-rollout-token-count-live-turn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestCodexUsage: task_complete drops transient output overlay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        row('session_meta', { id: '019dfaba-thread', cwd: '/repo' }),
        row('turn_context', { turn_id: '019dfaba-turn', model: 'gpt-5.5' }),
        event('task_started'),
        event('token_count', {
          info: {
            last_token_usage: {
              input_tokens: 151914,
              output_tokens: 1200,
            },
            model_context_window: 258400,
          },
        }),
        event('task_complete'),
        event('token_count', {
          info: {
            last_token_usage: {
              input_tokens: 151914,
              output_tokens: 1200,
            },
            model_context_window: 258400,
          },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const usage = readLatestCodexUsage(rollout);
    assert.equal(usage.tokens, 151914);
    assert.equal(usage.transientOutputTokens, 0);
    assert.equal(usage.liveTurn, false);
    assert.equal(usage.source, 'codex-rollout-token-count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestCodexUsage: falls back to model_provider when no turn_context model exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        row('session_meta', {
          id: '019dfaba-thread',
          cwd: '/repo',
          model_provider: 'openai',
        }),
        event('token_count', {
          info: {
            last_token_usage: {
              input_tokens: 151914,
              output_tokens: 60,
            },
            model_context_window: 258400,
          },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    assert.equal(readLatestCodexUsage(rollout)?.model, 'openai');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCodexMonitorUsage: estimates explicitly when token_count is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        row('session_meta', { id: '019dfaba-thread', cwd: '/repo' }),
        event('user_message', { message: 'hello codex monitor' }),
        event('task_started'),
        event('agent_message', { message: 'working on it' }),
        event('task_complete'),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const usage = buildCodexMonitorUsage(rollout);
    assert.ok(usage);
    assert.equal(usage.estimated, true);
    assert.equal(usage.source, 'codex-rollout-chars-div-4');
    assert.equal(usage.contextWindowEstimated, true);
    assert.ok(usage.tokens > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateCodexUsageFromRollout: returns null for empty active rollout text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-usage-'));
  try {
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(rollout, JSON.stringify(row('session_meta', { id: '019dfaba-thread', cwd: '/repo' })) + '\n');
    assert.equal(estimateCodexUsageFromRollout(rollout), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function row(type, payload) {
  return {
    timestamp: '2026-05-06T00:40:50.000Z',
    type,
    payload,
  };
}

function event(type, payload = {}) {
  return row('event_msg', { type, ...payload });
}
