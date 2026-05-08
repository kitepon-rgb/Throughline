import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildResumeContext } from './resume-context.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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

function insertSkeleton(db, row) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.summary, row.createdAt);
}

function insertBody(db, row) {
  db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.session, row.origin, row.turn, row.role, row.text, 1, row.createdAt);
}

function insertThinking(db, row) {
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, 'thinking', NULL, ?, 1, ?, 'thinking', ?)`,
  ).run(row.session, row.origin, row.turn, row.text, row.createdAt, row.sourceId);
}

test('buildResumeContext: inheritance output order is L1 -> L2 -> L3 refs -> reminder (no memo / no thinking)', () => {
  const db = makeDb();

  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'older L1 summary',
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
  // thinking は DB に書かれても、新仕様では注入テキストに出ない
  insertThinking(db, {
    session: 'new',
    origin: 'old',
    turn: 2,
    text: 'latest thinking block',
    createdAt: 2200,
    sourceId: 'asst:thinking:0',
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    // inflightMemo は互換のため受け取れるが、新仕様では注入テキストに使わない
    inflightMemo: '**Next**: keep going (should NOT appear)',
  });

  assert.ok(text);
  assert.match(text, /^## Throughline: 中断した作業の再開/);

  // 新仕様: memo / thinking セクションは注入されない
  assert.ok(text.indexOf('### 中断直前の in-flight メモ') < 0, 'memo section should not be injected');
  assert.ok(text.indexOf('### 中断直前の思考') < 0, 'thinking section should not be injected');
  assert.ok(!text.includes('**Next**: keep going'), 'inflightMemo content should be ignored');
  assert.ok(!text.includes('latest thinking block'), 'thinking text should not appear');

  // 注入される順序: L1 → L2 → L3 refs → 再開指示
  const l1Idx = text.indexOf('### それ以前の要約 (L1)');
  const l2Idx = text.indexOf('### 現在進行中の作業履歴 (L2 / active work thread)');
  const l3Idx = text.indexOf('### L3 詳細参照');
  const reminderIdx = text.indexOf('**再開指示:**');

  assert.ok(l1Idx > 0, 'L1 section should be present');
  assert.ok(l2Idx > l1Idx, 'L2 should follow L1');
  assert.ok(l3Idx > l2Idx, 'L3 references should follow L2');
  assert.ok(reminderIdx > l3Idx, 'continuation reminder should follow L3 refs');

  assert.ok(text.includes('older L1 summary'));
  assert.ok(text.includes('[user]: recent user body'));
  assert.ok(text.includes('[assistant]: recent assistant body'));
  // L3 refs は detail コマンドのみ (本文は注入しない)
  assert.match(text, /throughline detail \d{2}:\d{2}:\d{2}/);
  assert.match(text, /単なる過去ログではなく、現在進行中の作業/);
});

test('buildResumeContext: returns null when no memory rows or inflight memo exist', () => {
  const db = makeDb();
  assert.equal(
    buildResumeContext(db, { sessionId: 'empty', isInheritance: true }),
    null,
  );
});

test('buildResumeContext: excludeOriginId omits rows from the current origin', () => {
  const db = makeDb();

  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'old origin body',
    createdAt: 1000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'new',
    turn: 1,
    role: 'assistant',
    text: 'current origin body',
    createdAt: 2000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: false,
    excludeOriginId: 'new',
  });

  assert.ok(text);
  assert.ok(text.includes('old origin body'));
  assert.ok(!text.includes('current origin body'));
});
