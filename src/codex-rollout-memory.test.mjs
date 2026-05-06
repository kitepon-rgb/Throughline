import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCodexRolloutTrimSource, parseCodexRolloutFile } from './codex-rollout-memory.mjs';

test('parseCodexRolloutFile: applies rollback events before rendering active work', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  try {
    const rollout = writeRollout(home, {
      id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      cwd: project,
      events: [
        event('user_message', { message: '# AGENTS.md instructions for /repo\nskip me' }),
        event('user_message', { message: 'start active task' }),
        event('task_started'),
        event('agent_message', { message: 'turn one answer' }),
        event('task_complete'),
        event('user_message', { message: '<hook_prompt hook_run_id="stop">skip me</hook_prompt>' }),
        event('user_message', { message: 'continue active task' }),
        event('task_started'),
        event('agent_message', { message: 'turn two answer' }),
        event('task_complete'),
        event('user_message', { message: 'rolled back request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back answer' }),
        event('task_complete'),
        event('thread_rolled_back', { num_turns: 1 }),
        responseItem({
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: '## Throughline Trim Memory Preview\n\ninjected trim memory',
            },
          ],
        }),
        responseItem({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '[caveat] unrelated developer notice' }],
        }),
        event('user_message', { message: 'new request after rollback' }),
        event('task_started'),
        event('agent_message', { message: 'new answer after rollback' }),
        event('task_complete'),
      ],
    });

    const parsed = parseCodexRolloutFile(rollout);

    assert.equal(parsed.activeTurnCount, 4);
    assert.equal(parsed.stats.rolledBackTurns, 1);
    assert.equal(parsed.stats.injectedDeveloperMessages, 1);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.text),
      [
        'start active task',
        'turn one answer',
        'continue active task',
        'turn two answer',
        '## Throughline Trim Memory Preview injected trim memory',
        'new request after rollback',
        'new answer after rollback',
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('buildCodexRolloutTrimSource: returns trim source for explicit current-project Codex thread', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  try {
    writeRollout(home, {
      id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      cwd: project,
      events: [
        event('user_message', { message: 'implement rollout source' }),
        event('task_started'),
        event('agent_message', { message: 'rollout source implemented' }),
        event('task_complete'),
      ],
    });

    const source = buildCodexRolloutTrimSource({
      threadId: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      codexHome: home,
      projectPath: project,
    });

    assert.equal(source.source, 'codex-rollout');
    assert.equal(source.capturedTurns, 1);
    assert.equal(source.threadId, '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
    assert.match(source.memoryPreview.text, /Active Work Thread \(Codex Rollout\)/);
    assert.match(source.memoryPreview.text, /implement rollout source/);
    assert.match(source.memoryPreview.text, /rolled-back tail turns are not included/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function writeRollout(home, { id, cwd, events }) {
  const dir = join(home, 'sessions', '2026', '05', '06');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-06T09-40-50-${id}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-06T00:40:50.000Z',
      type: 'session_meta',
      payload: {
        id,
        timestamp: '2026-05-06T00:40:50.000Z',
        cwd,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    },
    ...events,
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function event(type, payload = {}) {
  return {
    timestamp: '2026-05-06T00:40:51.000Z',
    type: 'event_msg',
    payload: {
      type,
      ...payload,
    },
  };
}

function responseItem(payload) {
  return {
    timestamp: '2026-05-06T00:40:51.500Z',
    type: 'response_item',
    payload,
  };
}
