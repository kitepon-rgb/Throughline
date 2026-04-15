/**
 * haiku-summarizer.mjs — Claude Haiku 4.5 を使った同期 L1 要約生成
 *
 * 呼び出し経路: Claude Max 契約前提。`claude -p --model claude-haiku-4-5-20251001`
 * を子プロセス起動する。Anthropic API キーは使わない（Claude Code CLI が
 * Max 契約の認証を持っている前提）。
 *
 * 【再帰暴走の根本対策: 隔離 cwd で spawn】
 *   素朴に `claude -p` を spawn すると subprocess が同じ .claude/settings.json を
 *   読んで Throughline の Stop hook を起動し、無限再帰になる。
 *
 *   これを物理的に不可能にするため、subprocess は Throughline の project-local
 *   設定が見つからない空ディレクトリ（~/.throughline/haiku-workdir/）を cwd に
 *   して起動する。Claude Code は cwd 起点で .claude/settings.json を探すので、
 *   project-local 設定はロードされない。global (~/.claude/settings.json) のみ
 *   適用されるが、そこに Throughline hook は置かれない運用前提。
 *
 *   複数プロジェクト・複数セッションで並列実行しても互いに干渉しない（各呼び出し
 *   は独立した subprocess、ロックなし）。
 *
 *   さらに三重防御として env var THROUGHLINE_IN_HAIKU_SUBPROCESS=1 も設定する。
 *   万一 global に Throughline hook が紛れ込んでも turn-processor 冒頭で exit する。
 *
 * 失敗時のポリシー:
 *   1. 2 回までリトライ
 *   2. それでも失敗したら L2 全文を L1 に入れる（情報欠損ゼロ）
 */

import { spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;
const RECURSION_GUARD_ENV = 'THROUGHLINE_IN_HAIKU_SUBPROCESS';

// 隔離 cwd: Throughline project-local 設定が見つからない空ディレクトリ
const HAIKU_WORKDIR = join(homedir(), '.throughline', 'haiku-workdir');

function ensureWorkdir() {
  try {
    mkdirSync(HAIKU_WORKDIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * L2 本文を約 1/5 に要約する。
 * @param {string} l2Text ターンの会話本文（user+assistant を適当な形式で結合した文字列）
 * @returns {{ summary: string, fromFallback: boolean }}
 */
export function summarizeToL1(l2Text) {
  if (!l2Text || !l2Text.trim()) {
    return { summary: '(no content)', fromFallback: true };
  }

  // 防御（念のため）: 自分自身が Haiku subprocess 内で呼ばれていたら再帰せず即フォールバック
  if (process.env[RECURSION_GUARD_ENV] === '1') {
    return { summary: l2Text, fromFallback: true };
  }

  const targetChars = Math.max(20, Math.round(l2Text.length / 5));
  const prompt =
    `次の日本語テキストを約${targetChars}文字に要約してください。` +
    `固有名詞・数値・因果関係を優先して残し、枝葉は落としてください。` +
    `要約文だけを出力し、前置きや説明は不要です。`;

  // child_process に渡す env: 親の env を継承しつつ再帰ガードをセット
  const childEnv = { ...process.env, [RECURSION_GUARD_ENV]: '1' };

  // 隔離 cwd を準備（project-local .claude/settings.json が見えない場所）
  ensureWorkdir();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = spawnSync('claude', ['-p', '--model', MODEL, prompt], {
        input: l2Text,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        shell: process.platform === 'win32', // Windows は claude.cmd ラッパー
        env: childEnv,
        cwd: HAIKU_WORKDIR, // ← これが再帰防止の本丸
      });

      if (result.status === 0 && result.stdout) {
        const summary = result.stdout.trim();
        if (summary) return { summary, fromFallback: false };
      }
      // status != 0 や空出力は失敗とみなしてリトライ
    } catch {
      // spawn 失敗 (ENOENT 等) もリトライ
    }
  }

  // 全リトライ失敗 → L2 全文をそのまま L1 に（情報欠損ゼロ）
  return { summary: l2Text, fromFallback: true };
}
