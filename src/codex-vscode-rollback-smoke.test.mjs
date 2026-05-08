import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectCodexVsCodeRollbackSmoke } from './codex-vscode-rollback-smoke.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('inspectCodexVsCodeRollbackSmoke: passes only with rollback, later user turn, restore safety ok, and restart ack', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-project-'));
  const threadId = '019dfe10-0000-7000-8000-000000000001';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      events: [
        event('user_message', { message: 'stable request' }),
        event('task_started'),
        event('agent_message', { message: 'stable answer' }),
        event('task_complete'),
        event('user_message', { message: 'rolled back request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back answer' }),
        event('task_complete'),
        event('thread_rolled_back', { num_turns: 1 }),
        event('user_message', { message: 'post restart verifier prompt' }),
        event('task_started'),
        event('agent_message', { message: 'post restart answer' }),
        event('task_complete'),
      ],
    });

    const result = inspectCodexVsCodeRollbackSmoke({
      threadId,
      codexHome,
      projectPath: project,
      afterVsCodeRestart: true,
    });

    assert.equal(result.status, 'vscode-restart-rollback-nonresurrection-visible');
    assert.equal(result.restartSafe, true);
    assert.equal(result.proofScope, 'manual_vscode_reload_plus_rollout_restore_safety');
    assert.equal(result.stats.rollbackEvents, 1);
    assert.equal(result.stats.rolledBackUserMessages, 1);
    assert.equal(result.stats.userMessagesAfterRollback, 1);
    assert.equal(result.restoreSafety.status, 'ok');
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('inspectCodexVsCodeRollbackSmoke: does not claim restart safety without restart ack', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-project-'));
  const threadId = '019dfe10-0000-7000-8000-000000000002';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      events: [
        event('user_message', { message: 'rolled back request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back answer' }),
        event('task_complete'),
        event('thread_rolled_back', { num_turns: 1 }),
        event('user_message', { message: 'post rollback prompt' }),
        event('task_started'),
      ],
    });

    const result = inspectCodexVsCodeRollbackSmoke({
      threadId,
      codexHome,
      projectPath: project,
    });

    assert.equal(result.status, 'rollback-nonresurrection-visible-restart-unacknowledged');
    assert.equal(result.restartSafe, false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('inspectCodexVsCodeRollbackSmoke: reports restore safety risk instead of passing', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-project-'));
  const threadId = '019dfe10-0000-7000-8000-000000000003';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      events: [
        event('user_message', { message: 'rolled back compacted request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back compacted answer' }),
        event('task_complete'),
        compacted([userReplacement('rolled back compacted request')]),
        event('thread_rolled_back', { num_turns: 1 }),
        event('user_message', { message: 'post restart verifier prompt' }),
        event('task_started'),
      ],
    });

    const result = inspectCodexVsCodeRollbackSmoke({
      threadId,
      codexHome,
      projectPath: project,
      afterVsCodeRestart: true,
    });

    assert.equal(result.status, 'risk');
    assert.equal(result.reason, 'restore_safety_risk');
    assert.equal(result.restartSafe, false);
    assert.equal(result.restoreSafety.rollbackTextRetainedInCompacted, 1);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-vscode-rollback-smoke CLI accepts env thread id and prints JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-user-home-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-project-'));
  const threadId = '019dfe10-0000-7000-8000-000000000004';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      events: [
        event('user_message', { message: 'rolled back request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back answer' }),
        event('task_complete'),
        event('thread_rolled_back', { num_turns: 1 }),
        event('user_message', { message: 'post restart verifier prompt' }),
        event('task_started'),
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'bin/throughline.mjs'),
        'codex-vscode-rollback-smoke',
        '--verify',
        '--codex-home',
        codexHome,
        '--after-vscode-restart',
        '--json',
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_THREAD_ID: threadId,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'vscode-restart-rollback-nonresurrection-visible');
    assert.equal(payload.threadId, threadId);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-vscode-rollback-smoke text output summarizes restore-safety risks', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-user-home-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-project-'));
  const threadId = '019dfe10-0000-7000-8000-000000000005';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      events: [
        event('user_message', { message: 'rolled back compacted request' }),
        event('task_started'),
        event('agent_message', { message: 'rolled back compacted answer' }),
        event('task_complete'),
        compacted([userReplacement('rolled back compacted request')]),
        event('thread_rolled_back', { num_turns: 1 }),
        event('user_message', { message: 'post restart verifier prompt' }),
        event('task_started'),
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'bin/throughline.mjs'),
        'codex-vscode-rollback-smoke',
        '--verify',
        '--codex-thread-id',
        threadId,
        '--codex-home',
        codexHome,
        '--after-vscode-restart',
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /restore safety:\s+risk/);
    assert.match(result.stdout, /rollback text retained in compacted:\s+1/);
    assert.match(
      result.stdout,
      /risks: rollback_text_retained_in_compacted_replacement_history:1/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function writeRollout(codexHome, { project, threadId, events }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '07');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-07T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-07T00:00:00.000Z',
        cwd: project,
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
    timestamp: '2026-05-07T00:00:01.000Z',
    type: 'event_msg',
    payload: {
      type,
      ...payload,
    },
  };
}

function compacted(replacementHistory) {
  return {
    timestamp: '2026-05-07T00:00:01.000Z',
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: replacementHistory,
    },
  };
}

function userReplacement(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}
