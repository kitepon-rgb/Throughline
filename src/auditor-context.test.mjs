import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUDITOR_CONTEXT_SCHEMA,
  deriveAuditorFreshnessExpectation,
  hashAuditorBody,
  readAuditorContext,
} from './auditor-context.mjs';

function withDb(fn, { version = 8 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-auditor-context-'));
  const path = join(dir, 'throughline.db');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = ${version};
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  try {
    return fn({ db, path, dir });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedSession(db, { sessionId = 'session-1', projectPath = '/repo', pairs = [] } = {}) {
  db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run(sessionId, projectPath);
  let createdAt = 1;
  for (const pair of pairs) {
    for (const [role, text] of [['user', pair.user], ['assistant', pair.assistant]]) {
      db.prepare(
        'INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(sessionId, pair.originSessionId, pair.turnNumber, role, text, createdAt++);
    }
  }
}

function expected(pair) {
  return {
    expectedOriginSessionId: pair.originSessionId,
    expectedTurnNumber: pair.turnNumber,
    expectedUserSha256: hashAuditorBody(pair.user),
    expectedAssistantSha256: hashAuditorBody(pair.assistant),
  };
}

function read(path, pair, extra = {}) {
  return readAuditorContext({
    dbPath: path,
    sessionId: 'session-1',
    projectRoot: '/repo',
    ...expected(pair),
    ...extra,
  });
}

test('readAuditorContext: returns a fresh completed pair with canonical origin identity', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 4, user: ' ask\r\n', assistant: ' answer\r\n' };
    seedSession(db, { pairs: [pair] });

    const result = read(path, pair);
    assert.equal(result.schema, AUDITOR_CONTEXT_SCHEMA);
    assert.equal(result.status, 'fresh');
    assert.equal(result.reason, 'latest_pair_matched');
    assert.deepEqual(result.turns, [
      { originSessionId: 'origin-a', turnNumber: 4, user: 'ask', assistant: 'answer', createdAt: 2 },
    ]);
    assert.deepEqual(result.freshness, {
      originSessionId: 'origin-a', turnNumber: 4, identityMatched: true, userMatched: true, assistantMatched: true,
    });
  });
});

test('readAuditorContext: pair identity or hash mismatch is stale', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 4, user: 'ask', assistant: 'answer' };
    seedSession(db, { pairs: [pair] });

    for (const extra of [
      { expectedOriginSessionId: 'origin-other' },
      { expectedTurnNumber: 5 },
      { expectedUserSha256: hashAuditorBody('other') },
      { expectedAssistantSha256: hashAuditorBody('other') },
    ]) {
      const result = read(path, pair, extra);
      assert.equal(result.status, 'stale');
      assert.equal(result.reason, 'latest_pair_mismatch');
      assert.deepEqual(result.turns, []);
    }
  });
});

test('readAuditorContext: returns empty for no complete pair and excludes developer/L3 roles', () => {
  withDb(({ db, path }) => {
    seedSession(db);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('session-1', 'origin-a', 1, 'developer', 'secret developer context', 1);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('session-1', 'origin-a', 1, 'user', 'unpaired request', 2);
    const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'unpaired request', assistant: 'missing' };

    const result = read(path, pair);
    assert.equal(result.status, 'empty');
    assert.equal(result.reason, 'completed_pair_not_found');
    assert.deepEqual(result.turns, []);
  });
});

test('readAuditorContext: reports project mismatch without exposing rows', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'private', assistant: 'private reply' };
    seedSession(db, { projectPath: '/other-project', pairs: [pair] });
    const result = read(path, pair);
    assert.equal(result.status, 'session_mismatch');
    assert.equal(result.reason, 'project_mismatch');
    assert.deepEqual(result.turns, []);
  });
});

test('readAuditorContext: applies recent-turn, body, and total bounds from the newest pairs', () => {
  withDb(({ db, path }) => {
    const old = { originSessionId: 'origin-a', turnNumber: 1, user: 'old user', assistant: 'old assistant' };
    const latest = { originSessionId: 'origin-a', turnNumber: 2, user: 'abcdef', assistant: 'uvwxyz' };
    seedSession(db, { pairs: [old, latest] });
    const result = read(path, latest, { recentTurns: 1, maxBodyChars: 4, maxTotalChars: 5 });
    assert.equal(result.status, 'fresh');
    assert.deepEqual(result.turns, [
      { originSessionId: 'origin-a', turnNumber: 2, user: 'ef', assistant: 'xyz', createdAt: 4 },
    ]);
    assert.deepEqual(result.stats, { requestedTurns: 1, returnedTurns: 1, chars: 5, truncated: true });
  });
});

test('readAuditorContext: reports schema mismatch and missing DB as exit-safe JSON states', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'u', assistant: 'a' };
    seedSession(db, { pairs: [pair] });
    const mismatched = read(path, pair);
    assert.equal(mismatched.status, 'schema_mismatch');
    assert.equal(mismatched.reason, 'unsupported_db_schema');
  }, { version: 7 });

  const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'u', assistant: 'a' };
  const missing = read('/definitely-missing-throughline-auditor-context.db', pair);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'db_not_found');
});

