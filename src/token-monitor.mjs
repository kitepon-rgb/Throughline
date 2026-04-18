#!/usr/bin/env node
/**
 * token-monitor.mjs — マルチセッション対応トークンモニター
 *
 * 使い方:
 *   throughline monitor                  現在のプロジェクトの全 active セッション
 *   throughline monitor --all             全プロジェクト全セッション
 *   throughline monitor --session <id>    特定セッションのみ
 *
 * VS Code の分割ターミナルなどで常時起動しておく。
 *
 * 設計: docs/PUBLIC_RELEASE_PLAN.md §4.5/4.6
 *   - 状態ファイルはセッション単位 (~/.throughline/state/<session_id>.json)
 *   - setInterval (1s) + mtime 差分検知で更新を捕捉
 *   - updatedAt 降順ソート、先頭行を ▶ でハイライト
 *   - stale は PID 生存チェックで判定
 *   - トークン数は transcript JSONL の最新 assistant usage を直読
 */

import { basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { statSync, existsSync } from 'node:fs';
import { getStateDir, readAllSessionStates, snapshotStateMtimes, normalizeProjectPath } from './state-file.mjs';
import { readLatestUsage } from './transcript-usage.mjs';

const REFRESH_MS = 1000;
// データ変化が無くても N ms ごとに再描画して「(24m ago)」表示を進める。
// 変化検知のほうが優先で、こちらはフォールバック的なタイマー。
const TIME_AGO_REFRESH_MS = 10_000;
let lastTimeAgoRefresh = Date.now();

// --- ANSI ---
const ANSI = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  clearScreen: '\x1b[2J\x1b[H',
  clearBelow: '\x1b[0J',        // 現在位置から画面末尾までをクリア
  up: (n) => `\x1b[${n}A`,       // CUU: カーソルを N 行上へ (列は変えない)
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function color(c, text) {
  return `${c}${text}${ANSI.reset}`;
}

// --- セル幅計算（ANSI / CJK / 絵文字対応、依存ゼロ） ---
//
// Node v22 には util.getStringWidth がないため、主要な East Asian Wide + 絵文字ブロックを
// 自前の範囲判定で 2 セルとして扱う。East Asian Ambiguous は 1 セル（アラビア・タイ等は
// 既存の char-count 実装と同じ扱いなので悪化しない）。
// ZWJ / VS16 は幅 0 として扱う（絵文字シーケンスの微ズレは許容）。
const ZERO_WIDTH_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff, 0xfe0e, 0xfe0f]);

/**
 * 単一コードポイントのセル幅を返す（0 / 1 / 2）
 * @param {number} cp
 */
function codePointWidth(cp) {
  if (cp < 0x20) return 0;                          // C0 制御
  if (cp >= 0x7f && cp < 0xa0) return 0;            // DEL / C1 制御
  if (ZERO_WIDTH_CODEPOINTS.has(cp)) return 0;
  // Combining marks (簡易: Combining Diacritical Marks 主要ブロック)
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  // Wide ranges
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||               // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||               // CJK Radicals / Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||               // Hiragana/Katakana/Bopomofo/CJK Symbols
    (cp >= 0x3400 && cp <= 0x4dbf) ||               // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||               // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||               // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||               // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||               // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||               // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||               // Fullwidth
    (cp >= 0xffe0 && cp <= 0xffe6) ||               // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) ||             // 絵文字主要ブロック
    (cp >= 0x20000 && cp <= 0x3134f)                // CJK Ext B-G
  ) {
    return 2;
  }
  return 1;
}

/**
 * 文字列のセル幅合計（ANSI 剥ぎ取り済み前提ではない — 内部で剥ぐ）
 * @param {string} s
 */
function cellWidth(s) {
  if (typeof s !== 'string') return 0;
  const stripped = stripVTControlCharacters(s);
  let total = 0;
  for (const ch of stripped) {
    total += codePointWidth(ch.codePointAt(0));
  }
  return total;
}

