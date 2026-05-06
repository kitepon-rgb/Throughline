import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildTrimPlan, renderTrimDryRunReport } from './trim-model.mjs';

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

function seedTurns(db, { count = 25 } = {}) {
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES ('sess-trim', '/repo', 'active', 1, 2)`,
  ).run();

  for (let turn = 1; turn <= count; turn++) {
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('sess-trim', 'sess-trim', ?, 'user', ?, 1, ?)`,
    ).run(turn, `user body ${turn}`, turn * 1000);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('sess-trim', 'sess-trim', ?, 'assistant', ?, 1, ?)`,
    ).run(turn, `assistant body ${turn}`, turn * 1000 + 100);
  }

  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES ('sess-trim', 'sess-trim', 25, 'thinking', NULL, 'latest thought',
             1, 25100, 'thinking', 'thinking-25')`,
  ).run();
}

test('buildTrimPlan: default dry-run keeps recent 20 and marks Claude as manual-only', () => {
  const db = makeDb();
  seedTurns(db);

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'claude',
  });

  assert.equal(plan.status, 'manual-only');
  assert.equal(plan.session.id, 'sess-trim');
  assert.equal(plan.host.reason, 'claude_rewind_conversation_only_not_automated');
  assert.equal(plan.trim.capturedTurns, 25);
  assert.equal(plan.trim.keepRecent, 20);
  assert.equal(plan.trim.rollbackTurns, 5);
  assert.equal(plan.trim.automaticExecutionAllowed, false);
  assert.equal(plan.memoryPreview.stats.recentBodies, 40);
  assert.match(plan.memoryPreview.text, /assistant body 25/);
  assert.match(plan.memoryPreview.text, /current-task context for continuation/);
  assert.match(plan.memoryPreview.text, /Do not treat every older line as still-current truth/);
});

test('buildTrimPlan: --all plans to roll back every captured turn without enabling automation', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    trimAll: true,
  });

  assert.equal(plan.status, 'verified-host-primitive');
  assert.equal(plan.host.reason, 'codex_thread_rollback_inject_verified_but_not_integrated');
  assert.deepEqual(plan.hostIdentity, {
    host: 'codex',
    codexThreadId: null,
    explicit: false,
    reason: 'codex_thread_id_not_provided',
  });
  assert.equal(plan.trim.keepRecent, 0);
  assert.equal(plan.trim.rollbackTurns, 3);
  assert.equal(plan.trim.automaticExecutionAllowed, false);
});

test('buildTrimPlan: explicit Codex thread id is carried separately from Claude session id', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    trimAll: true,
  });

  assert.deepEqual(plan.hostIdentity, {
    host: 'codex',
    codexThreadId: '019dfabf-thread',
    explicit: true,
    reason: 'explicit_codex_thread_id',
  });
  assert.equal(plan.session.id, 'sess-trim');
  assert.equal(plan.trim.automaticExecutionAllowed, false);
});

test('buildTrimPlan: current-work memo is placed in curated memory preview', () => {
  const db = makeDb();
  seedTurns(db, { count: 3 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'claude',
    inflightMemo: '**次の一手**: keep implementing trim dry-run',
  });

  assert.match(plan.memoryPreview.text, /In-flight Memo/);
  assert.match(plan.memoryPreview.text, /keep implementing trim dry-run/);
});

test('renderTrimDryRunReport: explains host boundary and curated memory', () => {
  const db = makeDb();
  seedTurns(db, { count: 2 });

  const plan = buildTrimPlan(db, {
    sessionId: 'sess-trim',
    host: 'unknown',
    keepRecent: 20,
  });
  const report = renderTrimDryRunReport(plan);

  assert.match(report, /Throughline Trim Dry-run/);
  assert.match(report, /Automatic execution allowed: no/);
  assert.match(report, /host_unknown/);
  assert.match(report, /Curated Memory Preview/);
});
