import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildHandoffRecord } from './handoff-record.mjs';

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

function insertSession(db, sessionId = 'new') {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, '/repo', 'active', 1, 2)`,
  ).run(sessionId);
}

function insertSkeleton(db, row) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.summary, row.createdAt);
}

function insertBody(db, row) {
  db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.text, row.createdAt);
}

function insertDetail(db, row) {
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    row.session,
    row.origin,
    row.turn,
    row.toolName,
    row.inputText ?? null,
    row.outputText ?? null,
    row.createdAt,
    row.kind,
    row.sourceId ?? null,
  );
}

test('buildHandoffRecord: returns stable projection with memo, L1, L2, thinking, and L3 refs', () => {
  const db = makeDb();
  insertSession(db);
  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'old summary',
    createdAt: 1000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    role: 'user',
    text: 'recent user body',
    createdAt: 2000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    role: 'assistant',
    text: 'recent assistant body',
    createdAt: 2100,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    kind: 'thinking',
    toolName: 'thinking',
    outputText: 'latest thought',
    createdAt: 2200,
    sourceId: 'asst:thinking:0',
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    kind: 'tool_input',
    toolName: 'Bash',
    inputText: '{"command":"pwd"}',
    createdAt: 2300,
    sourceId: 'toolu_1',
  });

  const record = buildHandoffRecord(db, {
    sessionId: 'new',
    isInheritance: true,
    inflightMemo: 'Next: continue',
  });

  assert.ok(record);
  assert.equal(record.kind, 'handoff_record');
  assert.equal(record.version, 1);
  assert.equal(record.session.id, 'new');
  assert.equal(record.session.projectPath, '/repo');
  assert.equal(record.source.adapter, 'claude');
  assert.equal(record.source.inheritance, true);
  assert.deepEqual(record.source.originSessionIds, ['old']);
  assert.equal(record.intent, 'continue implementation');
  assert.ok(record.constraints.some((c) => c.includes('preserve existing Claude Code')));
  assert.equal(record.memory.inflightMemo, 'Next: continue');
  assert.equal(record.memory.latestThinking[0].text, 'latest thought');
  assert.equal(record.memory.latestThinking[0].sourceId, 'asst:thinking:0');
  assert.equal(record.memory.l1Summaries[0].summary, 'old summary');
  assert.deepEqual(record.memory.recentBodies.map((r) => r.role), ['user', 'assistant']);
  assert.equal(record.references.l3.length, 2);
  assert.deepEqual(record.references.l3.map((r) => r.kind), ['thinking', 'tool_input']);
  assert.match(record.references.l3[0].detailCommand, /^throughline detail \d{2}:\d{2}:\d{2}$/);
  assert.equal(record.stats.preservedContextRows, 3);
});

test('buildHandoffRecord: excludes current origin rows', () => {
  const db = makeDb();
  insertSession(db);
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'old body',
    createdAt: 1000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'new',
    turn: 1,
    role: 'assistant',
    text: 'current body',
    createdAt: 2000,
  });

  const record = buildHandoffRecord(db, {
    sessionId: 'new',
    excludeOriginId: 'new',
  });

  assert.ok(record);
  assert.deepEqual(record.source.originSessionIds, ['old']);
  assert.deepEqual(record.memory.recentBodies.map((r) => r.text), ['old body']);
});

test('buildHandoffRecord: returns null when no projected memory exists', () => {
  const db = makeDb();
  insertSession(db);
  assert.equal(buildHandoffRecord(db, { sessionId: 'empty' }), null);
});