test('readAuditorContext: opens a live WAL database read-only without changing DB, -wal, or -shm', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'u', assistant: 'a' };
    seedSession(db, { pairs: [pair] });
    db.exec('BEGIN IMMEDIATE');
    const before = snapshotSqliteFiles(path);
    const result = read(path, pair);
    assert.equal(result.status, 'fresh');
    assert.deepEqual(snapshotSqliteFiles(path), before);
    db.exec('ROLLBACK');
  });
});

test('readAuditorContext: classifies an exclusive database lock without exposing SQLite diagnostics', () => {
  withDb(({ db, path }) => {
    const pair = { originSessionId: 'origin-a', turnNumber: 1, user: 'u', assistant: 'a' };
    seedSession(db, { pairs: [pair] });
    db.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE');
    try {
      assert.throws(
        () => read(path, pair),
        (error) => {
          assert.equal(error.code, 'E_AUDITOR_CONTEXT_QUERY');
          assert.equal(error.message, 'auditor context query failed');
          assert.equal(error.message.includes('locked'), false);
          return true;
        },
      );
    } finally {
      db.exec('ROLLBACK');
    }
  });
});

test('deriveAuditorFreshnessExpectation: Claude logical groups use the latest representative fragment and session origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-auditor-claude-transcript-'));
  const transcript = join(dir, 'session.jsonl');
  try {
    writeFileSync(transcript, [
      claudeRow('user', 'first request'),
      claudeRow('assistant', 'first answer'),
      claudeRow('user', 'latest request'),
      claudeRow('assistant', 'partial answer'),
      claudeRow('assistant', 'latest representative answer'),
    ].map(JSON.stringify).join('\n'));

    assert.deepEqual(
      deriveAuditorFreshnessExpectation({ host: 'claude', transcriptPath: transcript, sessionId: 'claude-session' }),
      {
        expectedOriginSessionId: 'claude-session',
        expectedTurnNumber: 4,
        expectedUserSha256: hashAuditorBody('latest request'),
        expectedAssistantSha256: hashAuditorBody('latest representative answer'),
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveAuditorFreshnessExpectation: Codex excludes current in-flight turn before deriving latest completed identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-auditor-codex-rollout-'));
  const rollout = join(dir, 'rollout.jsonl');
  try {
    writeFileSync(rollout, [
      codexEvent('user_message', { message: 'completed request' }),
      codexEvent('task_started'),
      codexEvent('agent_message', { message: 'completed answer' }),
      codexEvent('task_complete'),
      codexEvent('user_message', { message: 'in-flight request' }),
      codexEvent('task_started'),
      codexEvent('agent_message', { message: 'in-flight answer' }),
    ].map(JSON.stringify).join('\n'));

    assert.deepEqual(
      deriveAuditorFreshnessExpectation({ host: 'codex', transcriptPath: rollout, sessionId: 'codex:thread-1' }),
      {
        expectedOriginSessionId: 'codex:thread-1',
        expectedTurnNumber: null,
        expectedUserSha256: hashAuditorBody('completed request'),
        expectedAssistantSha256: hashAuditorBody('completed answer'),
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readAuditorContext: Codex freshness uses exact origin and both pair hashes when turn ordinals are unstable', () => {
  withDb(({ db, path }) => {
    seedSession(db, {
      sessionId: 'codex:thread-1',
      projectPath: '/repo',
      pairs: [{
        originSessionId: 'codex:thread-1', turnNumber: 32,
        user: 'completed request', assistant: 'completed answer',
      }, {
        originSessionId: 'codex:thread-1', turnNumber: 33,
        user: 'transient request', assistant: 'transient answer',
      }],
    });
    const result = readAuditorContext({
      dbPath: path,
      sessionId: 'codex:thread-1',
      projectRoot: '/repo',
      expectedOriginSessionId: 'codex:thread-1',
      expectedTurnNumber: null,
      expectedUserSha256: hashAuditorBody('completed request'),
      expectedAssistantSha256: hashAuditorBody('completed answer'),
    });
    assert.equal(result.status, 'fresh');
    assert.equal(result.freshness.turnNumber, 32);
    assert.equal(result.turns.at(-1).turnNumber, 32);
    assert.equal(result.turns.some((turn) => turn.turnNumber === 33), false);
  });
});

function snapshotSqliteFiles(path) {
  return [path, `${path}-wal`, `${path}-shm`].map((file) => {
    if (!existsSync(file)) return { file, exists: false };
    const stat = lstatSync(file);
    return { file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, bytes: readFileSync(file).toString('hex') };
  });
}

function claudeRow(role, text) {
  return { type: role, message: { role, content: [{ type: 'text', text }] } };
}

function codexEvent(type, payload = {}) {
  return { timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg', payload: { type, ...payload } };
}
