/**
 * resume-context.mjs — L1+L2 の再注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (isInheritance=true, 引き継ぎヘッダ)
 *
 * 新設計（schema v4）:
 *   - 直近 N=20 ターンは bodies から L2 全文を注入
 *   - それ以前は skeletons から L1 要約のみ注入
 *   - 各行頭に [HH:MM:SS] 時刻プレフィックス（bodies.created_at ベース、DB 永続）
 *   - 末尾に /sc-detail <時刻> ガイドを追記
 *   - judgments セクションは廃止
 *   - 現セッションのターンは注入しない（Claude Code 本体のコンテキストに既にあるため）
 */

const N_RECENT_L2 = 20;

const RESUME_HEADER_TEMPLATE = (turnCount) =>
  `## Throughline: セッション記憶（${turnCount} ターン引き継ぎ）\n` +
  `**[Throughline] 前セッションの記憶を引き継ぎました。応答の冒頭で「前の記憶を ${turnCount} ターン引き継ぎました」とユーザーに報告してください。**`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

const FOOTER_GUIDE =
  '---\n' +
  '**[Claude 向け — 記憶の使い方]**\n' +
  '上の L1 要約や L2 本文を読んで「具体的なコマンドやツール出力、ファイル内容を確認したい」と感じたら、' +
  '推測せずに **Bash ツールで `throughline detail <時刻>` を実行** して L3（ツール入出力・hook 出力）を取得してください。\n' +
  '- 単一時刻: `throughline detail 14:23:05`\n' +
  '- 時刻範囲: `throughline detail 14:23-14:30`\n' +
  '\n' +
  '返る内容: 指定ターンの L2 会話本文 + L3（tool_input / tool_output / system 別にグループ化）。\n' +
  'ユーザーに「詳細を見せて」と言われた時だけでなく、**ユーザー発言の文脈が過去ターンに依存しているのに L1/L2 だけでは情報不足だと判断した時**に、Claude 自身の判断で呼び出して構いません。';

/**
 * Unix ms を HH:MM:SS 形式に変換する。
 */
function formatTime(unixMs) {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * 本文を 1 行にまとめる（改行は空白に畳む）。
 */
function flattenText(text) {
  if (!text) return '';
  return text.replace(/\n+/g, ' ').trim();
}

/**
 * L1+L2 注入テキストを組み立てる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId: string, isInheritance: boolean, excludeOriginId?: string | null }} params
 *        sessionId: 合流先 session_id (merge target)
 *        excludeOriginId: 注入対象から除外する origin_session_id（= 現セッションの origin）
 *                         指定すると「前任チェーンのターンのみ」を注入する
 * @returns {string | null}
 */
export function buildResumeContext(db, { sessionId, isInheritance, excludeOriginId = null }) {
  if (!sessionId) return null;

  const hasExclude = Boolean(excludeOriginId);

  // 直近 N 件の bodies を取得
  const bodiesQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, role, text, created_at
       FROM bodies
       WHERE session_id = ? AND origin_session_id != ?
       ORDER BY created_at DESC
       LIMIT ?`
    : `SELECT origin_session_id, turn_number, role, text, created_at
       FROM bodies
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`;

  const limitRows = N_RECENT_L2 * 2; // user/assistant の 2 ロール分

  let bodyRowsDesc = [];
  try {
    bodyRowsDesc = hasExclude
      ? db.prepare(bodiesQuery).all(sessionId, excludeOriginId, limitRows)
      : db.prepare(bodiesQuery).all(sessionId, limitRows);
  } catch {
    // bodies テーブル未作成（v3 DB）の場合は空
    bodyRowsDesc = [];
  }
  const bodyRows = bodyRowsDesc.reverse(); // ASC に戻す

  // 古い側の L1（bodies に既に含まれるターンを除いたもの）を skeletons から取得
  const bodySet = new Set(
    bodyRows.map((r) => `${r.origin_session_id}\x00${r.turn_number}`),
  );

  const skelQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, role, summary, created_at
       FROM skeletons
       WHERE session_id = ? AND origin_session_id != ?
       ORDER BY created_at ASC`
    : `SELECT origin_session_id, turn_number, role, summary, created_at
       FROM skeletons
       WHERE session_id = ?
       ORDER BY created_at ASC`;

  const allSkel = hasExclude
    ? db.prepare(skelQuery).all(sessionId, excludeOriginId)
    : db.prepare(skelQuery).all(sessionId);

  const l1Rows = allSkel.filter(
    (s) => !bodySet.has(`${s.origin_session_id}\x00${s.turn_number}`),
  );

  if (bodyRows.length === 0 && l1Rows.length === 0) {
    return null;
  }

  const turnCount = bodyRows.length + l1Rows.length;
  const header = isInheritance ? RESUME_HEADER_TEMPLATE(turnCount) : NORMAL_HEADER;
  const lines = [header];

  if (l1Rows.length > 0) {
    lines.push('');
    lines.push('### それ以前の要約 (L1)');
    for (const r of l1Rows) {
      if (!r.summary || r.summary === '(no content)') continue;
      lines.push(`[${formatTime(r.created_at)}] ${flattenText(r.summary)}`);
    }
  }

  if (bodyRows.length > 0) {
    lines.push('');
    lines.push('### 直近のターン履歴 (L2)');
    for (const r of bodyRows) {
      if (!r.text) continue;
      lines.push(`[${formatTime(r.created_at)}] [${r.role}]: ${r.text}`);
    }
  }

  lines.push('');
  lines.push(FOOTER_GUIDE);

  return lines.join('\n');
}
