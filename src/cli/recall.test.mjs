import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseRecallArgs, renderRecallL2, renderRecallL1 } from './recall.mjs';

const BIN = fileURLToPath(new URL('../../bin/throughline.mjs', import.meta.url));

function makeDb(path = ':memory:') {
  const db = new DatabaseSync(path);
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

function insertBody(db, { session, origin, turn, role, text, createdAt }) {
  db.prepare(
    `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(session, origin, turn, role, text, createdAt);
}

function insertSkeleton(db, { session, origin, turn, role, summary, createdAt }) {
  db.prepare(
    `INSERT INTO skeletons (session_id, origin_session_id, turn_number, role, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(session, origin, turn, role, summary, createdAt);
}

// day: 2026-07-17T23:50:00Z 起点の ms を返す (深夜跨ぎテスト用)
const BASE = Date.parse('2026-07-17T23:50:00.000Z');

function seedTurns(db, { session = 's1', origin = 'o1', turns = 10, stepMs = 60_000 } = {}) {
  for (let t = 1; t <= turns; t += 1) {
    insertBody(db, {
      session, origin, turn: t, role: 'user',
      text: `q-${String(t).padStart(2, '0')}`, createdAt: BASE + t * stepMs,
    });
    insertBody(db, {
      session, origin, turn: t, role: 'assistant',
      text: `a-${String(t).padStart(2, '0')}`, createdAt: BASE + t * stepMs + 1_000,
    });
  }
}

test('parseRecallArgs: mode/session/before are required, --l2 requires --last', () => {
  assert.throws(() => parseRecallArgs([]), /--l2 または --l1/);
  assert.throws(() => parseRecallArgs(['--l2', '--session', 's', '--last', '3']), /--before は必須/);
  assert.throws(() => parseRecallArgs(['--l2', '--before', '2026-07-18T00:00:00Z', '--last', '3']), /--session は必須/);
  assert.throws(
    () => parseRecallArgs(['--l2', '--session', 's', '--before', '2026-07-18T00:00:00Z']),
    /--last <N> が必須/,
  );
  assert.throws(() => parseRecallArgs(['--l2', '--l1']), /同時に指定できません/);
  assert.throws(
    () => parseRecallArgs(['--l2', '--session', 's', '--before', '14:02:11', '--last', '3']),
    /解釈できません/,
    'HH:MM:SS 単独は日付が無く受け付けない (深夜跨ぎで壊れるため ISO 必須)',
  );
  const ok = parseRecallArgs([
    '--l1', '--session', 's', '--before', '2026-07-18T00:00:00.482Z', '--skip', '7',
  ]);
  assert.equal(ok.mode, 'l1');
  assert.equal(ok.beforeMs, Date.parse('2026-07-18T00:00:00.482Z'));
  assert.equal(ok.skip, 7);
});

test('recall --l2: strict less-than ms boundary, newest-first selection, oldest-first output', () => {
  const db = makeDb();
  seedTurns(db, { turns: 10 });
  // 境界 = turn 8 の min(created_at) → turn 7 以前だけが対象 (turn 8 自身は含まない)
  const boundary = BASE + 8 * 60_000;

  const { text, turnCount } = renderRecallL2(db, { sessionId: 's1', beforeMs: boundary, last: 3 });

  assert.equal(turnCount, 3);
  assert.ok(!text.includes('a-08'), 'boundary turn itself must be excluded (strict less-than)');
  assert.ok(text.includes('q-05') && text.includes('a-07'), 'turns 5..7 must be returned');
  assert.ok(!text.includes('q-04 '), 'turns older than --last window are not returned');
  // 古い順: q-05 が a-07 より先
  assert.ok(text.indexOf('q-05') < text.indexOf('a-07'));
});

test('recall --l2: same-second sibling rows are split exactly by ms boundary (no gap, no overlap)', () => {
  const db = makeDb();
  const sec = Date.parse('2026-07-18T01:02:03.000Z');
  // 同一秒内に 2 ターン (ms 差のみ)
  insertBody(db, { session: 's1', origin: 'o1', turn: 1, role: 'assistant', text: 'ms-100', createdAt: sec + 100 });
  insertBody(db, { session: 's1', origin: 'o1', turn: 2, role: 'assistant', text: 'ms-482', createdAt: sec + 482 });

  const { text } = renderRecallL2(db, { sessionId: 's1', beforeMs: sec + 482, last: 10 });
  assert.ok(text.includes('ms-100'), 'older same-second row must be included');
  assert.ok(!text.includes('ms-482'), 'boundary row itself must be excluded');
});

test('recall --l2: ISO boundary works across midnight (no today-anchored resolution)', () => {
  const db = makeDb();
  seedTurns(db, { turns: 10 }); // BASE=23:50Z 起点、turn 10 は翌日 00:30Z 台
  const boundary = BASE + 10 * 60_000; // 日付跨ぎ後の turn 10 の min

  const { text, turnCount } = renderRecallL2(db, { sessionId: 's1', beforeMs: boundary, last: 20 });
  assert.equal(turnCount, 9, 'all 9 turns before the post-midnight boundary must be found');
  assert.ok(text.includes('q-01'));
});

test('recall --l2: results do not shift when the new session appends turns (no window recomputation)', () => {
  const db = makeDb();
  seedTurns(db, { turns: 10 });
  const boundary = BASE + 8 * 60_000;
  const before = renderRecallL2(db, { sessionId: 's1', beforeMs: boundary, last: 3 });

  // 新セッションのターンが同じ session_id へ大量に追記されても (merge 後の走行)、
  // recall の結果は焼き込まれた境界だけで決まり不変
  for (let t = 100; t < 130; t += 1) {
    insertBody(db, {
      session: 's1', origin: 'newborn', turn: t, role: 'assistant',
      text: `new-${t}`, createdAt: BASE + t * 60_000,
    });
  }
  const after = renderRecallL2(db, { sessionId: 's1', beforeMs: boundary, last: 3 });
  assert.equal(after.text, before.text);
});

test('recall --l2: fewer rows than --last is announced, not silent', () => {
  const db = makeDb();
  seedTurns(db, { turns: 3 });
  const { text, turnCount } = renderRecallL2(db, {
    sessionId: 's1', beforeMs: BASE + 3 * 60_000, last: 13,
  });
  assert.equal(turnCount, 2);
  assert.match(text, /--last 13 のうち DB に存在するのは 2 ターンのみ/);
});

test('recall --l2: other sessions are not mixed in', () => {
  const db = makeDb();
  seedTurns(db, { turns: 3 });
  insertBody(db, {
    session: 'codex:zzz', origin: 'codex:zzz', turn: 1, role: 'assistant',
    text: 'codex-row', createdAt: BASE + 60_000,
  });
  const { text } = renderRecallL2(db, { sessionId: 's1', beforeMs: BASE + 10 * 60_000, last: 20 });
  assert.ok(!text.includes('codex-row'));
});

test('recall --l2: L3 suffix appears on the last row of each turn', () => {
  const db = makeDb();
  seedTurns(db, { turns: 3 });
  db.prepare(
    `INSERT INTO details (session_id, origin_session_id, turn_number, tool_name, input_text, output_text, token_count, created_at, kind, source_id)
     VALUES ('s1', 'o1', 1, 'Bash', 'ls', 'ok', 1, ?, 'tool_input', 'tu-1')`,
  ).run(BASE + 60_000 + 500);
  const { text } = renderRecallL2(db, { sessionId: 's1', beforeMs: BASE + 10 * 60_000, last: 20 });
  assert.match(text, /a-01 \(詳細：Bash\)/);
});

test('recall --l1: skip jumps over the --l2 range; summarized and unsummarized turns are both listed', () => {
  const db = makeDb();
  seedTurns(db, { turns: 10 });
  // turn 1, 2 だけ要約済み
  insertSkeleton(db, { session: 's1', origin: 'o1', turn: 1, role: 'assistant', summary: 'sum-1', createdAt: BASE });
  insertSkeleton(db, { session: 's1', origin: 'o1', turn: 2, role: 'assistant', summary: 'sum-2', createdAt: BASE });

  // 境界 = turn 8 の min。--skip 3 で turn 7..5 を飛ばし、turn 4 以前が対象
  const boundary = BASE + 8 * 60_000;
  const { text, turnCount, summarizedCount } = renderRecallL1(db, {
    sessionId: 's1', beforeMs: boundary, skip: 3,
  });

  assert.equal(turnCount, 4, 'turns 1..4 must be listed');
  assert.equal(summarizedCount, 2);
  assert.match(text, /全4ターン \/ 要約済み 2/);
  assert.ok(text.includes('sum-1') && text.includes('sum-2'));
  assert.match(text, /\(未要約\) 全文: throughline detail \d{2}:\d{2}:\d{2}/);
  assert.ok(!text.includes('q-05'), 'skipped turns (--l2 range) must not appear');
  // 古い順: sum-1 が未要約 turn 4 より先
  assert.ok(text.indexOf('sum-1') < text.indexOf('(未要約)'));
});

test('recall --l1: empty result is explicit', () => {
  const db = makeDb();
  seedTurns(db, { turns: 2 });
  const { text, turnCount } = renderRecallL1(db, {
    sessionId: 's1', beforeMs: BASE + 2 * 60_000, skip: 5,
  });
  assert.equal(turnCount, 0);
  assert.match(text, /該当ターンなし/);
});

test('recall CLI: read-only contract — missing DB is an explicit error and is not created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-recall-'));
  const dbPath = join(dir, 'nope', 'throughline.db');
  try {
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [BIN, 'recall', '--l2', '--session', 's1',
          '--before', '2026-07-18T00:00:00Z', '--last', '3', '--db', dbPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      failed = true;
      assert.match(String(err.stderr), /DB がありません/);
    }
    assert.ok(failed, 'missing DB must exit non-zero');
    assert.ok(!existsSync(dbPath), 'recall must not create the DB');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall CLI: end-to-end via bin dispatcher against a real DB file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-recall-'));
  const dbPath = join(dir, 'throughline.db');
  try {
    const db = makeDb(dbPath);
    seedTurns(db, { turns: 5 });
    db.close();

    const boundaryIso = new Date(BASE + 4 * 60_000).toISOString();
    const out = execFileSync(
      process.execPath,
      [BIN, 'recall', '--l2', '--session', 's1',
        '--before', boundaryIso, '--last', '2', '--db', dbPath],
      { encoding: 'utf8' },
    );
    assert.match(out, /## Throughline recall \(L2\): 2ターン/);
    assert.ok(out.includes('a-03') && out.includes('q-02'));
    assert.ok(!out.includes('a-04'), 'boundary turn must be excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
