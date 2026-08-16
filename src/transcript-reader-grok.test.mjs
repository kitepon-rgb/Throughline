import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogicalTurnGroups, readTranscript } from './transcript-reader.mjs';

test('readTranscript accepts Grok chat_history.jsonl user/assistant rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-transcript-'));
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'system', content: 'ignore' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello grok' }] }),
      JSON.stringify({ type: 'assistant', content: 'captured reply' }),
      JSON.stringify({ type: 'tool_result', content: 'not a turn' }),
    ].join('\n'),
  );
  try {
    const turns = readTranscript(path);
    assert.deepEqual(
      turns.map((t) => ({ role: t.role, content: t.content })),
      [
        { role: 'user', content: 'hello grok' },
        { role: 'assistant', content: 'captured reply' },
      ],
    );
    const groups = getLogicalTurnGroups(path);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].user.content, 'hello grok');
    assert.equal(groups[0].representative.content, 'captured reply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
