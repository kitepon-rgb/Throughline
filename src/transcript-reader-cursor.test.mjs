import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogicalTurnGroups, readTranscript, sliceCurrentTurnEntries, readRawEntries } from './transcript-reader.mjs';

test('readTranscript accepts Cursor agent-transcripts role-first jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-cursor-transcript-'));
  const path = join(dir, '7face712.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'hello cursor' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'captured reply' }] },
      }),
    ].join('\n'),
  );
  try {
    const turns = readTranscript(path);
    assert.deepEqual(
      turns.map((t) => ({ role: t.role, content: t.content })),
      [
        { role: 'user', content: 'hello cursor' },
        { role: 'assistant', content: 'captured reply' },
      ],
    );
    const groups = getLogicalTurnGroups(path);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].user.content, 'hello cursor');
    assert.equal(groups[0].representative.content, 'captured reply');
    const sliced = sliceCurrentTurnEntries(readRawEntries(path));
    assert.equal(sliced.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
