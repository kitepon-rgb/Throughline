import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeBaton, consumeBaton, BATON_TTL_MS } from './baton.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE handoff_batons (
      project_path TEXT    PRIMARY KEY,
      session_id   TEXT    NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  return db;
}

test('BATON_TTL_MS default is 1 hour', () => {
  assert.equal(BATON_TTL_MS, 60 * 60 * 1000);
});

test('writeBaton: inserts a fresh baton', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/proj', sessionId: 'S1', now: 1000 });
  const row = db.prepare('SELECT * FROM handoff_batons').get();
  assert.equal(row.project_path, '/proj');
  assert.equal(row.session_id, 'S1');
  assert.equal(row.created_at, 1000);
});

test('writeBaton: overwrites previous baton for same project_path', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/proj', sessionId: 'S1', now: 1000 });
  writeBaton(db, { projectPath: '/proj', sessionId: 'S2', now: 2000 });
  const rows = db.prepare('SELECT * FROM handoff_batons').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'S2');
  assert.equal(rows[0].created_at, 2000);
});

test('writeBaton: separate project_paths coexist', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/a', sessionId: 'A', now: 1000 });
  writeBaton(db, { projectPath: '/b', sessionId: 'B', now: 1000 });
  const rows = db.prepare('SELECT * FROM handoff_batons ORDER BY project_path').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].project_path, '/a');
  assert.equal(rows[1].project_path, '/b');
});

test('consumeBaton: returns sessionId and deletes when within TTL', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/proj', sessionId: 'S1', now: 1000 });
  const result = consumeBaton(db, {
    projectPath: '/proj',
    now: 1000 + 30 * 60 * 1000, // 30 min後
    ttlMs: BATON_TTL_MS,
  });
  assert.equal(result.sessionId, 'S1');
  assert.equal(result.ageMs, 30 * 60 * 1000);

  const rows = db.prepare('SELECT * FROM handoff_batons').all();
  assert.equal(rows.length, 0, 'baton should be deleted after consumption');
});

test('consumeBaton: returns expired when age exceeds TTL, still deletes', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/proj', sessionId: 'S1', now: 1000 });
  const result = consumeBaton(db, {
    projectPath: '/proj',
    now: 1000 + 2 * 60 * 60 * 1000, // 2 時間後
    ttlMs: BATON_TTL_MS,
  });
  assert.equal(result.sessionId, null);
  assert.equal(result.skipReason, 'expired');
  assert.ok(result.ageMs > BATON_TTL_MS);

  const rows = db.prepare('SELECT * FROM handoff_batons').all();
  assert.equal(rows.length, 0, 'expired baton should still be deleted');
});

test('consumeBaton: returns missing when no baton exists', () => {
  const db = makeDb();
  const result = consumeBaton(db, { projectPath: '/proj', now: 1000 });
  assert.equal(result.sessionId, null);
  assert.equal(result.skipReason, 'missing');
});

test('consumeBaton: scopes per project_path (does not cross-consume)', () => {
  const db = makeDb();
  writeBaton(db, { projectPath: '/a', sessionId: 'A', now: 1000 });
  const result = consumeBaton(db, { projectPath: '/b', now: 1000 });
  assert.equal(result.sessionId, null);
  assert.equal(result.skipReason, 'missing');

  // /a のバトンは残っているはず
  const rows = db.prepare("SELECT * FROM handoff_batons WHERE project_path = '/a'").all();
  assert.equal(rows.length, 1);
});
