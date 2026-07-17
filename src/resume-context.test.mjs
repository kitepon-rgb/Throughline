import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildResumeContext,
  buildBudgetedResumeContext,
  INJECTION_BUDGET_CHARS,
} from './resume-context.mjs';

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
  // A 経路: 「直前スレッドの継続応答用コンテキスト」 framing (元の「中断した作業の再開」よりも
  // 強い directive。モデルが /clear 後の短い prompt を新規依頼として扱うのを抑止する目的)
  assert.match(text, /^## Throughline: 直前スレッドの継続応答用コンテキスト/);

  // 旧版の冗長な行は全部削除
  assert.ok(!text.includes('と報告してください'), 'meta-report instruction must be gone');
  assert.ok(!text.includes('一番下の'), 'redundant ordering hint must be gone');
  assert.ok(!text.includes('内訳の読み方'), 'glossary block must be gone');
  assert.ok(!text.includes('現在進行中の作業の active work context'), 'verbose framing must be gone');

  // A 経路の必須シグナル: 「あなた自身が直前にユーザーと交わした会話」 + 「新規依頼ではなく続き」
  // + 短い指示の扱い + 「新規会話ではない」明示
  assert.match(text, /あなた自身が直前にユーザーと交わした会話/);
  assert.match(text, /新規依頼ではなく、上記スレッドの \*\*続き\*\*/);
  assert.match(text, /続きよろしく.*OK.*次は？/s);
  assert.match(text, /新規会話ではない/);
  // β 経路 (early-style explicit report-back instruction): モデルが冒頭で
  // 「引き継いだ状態で続けます」と明示的に表明することで、user が体感する継続感を強める
  assert.match(text, /応答の冒頭で必ず以下を 1 行宣言/);
  assert.match(text, /Throughline で前のセッションから .* ターン分の記憶を引き継いだ状態で続けます/);
  assert.match(
    text,
    /\*\*各ターンの詳細\*\*: \*\*`Bash` ツールで `throughline detail HH:MM:SS` を実行\*\* \(該当ターンの本文＋詳細を stdout に返します\)/,
  );

  // v2.1: 古い番号リスト (1/2/3) を最新ユーザーが「2 をやれ」のように参照しても、
  // 直前アシスタントで既に実行済みなら再実行ではなく結果確認に回るというガード。
  // (このセッションで実際にハマった misread の再発防止)
  assert.match(text, /古い番号リストの再実行禁止/);
  assert.match(text, /既に直前アシスタントターンで実装\/実行済み/);
  assert.match(text, /最新アシスタント発話の指示が、過去ターンのリストへの参照より上位/);
});

test('buildResumeContext: 現在地 anchor surfaces the latest user/assistant exchange above L1/L2', () => {
  const db = makeDb();
  // 25 turns to exercise an L2 window edge and ensure the anchor picks the newest.
  for (let t = 1; t <= 25; t += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'user',
      text: `user turn ${t}`,
      createdAt: 1000 + t * 10,
    });
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn: t,
      role: 'assistant',
      text: `assistant turn ${t}`,
      createdAt: 1000 + t * 10 + 1,
    });
  }

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const anchorIdx = text.indexOf('### 現在地 (直前のやりとり)');
  const l2Idx = text.indexOf('### 直前の対話 (L2 / active work thread, 古い順)');
  assert.ok(anchorIdx > 0, '現在地 anchor section should be present');
  assert.ok(l2Idx > anchorIdx, '現在地 anchor must appear before the L2 section');

  // The anchor must point to turn 25 (the latest), not any earlier turn.
  assert.match(text, /\*\*最新ユーザー指示\*\* \[\d\d:\d\d:\d\d\]: user turn 25$/m);
  assert.match(text, /\*\*直前のアシスタント\*\* \[\d\d:\d\d:\d\d\]: assistant turn 25$/m);
});

test('buildResumeContext: 現在地 anchor truncates long bodies but full body still appears in L2', () => {
  const db = makeDb();
  const longText = 'a'.repeat(1200);
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: longText,
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);

  const anchorLine = text
    .split('\n')
    .find((l) => l.startsWith('**直前のアシスタント**'));
  assert.ok(anchorLine, '直前のアシスタント anchor line should be present');
  // Anchor must be truncated with ellipsis (originally 1200 chars > 600 cap).
  assert.ok(anchorLine.endsWith(' …'), 'long anchor body must end with the ellipsis marker');
  assert.ok(
    anchorLine.length < longText.length,
    'anchor line should be shorter than the original body',
  );

  // Full body must still appear in the L2 section below.
  assert.match(text, new RegExp(`\\[assistant\\]: ${longText}`));
});

test('buildResumeContext: 現在地 anchor is omitted for non-inheritance sessions', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'a body',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: false,
  });

  assert.ok(text);
  assert.ok(
    !text.includes('現在地'),
    'normal sessions (isInheritance=false) must not include the 現在地 anchor',
  );
  assert.ok(
    !text.includes('最新ユーザー指示'),
    'normal sessions must not surface a latest-user pointer',
  );
});

