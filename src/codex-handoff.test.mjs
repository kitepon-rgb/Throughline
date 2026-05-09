import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCodexActiveWorkContext,
  renderCodexNewThreadHandoff,
  toCodexDeveloperMessageItem,
  toThroughlineHandoffBlock,
} from './codex-handoff.mjs';

function makeRecord() {
  return {
    kind: 'handoff_record',
    version: 1,
    session: {
      id: 'sess-1',
      projectPath: '/repo',
      status: 'active',
      mergedInto: null,
    },
    source: {
      adapter: 'claude',
      inheritance: true,
      excludeOriginId: null,
      originSessionIds: ['old'],
    },
    intent: 'continue implementation',
    constraints: ['preserve Claude contract'],
    memory: {
      inflightMemo: 'Next: implement projection',
      latestThinking: [{ time: '12:00:03', text: 'latest hidden reasoning note' }],
      l1Summaries: [
        {
          time: '12:00:01',
          role: 'assistant',
          summary: 'old summary',
          originSessionId: 'old',
          turnNumber: 1,
          // bodyTime は handoff-record が bodies テーブル MIN(created_at) から付ける。
          // test では原ターン時刻として固定値を入れる。
          bodyTime: '11:59:50',
          bodyTimeMs: null,
        },
      ],
      recentBodies: [
        {
          time: '12:00:02',
          role: 'assistant',
          text: 'recent body',
          originSessionId: 'old',
          turnNumber: 2,
        },
      ],
    },
    references: {
      l3: [
        {
          kind: 'tool_input',
          toolName: 'Bash',
          sourceId: 'toolu_1',
          originSessionId: 'old',
          turnNumber: 2,
          createdAt: 1000,
          detailCommand: 'throughline detail 12:00:01',
        },
      ],
    },
    stats: {
      l1Rows: 1,
      l2Rows: 1,
      thinkingRows: 0,
      l3References: 1,
      preservedContextRows: 2,
    },
  };
}

test('toThroughlineHandoffBlock: creates stable Codex-facing JSON block', () => {
  const block = toThroughlineHandoffBlock(makeRecord());

  assert.equal(block.kind, 'throughline_handoff');
  assert.equal(block.source, 'throughline');
  assert.equal(block.trust, 'local');
  assert.equal(block.schemaVersion, undefined);
  assert.equal(block.data.throughlineHandoffSchemaVersion, 1);
  assert.equal(block.summary, 'In-flight handoff: Next: implement projection');
  assert.equal(block.references, undefined);
  assert.deepEqual(block.data.detailReferences, [
    {
      type: 'throughline_detail',
      label: 'tool_input:Bash',
      command: 'throughline detail 12:00:01',
      sourceId: 'toolu_1',
      detailKind: 'tool_input',
      originSessionId: 'old',
      turnNumber: 2,
    },
  ]);
  assert.equal(block.data.sessionId, 'sess-1');
  assert.equal(block.data.projectPath, '/repo');
  assert.equal(block.data.sourceAgent, 'claude');
  assert.equal(block.data.hostMode, 'claude-primary');
  assert.equal(block.data.intent, 'continue implementation');
  assert.deepEqual(block.data.constraints, ['preserve Claude contract']);
  assert.equal(block.data.memory.inflightMemo, 'Next: implement projection');
});

test('toThroughlineHandoffBlock: supports explicit codex-primary mode', () => {
  const block = toThroughlineHandoffBlock(makeRecord(), { hostMode: 'codex-primary' });
  assert.equal(block.data.hostMode, 'codex-primary');
});

test('toThroughlineHandoffBlock: rejects missing record', () => {
  assert.throws(() => toThroughlineHandoffBlock(null), /record is required/);
});