/**
 * 行をセル幅で切り詰める。ANSI コードはそのまま通過させ（幅 0）、
 * 可視セル幅が maxCells に達したら残りを捨てて reset を付けて返す。
 * CJK 文字を跨ぐときは 1 セル余る場合があるので空白で埋める。
 * @param {string} line
 * @param {number} maxCells
 */
function truncateToCells(line, maxCells) {
  if (maxCells <= 0) return '';
  if (cellWidth(line) <= maxCells) return line;
  let out = '';
  let cells = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    // ANSI CSI: \x1b[ ... 終端 (0x40-0x7e)
    if (code === 0x1b && line.charCodeAt(i + 1) === 0x5b) {
      let j = i + 2;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) { j++; break; }
        j++;
      }
      out += line.slice(i, j);
      i = j;
      continue;
    }
    // コードポイント単位で取得（サロゲートペア考慮）
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = codePointWidth(cp);
    if (cells + w > maxCells) {
      // CJK 1 セル余り
      if (cells < maxCells) out += ' ';
      break;
    }
    out += ch;
    cells += w;
    i += ch.length;
  }
  return out + ANSI.reset;
}

/**
 * 文字列の末尾を半角スペースでパディングして targetCells に揃える。
 * 既にはみ出している場合は truncateToCells で切り詰める。
 * @param {string} s
 * @param {number} targetCells
 */
function padCellsEnd(s, targetCells) {
  const width = cellWidth(s);
  if (width === targetCells) return s;
  if (width > targetCells) return truncateToCells(s, targetCells);
  return s + ' '.repeat(targetCells - width);
}

// --- CLI 引数 ---
/**
 * @param {string[]} argv
 * @returns {{all: boolean, session: string|null}}
 * @throws {Error} --session に値が欠落している場合
 */
function parseArgs(argv) {
  const args = { all: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') {
      args.all = true;
    } else if (argv[i] === '--session') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--session requires a session id (or prefix) as next argument');
      }
      args.session = value;
      i++;
    }
  }
  return args;
}

