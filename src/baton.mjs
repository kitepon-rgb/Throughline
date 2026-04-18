/**
 * baton.mjs — 引き継ぎバトン管理
 *
 * バトン方式の設計 (docs/INHERITANCE_ON_CLEAR_ONLY.md):
 *   - ユーザーが旧セッションで /tl スラッシュコマンドを打つ → UserPromptSubmit hook が
 *     baton テーブルに (project_path, session_id, created_at) を INSERT OR REPLACE
 *   - 新セッションの SessionStart hook が baton を消費:
 *     TTL 1 時間以内 かつ session_id が自分自身でない → 前任として merge
 *     期限切れ or 自己指名 → 破棄
 *   - 消費は atomic (BEGIN IMMEDIATE トランザクション内で SELECT + DELETE)
 *
 * なぜバトン方式か:
 *   - VSCode 拡張では SessionStart payload の source が /clear 後も "startup" に潰される
 *     ため source 値だけで /clear を識別できない (GitHub issue #49937)
 *   - 時間差ヒューリスティック (案 D) は誤爆の可能性があり、ユーザー明示の意思表示を
 *     引き継ぎ発火の唯一の条件とする方が決定論的
 */

/**
 * バトン TTL (ミリ秒)。ユーザーが /tl を打ってから新セッション開始までの猶予。
 * 超過したバトンは consumeBaton で破棄される（merge されない）。
 */
export const BATON_TTL_MS = 60 * 60 * 1000; // 1 時間

/**
 * 現在セッション (= /tl を発動したセッション) を次回 SessionStart で merge 対象に指名する。
 * 同 project_path の既存バトンは上書きされる (INSERT OR REPLACE)。最新意図のみ有効。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, sessionId: string, now?: number }} params
 */
export function writeBaton(db, { projectPath, sessionId, now = Date.now() }) {
  db.prepare(
    `INSERT OR REPLACE INTO handoff_batons (project_path, session_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(projectPath, sessionId, now);
}

/**
 * 同 project_path のバトンを読み出して削除する (atomic)。
 *
 * 戻り値:
 *   - { sessionId, ageMs }   : バトン存在 かつ TTL 以内
 *   - { sessionId: null, skipReason: 'expired', ageMs }  : TTL 超過で破棄
 *   - { sessionId: null, skipReason: 'missing' }          : バトン無し
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, now?: number, ttlMs?: number }} params
 * @returns {{ sessionId: string | null, ageMs?: number, skipReason?: 'expired' | 'missing' }}
 */
export function consumeBaton(db, { projectPath, now = Date.now(), ttlMs = BATON_TTL_MS }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(
        `SELECT session_id, created_at FROM handoff_batons WHERE project_path = ?`,
      )
      .get(projectPath);

    if (!row) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'missing' };
    }

    db.prepare('DELETE FROM handoff_batons WHERE project_path = ?').run(projectPath);
    const ageMs = now - row.created_at;

    if (ageMs > ttlMs) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'expired', ageMs };
    }

    db.exec('COMMIT');
    return { sessionId: row.session_id, ageMs };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
}
