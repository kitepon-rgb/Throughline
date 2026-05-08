#!/usr/bin/env node
/**
 * SessionStart hook — セッション登録 + 引き継ぎ判定 + 注入
 *
 * stdin: { session_id, source, cwd, transcript_path, hook_event_name }
 *
 * 【引き継ぎ条件 (2 経路)】 docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md
 *
 *   1. baton path: ユーザーが旧セッションで `/tl` を打つと UserPromptSubmit hook が
 *      handoff_batons に session_id を書く。本 hook が TTL 1 時間以内に消費して
 *      前任を merge + 引継ぎ stdout 注入。`source` 値関係なく発火。
 *   2. auto path: `source='clear'` かつ env `THROUGHLINE_DISABLE_AUTO_HANDOFF` が
 *      `'1'` でない場合、同 project_path の最新 Claude unmerged session を
 *      自動 merge して注入。
 *
 *   両方同時成立はしない (consumeBaton が先発、baton ありなら baton path、
 *   なければ source 判定)。env で OFF にしたユーザーは `/tl` を打ってから
 *   新セッションスタートで baton path を使う。
 *
 * 役割:
 *   1. sessions テーブルに新セッションを INSERT OR IGNORE
 *   2. baton path 判定 (consumeBaton + mergeSpecificPredecessor)
 *   3. baton 無し かつ source='clear' かつ env disable 無し → auto path 判定
 *   4. 合流成立なら curated memory (L1+L2+L3 refs) を「引き継ぎヘッダ」付きで stdout 注入
 *   5. 判定結果を ~/.throughline/logs/inheritance-decision.log に記録
 */

import { getDb } from './db.mjs';
import { consumeBaton } from './baton.mjs';
import { mergeSpecificPredecessor, resolveMergeTarget } from './session-merger.mjs';
import { buildResumeContext } from './resume-context.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ENV_DISABLE_AUTO_HANDOFF = 'THROUGHLINE_DISABLE_AUTO_HANDOFF';

function isAutoHandoffDisabled(env) {
  return env[ENV_DISABLE_AUTO_HANDOFF] === '1';
}

/**
 * 同 project_path の最新 Claude unmerged session を返す (auto path 用 predecessor)。
 * Codex session (`codex:*`) と現セッション自身は除外。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectPath
 * @param {string} currentSessionId
 * @returns {{ session_id: string } | null}
 */
function findLatestClaudePredecessor(db, projectPath, currentSessionId) {
  return (
    db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE lower(project_path) = lower(?)
           AND merged_into IS NULL
           AND session_id != ?
           AND session_id NOT LIKE 'codex:%'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(projectPath, currentSessionId) ?? null
  );
}

function logDecision(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'inheritance-decision.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[session-start:decision-log] ${msg}\n`);
  }
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
  const { session_id, cwd, source } = payload;

  if (!session_id) throw new Error('Missing session_id in SessionStart payload');

  const projectPath = cwd ?? process.cwd();
  const db = getDb();
  const now = Date.now();

  // 0. VSCode 用 tasks.json 自動プロビジョニング (冪等)
  try {
    ensureMonitorTaskFile({ cwd: projectPath, env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  // 1. sessions テーブルに INSERT OR IGNORE
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(session_id, projectPath, now, now);

  // 2. baton 消費
  const baton = consumeBaton(db, { projectPath, now });

  // 3. 引継ぎ判定
  let mergeResult = { merged: false, skipReason: 'no_trigger' };
  let triggeredPath = null;
  const autoDisabled = isAutoHandoffDisabled(process.env);

  if (baton.sessionId) {
    // baton path
    triggeredPath = 'baton';
    const { target: predecessorId } = resolveMergeTarget(db, baton.sessionId);
    mergeResult = mergeSpecificPredecessor(db, {
      newSessionId: session_id,
      predecessorId,
      now,
    });
  } else if (source === 'clear' && !autoDisabled) {
    // auto path: 同 project の最新 Claude unmerged session を自動 predecessor にする
    triggeredPath = 'auto';
    const predRow = findLatestClaudePredecessor(db, projectPath, session_id);
    if (predRow?.session_id) {
      const { target: predecessorId } = resolveMergeTarget(db, predRow.session_id);
      mergeResult = mergeSpecificPredecessor(db, {
        newSessionId: session_id,
        predecessorId,
        now,
      });
    } else {
      mergeResult = { merged: false, skipReason: 'no_predecessor' };
    }
  } else if (source === 'clear' && autoDisabled) {
    triggeredPath = 'auto-disabled';
    mergeResult = { merged: false, skipReason: 'auto_handoff_disabled' };
  }

  logDecision({
    ts: new Date(now).toISOString(),
    source: source ?? null,
    session_id,
    project_path: projectPath,
    triggered_path: triggeredPath,
    auto_handoff_disabled: autoDisabled,
    baton_session_id: baton.sessionId ?? null,
    baton_age_ms: baton.ageMs ?? null,
    baton_skip_reason: baton.skipReason ?? null,
    merged: mergeResult.merged,
    merge_skip_reason: mergeResult.skipReason ?? null,
    predecessor_id: mergeResult.predecessorId ?? null,
  });

  // 4. 合流成立なら curated memory を stdout 注入 (L1 + L2 + L3 refs)
  if (mergeResult.merged) {
    const text = buildResumeContext(db, {
      sessionId: session_id,
      isInheritance: true,
    });
    if (text) {
      process.stdout.write(text + '\n');
    }
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    process.stderr.write(`[session-start] error: ${err.message}\n`);
    process.exit(1);
  });
}
