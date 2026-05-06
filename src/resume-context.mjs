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
 *   - フレーミングを「過去の記憶」から「中断した作業の再開」に変更する。
 *     冒頭と末尾の両方に current-work instruction を置き、長文 context 内でも
 *     L1/L2 を現在タスク用の作業文脈として読むよう誘導する。
 */

import { buildHandoffRecord, N_RECENT_L2 } from './handoff-record.mjs';

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

const ACTIVE_WORK_READING_CONTRACT =
  `\n` +
  `**読み方の契約:**\n` +
  `- これは単なる過去ログではなく、現在進行中の作業を再開するための active work context です。\n` +
  `- L2 は古い順に並んだ作業履歴です。後の発言・判断・TODO は前の仮説や作業方針を上書きし得ます。\n` +
  `- すべての L2 行を現在も正しい事実として扱わず、最新の L2、in-flight メモ、最終ターン thinking を優先して現在状態を推定してください。\n` +
  `- 不足している tool output / 詳細根拠が必要なときだけ、末尾の \`throughline detail <時刻>\` を使って L3 を取得してください。`;

const CONTINUATION_REMINDER =
  '**再開指示:** 上記の L1 / L2 / thinking / in-flight メモを、現在タスクに使う作業コンテキストとして扱ってください。' +
  '最新の L2、in-flight メモ、最終ターン thinking から次の一手を決め、中断地点から続行してください。' +
  '古い仮説や未完了 TODO は、後続の判断で上書きされ得ます。';

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
  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
    inflightMemo,
  });
  if (!record) return null;

  const turnCount = record.stats.preservedContextRows;
  const header = isInheritance
    ? RESUME_HEADER_TEMPLATE(turnCount) + ACTIVE_WORK_READING_CONTRACT
    : NORMAL_HEADER;
  const lines = [header];

  if (record.memory.inflightMemo) {
    lines.push('');
    lines.push('### 中断直前の in-flight メモ（前セッションの Claude 自身による要約）');
    lines.push(record.memory.inflightMemo);
  }

  if (record.memory.latestThinking.length > 0) {
    lines.push('');
    lines.push('### 中断直前の思考 (最終ターンの extended thinking)');
    for (const r of record.memory.latestThinking) {
      lines.push(`[${r.time}] ${r.text}`);
    }
  }

  if (record.memory.l1Summaries.length > 0) {
    lines.push('');
    lines.push('### それ以前の要約 (L1)');
    for (const r of record.memory.l1Summaries) {
      if (!r.summary || r.summary === '(no content)') continue;
      lines.push(`[${r.time}] ${r.summary.replace(/\n+/g, ' ').trim()}`);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    lines.push('');
    lines.push('### 現在進行中の作業履歴 (L2 / active work thread)');
    lines.push('以下は古い順です。後の行ほど現在状態に近く、前の仮説を上書きし得ます。');
    for (const r of record.memory.recentBodies) {
      if (!r.text) continue;
      lines.push(`[${r.time}] [${r.role}]: ${r.text}`);
    }
  }

  lines.push('');
  lines.push(FOOTER_GUIDE);
  lines.push('');
  lines.push(CONTINUATION_REMINDER);

  return lines.join('\n');
}
