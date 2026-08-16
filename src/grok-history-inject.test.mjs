import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GROK_HANDOFF_SYNTHETIC_REASON,
  injectGrokHandoffContext,
} from './grok-history-inject.mjs';

test('injectGrokHandoffContext inserts reminder before the latest user_query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-inject-'));
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'system', content: 'sys' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>x</user_info>' }] }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nこれかな？\n</user_query>' }] }),
    ].join('\n') + '\n',
  );
  try {
    const result = injectGrokHandoffContext(path, 'old assistant body');
    assert.equal(result.injected, true);
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 4);
    assert.equal(rows[2].synthetic_reason, GROK_HANDOFF_SYNTHETIC_REASON);
    assert.match(rows[2].content[0].text, /old assistant body/);
    assert.match(rows[3].content[0].text, /これかな？/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectGrokHandoffContext appends when no user_query exists yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-inject-'));
  const path = join(dir, 'chat_history.jsonl');
  writeFileSync(path, `${JSON.stringify({ type: 'system', content: 'sys' })}\n`);
  try {
    const result = injectGrokHandoffContext(path, 'memory');
    assert.equal(result.injected, true);
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).synthetic_reason, GROK_HANDOFF_SYNTHETIC_REASON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectGrokHandoffContext is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-grok-inject-'));
  const path = join(dir, 'chat_history.jsonl');
  try {
    assert.equal(injectGrokHandoffContext(path, 'memory').injected, true);
    assert.deepEqual(injectGrokHandoffContext(path, 'memory'), {
      injected: false,
      reason: 'already_present',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
