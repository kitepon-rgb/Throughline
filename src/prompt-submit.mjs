#!/usr/bin/env node
/**
 * UserPromptSubmit hook — 二相ハンドオフ第二相 + /tl & /clear バトン書き込み + Phase 0-5 spike
 *
 * stdin: { session_id, cwd, prompt, transcript_path, hook_event_name, ... }
 *
 * 動作:
 *   - **二相ハンドオフ第二相 (ADR 0014)**: このセッションの pending intent
 *     (SessionStart が登録) が残っていれば、それを消費して baton path 優先 →
 *     auto path の順で前任を merge し、予算内 resume context を stdout 注入する。
 *     プロンプト到達 = セッション実在の証明であり、transcript を生成しない幽霊
 *     SessionStart はここに到達できない (= バトン・記憶を奪えない)。
 *     注入がこの hook に移ったため、SessionStart 側の注入は廃止済み
 *     (旧「二重注入回避」制約はこの構成では発生しない)。
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
import { executeFirstPromptHandoff } from './handoff-executor.mjs';
import { logDecision } from './decision-log.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { recordRuntimeErrorBestEffort } from './runtime-error-store.mjs';
import { GROK_SESSION_PREFIX, normalizeHookPayload } from './hook-envelope.mjs';
import { injectGrokHandoffContext } from './grok-history-inject.mjs';
import { readTranscript } from './transcript-reader.mjs';

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

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

/**
 * Grok は hook prompt と chat_history を
 * `<user_query>/tl</user_query>` + skill 本文で包む。
 * Claude の裸 `/tl` はそのまま返す。
 */
export function commandTextFromPrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  const match = prompt.match(USER_QUERY_RE);
  return (match ? match[1] : prompt).trim();
}

function isNamedSlashCommand(prompt, name) {
  const text = commandTextFromPrompt(prompt);
  if (!text) return false;
  return text === name || text.startsWith(`${name} `) || text.startsWith(`${name}\n`);
}

function lastUserPromptText(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].content;
  }
  return '';
}

/**
 * プロンプトが /tl バトン発動コマンドか判定する。
 * 許容: "/tl", "/tl\n", "/tl 何か"。Grok の user_query 包装も見る。
 */
export function isBatonCommand(prompt) {
  return isNamedSlashCommand(prompt, '/tl');
}

/**
 * プロンプトが /clear バトン発動コマンドか判定する。
 * 許容: "/clear", Grok の alias "/new"。Grok の user_query 包装も見る。
 */
export function isClearCommand(prompt) {
  return isNamedSlashCommand(prompt, '/clear') || isNamedSlashCommand(prompt, '/new');
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

  const payload = normalizeHookPayload(JSON.parse(raw));
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

  // 二相ハンドオフの第二相 (ADR 0014): このプロンプトが newborn セッションの
  // 初回プロンプトなら、pending intent を消費して merge + 注入をここで行う。
  // プロンプト到達 = セッション実在の証明。幽霊 SessionStart はここに来られない。
  // /tl・/clear のバトン書き込みより先に実行する (初回プロンプトが /tl でも、
  // 引き継ぎを受けてから自分のバトンを書く順序になり、自己バトン食いが起きない)。
  if (session_id) {
    const db = getDb();
    const projectPath = cwd ?? process.cwd();
    const now = Date.now();
    const handoff = executeFirstPromptHandoff(db, {
      sessionId: session_id,
      projectPath,
      now,
    });
    if (handoff.attempted) {
      if (handoff.injectionText) {
        if (session_id.startsWith(GROK_SESSION_PREFIX)) {
          const injected = injectGrokHandoffContext(
            payload.transcript_path,
            handoff.injectionText,
          );
          if (!injected.injected) {
            process.stderr.write(`[prompt-submit] grok chat_history inject skipped: ${injected.reason}\n`);
          }
        } else {
          process.stdout.write(handoff.injectionText + '\n');
        }
      }
      logDecision({
        ts: new Date(now).toISOString(),
        phase: 'prompt-submit',
        session_id,
        project_path: projectPath,
        pending_created_at: handoff.pendingCreatedAt,
        triggered_path: handoff.triggeredPath,
        baton_session_id: handoff.baton?.sessionId ?? null,
        baton_age_ms: handoff.baton?.ageMs ?? null,
        baton_skip_reason: handoff.baton?.skipReason ?? null,
        merged: handoff.mergeResult.merged,
        merge_skip_reason: handoff.mergeResult.skipReason ?? null,
        predecessor_id: handoff.mergeResult.predecessorId ?? null,
        injection: handoff.injectionStats,
      });
    }
  }

  let commandPrompt = prompt;
  if (
    typeof session_id === 'string'
    && session_id.startsWith(GROK_SESSION_PREFIX)
    && !isBatonCommand(commandPrompt)
    && !isClearCommand(commandPrompt)
  ) {
    commandPrompt = lastUserPromptText(payload.transcript_path);
  }
  const tlMatch = isBatonCommand(commandPrompt);
  const clearMatch = !tlMatch && isClearCommand(commandPrompt);

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
