import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from './token-monitor.mjs';
import { normalizeProjectPath } from './state-file.mjs';

const { parseArgs, filterStates } = _internal;

// state-file は projectPath を resolve + lowercase 正規化する。
// filterStates は cwd 引数を内部で正規化するので、テストでも同じ関数を使って揃える。
const CWD_FOO = normalizeProjectPath('/tmp/foo');
const CWD_BAR = normalizeProjectPath('/tmp/bar');

// ─── parseArgs ─────────────────────────────────────────────────────

test('parseArgs: 引数なしは defaults', () => {
  assert.deepEqual(parseArgs([]), { all: false, session: null });
});

test('parseArgs: --all フラグ', () => {
  assert.deepEqual(parseArgs(['--all']), { all: true, session: null });
});

test('parseArgs: --session <id>', () => {
  assert.deepEqual(parseArgs(['--session', 'abc123']), { all: false, session: 'abc123' });
});

test('parseArgs: --all と --session の組み合わせ', () => {
  assert.deepEqual(parseArgs(['--all', '--session', 'abc']), { all: true, session: 'abc' });
});

test('parseArgs: --session 値欠落は throw する', () => {
  assert.throws(() => parseArgs(['--session']), /requires a session id/);
});

test('parseArgs: --session の次が別フラグなら throw する', () => {
  assert.throws(() => parseArgs(['--session', '--all']), /requires a session id/);
});

test('parseArgs: 未知の引数は黙殺', () => {
  // 将来 --help などを足す余地を残すため、現状は黙殺で OK
  assert.deepEqual(parseArgs(['--unknown', 'value']), { all: false, session: null });
});

// ─── filterStates ─────────────────────────────────────────────────

function makeState({ sessionId, projectPath, stale = false }) {
  return {
    sessionId,
    projectPath,
    transcriptPath: null,
    updatedAt: Date.now(),
    stale,
  };
}

test('filterStates: --all なしでは stale を隠す', () => {
  const states = [
    makeState({ sessionId: 'a', projectPath: CWD_FOO, stale: false }),
    makeState({ sessionId: 'b', projectPath: CWD_FOO, stale: true }),
  ];
  const result = filterStates(states, { all: false, session: null }, CWD_FOO);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'a');
});

test('filterStates: --all は stale も含む', () => {
  const states = [
    makeState({ sessionId: 'a', projectPath: CWD_FOO, stale: false }),
    makeState({ sessionId: 'b', projectPath: CWD_BAR, stale: true }),
  ];
  const result = filterStates(states, { all: true, session: null }, CWD_FOO);
  assert.equal(result.length, 2);
});

test('filterStates: --session は base (stale フィルタ済み) 上でプレフィックス一致', () => {
  const states = [
    makeState({ sessionId: 'abc123', projectPath: CWD_FOO, stale: false }),
    makeState({ sessionId: 'abc999', projectPath: CWD_FOO, stale: true }), // stale は除外される
    makeState({ sessionId: 'def456', projectPath: CWD_FOO, stale: false }),
  ];
  const result = filterStates(states, { all: false, session: 'abc' }, CWD_FOO);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'abc123');
});

test('filterStates: --session + --all なら stale 含めたうえでプレフィックス一致', () => {
  const states = [
    makeState({ sessionId: 'abc123', projectPath: CWD_FOO, stale: false }),
    makeState({ sessionId: 'abc999', projectPath: CWD_FOO, stale: true }),
  ];
  const result = filterStates(states, { all: true, session: 'abc' }, CWD_FOO);
  assert.equal(result.length, 2);
});

test('filterStates: --session 完全一致もプレフィックス一致の一部として拾う', () => {
  const states = [
    makeState({ sessionId: 'exact-match-id', projectPath: CWD_FOO, stale: false }),
  ];
  const result = filterStates(states, { all: false, session: 'exact-match-id' }, CWD_FOO);
  assert.equal(result.length, 1);
});

test('filterStates: cwd 不一致は除外（--session も --all もなし）', () => {
  const states = [
    makeState({ sessionId: 'a', projectPath: CWD_FOO, stale: false }),
    makeState({ sessionId: 'b', projectPath: CWD_BAR, stale: false }),
  ];
  const result = filterStates(states, { all: false, session: null }, CWD_FOO);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'a');
});
