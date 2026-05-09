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

function insertDetail(db, row) {
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
        token_count, created_at, kind, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session,
    row.origin,
    row.turn,
    row.toolName ?? row.kind,
    row.input ?? null,
    row.output ?? null,
    row.tokenCount ?? 1,
    row.createdAt,
    row.kind,
    row.sourceId ?? null,
  );
}

test('buildResumeContext: header is terse and announces the Bash invocation contract', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'hi',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);
  assert.match(text, /^## Throughline: 中断した作業の再開/);

  // 旧版の冗長な行は全部削除
  assert.ok(!text.includes('と報告してください'), 'meta-report instruction must be gone');
  assert.ok(!text.includes('一番下の'), 'redundant ordering hint must be gone');
  assert.ok(!text.includes('内訳の読み方'), 'glossary block must be gone');
  assert.ok(!text.includes('現在進行中の作業の active work context'), 'verbose framing must be gone');

  // 残るのは 2 行: 自然な続き + Bash 呼び出し方法
  assert.match(text, /直前の対話の自然な続きとして応答してください/);
  assert.match(
    text,
    /\*\*各ターンの詳細の取得方法\*\*: \*\*`Bash` ツールで `throughline detail HH:MM:SS` を実行\*\* \(該当ターンの本文＋詳細を stdout に返します\)/,
  );
});

test('buildResumeContext: L2 is the very last section (anchored at bottom for attention)', () => {
  const db = makeDb();
  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'older L1 summary',
    createdAt: 800,
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
    text: 'recent assistant body — this should be the last line',
    createdAt: 2100,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  assert.ok(!text.includes('**再開指示:**'), 'continuation reminder should be removed');
  assert.ok(!text.includes('### L3 詳細参照'), 'standalone L3 section should be removed');

  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.match(
    lines[lines.length - 1],
    /\[assistant\]: recent assistant body — this should be the last line/,
  );

  const l1Idx = text.indexOf('### それ以前の要約 (L1)');
  const l2Idx = text.indexOf('### 直前の対話 (L2 / active work thread, 古い順)');
  assert.ok(l1Idx > 0, 'L1 section should be present');
  assert.ok(l2Idx > l1Idx, 'L2 section should follow L1');
});

test('buildResumeContext: L2 entries get inline (詳細：…) suffixes with tool-name-aware labels', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'assistant',
    text: 'turn with tools',
    createdAt: 5000,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'thinking',
    toolName: 'thinking',
    output: 'thinking text',
    createdAt: 5010,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'ls',
    createdAt: 5020,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'pwd',
    createdAt: 5030,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_output',
    toolName: 'Bash',
    output: 'home',
    createdAt: 5040,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'system',
    toolName: 'UserPromptSubmit',
    output: 'hook ran',
    createdAt: 5050,
  });
  // MCP tool: 末尾の関数名だけにすべき
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'mcp__plugin_everything-claude-code_playwright__browser_navigate',
    input: '{"url":"http://example.com"}',
    createdAt: 5060,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    role: 'user',
    text: 'plain user message',
    createdAt: 6000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const turnWithToolsLine = text
    .split('\n')
    .find((l) => l.includes('turn with tools'));
  assert.ok(turnWithToolsLine, 'L2 line for turn 5 should exist');
  // - tool_input + tool_output は tool 名で集約 (Bash ×2)
  // - hook 出力 (system) は suffix から除外
  // - MCP ツール名は末尾の関数名 (browser_navigate) だけ
  assert.match(
    turnWithToolsLine,
    /\(詳細：思考, Bash ×2, browser_navigate\)$/,
  );
  assert.ok(
    !turnWithToolsLine.includes('hook 出力'),
    'hook 出力 (system) must be excluded from the suffix',
  );
  assert.ok(
    !turnWithToolsLine.includes('mcp__'),
    'MCP full path must be shortened to function name only',
  );

  // 旧版にあった `[→ throughline detail HH:MM:SS]` のリンク表記は per-line には出さない
  assert.ok(
    !turnWithToolsLine.includes('throughline detail'),
    'per-line should not repeat the throughline detail command (the header announces it)',
  );

  const plainLine = text.split('\n').find((l) => l.includes('plain user message'));
  assert.ok(plainLine, 'L2 line for turn 6 should exist');
  assert.ok(
    !plainLine.includes('詳細：'),
    'L2 turns without L3 should not carry a (詳細：…) suffix',
  );

  // 旧版にあった独立 `### Detail References` セクションも出ない
  assert.ok(!text.includes('### L3 詳細参照'));
});

