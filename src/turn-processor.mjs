#!/usr/bin/env node
/**
 * Stop hook — L1 要約生成 + L2 本文保存 + turn_number 確定
 *
 * stdin: { session_id, transcript_path }
 * 処理:
 *   0. 【再帰ガード】環境変数 THROUGHLINE_IN_HAIKU_SUBPROCESS=1 が立っていたら即 exit
 *      （Haiku 要約用の claude -p subprocess 内で自分自身の Stop hook として起動された場合）
 *   1. resolveMergeTarget で「実書き込み先 (target) / origin」を解決
 *      （input session が別セッションに合流済みなら合流先に書く）
 *   2. 最後の assistant ターン + 直前の user ターンのペアを取得
 *   3. L2 本文 (bodies) に user / assistant の 2 行を INSERT
 *   4. 【遅延要約】target 配下の bodies ターン数 (distinct origin×turn) が
 *      WINDOW (=20) を超えていたら、最古の未要約ターンを 1 件だけ
 *      Haiku 4.5 で要約 → skeletons (L1) に INSERT。
 *      20 ターン以内で作業が終わるケースでは Haiku コスト 0。
 *      /clear 跨ぎでも同様に、合流後のターン総数が 20 超えた時点から逐次発火。
 *      失敗時は L2 全文をそのまま L1 に入れる（情報欠損ゼロ）
 *   5. turn_number=NULL の details レコードを確定 (L3)
 *
 * schema v4 以降で動作。judgments テーブルは廃止済み。
 */

// ★★★ 再帰暴走ガード ★★★
// haiku-summarizer が spawn する claude -p は独立した Claude Code セッションで、
// 同じ .claude/settings.json を読んで自分の Stop hook を起動する。放置すると
// turn-processor → claude -p → turn-processor → claude -p → ... の無限再帰で
// 大量の node プロセスが生まれ API 500 を引き起こす。
// haiku-summarizer が spawn 時に env.THROUGHLINE_IN_HAIKU_SUBPROCESS=1 を設定するので
// ここで即検出して exit する。env は child_process.spawn で継承される。
if (process.env.THROUGHLINE_IN_HAIKU_SUBPROCESS === '1') {
  process.exit(0);
}

import { getDb } from './db.mjs';
import {
  getLastTurnPair,
  readRawEntries,
  sliceCurrentTurnEntries,
  extractDetailBlocks,
} from './transcript-reader.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { writeSessionState } from './state-file.mjs';
import { summarizeToL1 } from './haiku-summarizer.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';

/** 直近 N ターンは bodies を生で残し、それより古いものだけ L1 要約する。 */
export const L2_WINDOW = 20;

/**
 * target 配下の distinct (origin_session_id, turn_number) ターン数を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} target
 */
export function countDistinctBodyTurns(db, target) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT origin_session_id, turn_number
         FROM bodies
         WHERE session_id = ?
       )`,
    )
    .get(target);
  return row?.c ?? 0;
}

/**
 * bodies に存在し skeletons に未登録の最古ターンを 1 件返す。
 * 遅延要約のターゲット選択に使う。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} target
 * @returns {{ origin_session_id: string, turn_number: number, created_at: number } | null}
 */
export function pickOldestUnsummarizedTurn(db, target) {
  const row = db
    .prepare(
      `SELECT b.origin_session_id, b.turn_number, MIN(b.created_at) AS created_at
       FROM bodies b
       WHERE b.session_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM skeletons s
           WHERE s.session_id = b.session_id
             AND s.origin_session_id = b.origin_session_id
             AND s.turn_number = b.turn_number
         )
       GROUP BY b.origin_session_id, b.turn_number
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(target);
  return row ?? null;
}

/**
 * user と assistant のペアを結合して L2 要約用テキストを作る。
 * @param {{content: string} | null} userTurn
 * @param {{content: string} | null} assistantTurn
 * @returns {string}
 */
