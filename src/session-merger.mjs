/**
 * session-merger.mjs — 記憶張り替え + merged_into チェーン解決
 *
 * 用途:
 *   - SessionStart hook: mergePredecessorInto で前任セッションの L1/L2/L3 を新セッションに張り替える
 *   - Stop / PostToolUse hook: resolveMergeTarget で「入力 session_id → 実書き込み先」を解決
 *
 * 設計背景: docs/SESSION_LINKING_DESIGN.md
 */

const MAX_CHAIN_DEPTH = 10;

/**
 * merged_into チェーンを辿って最終的な書き込み先 session_id を解決する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {{ target: string, origin: string }}
 *   target: 実書き込み先 session_id（合流先）
 *   origin: 入力 session_id そのもの（INSERT 時の origin_session_id に使う）
 */
export function resolveMergeTarget(db, sessionId) {
  const origin = sessionId;
  const seen = new Set();
  let current = sessionId;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (seen.has(current)) {
      throw new Error(`[session-merger] merge chain cycle detected at ${current}`);
    }
    seen.add(current);

    const row = db
      .prepare('SELECT merged_into FROM sessions WHERE session_id = ?')
      .get(current);

    if (!row || row.merged_into === null || row.merged_into === undefined) {
      return { target: current, origin };
    }
    current = row.merged_into;
  }

  throw new Error(
    `[session-merger] merge chain depth exceeded ${MAX_CHAIN_DEPTH} from ${sessionId}`,
  );
}

/**
 * 同一プロジェクト内の最新非合流セッションを新セッションに張り替える。
 *
 * 実行順序（BEGIN IMMEDIATE トランザクション内）:
 *   1. 前任候補 SELECT（同 project_path, session_id != new, merged_into IS NULL, 最新 updated_at）
 *   2. skeletons / judgments / details の session_id を new に UPDATE
 *   3. 前任 sessions.merged_into = new
 *   4. 新セッション sessions.updated_at = now
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ newSessionId: string, projectPath: string }} params
 * @returns {{ merged: boolean, predecessorId?: string, rowCounts?: { sk: number, jg: number, dt: number } }}
 */
export function mergePredecessorInto(db, { newSessionId, projectPath }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const pred = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE lower(project_path) = lower(?)
           AND session_id != ?
           AND merged_into IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(projectPath, newSessionId);

    if (!pred) {
      db.exec('COMMIT');
      return { merged: false };
    }

    const predecessorId = pred.session_id;

    const sk = db
      .prepare('UPDATE skeletons SET session_id = ? WHERE session_id = ?')
      .run(newSessionId, predecessorId);
    const jg = db
      .prepare('UPDATE judgments SET session_id = ? WHERE session_id = ?')
      .run(newSessionId, predecessorId);
    const dt = db
      .prepare('UPDATE details SET session_id = ? WHERE session_id = ?')
      .run(newSessionId, predecessorId);

    db.prepare('UPDATE sessions SET merged_into = ? WHERE session_id = ?').run(
      newSessionId,
      predecessorId,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(
      Date.now(),
      newSessionId,
    );

    db.exec('COMMIT');
    return {
      merged: true,
      predecessorId,
      rowCounts: { sk: sk.changes, jg: jg.changes, dt: dt.changes },
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
