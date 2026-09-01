import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildBudgetedResumeContext, INJECTION_BUDGET_CHARS } from '../resume-context.mjs';
import { parseArgs, readSessionProjectPath } from './handoff-context.mjs';

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

test('handoff-context adds a project-bound supplement inside the shared budget', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-'));
  try {
    const { db, dbPath } = createFixture(home);
    const before = ownershipSnapshot(db);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/project',
      sections: [
        { title: '長期記憶', content: 'オーナーとの約束を大切にしている' },
        { title: '関連知識', content: 'BellTeamではBotごとにprojectを分離する' },
      ],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.match(context, /このBotの長期記憶と関連知識/);
    assert.match(context, /オーナーとの約束を大切にしている/);
    assert.match(context, /BellTeamではBotごとにprojectを分離する/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
    assert.ok(context.indexOf('長期記憶') < context.indexOf('直前の対話'));
    assert.ok(context.length <= INJECTION_BUDGET_CHARS);

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context returns a project-bound supplement when the captured session has no dialogue yet', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-only-'));
  try {
    const { db, dbPath } = createFixture(home);
    db.exec('DELETE FROM details; DELETE FROM bodies; DELETE FROM skeletons;');
    const before = ownershipSnapshot(db);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/project',
      sections: [{ title: 'Botプロフィール', content: '名前はCursor確認担当' }],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'throughline.handoff_context.v1',
      status: 'ready',
      sessionId: SESSION_ID,
      context: '## このBotの長期記憶と関連知識\n\n### Botプロフィール\n名前はCursor確認担当',
    });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(ownershipSnapshot(verify), before);
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context refuses a supplement from another bot project', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-supplement-scope-'));
  try {
    const { db } = createFixture(home);
    db.close();
    const supplementFile = join(home, 'supplement.json');
    writeFileSync(supplementFile, JSON.stringify({
      schema: 'throughline.handoff_supplement.v1',
      projectPath: '/work/other-bot',
      sections: [{ title: '長期記憶', content: 'B_PRIVATE_MEMORY' }],
    }));

    const result = runCli(home, [
      'handoff-context', '--session', SESSION_ID, '--json',
      '--supplement-file', supplementFile,
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /B_PRIVATE_MEMORY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context accepts only the documented supplement argument shape', () => {
  assert.deepEqual(parseArgs(['--session', 's', '--json']), {
    sessionId: 's',
    supplementFile: null,
  });
  assert.deepEqual(parseArgs([
    '--session', 's', '--json', '--supplement-file', '/tmp/memory.json',
  ]), {
    sessionId: 's',
    supplementFile: '/tmp/memory.json',
  });
  assert.throws(() => parseArgs(['--session', 's', '--supplement-file', '/tmp/memory.json', '--json']));
});

test('readSessionProjectPath returns the source session project', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-session-project-'));
  try {
    const { db, dbPath } = createFixture(home);
    db.close();
    assert.equal(readSessionProjectPath(SESSION_ID, { dbPath }), '/work/project');
    assert.equal(readSessionProjectPath('missing', { dbPath }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-context excludes another bot project from every memory layer', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-handoff-context-project-scope-'));
  try {
    const { db } = createFixture(home);
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_path, status, created_at, updated_at, merged_into)
       VALUES ('bot-b-session', '/work/other-bot', 'active', 1, 4, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('bot-b-session', 'bot-b-session', 1, 'assistant', 'B_PRIVATE_L1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('bot-b-session', 'bot-b-session', 2, 'user', 'B_PRIVATE_L2', 4, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO details
         (session_id, origin_session_id, turn_number, tool_name, output_text, created_at, kind, source_id)
       VALUES ('bot-b-session', 'bot-b-session', 2, 'B_PRIVATE_L3', 'B_PRIVATE_DETAIL', 3, 'tool_output', 'bot-b-detail')`,
    ).run();
    db.close();

    const result = runCli(home);
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.doesNotMatch(context, /B_PRIVATE_L1|B_PRIVATE_L2|B_PRIVATE_L3|B_PRIVATE_DETAIL/);
    assert.match(context, /所有権を変えずに記憶を渡して/);
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
