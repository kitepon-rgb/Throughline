/**
 * session-merger.mjs — 記憶張り替え + merged_into チェーン解決
 *
 * 用途:
 *   - SessionStart hook: バトンで指名された旧セッションを mergeSpecificPredecessor で新セッションに張り替え
 *   - Stop hook: resolveMergeTarget で「入力 session_id → 実書き込み先」を解決
 *
 * 設計背景: docs/SESSION_LINKING_DESIGN.md, docs/INHERITANCE_ON_CLEAR_ONLY.md (バトン方式採用)
 *
 * 旧実装 (案 D: 時間差ヒューリスティック / 自動前任選択) は撤去済み。
 * 引き継ぎはユーザーが /tl を打って書いたバトンによる明示的指名のみで発火する。
 */

const MAX_CHAIN_DEPTH = 10;

/**
 * merged_into チェーンを辿って最終的な書き込み先 session_id を解決する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {{ target: string, origin: string }}
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
 * バトンで指名された特定の旧セッションを新セッションに張り替える。
 *
 * 実行順序（BEGIN IMMEDIATE トランザクション内）:
 *   1. 前任の妥当性チェック（存在する / 自分自身ではない / 既に合流済みでない / created_at が古い）
 *   2. skeletons / details / bodies の session_id を new に UPDATE
 *   3. 前任 sessions.merged_into = new
 *   4. 新セッション sessions.updated_at = now
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ newSessionId: string, predecessorId: string, now?: number }} params
 * @returns {{
 *   merged: boolean,
 *   predecessorId?: string,
 *   rowCounts?: { sk: number, dt: number, bd: number },
 *   skipReason?: 'self_handoff' | 'predecessor_not_found' | 'already_merged' | 'predecessor_not_older',
 * }}
 */
export function mergeSpecificPredecessor(db, { newSessionId, predecessorId, now = Date.now() }) {
  if (newSessionId === predecessorId) {
    return { merged: false, skipReason: 'self_handoff' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const pred = db
      .prepare('SELECT session_id, created_at, merged_into FROM sessions WHERE session_id = ?')
      .get(predecessorId);

    if (!pred) {
      db.exec('COMMIT');
      return { merged: false, skipReason: 'predecessor_not_found' };
    }
    if (pred.merged_into) {
      db.exec('COMMIT');
      return { merged: false, skipReason: 'already_merged' };
    }

    const self = db
      .prepare('SELECT created_at FROM sessions WHERE session_id = ?')
      .get(newSessionId);

    // 時系列単調制約: 前任は新セッションより created_at が古いこと。
    // バトンが自分より新しい session を指していたら（異常データ）merge しない。
    if (self && pred.created_at >= self.created_at) {
      db.exec('COMMIT');
      return { merged: false, skipReason: 'predecessor_not_older' };
    }

    const sk = db
      .prepare('UPDATE skeletons SET session_id = ? WHERE session_id = ?')
      .run(newSessionId, predecessorId);
    const dt = db
      .prepare('UPDATE details SET session_id = ? WHERE session_id = ?')
      .run(newSessionId, predecessorId);
    let bd = { changes: 0 };
    try {
      bd = db
        .prepare('UPDATE bodies SET session_id = ? WHERE session_id = ?')
        .run(newSessionId, predecessorId);
    } catch (err) {
      if (!/no such table/i.test(err.message || '')) throw err;
    }

    db.prepare('UPDATE sessions SET merged_into = ? WHERE session_id = ?').run(
      newSessionId,
      predecessorId,
    );
    db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(
      now,
      newSessionId,
    );

    db.exec('COMMIT');
    return {
      merged: true,
      predecessorId,
      rowCounts: { sk: sk.changes, dt: dt.changes, bd: bd.changes },
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