test('buildResumeContext: 現在地 anchor handles a single-role recent window', () => {
  const db = makeDb();
  // Only user rows (no assistant) — anchor should still render with just the user line.
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'user',
    text: 'lone user message',
    createdAt: 1000,
  });

  const text = buildResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
  });

  assert.ok(text);
  assert.ok(text.includes('### 現在地 (直前のやりとり)'));
  assert.match(text, /\*\*最新ユーザー指示\*\* \[\d\d:\d\d:\d\d\]: lone user message/);
  assert.ok(
    !text.includes('**直前のアシスタント**'),
    'no assistant body present → no 直前のアシスタント line',
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

  // Look for the L2 body line specifically (not the 現在地 anchor line which also
  // contains the latest assistant body).
  const turnWithToolsLine = text
    .split('\n')
    .find((l) => /^\[\d\d:\d\d:\d\d\] \[assistant\]: turn with tools/.test(l));
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

  const plainLine = text
    .split('\n')
    .find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: plain user message/.test(l));
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

  // Match L2 body lines specifically (`[HH:MM:SS] [role]: ...`) to avoid colliding
  // with the 現在地 anchor lines (`**最新ユーザー指示** [HH:MM:SS]: ...`).
  const lines = text.split('\n');
  const userTurn5 = lines.find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: user side of turn 5/.test(l));
  const assistantTurn5 = lines.find(
    (l) => /^\[\d\d:\d\d:\d\d\] \[assistant\]: assistant side of turn 5/.test(l),
  );
  const userTurn6 = lines.find((l) => /^\[\d\d:\d\d:\d\d\] \[user\]: lone user turn/.test(l));

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

// ---- buildBudgetedResumeContext (ADR 0014: hook stdout の 10k file 化対策) ----

test('INJECTION_BUDGET_CHARS stays under the measured 10k persisted-output limit', () => {
  assert.ok(INJECTION_BUDGET_CHARS <= 9_501, '実測 inline 通過上限 9,501 字以下であること');
});

test('budgeted: under budget output matches the unbudgeted renderer, nothing dropped', () => {
  const db = makeDb();
  insertBody(db, { session: 'new', origin: 'old', turn: 1, role: 'user', text: 'short question', createdAt: 1000 });
  insertBody(db, { session: 'new', origin: 'old', turn: 1, role: 'assistant', text: 'short answer', createdAt: 1100 });

  const full = buildResumeContext(db, { sessionId: 'new', isInheritance: true });
  const budgeted = buildBudgetedResumeContext(db, { sessionId: 'new', isInheritance: true });

  assert.ok(budgeted);
  assert.equal(budgeted.text, full);
  assert.equal(budgeted.droppedL1Rows, 0);
  assert.equal(budgeted.droppedL2Rows, 0);
  assert.equal(budgeted.truncatedNewestL2, false);
  assert.ok(budgeted.totalChars <= INJECTION_BUDGET_CHARS);
});

test('budgeted: drops oldest L2 rows first, keeps newest, and stays within maxChars', () => {
  const db = makeDb();
  // 各 ~800 字 × 10 行 = 本文だけで ~8,000 字 → maxChars 4000 で古い行が落ちる
  for (let turn = 1; turn <= 10; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${String(turn).padStart(2, '0')} ` + 'x'.repeat(800),
      createdAt: 1000 + turn * 100,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 4000, `totalChars ${budgeted.totalChars} must fit budget`);
  assert.ok(budgeted.droppedL2Rows > 0, 'some old L2 rows must be dropped');
  assert.ok(budgeted.text.includes('turn-10'), 'newest L2 row must survive');
  assert.ok(!budgeted.text.includes('turn-01 '), 'oldest L2 row must be dropped');
  assert.match(budgeted.text, /古い L2 を \d+ 行省略/, 'omission must be announced, not silent');
  // 「削るときは取り出すための参照を必ず残す」: 落とした行の [時刻 role] リストが
  // 告知に載っていること (窓内の行にはまだ L1 が無く、時刻が無いと detail で引けない)
  assert.match(
    budgeted.text,
    /省略分 \(新しい順\): (\[\d{2}:\d{2}:\d{2} assistant\][ ]?)+/,
    'dropped rows must be listed with [time role] refs for throughline detail',
  );
});

test('budgeted: very many dropped rows fold into ほかN行 keeping the note bounded', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 40; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: `turn-${String(turn).padStart(2, '0')} ` + 'x'.repeat(700),
      createdAt: 1000 + turn * 1000,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 4000);
  assert.match(budgeted.text, /ほか\d+行/, 'overflow refs must fold into a count');
});

test('budgeted: a single oversized newest L2 row is truncated with a detail pointer', () => {
  const db = makeDb();
  insertBody(db, {
    session: 'new',
    origin: 'old',
    turn: 1,
    role: 'assistant',
    text: 'HEAD-MARKER ' + 'y'.repeat(20_000),
    createdAt: 1000,
  });

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.ok(budgeted.totalChars <= 4000);
  assert.equal(budgeted.truncatedNewestL2, true);
  assert.ok(budgeted.text.includes('HEAD-MARKER'), 'the head of the newest row must survive');
  assert.match(budgeted.text, /全文: throughline detail /, 'truncation must point to detail command');
});

test('budgeted: header and anchor always survive even under pressure', () => {
  const db = makeDb();
  for (let turn = 1; turn <= 5; turn += 1) {
    insertBody(db, {
      session: 'new',
      origin: 'old',
      turn,
      role: 'assistant',
      text: 'z'.repeat(3000),
      createdAt: 1000 + turn,
    });
  }

  const budgeted = buildBudgetedResumeContext(db, {
    sessionId: 'new',
    isInheritance: true,
    maxChars: 4000,
  });

  assert.ok(budgeted);
  assert.match(budgeted.text, /^## Throughline: 直前スレッドの継続応答用コンテキスト/);
  assert.ok(budgeted.text.includes('### 現在地 (直前のやりとり)'));
});
