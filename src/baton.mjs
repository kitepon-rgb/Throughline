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
 * 同 project_path の既存バトンがあれば session_id / created_at のみ上書き。
 * v7 で追加された memo_text は保持する（連続した /tl → save-inflight の順番で
 * 呼ばれた場合に、再度 /tl を打った時点で古い memo が消えないようにする）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, sessionId: string, now?: number }} params
 */
export function writeBaton(db, { projectPath, sessionId, now = Date.now() }) {
  db.prepare(
    `INSERT INTO handoff_batons (project_path, session_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_path) DO UPDATE SET
       session_id = excluded.session_id,
       created_at = excluded.created_at`,
  ).run(projectPath, sessionId, now);
}

/**
 * 既存バトンの memo_text を更新する。バトンが存在しない場合は NOOP。
 * /tl 発動後、現行セッションの Claude が `throughline save-inflight` CLI 経由で
 * 呼び出す。memo_text は Markdown 形式の「次の一手 / 現在の方針 / 未解決 /
 * 進行中 TODO」をまとめたテキスト。
 *
 * Windows 互換: ドライブレター（`C:` / `c:`）やパス区切りの差異で
 * /tl 書き込み時と save-inflight 呼び出し時の project_path が一致しない
 * ケースがあるため、SQLite の COLLATE NOCASE で大小無視で照合する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, memoText: string, now?: number }} params
 * @returns {{ updated: boolean }}
 */
export function updateBatonMemo(db, { projectPath, memoText }) {
  const result = db
    .prepare(
      `UPDATE handoff_batons SET memo_text = ? WHERE project_path = ? COLLATE NOCASE`,
    )
    .run(memoText, projectPath);
  return { updated: (result.changes ?? 0) > 0 };
}

/**
 * 同 project_path のバトンを読み出して削除する (atomic)。
 *
 * 戻り値:
 *   - { sessionId, ageMs, memoText }   : バトン存在 かつ TTL 以内
 *   - { sessionId: null, skipReason: 'expired', ageMs }  : TTL 超過で破棄
 *   - { sessionId: null, skipReason: 'missing' }          : バトン無し
 *
 * memoText は /tl 後に save-inflight で書き込まれた in-flight メモ。
 * 未保存なら null。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, now?: number, ttlMs?: number }} params
 * @returns {{ sessionId: string | null, ageMs?: number, memoText?: string | null, skipReason?: 'expired' | 'missing' }}
 */
export function consumeBaton(db, { projectPath, now = Date.now(), ttlMs = BATON_TTL_MS }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Windows 互換: ドライブレターの大小差を吸収するため COLLATE NOCASE
    const row = db
      .prepare(
        `SELECT session_id, created_at, memo_text FROM handoff_batons WHERE project_path = ? COLLATE NOCASE`,
      )
      .get(projectPath);

    if (!row) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'missing' };
    }

    db.prepare('DELETE FROM handoff_batons WHERE project_path = ? COLLATE NOCASE').run(
      projectPath,
    );
    const ageMs = now - row.created_at;

    if (ageMs > ttlMs) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'expired', ageMs };
    }

    db.exec('COMMIT');
    return {
      sessionId: row.session_id,
      ageMs,
      memoText: row.memo_text ?? null,
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
