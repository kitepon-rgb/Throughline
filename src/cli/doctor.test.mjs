import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _internal } from './doctor.mjs';

const { parseArgs, formatAgo, formatBytes, findLatestJsonlInSameDir, isPidAlive } = _internal;

// ─── parseArgs ──────────────────────────────────────────────────────

test('parseArgs: 引数なしは session null', () => {
  assert.deepEqual(parseArgs([]), { session: null });
});

test('parseArgs: --session <prefix>', () => {
  assert.deepEqual(parseArgs(['--session', 'abc']), { session: 'abc' });
});

test('parseArgs: --session の値欠落は throw', () => {
  assert.throws(() => parseArgs(['--session']), /session id prefix/);
});

test('parseArgs: --session の次が別フラグなら throw', () => {
  assert.throws(() => parseArgs(['--session', '--other']), /session id prefix/);
});

// ─── formatAgo ──────────────────────────────────────────────────────

test('formatAgo: 60 秒未満は秒表示', () => {
  assert.equal(formatAgo(30_000), '30s ago');
});

test('formatAgo: 60 分未満は分表示', () => {
  assert.equal(formatAgo(5 * 60_000), '5m ago');
});

test('formatAgo: 24 時間未満は時表示', () => {
  assert.equal(formatAgo(3 * 60 * 60_000), '3h ago');
});

test('formatAgo: 24 時間以上は日表示', () => {
  assert.equal(formatAgo(2 * 24 * 60 * 60_000), '2d ago');
});

test('formatAgo: 無効値', () => {
  assert.equal(formatAgo(NaN), '?');
  assert.equal(formatAgo(-1), '?');
});

// ─── formatBytes ────────────────────────────────────────────────────

test('formatBytes: KB/MB/GB の切り替え', () => {
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1_500), '1.5 kB');
  assert.equal(formatBytes(1_500_000), '1.50 MB');
  assert.equal(formatBytes(2_000_000_000), '2.00 GB');
});

test('formatBytes: 無効値', () => {
  assert.equal(formatBytes(NaN), '?');
  assert.equal(formatBytes(-1), '?');
});

// ─── findLatestJsonlInSameDir ──────────────────────────────────────

test('findLatestJsonlInSameDir: 同じディレクトリ内の最新 JSONL を返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-doctor-'));
  try {
    const older = join(dir, 'a.jsonl');
    const newer = join(dir, 'b.jsonl');
    writeFileSync(older, 'x');
    // mtime を強制的に差をつけるため書き込み間隔を開けたいが、連続 write だと同 ms 。
    // ここでは newer の内容を後に書いて、後書きが newer の mtime を十分大きくする。
    const now = Date.now();
    writeFileSync(newer, 'y');
    // older の mtime を古く設定
    utimesSync(older, new Date(now - 10000), new Date(now - 10000));
    utimesSync(newer, new Date(now), new Date(now));
    const result = findLatestJsonlInSameDir(older);
    assert.ok(result);
    assert.equal(result.path, newer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findLatestJsonlInSameDir: 存在しないパスは null', () => {
  assert.equal(findLatestJsonlInSameDir('/does/not/exist/x.jsonl'), null);
});

// ─── isPidAlive ─────────────────────────────────────────────────────

test('isPidAlive: 自身の PID は alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: 不正な値は false', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(undefined), false);
});

test('isPidAlive: 存在しない PID は false', () => {
  // 巨大な PID はほぼ確実に未使用
  assert.equal(isPidAlive(2_147_483_646), false);
});
