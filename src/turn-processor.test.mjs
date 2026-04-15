import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  L2_WINDOW,
  countDistinctBodyTurns,
  pickOldestUnsummarizedTurn,
} from './turn-processor.mjs';

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
  `);
  return db;
}

/** 1 往復 (user+assistant) を同じ turn_number で保存。実装と同じペアリング規約。 */
function insertTurn(db, { session, origin, turn, createdAt }) {
  const stmt = db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(session, origin, turn, 'user', `u${turn}`, 1, createdAt);
  stmt.run(session, origin, turn, 'assistant', `a${turn}`, 1, createdAt);
}

function insertSkeleton(db, { session, origin, turn, createdAt }) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?)`,
  ).run(session, origin, turn, `s${turn}`, createdAt);
}

test('L2_WINDOW is 20', () => {
  assert.equal(L2_WINDOW, 20);
});

test('countDistinctBodyTurns: 2 ロール行 = 1 ターンとして数える', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  assert.equal(countDistinctBodyTurns(db, 'S'), 2);
});

test('countDistinctBodyTurns: merge 跨ぎで origin が違うターンも別勘定', () => {
  const db = makeDb();
  // 前任 (origin=P) 15 ターン + 合流先 (origin=S) 10 ターン = 25
  for (let i = 1; i <= 15; i++) {
    insertTurn(db, { session: 'S', origin: 'P', turn: i, createdAt: i * 100 });
  }
  for (let i = 1; i <= 10; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: 10000 + i * 100 });
  }
  assert.equal(countDistinctBodyTurns(db, 'S'), 25);
});

test('pickOldestUnsummarizedTurn: 全ターンが未要約なら created_at 最小を返す', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 3, createdAt: 300 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.turn_number, 1);
  assert.equal(oldest?.origin_session_id, 'S');
  assert.equal(oldest?.created_at, 100);
});

test('pickOldestUnsummarizedTurn: 既に要約済みのターンはスキップ', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 3, createdAt: 300 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 2, createdAt: 200 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.turn_number, 3);
});

test('pickOldestUnsummarizedTurn: 全部要約済みなら null', () => {
  const db = makeDb();
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  assert.equal(pickOldestUnsummarizedTurn(db, 'S'), null);
});

test('pickOldestUnsummarizedTurn: merge 跨ぎで前任の最古ターンを優先', () => {
  const db = makeDb();
  // 前任 (origin=P) 15 ターン + 合流先 (origin=S) 10 ターン
  for (let i = 1; i <= 15; i++) {
    insertTurn(db, { session: 'S', origin: 'P', turn: i, createdAt: i * 100 });
  }
  for (let i = 1; i <= 10; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: 10000 + i * 100 });
  }
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.origin_session_id, 'P');
  assert.equal(oldest?.turn_number, 1);
  assert.equal(oldest?.created_at, 100);
});

test('pickOldestUnsummarizedTurn: 同じ turn_number でも origin が違えば別扱い', () => {
  const db = makeDb();
  // 前任 turn 1 (未要約) と 合流先 turn 1 (要約済) が共存
  insertTurn(db, { session: 'S', origin: 'P', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 1, createdAt: 500 });
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 500 });
  const oldest = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(oldest?.origin_session_id, 'P');
  assert.equal(oldest?.turn_number, 1);
});

test('逐次要約シナリオ: 20 ターンまでは要約発火しない、21 ターン目で発火', () => {
  const db = makeDb();
  // 20 ターン投入
  for (let i = 1; i <= 20; i++) {
    insertTurn(db, { session: 'S', origin: 'S', turn: i, createdAt: i * 100 });
  }
  // 20 ターン時点: window を超えていないので要約しない
  assert.equal(countDistinctBodyTurns(db, 'S') > L2_WINDOW, false);

  // 21 ターン目投入
  insertTurn(db, { session: 'S', origin: 'S', turn: 21, createdAt: 2100 });
  assert.equal(countDistinctBodyTurns(db, 'S') > L2_WINDOW, true);

  // 最古 = turn 1 が要約対象として選ばれる
  const target1 = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(target1?.turn_number, 1);

  // turn 1 を要約済にして次のターンを模擬
  insertSkeleton(db, { session: 'S', origin: 'S', turn: 1, createdAt: 100 });
  insertTurn(db, { session: 'S', origin: 'S', turn: 22, createdAt: 2200 });

  // 次は turn 2 が選ばれる
  const target2 = pickOldestUnsummarizedTurn(db, 'S');
  assert.equal(target2?.turn_number, 2);
});
