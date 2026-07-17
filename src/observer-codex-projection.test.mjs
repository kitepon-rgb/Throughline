import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { resolveObserverTurnFeed } from './observer-turn-feed.mjs';

test('observer Codex projection: feed origin hash matches codex:<thread_id> DB identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-observer-codex-projection-'));
  const project = join(root, 'project');
  const codexHome = join(root, 'codex');
  const rolloutDir = join(codexHome, 'sessions', '2026', '07', '15');
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  const sessionId = `codex:${threadId}`;
  const dbPath = join(root, 'throughline.db');
  let db;
  try {
    mkdirSync(project);
    mkdirSync(rolloutDir, { recursive: true });
    const events = [
      { type: 'session_meta', timestamp: '2026-07-15T00:00:00.000Z', payload: { id: threadId, cwd: project } },
      { type: 'event_msg', timestamp: '2026-07-15T00:00:01.000Z', payload: { type: 'user_message', message: 'codex user' } },
      { type: 'event_msg', timestamp: '2026-07-15T00:00:02.000Z', payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: '2026-07-15T00:00:03.000Z', payload: { type: 'agent_message', message: 'codex answer' } },
      { type: 'event_msg', timestamp: '2026-07-15T00:00:04.000Z', payload: { type: 'task_complete' } },
    ];
    writeFileSync(join(rolloutDir, `rollout-2026-07-15T00-00-00-${threadId}.jsonl`), events.map(JSON.stringify).join('\n'));

    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = 9;
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
      CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run(sessionId, project);
    const insert = db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, ?, ?, ?)');
    insert.run(sessionId, sessionId, 'user', 'codex user', 1);
    insert.run(sessionId, sessionId, 'assistant', 'codex answer', 2);

    const result = resolveObserverTurnFeed({ projectPath: project, codexHome, dbPath });
    assert.equal(result.status, 'snapshot');
    assert.deepEqual(result.turns.map(({ user, assistant }) => ({ user, assistant })), [
      { user: 'codex user', assistant: 'codex answer' },
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${threadId}|codex:`));
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
