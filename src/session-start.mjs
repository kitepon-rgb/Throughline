#!/usr/bin/env node
/**
 * SessionStart hook — セッション登録 + 前任記憶の張り替え + 引き継ぎ注入
 *
 * stdin: { session_id, source, cwd, transcript_path, hook_event_name }
 *
 * 【実機確認 (2026-04-15)】
 *   SessionStart は /clear 後も source="startup" で発火する。
 *   (Windows + VSCode 拡張では source="clear" は来ないが hook 自体は発火)
 *   source に依存せず、毎回「前任の張り替え候補」を探して合流させる。
 *
 * 役割:
 *   1. sessions テーブルに新セッションを INSERT OR IGNORE
 *   2. 同プロジェクト内の最新非合流セッションを新セッションに張り替え (session-merger)
 *   3. 合流成立なら L1+L2 を「引き継ぎヘッダ」付きで stdout 注入
 */

import { getDb } from './db.mjs';
import { mergePredecessorInto } from './session-merger.mjs';
import { buildResumeContext } from './resume-context.mjs';

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
  const { session_id, cwd } = payload;

  if (!session_id) throw new Error('Missing session_id in SessionStart payload');

  const projectPath = cwd ?? process.cwd();
  const db = getDb();
  const now = Date.now();

  // 1. sessions テーブルに INSERT OR IGNORE
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(session_id, projectPath, now, now);

  // 2. 前任の張り替え
  const mergeResult = mergePredecessorInto(db, {
    newSessionId: session_id,
    projectPath,
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
