/**
 * baton.mjs — 引き継ぎバトン管理
 *
 * バトン方式の設計 (docs/02_clear_auto_handoff_plan.md):
 *   - 新仕様では `/clear` 自動引継ぎがデフォルト ON。バトンは「/clear 自動引継ぎを
 *     使わずに明示的に引き継ぎたい」ユーザーのための逃げ道。
 *   - ユーザーが旧セッションで `/tl` スラッシュコマンドを打つ → UserPromptSubmit hook が
 *     baton テーブルに (project_path, session_id, created_at) を INSERT OR REPLACE
 *   - 新セッションの SessionStart hook が baton を atomic に消費 (BEGIN IMMEDIATE 内で
 *     SELECT + DELETE)。TTL 1 時間以内なら前任として merge、超過は破棄。
 *   - 注入する curated memory は L1 + L2 + L3 refs のみ (memo / thinking なし)。
 *
 * 履歴: もともと VSCode 拡張で SessionStart payload の source が /clear 後も
 *       "startup" に潰される問題 (#49937) に対する明示意思マーカーとして導入。
 *       2026-05-08 時点で Claude Code 2.1.128 で source='clear' は reliable に
 *       なったため auto path 中心の設計に変わったが、明示意思の signal として
 *       baton 仕組み自体は残す。詳細は docs/02_clear_auto_handoff_plan.md。
 */

/**
 * バトン TTL (ミリ秒)。ユーザーが /tl を打ってから新セッション開始までの猶予。
 * 超過したバトンは consumeBaton で破棄される（merge されない）。
 */
export const BATON_TTL_MS = 60 * 60 * 1000; // 1 時間

/**
 * 現在セッション (= /tl を発動したセッション) を次回 SessionStart で merge 対象に指名する。
 * 同 project_path の既存バトンがあれば session_id / created_at を上書き。
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
 * 同 project_path のバトンを読み出して削除する (atomic)。
 *
 * 適格性は `bornAt`（= 消費者セッションの誕生時刻）基準で判定する:
 *   age = bornAt - baton.created_at
 *   - age < 0     : バトンは消費者セッションより後に書かれた（本来の後継は
 *                   その後に生まれる別セッション）→ **消さずに残し** skip。
 *                   二相ハンドオフでは消費が最初のプロンプト時点まで遅延するため、
 *                   「自分より後に書かれたバトン」を走行中セッションが横取りしない
 *                   ためのガード。
 *   - age > ttlMs : TTL 超過。従来どおり削除して破棄。
 *   - それ以外    : 削除して sessionId を返す。
 * `bornAt` 省略時は now と同値（= 従来の SessionStart 即時消費と同じ判定）。
 *
 * 戻り値:
 *   - { sessionId, ageMs }                                    : バトン存在 かつ適格
 *   - { sessionId: null, skipReason: 'expired', ageMs }       : TTL 超過で破棄
 *   - { sessionId: null, skipReason: 'future_baton', ageMs }  : 消費者誕生より後の
 *                                                               バトン（残置）
 *   - { sessionId: null, skipReason: 'missing' }              : バトン無し
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ projectPath: string, now?: number, bornAt?: number, ttlMs?: number }} params
 * @returns {{ sessionId: string | null, ageMs?: number, skipReason?: 'expired' | 'missing' | 'future_baton' }}
 */
export function consumeBaton(db, { projectPath, now = Date.now(), bornAt = now, ttlMs = BATON_TTL_MS }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Windows 互換: ドライブレターの大小差を吸収するため COLLATE NOCASE
    const row = db
      .prepare(
        `SELECT session_id, created_at FROM handoff_batons WHERE project_path = ? COLLATE NOCASE`,
      )
      .get(projectPath);

    if (!row) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'missing' };
    }

    const ageMs = bornAt - row.created_at;

    if (ageMs < 0) {
      // 消費者より未来のバトンは本来の後継のために残す（削除しない）
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'future_baton', ageMs };
    }

    db.prepare('DELETE FROM handoff_batons WHERE project_path = ? COLLATE NOCASE').run(
      projectPath,
    );

    if (ageMs > ttlMs) {
      db.exec('COMMIT');
      return { sessionId: null, skipReason: 'expired', ageMs };
    }

    db.exec('COMMIT');
    return {
      sessionId: row.session_id,
      ageMs,
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
