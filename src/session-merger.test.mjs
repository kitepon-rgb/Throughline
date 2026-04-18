import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolveMergeTarget, mergeSpecificPredecessor } from './session-merger.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id   TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      merged_into  TEXT
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
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertSession(db, id, createdAt, mergedInto = null, projectPath = '/proj') {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at, merged_into)
     VALUES (?, ?, 'active', ?, ?, ?)`,
  ).run(id, projectPath, createdAt, createdAt, mergedInto);
}

test('resolveMergeTarget: unmerged session returns itself', () => {
  const db = makeDb();
  insertSession(db, 'A', 1);
  const { target, origin } = resolveMergeTarget(db, 'A');
  assert.equal(target, 'A');
  assert.equal(origin, 'A');
});

test('resolveMergeTarget: follows chain to end', () => {
  const db = makeDb();
  insertSession(db, 'A', 1, 'B');
  insertSession(db, 'B', 2, 'C');
  insertSession(db, 'C', 3, null);
  const { target, origin } = resolveMergeTarget(db, 'A');
  assert.equal(target, 'C');
  assert.equal(origin, 'A');
});

test('resolveMergeTarget: detects cycle and throws', () => {
  const db = makeDb();
  insertSession(db, 'A', 1, 'B');
  insertSession(db, 'B', 2, 'C');
  insertSession(db, 'C', 3, 'A');
  assert.throws(() => resolveMergeTarget(db, 'A'), /cycle detected/);
});

test('mergeSpecificPredecessor: moves rows from named predecessor to new session', () => {
  const db = makeDb();
  insertSession(db, 'old', 100);
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES ('old', 'old', 1, 'user', 's', 100)`,
  ).run();
  insertSession(db, 'new', 200);

  const result = mergeSpecificPredecessor(db, {
    newSessionId: 'new',
    predecessorId: 'old',
    now: 200,
  });

  assert.equal(result.merged, true);
  assert.equal(result.predecessorId, 'old');
  assert.equal(result.rowCounts.sk, 1);

  const skRow = db.prepare('SELECT session_id FROM skeletons').get();
  assert.equal(skRow.session_id, 'new');

  const oldRow = db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get('old');
  assert.equal(oldRow.merged_into, 'new');
});

test('mergeSpecificPredecessor: self-handoff is refused', () => {
  const db = makeDb();
  insertSession(db, 'A', 100);

  const result = mergeSpecificPredecessor(db, {
    newSessionId: 'A',
    predecessorId: 'A',
    now: 100,
  });

  assert.equal(result.merged, false);
  assert.equal(result.skipReason, 'self_handoff');
});

test('mergeSpecificPredecessor: predecessor not in sessions table', () => {
  const db = makeDb();
  insertSession(db, 'new', 200);

  const result = mergeSpecificPredecessor(db, {
    newSessionId: 'new',
    predecessorId: 'nonexistent',
    now: 200,
  });

  assert.equal(result.merged, false);
  assert.equal(result.skipReason, 'predecessor_not_found');
});

test('mergeSpecificPredecessor: predecessor already merged into third session', () => {
  const db = makeDb();
  insertSession(db, 'old', 100, 'middle');
  insertSession(db, 'middle', 150);
  insertSession(db, 'new', 200);

  const result = mergeSpecificPredecessor(db, {
    newSessionId: 'new',
    predecessorId: 'old',
    now: 200,
  });

  assert.equal(result.merged, false);
  assert.equal(result.skipReason, 'already_merged');
});

test('mergeSpecificPredecessor: refuses predecessor with created_at >= self', () => {
  const db = makeDb();
  insertSession(db, 'new', 100);
  insertSession(db, 'newer', 200);

  const result = mergeSpecificPredecessor(db, {
    newSessionId: 'new',
    predecessorId: 'newer',
    now: 100,
  });

  assert.equal(result.merged, false);
  assert.equal(result.skipReason, 'predecessor_not_older');
});

test('mergeSpecificPredecessor: updates new session updated_at to provided now', () => {
  const db = makeDb();
  insertSession(db, 'old', 100);
  insertSession(db, 'new', 200);

  mergeSpecificPredecessor(db, {
    newSessionId: 'new',
    predecessorId: 'old',
    now: 500,
  });

  const newRow = db.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get('new');
  assert.equal(newRow.updated_at, 500);
});