// --- 表示 ---
function renderBar(ratio, width = 20) {
  // NaN は 0、+Infinity は 1（オーバーフロー = 満タン表示）、負値 / -Infinity は 0 にクランプ
  let safe;
  if (Number.isNaN(ratio)) safe = 0;
  else if (ratio === Infinity) safe = 1;
  else if (ratio === -Infinity) safe = 0;
  else safe = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(safe * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatNumber(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  // 999_950 以上は toFixed(1) で "1000.0k" になってしまうので M 表記に切り上げる
  if (n >= 999_500) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.floor(n));
}

/**
 * ある時刻からの経過時間を短い人間可読形式で返す。
 * 「止まって見える」瞬間に、それがどれだけ前の値なのかを一目で示すために使う。
 * @param {number} ms - 経過ミリ秒
 */
export function formatTimeAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * columns の変化を検知して全画面再描画すべきかを返す。
 * process.stdout.on('resize') イベントが VSCode 統合ターミナルで発火しないケースが
 * あるため、1 秒 tick から呼び出して polling で検知する。
 * @param {number} prevCols
 * @param {number} currCols
 */
export function shouldForceFullRedraw(prevCols, currCols) {
  return prevCols !== currCols && currCols > 0;
}

function formatLine({ state, usage, isActive, now = Date.now() }) {
  const project = basename(state.projectPath || '?');
  const shortId = state.sessionId.slice(0, 8);
  const tokens = usage?.tokens ?? 0;
  const max = usage?.contextWindowSize ?? 200_000;
  const ratio = max > 0 ? tokens / max : 0;
  const pct = Math.round(ratio * 100);
  const remaining = Math.max(0, max - tokens);

  const bar = renderBar(ratio);
  const barColor =
    ratio >= 0.9 ? ANSI.red :
    ratio >= 0.7 ? ANSI.yellow :
    ANSI.green;

  // 色覚配慮: 色だけでなく記号 / テキスト接頭辞でも重要度を示す
  //   90%超: !! + 強い文言 (赤)
  //   70%超: !  + 弱い文言 (黄)
  const warn =
    ratio >= 0.9 ? color(ANSI.red + ANSI.bold, '  !! /clear 強く推奨') :
    ratio >= 0.7 ? color(ANSI.yellow, '  !  そろそろ /clear') :
    '';

  const marker = isActive ? color(ANSI.bold + ANSI.cyan, '▶') : ' ';
  const projectCol = padCellsEnd(project, 18);
  const idCol = color(ANSI.dim, shortId);
  const barCol = color(barColor, bar);
  const tokCol = `${formatNumber(tokens).padStart(6)} / ${pct.toString().padStart(3)}%`;
  const remCol = color(ANSI.dim, `残 ${formatNumber(remaining)}`);
  const modelCol = usage?.model ? color(ANSI.dim, usage.model) : color(ANSI.dim, '(未取得)');
  // 最終更新からの経過: 表示が「止まって見える」とき、それが idle なのか障害なのかを
  // 即座に判別できるようにする。updatedAt は state.writeSessionState 時の Date.now()。
  // 位置は session id の直後（左寄せ固定幅）。狭いターミナルでもモデル名より先に
  // 切れない位置に置くのと、縦の視線移動で「どれが最新更新か」を把握しやすくするため。
  const agoText = typeof state.updatedAt === 'number'
    ? formatTimeAgo(now - state.updatedAt)
    : '';
  // 8 セル固定: "just now" が最長 (8 セル)、"99d ago" は 7 セル。括弧なしで OK
  const agoCol = color(ANSI.dim, padCellsEnd(agoText, 8));

  return `${marker} ${projectCol} ${idCol} ${agoCol} ${barCol} ${tokCol}  ${remCol}  ${modelCol}${warn}`;
}

// --- フィルタ ---
/**
 * セッション一覧に表示フィルタを適用する。
 * ルール:
 *   - stale (15 分無活動) は基本非表示。--all のときのみ stale も含める
 *   - --session が指定されればプレフィックス一致、ただし base (stale フィルタ通過済み) 上で絞る
 *   - --session 無し & --all 無しのときは cwd 一致のみ残す
 */
function filterStates(states, args, cwd) {
  const base = args.all ? states : states.filter((s) => !s.stale);
  if (args.session) {
    // startsWith が完全一致も含むので === は冗長
    return base.filter((s) => s.sessionId.startsWith(args.session));
  }
  if (args.all) return base;
  const normalizedCwd = normalizeProjectPath(cwd);
  return base.filter((s) => s.projectPath === normalizedCwd);
}

// --- メインループ ---
let lastRenderedLines = 0;
let lastRenderKey = '';

/**
 * 再描画要否の判定キー。state ファイル群の mtime と transcript JSONL の size を
 * 1 本の文字列にまとめてハッシュキーとする。キーが前回と同じなら描画スキップ。
 *
 * 注: transcript は JSONL append-only なので size 変化 = 新しい usage エントリ到来と
 * 同義。mtime だけでは transcript 更新を検出できない（state-file の mtime は
 * Stop hook のタイミングで更新され、transcript は Claude の stream 中に太る）。
 */
function computeRenderKey() {
  const parts = [];
  // state mtimes
  const mtimes = snapshotStateMtimes();
  const names = Array.from(mtimes.keys()).sort();
  for (const name of names) parts.push(`s:${name}:${mtimes.get(name)}`);
  // transcript sizes（state ファイルを読まずに直接 stat、IO 最小化）
  try {
    const states = readAllSessionStates();
    for (const st of states) {
      if (!st.transcriptPath || !existsSync(st.transcriptPath)) continue;
      try {
        const size = statSync(st.transcriptPath).size;
        parts.push(`t:${st.sessionId}:${size}`);
      } catch {
        // stat 失敗は無視（次フレームで回復）
      }
    }
  } catch {
    // readAllSessionStates 自体の失敗も 1 フレームで回復
  }
  return parts.join('|');
}

/**
 * 前回と比べてキーが変化していれば true。副作用として lastRenderKey を更新する。
 */
function needsRerender() {
  const key = computeRenderKey();
  if (key !== lastRenderKey) {
    lastRenderKey = key;
    return true;
  }
  return false;
}

/** テスト用リセット */
function resetRenderKeyCache() {
  lastRenderKey = '';
}

function renderFrame(args) {
  const states = readAllSessionStates();
  const filtered = filterStates(states, args, process.cwd()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const lines = [];
  if (filtered.length === 0) {
    if (args.session) {
      // --session 指定で未ヒットは「存在しない」と明示（一般の "待機中" と区別）
      lines.push(color(ANSI.yellow, `[Throughline] セッション "${args.session}" に一致する active セッションが見つかりません`));
      lines.push(color(ANSI.dim, '  (プレフィックス指定も可。--all で stale を含めて再検索)'));
    } else {
      lines.push(color(ANSI.dim, '[Throughline] 待機中 — アクティブなセッションがありません'));
      if (!args.all) {
        lines.push(color(ANSI.dim, `  (${normalizeProjectPath(process.cwd())} に state 無し。--all で全プロジェクト表示)`));
      }
    }
  } else {
    const header = color(
      ANSI.bold,
      `[Throughline] ${filtered.length} セッション${args.all ? ' (--all)' : ''}`,
    );
    lines.push(header);
    const now = Date.now();
    for (let i = 0; i < filtered.length; i++) {
      const state = filtered[i];
      // Stop hook が state.usage に固定値を入れていればそれを使う（JSONL 再スキャン不要）。
      // 旧バージョンが書いた state や usage スナップショットが取れなかったターンでは
      // transcriptPath を直読してフォールバック。state 側の情報が 1 本化されると
      // 「state が古い JSONL を指している」時の表示ブレが減る。
      const usage = state.usage
        ?? (state.transcriptPath ? readLatestUsage(state.transcriptPath) : null);
      lines.push(formatLine({ state, usage, isActive: i === 0, now }));
    }
  }

  // ★ 折り返し対策: 各行を (columns - 1) セル幅に切り詰めて物理 1 行に収める。
  //   こうすれば ANSI.up(lines.length) と論理行数が物理行数と一致する。
  //   columns - 1 にしてるのはターミナル末尾列に書くと自動改行する端末があるため。
  //   truncateToCells は CJK / 絵文字を 2 セルとして正しく数える。
  const columns = process.stdout.columns && process.stdout.columns > 10
    ? process.stdout.columns - 1
    : 120;
  const clipped = lines.map((l) => truncateToCells(l, columns));

  // 前フレームを消去してから再描画:
  //   1. カーソルを前フレームの先頭行へ戻す (CUU = 行移動のみ)
  //   2. 列 1 へ戻す (CR)
  //   3. 現在位置から画面末尾までを一括消去 (ED 0)
  // CPL (\x1b[nF) は VSCode 統合ターミナルで挙動が不安定だったため使わない
  if (lastRenderedLines > 0) {
    process.stdout.write(ANSI.up(lastRenderedLines) + '\r' + ANSI.clearBelow);
  }

  process.stdout.write(clipped.join('\n') + '\n');
  lastRenderedLines = clipped.length;
}

// --- 起動 ---
let cursorRestored = false;
function restoreCursor() {
  if (cursorRestored) return;
  cursorRestored = true;
  try {
    process.stdout.write(ANSI.showCursor);
  } catch {
    // stdout がすでに閉じていても無視
  }
}

function safeRenderFrame(args) {
  try {
    renderFrame(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    process.stderr.write(`[Throughline] render error: ${msg}\n`);
    // 1 フレームの失敗で常駐を落とさない。次フレームで回復を試す
  }
}

export function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid args';
    process.stderr.write(`[Throughline] ${msg}\n`);
    process.exit(2);
  }

  process.stdout.write(ANSI.hideCursor);
  process.stdout.write(color(ANSI.dim, `[Throughline] モニター起動 (state: ${getStateDir()}, Ctrl+C で終了)\n`));

  safeRenderFrame(args);
  // columns の最後に使った値。polling で resize 検知するために使う。
  // VSCode 統合ターミナルは process.stdout.on('resize') が発火しないことがあり、
  // 起動時に狭い幅だった場合に描画が崩れたまま固定される（実害ベースで確認済み）。
  // 1 秒 tick のたびに currCols と比較してイベント不達を埋める。
  let lastColumns = process.stdout.columns ?? 0;
  const timer = setInterval(() => {
    const currCols = process.stdout.columns ?? 0;
    if (shouldForceFullRedraw(lastColumns, currCols)) {
      lastColumns = currCols;
      lastRenderedLines = 0;
      resetRenderKeyCache();
      safeRenderFrame(args);
      return;
    }
    // 状態が更新されていれば再描画。state mtime か transcript size のどちらかが
    // 変わっていれば発火するので、Stop 完了・新 assistant エントリ追記の両方を捕捉する。
    if (needsRerender()) safeRenderFrame(args);
    // 1 秒刻みの「経過時間」(24m ago など) を反映するため、データに変化が無くても
    // 10 秒に 1 回は強制再描画する。コストは state 数本の JSONL パースのみで軽い。
    if (Date.now() - lastTimeAgoRefresh > TIME_AGO_REFRESH_MS) {
      lastTimeAgoRefresh = Date.now();
      safeRenderFrame(args);
    }
  }, REFRESH_MS);

  // resize イベント経路は残す: polling 前に通知が来ればより速く反応できる。
  // debounce 200ms でドラッグ中のジッタを吸収し、polling 側との二重再描画も防ぐ。
  let resizeTimer = null;
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // 既存描画が新しい幅では崩れている可能性があるため座標情報を破棄して再描画
      lastColumns = process.stdout.columns ?? 0;
      lastRenderedLines = 0;
      resetRenderKeyCache();
      safeRenderFrame(args);
    }, 200);
  };
  if (typeof process.stdout.on === 'function') {
    process.stdout.on('resize', onResize);
  }

  const shutdown = (code = 0) => {
    clearInterval(timer);
    if (resizeTimer) clearTimeout(resizeTimer);
    restoreCursor();
    process.stdout.write('\n' + color(ANSI.dim, '[Throughline] モニター終了\n'));
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // クラッシュ時もカーソルを必ず戻す
  process.on('exit', restoreCursor);
  process.on('uncaughtException', (err) => {
    restoreCursor();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[Throughline] uncaught exception:\n${msg}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    restoreCursor();
    process.stderr.write(`[Throughline] unhandled rejection: ${String(reason)}\n`);
    process.exit(1);
  });
}

// --- テスト用エクスポート（本番コードからは参照しない） ---
export const _internal = {
  parseArgs,
  filterStates,
  cellWidth,
  truncateToCells,
  padCellsEnd,
  formatNumber,
  renderBar,
  formatLine,
  computeRenderKey,
  needsRerender,
  resetRenderKeyCache,
  formatTimeAgo,
  shouldForceFullRedraw,
};

// --- エントリポイント自動起動 ---
// `node src/token-monitor.mjs` 直接起動（VSCode タスク .vscode/tasks.json が使うパターン）
// のとき main() を自動実行する。
// dispatcher 経由（`throughline monitor`）は bin/throughline.mjs が明示的に main() を呼ぶ。
// テスト import（`node --test src/token-monitor.test.mjs`）は argv[1] が `.test.mjs` で終わる。
// argv[1] が 'token-monitor.mjs' で終わって '.test.mjs' でないケースだけ auto-run する。
{
  const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
  const isDirectEntry = argv1.endsWith('token-monitor.mjs') && !argv1.endsWith('.test.mjs');
  if (isDirectEntry) {
    main();
  }
}
