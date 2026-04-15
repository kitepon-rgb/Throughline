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
import { getStateDir, readAllSessionStates, snapshotStateMtimes, normalizeProjectPath } from './state-file.mjs';
import { readLatestUsage } from './transcript-usage.mjs';

const REFRESH_MS = 1000;

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

/** ANSI エスケープシーケンスを除いた可視文字数を返す（サロゲートペア考慮はしない簡易版） */
function visibleLength(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
}

/**
 * 行をターミナル幅に収まるよう切り詰める。ANSI コードを壊さないため、
 * 可視文字だけを数えながらコピーし、上限に達したら reset を付けて返す。
 * @param {string} line
 * @param {number} maxWidth
 */
function truncateToWidth(line, maxWidth) {
  if (maxWidth <= 0) return '';
  if (visibleLength(line) <= maxWidth) return line;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < line.length && visible < maxWidth) {
    const ch = line[i];
    if (ch === '\x1b' && line[i + 1] === '[') {
      // ANSI sequence: copy until final byte (a-zA-Z)
      const end = line.slice(i).search(/[a-zA-Z]/);
      if (end === -1) break;
      out += line.slice(i, i + end + 1);
      i += end + 1;
      continue;
    }
    out += ch;
    visible++;
    i++;
  }
  return out + ANSI.reset;
}

// --- CLI 引数 ---
function parseArgs(argv) {
  const args = { all: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--session') args.session = argv[++i];
  }
  return args;
}

// --- 表示 ---
function renderBar(ratio, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatLine({ state, usage, isActive }) {
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

  const warn =
    ratio >= 0.9 ? color(ANSI.red, '  ⚠ /clear 強く推奨') :
    ratio >= 0.7 ? color(ANSI.yellow, '  ⚠ そろそろ /clear') :
    '';

  const marker = isActive ? color(ANSI.bold + ANSI.cyan, '▶') : ' ';
  const projectCol = project.padEnd(18).slice(0, 18);
  const idCol = color(ANSI.dim, shortId);
  const barCol = color(barColor, bar);
  const tokCol = `${formatNumber(tokens).padStart(6)} / ${pct.toString().padStart(3)}%`;
  const remCol = color(ANSI.dim, `残 ${formatNumber(remaining)}`);
  const modelCol = usage?.model ? color(ANSI.dim, usage.model) : color(ANSI.dim, '(未取得)');

  return `${marker} ${projectCol} ${idCol} ${barCol} ${tokCol}  ${remCol}  ${modelCol}${warn}`;
}

// --- フィルタ ---
function filterStates(states, args, cwd) {
  // stale (15 分無活動) は基本非表示。--all のときだけ stale も含める
  let base = args.all ? states : states.filter((s) => !s.stale);
  if (args.session) {
    return states.filter((s) => s.sessionId === args.session || s.sessionId.startsWith(args.session));
  }
  if (args.all) return base;
  const normalizedCwd = normalizeProjectPath(cwd);
  return base.filter((s) => s.projectPath === normalizedCwd);
}

// --- メインループ ---
let lastRenderedLines = 0;
let lastMtimes = new Map();

function needsRerender() {
  const current = snapshotStateMtimes();
  if (current.size !== lastMtimes.size) {
    lastMtimes = current;
    return true;
  }
  for (const [name, mtime] of current) {
    if (lastMtimes.get(name) !== mtime) {
      lastMtimes = current;
      return true;
    }
  }
  // mtime は同じでも transcript JSONL のサイズが変われば再描画したい
  // → transcript-usage のキャッシュ判定に任せるため毎秒呼ぶ設計。
  //    state ファイル変化なしでも再計算は走らせる（キャッシュヒット時は軽量）
  return true;
}

function renderFrame(args) {
  const states = readAllSessionStates();
  const filtered = filterStates(states, args, process.cwd()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const lines = [];
  if (filtered.length === 0) {
    lines.push(color(ANSI.dim, '[Throughline] 待機中 — アクティブなセッションがありません'));
    if (!args.all) {
      lines.push(color(ANSI.dim, `  (${normalizeProjectPath(process.cwd())} に state 無し。--all で全プロジェクト表示)`));
    }
  } else {
    const header = color(
      ANSI.bold,
      `[Throughline] ${filtered.length} セッション${args.all ? ' (--all)' : ''}`,
    );
    lines.push(header);
    for (let i = 0; i < filtered.length; i++) {
      const state = filtered[i];
      const usage = state.transcriptPath ? readLatestUsage(state.transcriptPath) : null;
      lines.push(formatLine({ state, usage, isActive: i === 0 }));
    }
  }

  // ★ 折り返し対策: 各行を (columns - 1) 幅に切り詰めて物理 1 行に収める。
  //   こうすれば ANSI.up(lines.length) と論理行数が物理行数と一致する。
  //   columns - 1 にしてるのはターミナル末尾列に書くと自動改行する端末があるため。
  const columns = process.stdout.columns && process.stdout.columns > 10
    ? process.stdout.columns - 1
    : 120;
  const clipped = lines.map((l) => truncateToWidth(l, columns));

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
function main() {
  const args = parseArgs(process.argv.slice(2));

  process.stdout.write(ANSI.hideCursor);
  process.stdout.write(color(ANSI.dim, `[Throughline] モニター起動 (state: ${getStateDir()}, Ctrl+C で終了)\n`));

  renderFrame(args);
  const timer = setInterval(() => {
    if (needsRerender()) renderFrame(args);
  }, REFRESH_MS);

  const shutdown = () => {
    clearInterval(timer);
    process.stdout.write('\n' + ANSI.showCursor);
    process.stdout.write(color(ANSI.dim, '[Throughline] モニター終了\n'));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
