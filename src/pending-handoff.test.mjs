import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerPendingHandoff, consumePendingHandoff } from './pending-handoff.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pending_handoffs (
      session_id          TEXT    PRIMARY KEY,
      project_path        TEXT    NOT NULL,
      source              TEXT,
      auto_predecessor_id TEXT,
      created_at          INTEGER NOT NULL
    );
  `);
  return db;
}

test('registerPendingHandoff: inserts an intent row', () => {
  const db = makeDb();
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'startup',
    now: 1000,
  });
  const row = db.prepare('SELECT * FROM pending_handoffs').get();
  assert.equal(row.session_id, 'S1');
  assert.equal(row.project_path, '/proj');
  assert.equal(row.source, 'startup');
  assert.equal(row.auto_predecessor_id, null);
  assert.equal(row.created_at, 1000);
});

test('registerPendingHandoff: re-registration (resume) updates source and created_at', () => {
  const db = makeDb();
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'startup',
    now: 1000,
  });
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'resume',
    now: 5000,
  });
  const rows = db.prepare('SELECT * FROM pending_handoffs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'resume');
  assert.equal(rows[0].created_at, 5000);
});

test('registerPendingHandoff: stores frozen auto predecessor for source=clear', () => {
  const db = makeDb();
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'clear',
    autoPredecessorId: 'PRED',
    now: 1000,
  });
  const row = db.prepare('SELECT * FROM pending_handoffs').get();
  assert.equal(row.auto_predecessor_id, 'PRED');
});

test('consumePendingHandoff: returns the row once and deletes it', () => {
  const db = makeDb();
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'clear',
    autoPredecessorId: 'PRED',
    now: 1234,
  });

  const first = consumePendingHandoff(db, { sessionId: 'S1' });
  assert.deepEqual(first, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'clear',
    autoPredecessorId: 'PRED',
    createdAt: 1234,
  });

  const second = consumePendingHandoff(db, { sessionId: 'S1' });
  assert.equal(second, null, 'second consumption must return null (row deleted)');
});

test('consumePendingHandoff: returns null for an unknown session (not newborn)', () => {
  const db = makeDb();
  registerPendingHandoff(db, {
    sessionId: 'S1',
    projectPath: '/proj',
    source: 'startup',
    now: 1000,
  });
  const result = consumePendingHandoff(db, { sessionId: 'OTHER' });
  assert.equal(result, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM pending_handoffs').get().c,
    1,
    'other sessions must not consume S1 pending row',
  );
});