test('buildResumeContext: (詳細：…) suffix appears only on the last role row of each turn (no duplication)', () => {
  const db = makeDb();
  // Turn 5: both user and assistant rows. L3 attached at turn level.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'user',
    text: 'user side of turn 5',
    createdAt: 5000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    role: 'assistant',
    text: 'assistant side of turn 5',
    createdAt: 5100,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'thinking',
    toolName: 'thinking',
    output: 'thinking',
    createdAt: 5050,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 5,
    kind: 'tool_input',
    toolName: 'Bash',
    input: 'ls',
    createdAt: 5060,
  });

  // Turn 6: only user row (e.g. compact session ending on user). suffix should
  // attach to the user row since it's the last role of the turn.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    role: 'user',
    text: 'lone user turn',
    createdAt: 6000,
  });
  insertDetail(db, {
    session: 'new',
    origin: 'old',
    turn: 6,
    kind: 'image',
    toolName: 'image',
    output: '[img]',
    createdAt: 6010,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const userTurn5 = text.split('\n').find((l) => l.includes('user side of turn 5'));
  const assistantTurn5 = text.split('\n').find((l) => l.includes('assistant side of turn 5'));
  const userTurn6 = text.split('\n').find((l) => l.includes('lone user turn'));

  assert.ok(userTurn5 && assistantTurn5 && userTurn6);
  // Turn 5: only assistant (last role of the turn) gets the suffix
  assert.ok(!userTurn5.includes('詳細：'), 'user row should not duplicate the turn suffix');
  assert.match(assistantTurn5, /\(詳細：思考, Bash\)$/);
  // Turn 6: user is the only role, so it gets the suffix
  assert.match(userTurn6, /\(詳細：画像\)$/);
});

test('buildResumeContext: L1 entries display the body time at the start and prepend "本文" to the suffix', () => {
  const db = makeDb();
  // L1 summary was created at turn-processor run time (8000), but the original
  // body was written at 1500. The line prefix [HH:MM:SS] must be the body time
  // so `Bash で throughline detail HH:MM:SS` resolves correctly.
  insertSkeleton(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    summary: 'old turn summary',
    createdAt: 8000,
  });
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'original body text from turn 1',
    createdAt: 1500,
  });
  // Push turn 1 out of L2 window
  for (let t = 2; t <= 25; t += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'user',
      text: `filler turn ${t}`,
      createdAt: 9000 + t,
    });
  }

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const l1Line = text.split('\n').find((l) => l.includes('old turn summary'));
  assert.ok(l1Line, 'L1 line should be present');

  // 行頭 [HH:MM:SS] が body 時刻を指している (skeleton 時刻ではない)
  const bodyTime = new Date(1500).toTimeString().slice(0, 8);
  const skeletonTime = new Date(8000).toTimeString().slice(0, 8);
  assert.ok(
    l1Line.startsWith(`[${bodyTime}] `),
    `L1 line should start with body time [${bodyTime}], got: ${l1Line}`,
  );
  assert.ok(
    !l1Line.startsWith(`[${skeletonTime}] `),
    'L1 line must not start with skeleton (summarization) time',
  );

  // (詳細：本文) suffix が付く (body が引けるという案内)
  assert.match(l1Line, /\(詳細：本文\)$/);
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

test('buildResumeContext: ignores inflightMemo (kept only for signature compatibility)', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'hi',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    inflightMemo: '**Next**: keep going (should NOT appear)',
  });

  assert.ok(text);
  assert.ok(!text.includes('**Next**: keep going'));
});
