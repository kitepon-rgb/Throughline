import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildBudgetedResumeContext } from '../resume-context.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const SESSION_ID = 'claude-source-session';

function runCli(home, args = ['handoff-context', '--session', SESSION_ID, '--json']) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

function createFixture(home) {
  const dir = join(home, '.throughline');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'throughline.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 9;
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
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      origin_session_id TEXT
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
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      origin_session_id TEXT,
      kind TEXT NOT NULL DEFAULT 'tool_input',
      source_id TEXT
    );
  `);
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_path, status, created_at, updated_at, merged_into)
     VALUES (?, ?, 'active', ?, ?, NULL)`,
  ).run(SESSION_ID, '/work/project', 1_700_000_000_000, 1_700_000_004_000);
  db.prepare(
    `INSERT INTO skeletons
       (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, 1, 'assistant', ?, ?)`,
  ).run(SESSION_ID, 'older-origin', '以前に portable fork の方針を決めた', 1_700_000_001_000);
  const insertBody = db.prepare(
    `INSERT INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, 2, ?, ?, 8, ?)`,
  );
  insertBody.run(SESSION_ID, SESSION_ID, 'user', '所有権を変えずに記憶を渡して', 1_700_000_002_000);
  insertBody.run(SESSION_ID, SESSION_ID, 'assistant', 'read-only I/F を実装する', 1_700_000_003_000);
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, output_text, created_at, kind, source_id)
     VALUES (?, ?, 2, 'Read', 'schema inspected', ?, 'tool_output', 'detail-1')`,
  ).run(SESSION_ID, SESSION_ID, 1_700_000_003_500);
  return { db, dbPath };
}

function ownershipSnapshot(db) {
  return {
    sessions: db.prepare('SELECT session_id, merged_into FROM sessions ORDER BY session_id').all(),
    skeletons: db.prepare('SELECT id, session_id FROM skeletons ORDER BY id').all(),
    bodies: db.prepare('SELECT id, session_id FROM bodies ORDER BY id').all(),
    details: db.prepare('SELECT id, session_id FROM details ORDER BY id').all(),
  };
}

test('handoff-context emits the exact inheritance context without changing DB ownership', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-'));
  try {
    const { db, dbPath } = createFixture(home);
    const before = ownershipSnapshot(db);
    const expected = buildBudgetedResumeContext(db, {
      sessionId: SESSION_ID,
      isInheritance: true,
    })?.text;
    db.close();

    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'ready',
      sessionId: SESSION_ID,
      context: expected,
    });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context fails without creating a missing database', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-missing-'));
  try {
    const result = runCli(home);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(home, '.throughline')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
