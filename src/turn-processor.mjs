#!/usr/bin/env node
/**
 * Stop hook — L1 サマリ生成 + L2 分類 + turn_number 確定
 *
 * stdin: { session_id, transcript_path }
 * 処理:
 *   1. resolveMergeTarget で「実書き込み先 (target) / origin」を解決
 *      （input session が別セッションに合流済みなら合流先に書く）
 *   2. 最後の assistant ターンを取得
 *   3. L1 サマリをヒューリスティックで生成 → skeletons (target, origin)
 *   4. L2 判断をヒューリスティックで抽出 → judgments (target, origin)（重複排除）
 *   5. details の turn_number を確定 (target, origin で絞り込み)
 */

import { getDb } from './db.mjs';
import { getLastAssistantTurn } from './transcript-reader.mjs';
import { classifyAssistantText } from './classifier.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { writeSessionState } from './state-file.mjs';

function buildSummary(content) {
  if (!content) return '(no content)';
  const oneline = content.replace(/\n+/g, ' ').trim();
  return oneline.length <= 200 ? oneline : oneline.slice(0, 197) + '...';
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

  const payload = JSON.parse(raw || '{}');

  const { session_id, transcript_path, cwd } = payload;
  if (!session_id) throw new Error('Missing session_id in Stop payload');

  // Stop hook 時点で state ファイルを更新 → token-monitor の「アクティブ行」判定が
  // アシスタント応答終了時刻まで追従する（§4.5/4.6 設計判断）
  writeSessionState({
    sessionId: session_id,
    projectPath: cwd ?? process.cwd(),
    transcriptPath: transcript_path ?? null,
    pid: process.ppid,
  });

  {
    const db = getDb();
    const now = Date.now();

    // merge target 解決: 入力 session が既に合流済みなら target = 合流先
    const { target, origin } = resolveMergeTarget(db, session_id);

    // target の sessions 行を upsert
    const existing = db
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get(target);
    if (!existing) {
      db.prepare(
        `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      ).run(target, process.cwd(), now, now);
    } else {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(
        now,
        target,
      );
    }

    // 最後の assistant ターンを取得
    const lastTurn = getLastAssistantTurn(transcript_path);
    if (!lastTurn) {
      // /clear 直後などでトランスクリプトが空の場合は何もしない
      process.exit(0);
    }
    const turnNumber = lastTurn.turn_number;
    const content = lastTurn.content;
    const summary = buildSummary(content);

    // L1 を skeletons テーブルに保存（重複しないよう IGNORE）
    db.prepare(
      `INSERT OR IGNORE INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?)`,
    ).run(target, origin, turnNumber, summary, now);

    // L2 を judgments テーブルに保存（content_hash で重複排除）
    const judgments = classifyAssistantText(content);
    const insertJudgment = db.prepare(
      `INSERT OR IGNORE INTO judgments
         (session_id, origin_session_id, turn_number, category, content, content_hash, resolved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    for (const j of judgments) {
      insertJudgment.run(target, origin, turnNumber, j.category, j.content, j.contentHash, now);
    }

    // turn_number=NULL の details レコードを確定（origin で絞り、他 origin の残留 NULL を誤埋めしない）
    db.prepare(
      `UPDATE details SET turn_number = ?
       WHERE session_id = ? AND origin_session_id = ? AND turn_number IS NULL`,
    ).run(turnNumber, target, origin);

    // 30日以上経った resolved=1 の judgments を削除（DB 定期クリーンアップ）
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM judgments WHERE resolved = 1 AND created_at < ?`).run(cutoff);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[turn-processor] error: ${err.message}\n`);
  process.exit(1);
});
