import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripAnsi,
  normalizeToolResultContent,
  sliceCurrentTurnEntries,
  extractDetailBlocks,
} from './transcript-reader.mjs';
import { DETAIL_KIND } from './constants.mjs';

test('stripAnsi: ANSI 色コードを除去する', () => {
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m text'), 'green text');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(''), '');
});

test('normalizeToolResultContent: string / array / image mix', () => {
  assert.equal(normalizeToolResultContent('raw string'), 'raw string');
  assert.equal(
    normalizeToolResultContent([
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ]),
    'hello world',
  );
  assert.equal(
    normalizeToolResultContent([
      { type: 'text', text: 'before' },
      { type: 'image', source: {} },
      { type: 'text', text: 'after' },
    ]),
    'before[image]after',
  );
  assert.equal(normalizeToolResultContent(null), '');
});

/** 単一 text ブロック user / assistant エントリを作る */
function userEntry(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function asstTextEntry(text) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}
function asstToolUseEntry(id, name, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function userToolResultEntry(toolUseId, content) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  };
}
function attachmentEntry(uuid, hookEvent, command, content) {
  return {
    type: 'attachment',
    uuid,
    attachment: { type: 'hook_success', hookEvent, command, content },
  };
}

test('sliceCurrentTurnEntries: 最後の user text → 最後の assistant text を切り出す', () => {
  const entries = [
    userEntry('old prompt'),
    asstTextEntry('old response'),
    userEntry('current prompt'),
    asstToolUseEntry('toolu_1', 'Bash', { command: 'ls' }),
    userToolResultEntry('toolu_1', 'file1\nfile2'),
    asstTextEntry('current response'),
  ];
  const slice = sliceCurrentTurnEntries(entries);
  assert.equal(slice.length, 4);
  assert.equal(slice[0].message.content[0].text, 'current prompt');
  assert.equal(slice[3].message.content[0].text, 'current response');
});

test('sliceCurrentTurnEntries: 空配列なら空を返す', () => {
  assert.deepEqual(sliceCurrentTurnEntries([]), []);
});

test('sliceCurrentTurnEntries: assistant text が無ければ空', () => {
  const entries = [userEntry('hello'), asstToolUseEntry('t1', 'Read', { path: '/x' })];
  assert.deepEqual(sliceCurrentTurnEntries(entries), []);
});

test('extractDetailBlocks: tool_use と tool_result をペアで抽出', () => {
  const entries = [
    userEntry('do it'),
    asstToolUseEntry('toolu_42', 'Bash', { command: 'echo hi' }),
    userToolResultEntry('toolu_42', 'hi\n'),
    asstTextEntry('done'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 2);

  const [input, output] = details;
  assert.equal(input.kind, DETAIL_KIND.TOOL_INPUT);
  assert.equal(input.tool_name, 'Bash');
  assert.equal(input.source_id, 'toolu_42');
  assert.ok(input.input_text.includes('echo hi'));
  assert.equal(input.output_text, null);

  assert.equal(output.kind, DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.tool_name, 'Bash'); // tool_use からマップされる
  assert.equal(output.source_id, 'toolu_42:result');
  assert.equal(output.output_text, 'hi\n');
});

test('extractDetailBlocks: thinking / text ブロックは L3 に入れない', () => {
  const entries = [
    userEntry('prompt'),
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal thoughts' },
          { type: 'text', text: 'response' },
        ],
      },
    },
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 0);
});

test('extractDetailBlocks: attachment (hook_success) を system として抽出', () => {
  const entries = [
    userEntry('prompt'),
    attachmentEntry('att-uuid-1', 'UserPromptSubmit', 'node hook.mjs', 'injected context'),
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 1);
  assert.equal(details[0].kind, DETAIL_KIND.SYSTEM);
  assert.equal(details[0].tool_name, 'hook:UserPromptSubmit');
  assert.equal(details[0].source_id, 'att-uuid-1');
  assert.equal(details[0].input_text, 'node hook.mjs');
  assert.equal(details[0].output_text, 'injected context');
});

test('extractDetailBlocks: tool_output の ANSI コードは剥離される', () => {
  const entries = [
    userEntry('run it'),
    asstToolUseEntry('t1', 'Bash', { command: 'ls' }),
    userToolResultEntry('t1', '\x1b[32mgreen\x1b[0m file'),
    asstTextEntry('ok'),
  ];
  const details = extractDetailBlocks(entries);
  const output = details.find((d) => d.kind === DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.output_text, 'green file');
});

test('extractDetailBlocks: system (stop_hook_summary) と queue-operation はスキップ', () => {
  const entries = [
    userEntry('prompt'),
    { type: 'system', subtype: 'stop_hook_summary', hookCount: 3 },
    { type: 'queue-operation', op: 'enqueue' },
    { type: 'file-history-snapshot', uuid: 'abc' },
    asstTextEntry('reply'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 0);
});

test('extractDetailBlocks: tool_result の content が配列でも処理できる', () => {
  const entries = [
    userEntry('fetch'),
    asstToolUseEntry('t1', 'Read', { file_path: '/x' }),
    userToolResultEntry('t1', [
      { type: 'text', text: 'line1\n' },
      { type: 'text', text: 'line2' },
    ]),
    asstTextEntry('done'),
  ];
  const details = extractDetailBlocks(entries);
  const output = details.find((d) => d.kind === DETAIL_KIND.TOOL_OUTPUT);
  assert.equal(output.output_text, 'line1\nline2');
});

test('extractDetailBlocks: 複数ツール連続呼び出しを全て拾う', () => {
  const entries = [
    userEntry('investigate'),
    asstToolUseEntry('t1', 'Read', { path: '/a' }),
    userToolResultEntry('t1', 'a contents'),
    asstToolUseEntry('t2', 'Grep', { pattern: 'foo' }),
    userToolResultEntry('t2', 'foo found'),
    asstTextEntry('summary'),
  ];
  const details = extractDetailBlocks(entries);
  assert.equal(details.length, 4);
  assert.deepEqual(
    details.map((d) => d.kind),
    [DETAIL_KIND.TOOL_INPUT, DETAIL_KIND.TOOL_OUTPUT, DETAIL_KIND.TOOL_INPUT, DETAIL_KIND.TOOL_OUTPUT],
  );
});
