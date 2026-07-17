/**
 * pending-handoff.mjs — 二相ハンドオフの intent 管理 (schema v9 pending_handoffs)
 *
 * 背景 (ADR 0014): Claude Code は同一 project_path に対して短時間 (実測 315–488ms) に
 * 複数の SessionStart hook を発火させることがあり、その一部は transcript を一度も
 * 生成しない「幽霊セッション」になる。SessionStart 時点では payload・DB のどこにも
 * 実体と幽霊を判別する情報が存在しない（transcript ファイルは本物でも hook より
 * 数百 ms 遅れて作られる）。
 *
 * したがって merge / 注入は「実体の証明」= 最初の UserPromptSubmit まで遅延する:
 *   - SessionStart:  registerPendingHandoff で intent を登録するだけ
 *   - 最初の prompt: consumePendingHandoff → baton / auto の順で merge + 注入
 * 幽霊はプロンプトを一度も発火しないため、pending 行が残るだけで記憶を奪えない。
 *
 * pending 行の created_at はセッション誕生時刻として baton TTL 判定の基準
 * (consumeBaton の bornAt) に使う。これにより「/tl からセッション開始までの猶予 1h」
 * という従来の TTL 意味論を、消費が初回プロンプトまで遅れても保存する。
 */

/**
 * SessionStart から呼ぶ。intent を登録する（merge も注入もしない）。
 * resume / compact 由来の SessionStart でも再登録してよい（INSERT OR REPLACE）。
 * その場合 created_at は再開時刻に更新され、従来の「SessionStart 時点で消費」と
 * 同じ適格判定が初回プロンプト時に再現される。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   projectPath: string,
 *   source: string | null,
 *   autoPredecessorId?: string | null,
 *   now?: number,
 * }} params
 */
export function registerPendingHandoff(
  db,
  { sessionId, projectPath, source, autoPredecessorId = null, now = Date.now() },
) {
  db.prepare(
    `INSERT INTO pending_handoffs (session_id, project_path, source, auto_predecessor_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_path = excluded.project_path,
       source = excluded.source,
       auto_predecessor_id = excluded.auto_predecessor_id,
       created_at = excluded.created_at`,
  ).run(sessionId, projectPath, source ?? null, autoPredecessorId ?? null, now);
}

/**
 * UserPromptSubmit から呼ぶ。自セッションの pending 行を atomic に取り出して削除する。
 * 行が無ければ null（= newborn ではない。ハンドオフ判定はしない）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId: string }} params
 * @returns {{
 *   sessionId: string,
 *   projectPath: string,
 *   source: string | null,
 *   autoPredecessorId: string | null,
 *   createdAt: number,
 * } | null}
 */
export function consumePendingHandoff(db, { sessionId }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(
        `SELECT session_id, project_path, source, auto_predecessor_id, created_at
         FROM pending_handoffs WHERE session_id = ?`,
      )
      .get(sessionId);

    if (!row) {
      db.exec('COMMIT');
      return null;
    }

    db.prepare('DELETE FROM pending_handoffs WHERE session_id = ?').run(sessionId);
    db.exec('COMMIT');
    return {
      sessionId: row.session_id,
      projectPath: row.project_path,
      source: row.source ?? null,
      autoPredecessorId: row.auto_predecessor_id ?? null,
      createdAt: row.created_at,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
}