function buildL2ForSummary(userTurn, assistantTurn) {
  const parts = [];
  if (userTurn?.content) parts.push(`[user]: ${userTurn.content}`);
  if (assistantTurn?.content) parts.push(`[assistant]: ${assistantTurn.content}`);
  return parts.join('\n\n');
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

  // VSCode で開かれたプロジェクトに .vscode/tasks.json を自動プロビジョニングする。
  // 2 回目以降は冪等性チェックで即 return するので毎ターン走っても安全。
  // 失敗しても主処理は継続させるため try/catch でラップ。
  try {
    ensureMonitorTaskFile({ cwd, env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  // Stop hook 時点で state ファイルを更新 → token-monitor の「アクティブ行」判定が
  // アシスタント応答終了時刻まで追従する
  writeSessionState({
    sessionId: session_id,
    projectPath: cwd ?? process.cwd(),
    transcriptPath: transcript_path ?? null,
    pid: process.ppid,
  });

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
    ).run(target, cwd ?? process.cwd(), now, now);
  } else {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(now, target);
  }

  // 最後の assistant ターン + 直前の user ターンを取得
  const { user: userTurn, assistant: assistantTurn } = getLastTurnPair(transcript_path);
  if (!assistantTurn) {
    // /clear 直後などでトランスクリプトが空の場合は何もしない
    process.exit(0);
  }

  const turnNumber = assistantTurn.turn_number;

  // L2 = bodies に user / assistant を個別行で保存
  const insertBody = db.prepare(
    `INSERT OR IGNORE INTO bodies
       (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // user / assistant を「1 往復 = 1 ターン」として扱うため、同じ turn_number
  // （= assistant 側の turn_number）でペアリングして保存する。
  // これにより bodies と skeletons が同じ turn_number で突合できる。
  if (userTurn?.content) {
    insertBody.run(
      target,
      origin,
      turnNumber,
      'user',
      userTurn.content,
      Math.round(userTurn.content.length / 4),
      now,
    );
  }
  if (assistantTurn?.content) {
    insertBody.run(
      target,
      origin,
      turnNumber,
      'assistant',
      assistantTurn.content,
      Math.round(assistantTurn.content.length / 4),
      now,
    );
  }

  // L1 = 遅延要約。target 配下の bodies ターン数 (distinct origin×turn) が
  // WINDOW を超えていたら、最古の未要約ターンを 1 件だけ要約する。
  // 20 ターン以内で終わる作業では Haiku コストゼロ。
  if (countDistinctBodyTurns(db, target) > L2_WINDOW) {
    const oldest = pickOldestUnsummarizedTurn(db, target);
    if (oldest) {
      const rows = db
        .prepare(
          `SELECT role, text FROM bodies
           WHERE session_id = ? AND origin_session_id = ? AND turn_number = ?`,
        )
        .all(target, oldest.origin_session_id, oldest.turn_number);
      const userRow = rows.find((r) => r.role === 'user');
      const asstRow = rows.find((r) => r.role === 'assistant');
      const l2ForSummary = buildL2ForSummary(
        userRow ? { content: userRow.text } : null,
        asstRow ? { content: asstRow.text } : null,
      );
      const { summary } = summarizeToL1(l2ForSummary);

      db.prepare(
        `INSERT OR IGNORE INTO skeletons
           (session_id, origin_session_id, turn_number, role, summary, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      ).run(
        target,
        oldest.origin_session_id,
        oldest.turn_number,
        summary,
        oldest.created_at,
      );
    }
  }

  // L3 = transcript から tool_use / tool_result / attachment (hook) を抽出して details に INSERT
  // extractDetailBlocks はこの論理ターンの範囲のみをスキャンする。再実行時は
  // source_id ベースの UNIQUE 制約で冪等性を確保（INSERT OR IGNORE）。
  const allEntries = transcript_path ? readRawEntries(transcript_path) : [];
  const turnEntries = sliceCurrentTurnEntries(allEntries);
  const detailBlocks = extractDetailBlocks(turnEntries);

  if (detailBlocks.length > 0) {
    const insertDetail = db.prepare(
      `INSERT OR IGNORE INTO details
         (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
          token_count, created_at, kind, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 数百行の INSERT を 1 トランザクションにまとめて fsync コストを 1 回に抑える
    db.exec('BEGIN');
    try {
      for (const d of detailBlocks) {
        const tokenCount = Math.round(
          ((d.input_text?.length ?? 0) + (d.output_text?.length ?? 0)) / 4,
        );
        insertDetail.run(
          target,
          origin,
          turnNumber,
          d.tool_name,
          d.input_text,
          d.output_text,
          tokenCount,
          now,
          d.kind,
          d.source_id,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[turn-processor] error: ${msg}\n`);
  process.exit(1);
});
