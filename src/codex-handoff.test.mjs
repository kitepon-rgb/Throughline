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
      l1Summaries: [{ time: '12:00:01', role: 'assistant', summary: 'old summary' }],
      recentBodies: [{ time: '12:00:02', role: 'assistant', text: 'recent body' }],
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

test('renderCodexActiveWorkContext: renders persisted memory as active work context', () => {
  const text = renderCodexActiveWorkContext(makeRecord());

  assert.match(text, /## Throughline: Active Work Context/);
  assert.match(text, /### Reading Contract/);
  assert.match(text, /current-task context for continuation/);
  assert.match(text, /Throughline session: sess-1/);
  assert.match(text, /Source agent: claude/);
  assert.match(text, /### In-flight Memo\nNext: implement projection/);
  assert.match(text, /### Latest Thinking/);
  assert.match(text, /latest hidden reasoning note/);
  assert.match(text, /### L1 Summaries/);
  assert.match(text, /old summary/);
  assert.match(text, /### Active Work Thread \(L2\)/);
  assert.match(text, /\[12:00:02\] \[assistant\] recent body/);
  assert.match(text, /### Detail References/);
  assert.match(text, /throughline detail 12:00:01/);
  assert.match(text, /### Continuation Instruction/);
  assert.match(text, /Continue from the latest actionable state/);
});

test('renderCodexNewThreadHandoff: renders concise fresh-thread handoff context', () => {
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
  assert.match(text, /throughline detail 12:00:01/);
  assert.match(text, /Do not mutate the original Codex thread/);
});

test('renderCodexNewThreadHandoff: caps detail references for pasteable new-thread prompts', () => {
  const record = makeRecord();
  record.references.l3 = [
    {
      kind: 'tool_input',
      toolName: 'Bash',
      sourceId: 'toolu_1',
      originSessionId: 'old',
      turnNumber: 1,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
    {
      kind: 'tool_output',
      toolName: 'Bash',
      sourceId: 'toolu_2',
      originSessionId: 'old',
      turnNumber: 2,
      createdAt: 2000,
      detailCommand: 'throughline detail 12:00:02',
    },
  ];

  const text = renderCodexNewThreadHandoff(record, { maxDetailRefs: 1 });

  assert.match(text, /Showing latest 1 of 2 detail commands; 1 older omitted/);
  assert.doesNotMatch(text, /throughline detail 12:00:01/);
  assert.match(text, /throughline detail 12:00:02/);
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

test('renderCodexNewThreadHandoff: deduplicates repeated detail commands', () => {
  const record = makeRecord();
  record.references.l3 = [
    {
      kind: 'tool_input',
      toolName: 'Bash',
      sourceId: 'toolu_1',
      originSessionId: 'old',
      turnNumber: 1,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
    {
      kind: 'tool_output',
      toolName: 'Bash',
      sourceId: 'toolu_2',
      originSessionId: 'old',
      turnNumber: 1,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
  ];

  const text = renderCodexNewThreadHandoff(record);

  assert.equal(text.match(/throughline detail 12:00:01/g)?.length, 1);
  assert.doesNotMatch(text, /Showing latest 1 of 2/);
});

test('toCodexDeveloperMessageItem: wraps active work context as a developer message item', () => {
  const item = toCodexDeveloperMessageItem(makeRecord());

  assert.equal(item.type, 'message');
  assert.equal(item.role, 'developer');
  assert.equal(item.content[0].type, 'input_text');
  assert.match(item.content[0].text, /Throughline: Active Work Context/);
  assert.match(item.content[0].text, /recent body/);
});
