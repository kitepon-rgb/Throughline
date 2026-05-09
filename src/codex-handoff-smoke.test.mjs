import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexHandoffSmoke } from './codex-handoff-smoke.mjs';

function makeRecord({ bodyText = 'latest body', detailRefs = [] } = {}) {
  return {
    kind: 'handoff_record',
    version: 1,
    session: {
      id: 'codex:thread-smoke',
      projectPath: '/repo',
      status: 'active',
      mergedInto: null,
    },
    source: {
      adapter: 'codex',
      inheritance: false,
      excludeOriginId: null,
      originSessionIds: ['codex:thread-smoke'],
    },
    intent: 'continue implementation',
    constraints: ['preserve user instructions'],
    memory: {
      inflightMemo: null,
      latestThinking: [],
      l1Summaries: [{ time: '12:00:01', role: 'assistant', summary: 'older summary' }],
      recentBodies: [{ time: '12:00:02', role: 'assistant', text: bodyText }],
    },
    references: {
      l3: detailRefs,
    },
    stats: {
      l1Rows: 1,
      l2Rows: 1,
      thinkingRows: 0,
      l3References: detailRefs.length,
      preservedContextRows: 2,
    },
  };
}

test('buildCodexHandoffSmoke: validates a fresh-thread handoff prompt', () => {
  const result = buildCodexHandoffSmoke(makeRecord(), { includePrompt: true });

  assert.equal(result.status, 'ready');
  assert.equal(result.reason, 'fresh_thread_handoff_prompt_ready');
  assert.equal(result.sessionId, 'codex:thread-smoke');
  assert.equal(result.sourceAgent, 'codex');
  assert.equal(result.l1Summaries, 1);
  assert.equal(result.recentBodies, 1);
  assert.ok(result.promptChars > 0);
  assert.ok(result.estimatedTokens > 0);
  assert.match(result.prompt, /Throughline: New Codex Thread Handoff/);
  assert.match(result.prompt, /Do not mutate the original Codex thread/);
  assert.equal(result.checks.every((check) => check.status === 'pass'), true);
});

test('buildCodexHandoffSmoke: fails when prompt exceeds max size', () => {
  const result = buildCodexHandoffSmoke(makeRecord({ bodyText: 'x'.repeat(200) }), {
    maxPromptChars: 100,
  });

  assert.equal(result.status, 'not-ready');
  assert.equal(
    result.checks.find((check) => check.id === 'prompt_size_within_limit')?.status,
    'fail',
  );
});

test('buildCodexHandoffSmoke: aggregates same-turn L3 into a single inline (詳細：…) suffix', () => {
  // 旧版は L3 を独立 `### Detail References` セクションで列挙し、同一 detail command
  // を dedup していた。新版は groupL3ByTurn が turn 単位に集約して L2 ターンの
  // 最終 role 行に inline suffix を 1 つ貼る。結果として「同 turn の tool_input +
  // tool_output」は (詳細：exec_command) 1 件になる。
  const detailRefs = [
    {
      kind: 'tool_input',
      toolName: 'exec_command',
      sourceId: 'tool-1',
      originSessionId: 'codex:thread-smoke',
      turnNumber: 1,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
    {
      kind: 'tool_output',
      toolName: 'exec_command',
      sourceId: 'tool-2',
      originSessionId: 'codex:thread-smoke',
      turnNumber: 1,
      createdAt: 1000,
      detailCommand: 'throughline detail 12:00:01',
    },
  ];

  const record = makeRecord({ detailRefs });
  // L3 と turn key が一致する L2 行に上書き (smoke の makeRecord 既定では
  // recentBodies が originSessionId/turnNumber を持たない)
  record.memory.recentBodies = [
    {
      time: '12:00:02',
      role: 'assistant',
      text: 'body of turn 1',
      originSessionId: 'codex:thread-smoke',
      turnNumber: 1,
    },
  ];

  const result = buildCodexHandoffSmoke(record, { includePrompt: true });

  assert.equal(result.status, 'ready');
  assert.equal(result.l3References, 2);
  // 2 件の L3 (tool_input + tool_output) は同一 turn なので 1 件の suffix にまとまる
  assert.equal(result.renderedDetailSuffixes, 1);
  assert.match(result.prompt, /\(詳細：exec_command\)/);
  // 旧 detail_commands_deduplicated check は廃止 (構造的に重複しない)
  assert.equal(
    result.checks.find((check) => check.id === 'detail_commands_deduplicated'),
    undefined,
  );
});
