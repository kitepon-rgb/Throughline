import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { runCodexStopHook, _internal } from './codex-hook.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
  `);
  return db;
}

test('codex-hook stop captures rollout using Codex stdin payload fields', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-hook-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-hook-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const db = makeDb();
  let monitorState = null;
  let monitorTaskCwd = null;
  try {
    const rolloutPath = writeRollout(codexHome, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'hook request' }),
        event('task_started'),
        turnContext({ model: 'gpt-5.5', cwd: project }),
        event('agent_message', { message: 'hook answer' }),
        event('task_complete'),
        tokenCountEvent({
          inputTokens: 12345,
          outputTokens: 67,
          contextWindow: 258400,
        }),
      ],
    });

    const result = await runCodexStopHook({
      payload: {
        session_id: threadId,
        transcript_path: rolloutPath,
        cwd: project,
      },
      env: {},
      db,
      ensureMonitorTask: ({ cwd }) => {
        monitorTaskCwd = cwd;
      },
      writeMonitorState: (state) => {
        monitorState = state;
      },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.codexThreadIdSource, 'payload:session_id');
    assert.equal(result.captured.sessionId, `codex:${threadId}`);
    assert.equal(result.captured.capturedTurns, 1);
    assert.equal(result.captured.capturedRows, 2);
    assert.equal(result.summarized.status, 'skipped');
    assert.equal(result.summarized.reason, 'within_l2_window');
    assert.equal(monitorState.sessionId, `codex:${threadId}`);
    assert.equal(monitorState.host, 'codex');
    assert.equal(monitorState.projectPath, project);
    assert.equal(monitorState.transcriptPath, null);
    assert.equal(monitorState.rolloutPath, rolloutPath);
    assert.equal(monitorState.usage.tokens, 12345);
    assert.equal(monitorState.usage.model, 'gpt-5.5');
    assert.equal(monitorState.usage.source, 'codex-rollout-token-count');
    assert.equal(result.monitorState.sessionId, `codex:${threadId}`);
    assert.equal(result.autoRefresh.status, 'skipped');
    assert.equal(result.autoRefresh.reason, 'below_threshold');
    assert.equal(monitorTaskCwd, project);
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-hook stop runs auto refresh when verified usage reaches 80%', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-hook-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-hook-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const db = makeDb();
  let autoRefreshArgs = null;
  try {
    const rolloutPath = writeRollout(codexHome, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'hook request' }),
        event('task_started'),
        turnContext({ model: 'gpt-5.5', cwd: project }),
        event('agent_message', { message: 'hook answer' }),
        event('task_complete'),
        tokenCountEvent({
          inputTokens: 240_000,
          outputTokens: 67,
          contextWindow: 258400,
        }),
      ],
    });

    const result = await runCodexStopHook({
      payload: {
        session_id: threadId,
        transcript_path: rolloutPath,
        cwd: project,
      },
      env: {},
      db,
      ensureMonitorTask: () => {},
      writeMonitorState: () => {},
      runAutoRefresh: async (args) => {
        autoRefreshArgs = args;
        return {
          status: 'refreshed-live',
          reason: 'rollback_and_inject_sent_live',
        };
      },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.autoRefresh.status, 'refreshed-live');
    assert.equal(autoRefreshArgs.threadId, threadId);
    assert.equal(autoRefreshArgs.codexThreadIdSource, 'payload:session_id');
    assert.equal(autoRefreshArgs.codexHome, codexHome);
    assert.equal(autoRefreshArgs.projectPath, project);
    assert.equal(autoRefreshArgs.sessionId, `codex:${threadId}`);
    assert.equal(autoRefreshArgs.usage.tokens, 240_000);
    assert.equal(autoRefreshArgs.usage.contextWindowSize, 258400);
    assert.equal(autoRefreshArgs.usage.estimated, false);
    assert.equal(autoRefreshArgs.command, 'codex');
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-hook stop reports camelCase payload thread id source', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'tl-codex-hook-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-hook-project-'));
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const db = makeDb();
  try {
    const rolloutPath = writeRollout(codexHome, {
      id: threadId,
      cwd: project,
      events: [
        event('user_message', { message: 'hook request' }),
        event('task_started'),
        event('agent_message', { message: 'hook answer' }),
        event('task_complete'),
      ],
    });

    const result = await runCodexStopHook({
      payload: {
        sessionId: threadId,
        transcriptPath: rolloutPath,
        cwd: project,
      },
      env: {},
      db,
      ensureMonitorTask: () => {},
      writeMonitorState: () => {},
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.codexThreadIdSource, 'payload:sessionId');
    assert.equal(result.captured.sessionId, `codex:${threadId}`);
  } finally {
    db.close();
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-hook stop skips cleanly when Codex thread id is unavailable', async () => {
  const db = makeDb();
  try {
    const result = await runCodexStopHook({
      payload: { cwd: process.cwd() },
      env: {},
      db,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'codex_thread_id_not_available');
  } finally {
    db.close();
  }
});

test('codexHomeFromTranscriptPath infers CODEX_HOME from rollout path', () => {
  const path = '/tmp/codex-home/sessions/2026/05/06/rollout-2026-05-06T09-40-50-id.jsonl';
  assert.equal(_internal.codexHomeFromTranscriptPath(path), '/tmp/codex-home');
});

function writeRollout(home, { id, cwd, events }) {
  const dir = join(home, 'sessions', '2026', '05', '06');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-06T09-40-50-${id}.jsonl`);
  writeFileSync(path, [sessionMeta(id, cwd), ...events].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function sessionMeta(id, cwd) {
  return {
    timestamp: '2026-05-06T00:40:50.000Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-05-06T00:40:50.000Z',
      cwd,
      source: 'vscode',
      cli_version: '0.128.0-alpha.1',
    },
  };
}

function event(type, payload = {}) {
  return {
    timestamp: '2026-05-06T00:41:00.000Z',
    type: 'event_msg',
    payload: { type, ...payload },
  };
}

function turnContext(payload = {}) {
  return {
    timestamp: '2026-05-06T00:41:00.000Z',
    type: 'turn_context',
    payload,
  };
}

function tokenCountEvent({ inputTokens, outputTokens, contextWindow }) {
  return event('token_count', {
    info: {
      last_token_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      model_context_window: contextWindow,
    },
  });
}
