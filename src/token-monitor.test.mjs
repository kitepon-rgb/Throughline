import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from './token-monitor.mjs';
import { normalizeProjectPath } from './state-file.mjs';

const {
  parseArgs,
  filterStates,
  cellWidth,
  truncateToCells,
  padCellsEnd,
  formatNumber,
  renderBar,
  formatLine,
} = _internal;

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

// ─── cellWidth ─────────────────────────────────────────────────────

test('cellWidth: ASCII は 1 セル', () => {
  assert.equal(cellWidth('abc'), 3);
  assert.equal(cellWidth(''), 0);
  assert.equal(cellWidth('Hello World'), 11);
});

test('cellWidth: CJK は 2 セル', () => {
  assert.equal(cellWidth('あ'), 2);
  assert.equal(cellWidth('漢字'), 4);
  assert.equal(cellWidth('한글'), 4);
});

test('cellWidth: 絵文字は 2 セル', () => {
  assert.equal(cellWidth('😀'), 2);
  assert.equal(cellWidth('🚀🎉'), 4);
});

test('cellWidth: ANSI エスケープは 0 セル', () => {
  assert.equal(cellWidth('\x1b[32mhello\x1b[0m'), 5);
  assert.equal(cellWidth('\x1b[1;36m★\x1b[0m'), 1);
});

test('cellWidth: 混在 (ASCII + CJK + 絵文字 + ANSI)', () => {
  const line = '\x1b[32m▶\x1b[0m Throughline プロジェクト';
  // ▶ (U+25B6) は "Geometric Shapes" で現状 1 セル扱い、ASCII 12 + ひらがな 4 * 2
  // "Throughline " = 12, "プロジェクト" = 12 (6 文字 * 2), ▶ = 1, 空白 = 1
  assert.equal(cellWidth(line), 1 + 1 + 12 + 12);
});

test('cellWidth: 制御文字は 0', () => {
  assert.equal(cellWidth('\x00\x01\x02'), 0);
});

test('cellWidth: ZWJ は 0', () => {
  assert.equal(cellWidth('a\u200db'), 2); // a + ZWJ (0) + b
});

// ─── truncateToCells ──────────────────────────────────────────────

test('truncateToCells: ASCII で単純切り詰め', () => {
  const result = truncateToCells('abcdefghij', 5);
  // 切り詰め後に reset が付く
  assert.ok(result.startsWith('abcde'));
});

test('truncateToCells: CJK 境界で 1 セル余る場合は空白で埋める', () => {
  // maxCells=5 で "あいう" (6 セル) を切ると "あい" (4 セル) + 1 セル分空白
  const result = truncateToCells('あいうえお', 5);
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
  // CJK 2 セル × 2 = 4 セル + 空白 1 = 5 セル
  assert.ok(stripped.startsWith('あい '));
});

test('truncateToCells: 既に収まっていればそのまま', () => {
  assert.equal(truncateToCells('abc', 10), 'abc');
});

test('truncateToCells: ANSI コードを破壊しない', () => {
  const input = '\x1b[32mhello\x1b[0m world';
  const result = truncateToCells(input, 7);
  // ANSI がそのまま残り、可視部分は "hello w" で切れる
  assert.ok(result.includes('\x1b[32m'));
});

test('truncateToCells: maxCells=0 は空文字列', () => {
  assert.equal(truncateToCells('hello', 0), '');
});

// ─── padCellsEnd ──────────────────────────────────────────────────

test('padCellsEnd: ASCII を右端パディング', () => {
  assert.equal(padCellsEnd('abc', 6), 'abc   ');
});

test('padCellsEnd: CJK でも正しく幅を計算してパディング', () => {
  // "あい" = 4 セル、target 6 → 空白 2 個付加
  assert.equal(padCellsEnd('あい', 6), 'あい  ');
});

test('padCellsEnd: ちょうど target なら変化なし', () => {
  assert.equal(padCellsEnd('abc', 3), 'abc');
  assert.equal(padCellsEnd('漢字', 4), '漢字');
});

test('padCellsEnd: target 超過なら切り詰め', () => {
  const result = padCellsEnd('abcdefgh', 4);
  const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(stripped.slice(0, 4), 'abcd');
});

// ─── formatNumber ─────────────────────────────────────────────────

test('formatNumber: 1000 未満はそのまま（小数なし）', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(42), '42');
  assert.equal(formatNumber(999), '999');
});

