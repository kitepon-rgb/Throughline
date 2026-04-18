import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readLatestUsage, clearUsageCache, inferContextWindowSize } from './transcript-usage.mjs';

function writeTranscript(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function assistantEntry({ model, inputTokens, cacheCreate = 0, cacheRead = 0, outputTokens = 0 }) {
  return {
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: outputTokens,
      },
    },
  };
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-usage-'));
  const path = join(dir, 'transcript.jsonl');
  clearUsageCache();
  try {
    fn({ dir, path });
  } finally {
    clearUsageCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── inferContextWindowSize ────────────────────────────────────────

test('inferContextWindowSize: [1m] サフィックスは 1M', () => {
  assert.equal(inferContextWindowSize('claude-opus-4-6[1m]', 0, false), 1_000_000);
  assert.equal(inferContextWindowSize('claude-sonnet-4-7[1M]', 0, false), 1_000_000);
});

test('inferContextWindowSize: rawHint=true なら 1M', () => {
  assert.equal(inferContextWindowSize('claude-opus-4-6', 0, true), 1_000_000);
});

test('inferContextWindowSize: 200k 超観測でも 1M', () => {
  assert.equal(inferContextWindowSize('claude-opus-4-6', 250_000, false), 1_000_000);
});

test('inferContextWindowSize: デフォルトは 200k', () => {
  assert.equal(inferContextWindowSize('claude-opus-4-6', 100_000, false), 200_000);
  assert.equal(inferContextWindowSize('', 0, false), 200_000);
});

// ─── readLatestUsage ──────────────────────────────────────────────

test('readLatestUsage: 存在しないファイルは null', () => {
  assert.equal(readLatestUsage('/nonexistent/path'), null);
  assert.equal(readLatestUsage(''), null);
  assert.equal(readLatestUsage(null), null);
});

test('readLatestUsage: 最新の assistant エントリを返す', () => {
  withFixture(({ path }) => {
    writeTranscript(path, [
      assistantEntry({ model: 'claude-opus-4-6', inputTokens: 1000 }),
      { type: 'user', message: { content: 'hi' } },
      assistantEntry({ model: 'claude-opus-4-6', inputTokens: 5000, cacheRead: 1000, outputTokens: 100 }),
    ]);
    const result = readLatestUsage(path);
    assert.ok(result);
    assert.equal(result.tokens, 6000);
    assert.equal(result.model, 'claude-opus-4-6');
    assert.equal(result.outputTokens, 100);
    assert.equal(result.contextWindowSize, 200_000);
  });
});

test('readLatestUsage: usage なしエントリは skip', () => {
  withFixture(({ path }) => {
    writeTranscript(path, [
      { type: 'assistant', message: { model: 'x', content: [] } },
      assistantEntry({ model: 'claude-opus-4-6', inputTokens: 500 }),
    ]);
    const result = readLatestUsage(path);
    assert.equal(result.tokens, 500);
  });
});

test('readLatestUsage: キャッシュが mtime 変化で無効化される', () => {
  withFixture(({ path }) => {
    writeTranscript(path, [assistantEntry({ model: 'x', inputTokens: 100 })]);
    const first = readLatestUsage(path);
    assert.equal(first.tokens, 100);

    // 同じサイズで中身を差し替え、mtime も進める
    writeTranscript(path, [assistantEntry({ model: 'x', inputTokens: 999 })]);
    // 強制的に mtime を 2 秒後にする（OS によっては書き込み直後でも mtime が同じことがある）
    const future = new Date(Date.now() + 2000);
    utimesSync(path, future, future);

    const second = readLatestUsage(path);
    assert.equal(second.tokens, 999, 'cache should be invalidated by mtime change');
  });
});

// ─── sticky 1M ──────────────────────────────────────────────────

test('readLatestUsage: 一度 1M を観測したら以後は下がらない', () => {
  withFixture(({ path }) => {
    // 初回: 250k 観測 → 1M 判定
    writeTranscript(path, [assistantEntry({ model: 'claude-opus-4-6', inputTokens: 250_000 })]);
    const first = readLatestUsage(path);
    assert.equal(first.contextWindowSize, 1_000_000);

    // 次: 100k に下がっても window は 1M のまま維持（sticky）
    writeTranscript(path, [assistantEntry({ model: 'claude-opus-4-6', inputTokens: 100_000 })]);
    const future = new Date(Date.now() + 2000);
    utimesSync(path, future, future);

    const second = readLatestUsage(path);
    assert.equal(second.tokens, 100_000);
    assert.equal(second.contextWindowSize, 1_000_000, 'sticky 1M must remain after observation');
  });
});

test('readLatestUsage: clearUsageCache で sticky もリセット', () => {
  withFixture(({ path }) => {
    writeTranscript(path, [assistantEntry({ model: 'claude-opus-4-6', inputTokens: 250_000 })]);
    readLatestUsage(path);
    clearUsageCache();

    writeTranscript(path, [assistantEntry({ model: 'claude-opus-4-6', inputTokens: 100_000 })]);
    const future = new Date(Date.now() + 2000);
    utimesSync(path, future, future);

    const result = readLatestUsage(path);
    assert.equal(result.contextWindowSize, 200_000, 'sticky should reset after clearUsageCache');
  });
});

test('readLatestUsage: partial-write JSONL 行は skip', () => {
  withFixture(({ path }) => {
    // 最後の行が壊れている
    writeFileSync(
      path,
      JSON.stringify(assistantEntry({ model: 'x', inputTokens: 42 })) +
        '\n' +
        '{"type":"assistant","message":{"model":"x","us',
    );
    const result = readLatestUsage(path);
    assert.equal(result.tokens, 42);
  });
});
