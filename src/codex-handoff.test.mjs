import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toThroughlineHandoffBlock } from './codex-handoff.mjs';

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
      latestThinking: [],
      l1Summaries: [{ summary: 'old summary' }],
      recentBodies: [{ role: 'assistant', text: 'recent body' }],
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