test('formatNumber: 1_000 以上は k 表記', () => {
  assert.equal(formatNumber(1_000), '1.0k');
  assert.equal(formatNumber(1_234), '1.2k');
  assert.equal(formatNumber(999_499), '999.5k');
});

test('formatNumber: 999_500 以上は M 表記にジャンプ（"1000.0k" 回避）', () => {
  assert.equal(formatNumber(999_500), '1.00M');
  assert.equal(formatNumber(999_950), '1.00M');
  assert.equal(formatNumber(999_999), '1.00M');
  assert.equal(formatNumber(1_000_000), '1.00M');
  assert.equal(formatNumber(1_234_567), '1.23M');
});

test('formatNumber: 無効値は "0"', () => {
  assert.equal(formatNumber(NaN), '0');
  assert.equal(formatNumber(-1), '0');
  assert.equal(formatNumber(Infinity), '0');
});

// ─── renderBar ────────────────────────────────────────────────────

test('renderBar: ratio=0 は全部 ░', () => {
  assert.equal(renderBar(0, 5), '░░░░░');
});

test('renderBar: ratio=1 は全部 █', () => {
  assert.equal(renderBar(1, 5), '█████');
});

test('renderBar: ratio=0.5 は半々', () => {
  // width=10, 0.5 * 10 = 5 filled
  assert.equal(renderBar(0.5, 10), '█████░░░░░');
});

test('renderBar: NaN でもバーが消えない', () => {
  const result = renderBar(NaN, 5);
  assert.equal(result.length, 5);
  assert.ok(result.includes('░'));
});

test('renderBar: Infinity / 負値は安全にクランプ', () => {
  assert.equal(renderBar(Infinity, 5), '█████');
  assert.equal(renderBar(-1, 5), '░░░░░');
  assert.equal(renderBar(1.5, 5), '█████');
});

// ─── formatLine 警告表示（色覚配慮） ────────────────────────────

function stripColors(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeLineArgs(ratio) {
  const max = 200_000;
  const tokens = Math.round(ratio * max);
  return {
    state: {
      sessionId: 'abc12345-xxxx',
      projectPath: '/tmp/foo',
      transcriptPath: null,
      updatedAt: Date.now(),
    },
    usage: {
      tokens,
      model: 'test-model',
      contextWindowSize: max,
      outputTokens: 0,
    },
    isActive: true,
  };
}

test('formatLine: 70% 未満は警告テキストなし', () => {
  const out = stripColors(formatLine(makeLineArgs(0.5)));
  assert.ok(!out.includes('!!'));
  assert.ok(!out.includes('!  '));
  assert.ok(!out.includes('/clear'));
});

test('formatLine: 70% 以上で "!" マーカーと弱めの文言', () => {
  const out = stripColors(formatLine(makeLineArgs(0.75)));
  assert.ok(out.includes('!'), 'should include ! marker');
  assert.ok(out.includes('そろそろ /clear'), 'should show soft warning');
  assert.ok(!out.includes('!!'), 'should not include critical marker yet');
});

test('formatLine: 90% 以上で "!!" マーカーと強い文言', () => {
  const out = stripColors(formatLine(makeLineArgs(0.95)));
  assert.ok(out.includes('!!'), 'should include !! critical marker');
  assert.ok(out.includes('強く推奨'), 'should show strong warning');
});

test('formatLine: 色付きで警告が赤 / 黄になる（色覚配慮の裏付け）', () => {
  const critical = formatLine(makeLineArgs(0.95));
  assert.ok(critical.includes('\x1b[31m'), 'critical should use red');
  const warning = formatLine(makeLineArgs(0.75));
  assert.ok(warning.includes('\x1b[33m'), 'warning should use yellow');
});

test('formatLine: プロジェクト名に CJK が含まれてもセル幅で整形される', () => {
  const args = makeLineArgs(0.5);
  args.state.projectPath = '/tmp/プロジェクト名';
  const out = formatLine(args);
  // basename で "プロジェクト名" (7 文字, 14 セル) が project 欄に入る。
  // padCellsEnd(..., 18) で 14 セル + 4 セル空白になる。セル幅を数える
  // のは難しいがクラッシュしないことと想定文字列が含まれることを最低限確認
  assert.ok(stripColors(out).includes('プロジェクト名'));
});
