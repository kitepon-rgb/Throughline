#!/usr/bin/env node
/**
 * UserPromptSubmit hook — /tl & /clear スラッシュコマンド検出 + バトン書き込み + Phase 0-5 spike
 *
 * stdin: { session_id, cwd, prompt, transcript_path, hook_event_name, ... }
 *
 * 動作:
 *   - prompt が /tl (単独 or /tl ... 形式) で始まっていればバトンを書き込んで終了
 *   - prompt が /clear (単独 or /clear ... 形式) で始まっていれば、現セッションの
 *     session_id をバトンに書き込んで終了。
 *     (これにより SessionStart 側の findLatestClaudePredecessor heuristic に頼らず、
 *      確定的に「/clear が打たれたセッション」を新セッションに引き継げる。複数
 *      VSCode ウィンドウ等で「最新更新セッション = clear されたセッション」が
 *      成立しない multi-window シナリオで誤った前任を選ばないための確定的指名)
 *   - それ以外は何もせず exit 0（プロンプトはそのまま Claude に渡る）
 *   - 本 hook は引き継ぎ注入を行わない (SessionStart の stdout 注入と二重にならないため)
 *
 *   - **Phase 0-5 spike (SPIKE ONLY)**: marker file `~/.throughline/spike-prompt.flag`
 *     が存在し、当該セッションでまだ spike を打っていなければ、JSONL に user/assistant
 *     行を chain-reachable (= 直前の attachment uuid を parent に取る) で append する。
 *     SessionStart 経路の spike (chain (a) = orphan) ではモデルに届かなかったため、
 *     UserPromptSubmit 経路で chain (b) を成立させて再検証する。
 *     docs/10_transcript_injection_plan.md Phase 0-5 参照。
 *
 * 設計背景: docs/03_inheritance_on_clear_only.md バトン方式
 */

import { getDb } from './db.mjs';
import { writeBaton } from './baton.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';

// Phase 0-5 spike marker (SessionStart の spike-inject.flag とは別)
const PROMPT_SPIKE_MARKER_PATH = join(homedir(), '.throughline', 'spike-prompt.flag');
const PROMPT_SPIKE_STATE_DIR = join(homedir(), '.throughline', 'spike-prompt-state');

function logBaton(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'baton-write.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[prompt-submit:log] ${msg}\n`);
  }
}

function logPromptSpike(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'prompt-spike.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[prompt-submit:spike-log] ${msg}\n`);
  }
}

/**
 * transcript_path の末尾 3 行を読み、各行の type / uuid / parentUuid を返す。
 * 診断ログ用 (chain (b) が CC に効いたかを後で検証するための context)。
 */
