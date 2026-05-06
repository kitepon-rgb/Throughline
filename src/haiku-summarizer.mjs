/**
 * haiku-summarizer.mjs — L1 要約生成
 *
 * 基本方針:
 *   - codex-sidecar diagnostics が configured なら、Codex sidecar で L2→L1 要約する。
 *   - codex-sidecar が disabled / unavailable なら、現行の Claude Haiku 要約に戻す。
 *   - どちらも失敗したら L2 全文を L1 に入れる（情報欠損ゼロ）。
 *
 * Claude Haiku 経路:
 *   Claude Max 契約前提。`claude -p --model claude-haiku-4-5-20251001`
 *   を子プロセス起動する。Anthropic API キーは使わない（Claude Code CLI が
 *   Max 契約の認証を持っている前提）。
 *
 * 【Haiku 再帰暴走の根本対策: 隔離 cwd で spawn】
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  diagnoseCodexSidecar,
  CODEX_SIDECAR_STATUS,
  runCodexSidecarCommand,
} from './codex-sidecar.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;
const SIDECAR_TIMEOUT_MS = 10 * 60_000;
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

function buildPrompt(l2Text) {
  const targetChars = Math.max(20, Math.round(l2Text.length / 5));
  return (
    `次の日本語テキストを約${targetChars}文字に要約してください。` +
    `固有名詞・数値・因果関係を優先して残し、枝葉は落としてください。` +
    `要約文だけを出力し、前置きや説明は不要です。`
  );
}

function parseSidecarSummary(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed?.status && !['ok', 'completed'].includes(parsed.status)) return null;
  if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
    return parsed.summary.trim();
  }
  if (typeof parsed.recommendation === 'string' && parsed.recommendation.trim()) {
    return parsed.recommendation.trim();
  }
  return null;
}

function tryCodexSidecarSummary(l2Text, { projectPath, prompt, env }) {
  if (!projectPath) {
    return { summary: null, reason: 'missing_project_path' };
  }

  const diagnostics = diagnoseCodexSidecar({
    projectPath,
    preset: 'summarize-l1',
    env,
    timeoutMs: SIDECAR_TIMEOUT_MS,
  });
  if (diagnostics.status !== CODEX_SIDECAR_STATUS.CONFIGURED) {
    return {
      summary: null,
      reason: `sidecar_${diagnostics.status}`,
      diagnostics,
    };
  }

  const contextDir = mkdtempSync(join(tmpdir(), 'throughline-l1-context-'));
  const contextFile = join(contextDir, 'context.json');
  try {
    writeFileSync(
      contextFile,
      JSON.stringify(
        [
          {
            kind: 'manual_note',
            source: 'throughline:l2-turn',
            trust: 'local',
            summary: 'Throughline L2 turn text to summarize into L1 memory.',
            data: {
              text: l2Text,
            },
          },
        ],
        null,
        2,
      ),
    );

    const command = env.THROUGHLINE_CODEX_SIDECAR_BIN ?? 'codex-sidecar';
    const result = runCodexSidecarCommand(
      command,
      [
        'explore',
        '--project',
        projectPath,
        '--preset',
        'summarize-l1',
        '--context-file',
        contextFile,
        '--turn-timeout-ms',
        String(SIDECAR_TIMEOUT_MS),
        prompt,
      ],
      {
        encoding: 'utf8',
        env,
        timeout: SIDECAR_TIMEOUT_MS + 5_000,
      },
    );

    if (result.status !== 0 || !result.stdout) {
      return {
        summary: null,
        reason: 'sidecar_run_failed',
        exitCode: result.status,
        stderr: result.stderr ?? '',
      };
    }

    const summary = parseSidecarSummary(result.stdout);
    if (!summary) {
      return {
        summary: null,
        reason: 'sidecar_summary_missing',
        stdout: result.stdout,
      };
    }
    return { summary, reason: 'sidecar_ok' };
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

function summarizeWithHaiku(l2Text, prompt, env) {
  // child_process に渡す env: 親の env を継承しつつ再帰ガードをセット
  const childEnv = { ...env, [RECURSION_GUARD_ENV]: '1' };

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
        if (summary) return { summary, fromFallback: false, source: 'haiku' };
      }
      // status != 0 や空出力は失敗とみなしてリトライ
    } catch {
      // spawn 失敗 (ENOENT 等) もリトライ
    }
  }

  // 全リトライ失敗 → L2 全文をそのまま L1 に（情報欠損ゼロ）
  return { summary: l2Text, fromFallback: true, source: 'raw_l2' };
}

/**
 * L2 本文を約 1/5 に要約する。
 * @param {string} l2Text ターンの会話本文（user+assistant を適当な形式で結合した文字列）
 * @param {{ projectPath?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ summary: string, fromFallback: boolean, source?: string, sidecarReason?: string }}
 */
export function summarizeToL1(l2Text, { projectPath = null, env = process.env } = {}) {
  if (!l2Text || !l2Text.trim()) {
    return { summary: '(no content)', fromFallback: true, source: 'empty' };
  }

  // 防御（念のため）: 自分自身が Haiku subprocess 内で呼ばれていたら再帰せず即フォールバック
  if (env[RECURSION_GUARD_ENV] === '1') {
    return { summary: l2Text, fromFallback: true, source: 'recursion_guard' };
  }

  const prompt = buildPrompt(l2Text);
  const sidecar = tryCodexSidecarSummary(l2Text, { projectPath, prompt, env });
  if (sidecar.summary) {
    return {
      summary: sidecar.summary,
      fromFallback: false,
      source: 'codex-sidecar',
      sidecarReason: sidecar.reason,
    };
  }

  const haiku = summarizeWithHaiku(l2Text, prompt, env);
  return {
    ...haiku,
    sidecarReason: sidecar.reason,
  };
}
