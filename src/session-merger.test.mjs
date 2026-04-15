import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolveMergeTarget, mergePredecessorInto } from './session-merger.mjs';

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
    CREATE TABLE judgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
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

test('mergePredecessorInto: picks older predecessor and moves rows', () => {
  const db = makeDb();
  insertSession(db, 'old', 100);
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES ('old', 'old', 1, 'user', 's', 100)`,
  ).run();
  insertSession(db, 'new', 200);

  const result = mergePredecessorInto(db, { newSessionId: 'new', projectPath: '/proj' });
  assert.equal(result.merged, true);
  assert.equal(result.predecessorId, 'old');
  assert.equal(result.rowCounts.sk, 1);

  const skRow = db.prepare('SELECT session_id FROM skeletons').get();
  assert.equal(skRow.session_id, 'new');

  const oldRow = db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get('old');
  assert.equal(oldRow.merged_into, 'new');
});

test('mergePredecessorInto: does NOT pick a session newer than self (cycle prevention)', () => {
  const db = makeDb();
  // new session created at t=100
  insertSession(db, 'new', 100);
  // another session was created LATER at t=200 (e.g. a parallel window that started after)
  insertSession(db, 'newer', 200);

  const result = mergePredecessorInto(db, { newSessionId: 'new', projectPath: '/proj' });
  assert.equal(result.merged, false, 'should not merge a newer session into an older one');

  const newerRow = db
    .prepare('SELECT merged_into FROM sessions WHERE session_id = ?')
    .get('newer');
  assert.equal(newerRow.merged_into, null);
});

test('mergePredecessorInto: chronological monotonicity prevents cycles across 3 sessions', () => {
  const db = makeDb();
  // Sessions created in order: A (t=100), B (t=200), C (t=300)
  insertSession(db, 'A', 100);
  insertSession(db, 'B', 200);
  insertSession(db, 'C', 300);

  // Simulate SessionStart firing for B first, then C, then (accidentally) A again
  mergePredecessorInto(db, { newSessionId: 'B', projectPath: '/proj' });
  // B should have absorbed A
  assert.equal(
    db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get('A').merged_into,
    'B',
  );

  mergePredecessorInto(db, { newSessionId: 'C', projectPath: '/proj' });
  // C should have absorbed B (A is already merged, so not a candidate)
  assert.equal(
    db.prepare('SELECT merged_into FROM sessions WHERE session_id = ?').get('B').merged_into,
    'C',
  );

  // Re-firing SessionStart for A must not create a cycle (A cannot absorb newer B or C)
  const redundant = mergePredecessorInto(db, { newSessionId: 'A', projectPath: '/proj' });
  assert.equal(redundant.merged, false);

  // Verify no cycle: resolveMergeTarget from any node terminates at C
  assert.equal(resolveMergeTarget(db, 'A').target, 'C');
  assert.equal(resolveMergeTarget(db, 'B').target, 'C');
  assert.equal(resolveMergeTarget(db, 'C').target, 'C');
});
