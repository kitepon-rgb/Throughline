#!/usr/bin/env node
/**
 * SessionStart hook — セッション登録 + バトン消費 + 引き継ぎ注入
 *
 * stdin: { session_id, source, cwd, transcript_path, hook_event_name }
 *
 * 【引き継ぎ条件 (バトン方式)】
 *   ユーザーが旧セッションで /tl スラッシュコマンドを打つと UserPromptSubmit hook が
 *   baton テーブルに session_id を書き込む。本 SessionStart hook はそれを TTL 1 時間以内
 *   なら消費して merge + 引き継ぎヘッダ付き L1+L2 を stdout 注入する。
 *   バトンが無ければ / 期限切れなら何も引き継がない（docs/INHERITANCE_ON_CLEAR_ONLY.md 参照）。
 *
 * 役割:
 *   1. sessions テーブルに新セッションを INSERT OR IGNORE
 *   2. バトン消費 + 指名された前任を merge (session-merger.mjs)
 *   3. 合流成立なら L1+L2 を「引き継ぎヘッダ」付きで stdout 注入
 *   4. 判定結果を ~/.throughline/logs/inheritance-decision.log に記録
 */

import { getDb } from './db.mjs';
import { consumeBaton } from './baton.mjs';
import { mergeSpecificPredecessor, resolveMergeTarget } from './session-merger.mjs';
import { buildResumeContext } from './resume-context.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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

async function main() {
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

  // 1. sessions テーブルに INSERT OR IGNORE
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(session_id, projectPath, now, now);

  // 2. バトン消費
  const baton = consumeBaton(db, { projectPath, now });

  let mergeResult = { merged: false, skipReason: 'no_baton' };
  if (baton.sessionId) {
    // バトンが指す session が既に他と merge 済みなら、その合流先末端を前任とする
    const { target: predecessorId } = resolveMergeTarget(db, baton.sessionId);
    mergeResult = mergeSpecificPredecessor(db, {
      newSessionId: session_id,
      predecessorId,
      now,
    });
  }

  logDecision({
    ts: new Date(now).toISOString(),
    source: source ?? null,
    session_id,
    project_path: projectPath,
    baton_session_id: baton.sessionId ?? null,
    baton_age_ms: baton.ageMs ?? null,
    baton_skip_reason: baton.skipReason ?? null,
    merged: mergeResult.merged,
    merge_skip_reason: mergeResult.skipReason ?? null,
    predecessor_id: mergeResult.predecessorId ?? null,
  });

  // 3. 合流成立なら引き継ぎヘッダ付きで注入
  if (mergeResult.merged) {
    const text = buildResumeContext(db, { sessionId: session_id, isInheritance: true });
    if (text) {
      process.stdout.write(text + '\n');
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[session-start] error: ${err.message}\n`);
  process.exit(1);
});