test('renderCodexActiveWorkContext: renders persisted memory with inline (詳細：…) suffix', () => {
  const text = renderCodexActiveWorkContext(makeRecord());

  assert.match(text, /## Throughline: Active Work Context/);
  assert.match(text, /### Reading Contract/);
  assert.match(text, /current-task context for continuation/);
  // 詳細取得方法 (throughline detail HH:MM:SS) はヘッダーで announce 済み
  assert.match(text, /throughline detail HH:MM:SS/);
  assert.match(text, /Throughline session: sess-1/);
  assert.match(text, /Source agent: claude/);
  assert.match(text, /### In-flight Memo\nNext: implement projection/);
  assert.match(text, /### Latest Thinking/);
  assert.match(text, /latest hidden reasoning note/);
  assert.match(text, /### L1 Summaries/);
  // L1 行頭は body 時刻 (bodyTime)、suffix は `本文` を含む (元 body が引ける案内)
  assert.match(text, /\[11:59:50\] \[assistant\] old summary \(詳細：本文\)/);
  assert.match(text, /### Active Work Thread \(L2\)/);
  // L2 末尾には L3 集約 suffix (turn 2 の Bash 入力 1 件 → "Bash")
  assert.match(text, /\[12:00:02\] \[assistant\] recent body \(詳細：Bash\)/);
  // 旧 `### Detail References` セクションは廃止
  assert.ok(!text.includes('### Detail References'));
  assert.match(text, /### Continuation Instruction/);
  assert.match(text, /Continue from the latest actionable state/);
});

test('renderCodexNewThreadHandoff: renders concise fresh-thread handoff context with inline suffix', () => {
  const record = makeRecord();
  const text = renderCodexNewThreadHandoff(record);

  assert.match(text, /## Throughline: New Codex Thread Handoff/);
  assert.match(text, /fresh Codex thread without mutating the risky current thread/);
  assert.match(text, /Reading contract: This is current-task context/);
  assert.match(text, /### Work Boundary/);
  assert.match(text, /preserve Claude contract/);
  assert.match(text, /### In-flight Memo\nNext: implement projection/);
  assert.match(text, /### L1 Memory Summaries/);
  assert.match(text, /### Recent Active Thread \(L2\)/);
  // 詳細取得方法はヘッダーで announce
  assert.match(text, /throughline detail HH:MM:SS/);
  // L2 行に inline suffix
  assert.match(text, /\[12:00:02\] \[assistant\] recent body \(詳細：Bash\)/);
  // 旧 `### Detail References` セクションは廃止
  assert.ok(!text.includes('### Detail References'));
  assert.match(text, /Do not mutate the original Codex thread/);
});

test('renderCodexNewThreadHandoff: maxDetailRefs option is accepted but no longer renders a Detail References section', () => {
  // 旧 ### Detail References セクションは廃止された。CLI flag 互換のため
  // maxDetailRefs はバリデーションだけ通り、描画には影響しない (per-line suffix で
  // turn 単位に集約済みのため)。
  const record = makeRecord();
  record.references.l3 = [
    {
      kind: 'tool_input',
      toolName: 'Bash',
      sourceId: 'toolu_1',
      originSessionId: 'old',
      turnNumber: 2,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:02',
    },
  ];

  const text = renderCodexNewThreadHandoff(record, { maxDetailRefs: 1 });

  assert.ok(!text.includes('### Detail References'));
  assert.ok(!text.includes('detail commands; '));
  // ヘッダーの placeholder のみで、行末に固有時刻の throughline detail は出ない
  assert.ok(!text.includes('throughline detail 12:00:02'));
  // 代わりに inline suffix で turn 集約された情報が出る
  assert.match(text, /\(詳細：Bash\)/);
});

test('renderCodexNewThreadHandoff: caps recent L2 entries and long bodies', () => {
  const record = makeRecord();
  record.memory.recentBodies = [
    { time: '12:00:01', role: 'assistant', text: 'older body' },
    { time: '12:00:02', role: 'assistant', text: 'latest body with a long tail' },
  ];

  const text = renderCodexNewThreadHandoff(record, {
    maxRecentBodies: 1,
    maxBodyChars: 11,
  });

  assert.match(text, /full context: throughline codex-resume --session sess-1/);
  assert.match(text, /Showing latest 1 of 2 active L2 entries; 1 older omitted/);
  assert.doesNotMatch(text, /older body/);
  assert.match(text, /latest body/);
  assert.match(text, /\[entry truncated to 11 chars\]/);
  assert.doesNotMatch(text, /long tail/);
});

test('renderCodexNewThreadHandoff: aggregates same-turn L3 into a single (詳細：…) suffix on the assistant line', () => {
  // 旧版は同一 detail command の dedup (uniqueDetailRefsByCommand) を独立 Detail
  // References セクションで行っていた。新版は groupL3ByTurn が turn 単位に集約し、
  // L2 ターンの最終 role 行 (assistant) にだけ inline suffix を付ける。
  const record = makeRecord();
  record.memory.recentBodies = [
    { time: '12:00:02', role: 'user', text: 'user body', originSessionId: 'old', turnNumber: 2 },
    { time: '12:00:02', role: 'assistant', text: 'assistant body', originSessionId: 'old', turnNumber: 2 },
  ];
  record.references.l3 = [
    {
      kind: 'tool_input',
      toolName: 'Bash',
      sourceId: 'toolu_1',
      originSessionId: 'old',
      turnNumber: 2,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
    {
      kind: 'tool_output',
      toolName: 'Bash',
      sourceId: 'toolu_2',
      originSessionId: 'old',
      turnNumber: 2,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
  ];

  const text = renderCodexNewThreadHandoff(record);

  // user 行には suffix が出ない (重複排除)
  const userLine = text.split('\n').find((l) => l.includes('user body'));
  assert.ok(userLine);
  assert.ok(!userLine.includes('詳細：'));

  // assistant 行 (turn 内最終 role) に suffix が 1 つだけ
  const assistantLine = text.split('\n').find((l) => l.includes('assistant body'));
  assert.ok(assistantLine);
  // tool_input + tool_output の 1:1 ペアは tool 名 (Bash) で 1 つに集約される
  assert.match(assistantLine, /\(詳細：Bash\)$/);
});

test('toCodexDeveloperMessageItem: wraps active work context as a developer message item', () => {
  const item = toCodexDeveloperMessageItem(makeRecord());

  assert.equal(item.type, 'message');
  assert.equal(item.role, 'developer');
  assert.equal(item.content[0].type, 'input_text');
  assert.match(item.content[0].text, /Throughline: Active Work Context/);
  assert.match(item.content[0].text, /recent body/);
});
