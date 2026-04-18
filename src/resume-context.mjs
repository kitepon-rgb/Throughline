/**
 * resume-context.mjs — 中断地点からの再開注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (isInheritance=true, 引き継ぎヘッダ)
 *
 * 設計（schema v7 対応）:
 *   - 注入順: ヘッダ → [in-flight メモ] → [中断直前の思考] → L1 要約 → L2 本文 → フッタ
 *   - in-flight メモ: /tl 発動時に現行 Claude が書いた「次の一手 / 方針 / 未解決 / TODO」
 *   - 中断直前の思考: 最終ターンの assistant extended thinking (details kind='thinking')
 *   - 直近 N=20 ターンは bodies から L2 全文を注入
 *   - それ以前は skeletons から L1 要約のみ注入
 *   - 各行頭に [HH:MM:SS] 時刻プレフィックス（created_at ベース、DB 永続）
 *   - 末尾に /sc-detail <時刻> ガイドを追記
 *   - 現セッションのターンは注入しない（Claude Code 本体のコンテキストに既にあるため）
 *   - フレーミングを「過去の記憶」から「中断した作業の再開」に変更 (B 案)
 */

const N_RECENT_L2 = 20;

const RESUME_HEADER_TEMPLATE = (turnCount) =>
  `## Throughline: 中断した作業の再開（${turnCount} ターン分の文脈を保持）\n` +
  `\n` +
  `**前セッションで進行中だった作業を、この新セッションで引き継いでいます。以下が中断時点の状態です:**\n` +
  `- 中断直前の in-flight メモ（前セッション末尾で Claude 自身が書いた「次の一手・方針・未解決・TODO」）\n` +
  `- 中断直前の思考 (最終ターンの extended thinking)\n` +
  `- 直近 ${N_RECENT_L2} ターンの会話本文 (L2)\n` +
  `- それ以前の要約 (L1)\n` +
  `\n` +
  `応答の冒頭でユーザーに「前の作業を ${turnCount} ターン分引き継ぎました」と報告してください。` +
  `作業方針は前セッションのものを踏襲し、中断地点から自然に続行してください。`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

const FOOTER_GUIDE =
  '---\n' +
  '**[Claude 向け — 記憶の使い方]**\n' +
  '上の L1 要約や L2 本文を読んで「具体的なコマンドやツール出力、ファイル内容を確認したい」と感じたら、' +
  '推測せずに **Bash ツールで `throughline detail <時刻>` を実行** して L3（ツール入出力・hook 出力・thinking）を取得してください。\n' +
  '- 単一時刻: `throughline detail 14:23:05`\n' +
  '- 時刻範囲: `throughline detail 14:23-14:30`\n' +
  '\n' +
  '返る内容: 指定ターンの L2 会話本文 + L3（tool_input / tool_output / system / thinking 別にグループ化）。\n' +
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
 * 最新ターン番号 (= 中断直前) の thinking ブロックを details から取り出す。
 * origin 除外がある場合はそれも考慮する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {string | null} excludeOriginId
 * @returns {Array<{ output_text: string, created_at: number }>}
 */
function loadLatestThinking(db, sessionId, excludeOriginId) {
  const hasExclude = Boolean(excludeOriginId);

  // 最新 (origin_session_id, turn_number) を bodies から特定
  const latestQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, created_at
       FROM bodies
       WHERE session_id = ? AND origin_session_id != ? AND role = 'assistant'
       ORDER BY created_at DESC
       LIMIT 1`
    : `SELECT origin_session_id, turn_number, created_at
       FROM bodies
       WHERE session_id = ? AND role = 'assistant'
       ORDER BY created_at DESC
       LIMIT 1`;

  let latest;
  try {
    latest = hasExclude
      ? db.prepare(latestQuery).get(sessionId, excludeOriginId)
      : db.prepare(latestQuery).get(sessionId);
  } catch {
    return [];
  }
  if (!latest) return [];

  // その (origin_session_id, turn_number) に紐づく kind='thinking' を取り出す
  try {
    const rows = db
      .prepare(
        `SELECT output_text, created_at FROM details
         WHERE session_id = ? AND origin_session_id = ? AND turn_number = ? AND kind = 'thinking'
         ORDER BY created_at ASC`,
      )
      .all(sessionId, latest.origin_session_id, latest.turn_number);
    return rows.filter((r) => typeof r.output_text === 'string' && r.output_text.length > 0);
  } catch {
    return [];
  }
}

/**
 * L1+L2 注入テキストを組み立てる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   isInheritance: boolean,
 *   excludeOriginId?: string | null,
 *   inflightMemo?: string | null,
 * }} params
 * @returns {string | null}
 */
export function buildResumeContext(
  db,
  { sessionId, isInheritance, excludeOriginId = null, inflightMemo = null },
) {
  if (!sessionId) return null;

  const hasExclude = Boolean(excludeOriginId);

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

  // 古い側の L1（bodies に既に含まれるターンを除いたもの）
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

  const thinkingRows = loadLatestThinking(db, sessionId, excludeOriginId);

  if (
    bodyRows.length === 0 &&
    l1Rows.length === 0 &&
    thinkingRows.length === 0 &&
    !inflightMemo
  ) {
    return null;
  }

  const turnCount = bodyRows.length + l1Rows.length;
  const header = isInheritance ? RESUME_HEADER_TEMPLATE(turnCount) : NORMAL_HEADER;
  const lines = [header];

  if (inflightMemo && inflightMemo.trim().length > 0) {
    lines.push('');
    lines.push('### 中断直前の in-flight メモ（前セッションの Claude 自身による要約）');
    lines.push(inflightMemo.trim());
  }

  if (thinkingRows.length > 0) {
    lines.push('');
    lines.push('### 中断直前の思考 (最終ターンの extended thinking)');
    for (const r of thinkingRows) {
      lines.push(`[${formatTime(r.created_at)}] ${r.output_text}`);
    }
  }

  if (l1Rows.length > 0) {
    lines.push('');
    lines.push('### それ以前の要約 (L1)');
    for (const r of l1Rows) {
      if (!r.summary || r.summary === '(no content)') continue;
      lines.push(`[${formatTime(r.created_at)}] ${r.summary.replace(/\n+/g, ' ').trim()}`);
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