function readTailLineSummary(targetJsonlPath, n = 3) {
  if (!existsSync(targetJsonlPath)) return null;
  try {
    const text = readFileSync(targetJsonlPath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const tail = lines.slice(-n);
    return tail.map((l) => {
      try {
        const o = JSON.parse(l);
        const sub = o.type === 'attachment'
          ? `attachment.${o.attachment?.type ?? '?'}`
          : (o.type ?? 'n/a');
        return { type: sub, uuid: o.uuid ?? null, parentUuid: o.parentUuid ?? null };
      } catch {
        return { type: 'parse-error', uuid: null, parentUuid: null };
      }
    });
  } catch {
    return null;
  }
}

/**
 * Phase 0-5 spike を当該セッションで既に打ったかを判定する。
 * per-session marker file `~/.throughline/spike-prompt-state/<session_id>` の存在で判定。
 */
function alreadySpiked(sessionId) {
  return existsSync(join(PROMPT_SPIKE_STATE_DIR, sessionId));
}

function markSpiked(sessionId) {
  mkdirSync(PROMPT_SPIKE_STATE_DIR, { recursive: true });
  writeFileSync(join(PROMPT_SPIKE_STATE_DIR, sessionId), '', 'utf8');
}

/**
 * プロンプトが /tl バトン発動コマンドか判定する。
 * 許容: "/tl", "/tl\n", "/tl 何か" (前後空白は trim 済み前提)
 */
export function isBatonCommand(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (trimmed === '/tl') return true;
  if (trimmed.startsWith('/tl ') || trimmed.startsWith('/tl\n')) return true;
  return false;
}

/**
 * プロンプトが /clear バトン発動コマンドか判定する。
 * 許容: "/clear", "/clear\n", "/clear 何か" (前後空白は trim 済み前提)
 */
export function isClearCommand(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (trimmed === '/clear') return true;
  if (trimmed.startsWith('/clear ') || trimmed.startsWith('/clear\n')) return true;
  return false;
}

export async function run() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = JSON.parse(raw);
  const { session_id, cwd, prompt } = payload;

  // VSCode 新規プロジェクトへの tasks.json 自動プロビジョニング。
  // SessionStart/Stop に加えここでも呼ぶことで、どれか 1 つでも発火すれば初回メッセージ送信で
  // tasks.json が生える。冪等性は ensureMonitorTaskFile 側で保証。/tl 判定より前に置く。
  try {
    ensureMonitorTaskFile({ cwd: cwd ?? process.cwd(), env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  const tlMatch = isBatonCommand(prompt);
  const clearMatch = !tlMatch && isClearCommand(prompt);

  // Phase 0-5 spike: real user prompt (not /tl, not /clear) で、marker file あり、
  // session 未 spike なら chain (b) で JSONL に inject する。失敗しても prompt 自体は
  // そのまま Claude に流す。
  if (!tlMatch && !clearMatch && session_id && existsSync(PROMPT_SPIKE_MARKER_PATH)) {
    await maybeRunPromptSpike({ payload, sessionId: session_id, projectPath: cwd ?? process.cwd() });
  }

  if (!tlMatch && !clearMatch) {
    process.exit(0);
    return;
  }

  if (!session_id) {
    process.stderr.write('[prompt-submit] missing session_id in payload\n');
    process.exit(0);
    return;
  }

  const projectPath = cwd ?? process.cwd();
  const db = getDb();
  const now = Date.now();

  writeBaton(db, { projectPath, sessionId: session_id, now });

  logBaton({
    ts: new Date(now).toISOString(),
    session_id,
    project_path: projectPath,
    trigger: tlMatch ? 'tl' : 'clear',
  });

  process.exit(0);
}

/**
 * Phase 0-5 spike を本セッションでまだ打っていなければ inject する。
 * idempotency: per-session marker `~/.throughline/spike-prompt-state/<session_id>`。
 *
 * 失敗は stderr に出して continue。本 hook の主目的 (baton / tasks.json) を阻害しない。
 */
async function maybeRunPromptSpike({ payload, sessionId, projectPath }) {
  const transcriptPath = payload.transcript_path ?? null;
  if (!transcriptPath) {
    logPromptSpike({
      ts: new Date().toISOString(),
      session_id: sessionId,
      skip_reason: 'no_transcript_path_in_payload',
    });
    return;
  }
  if (alreadySpiked(sessionId)) {
    return; // 静かに skip (1 session 1 回限定)
  }
  try {
    const { spikeInject, generateSpikeTracer } = await import('./spike-transcript-writer.mjs');
    const { getDb } = await import('./db.mjs');
    const db = getDb();
    const tracer = generateSpikeTracer();
    const tailBefore = readTailLineSummary(transcriptPath);
    const result = spikeInject({
      db,
      targetJsonlPath: transcriptPath,
      newSessionId: sessionId,
      cwd: projectPath,
      version: payload.version ?? '2.1.145',
      gitBranch: payload.gitBranch ?? 'main',
      tracer,
    });
    logPromptSpike({
      ts: new Date().toISOString(),
      session_id: sessionId,
      transcript_path: transcriptPath,
      tracer: result.tracer,
      parent_uuid_start: result.parentUuidStart,
      appended: result.appended,
      tracer_appended_at: result.tracerAppendedAt,
      skip_reason: result.skipReason ?? null,
      tail_before: tailBefore,
    });
    if (result.appended > 0) {
      markSpiked(sessionId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[prompt-spike] ${msg}\n`);
    logPromptSpike({
      ts: new Date().toISOString(),
      session_id: sessionId,
      error: msg,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    recordRuntimeErrorBestEffort('HOOK_PROMPT_SUBMIT_FAILED');
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[prompt-submit] error: ${msg}\n`);
    process.exit(1);
  });
}
