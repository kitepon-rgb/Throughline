/**
 * resume-context.mjs — 引継ぎ注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (auto path / baton path どちらでも同じ注入)
 *
 * 設計 (docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md):
 *   - 注入順: ヘッダ + Reading Contract → L1 要約 → L2 本文 → L3 refs 一覧 → Continuation Instruction
 *   - 直近 N=20 ターンは bodies から L2 全文を注入
 *   - それ以前は skeletons から L1 要約のみ注入
 *   - L3 references は具体的な `throughline detail <時刻>` コマンドの一覧として注入
 *     (本文は埋め込まず、参照のみ)
 *   - memo / thinking は注入しない (= L2 全文があれば最後の assistant turn 自体に
 *     「次に何をしようとしていたか」が含まれる)
 *   - 各行頭に [HH:MM:SS] 時刻プレフィックス（created_at ベース、DB 永続）
 *   - 現セッションのターンは注入しない（Claude Code 本体のコンテキストに既にあるため）
 *   - フレーミング: 「過去の記憶」ではなく「現在進行中の作業」として読ませる
 *     (Codex 側 renderCodexRolloutMemoryPreview の写像)
 */

import { buildHandoffRecord, formatTime, N_RECENT_L2 } from './handoff-record.mjs';

const RESUME_HEADER_TEMPLATE = (turnCount) =>
  `## Throughline: 中断した作業の再開（${turnCount} ターン分の文脈を保持）\n` +
  `\n` +
  `**前セッションで進行中だった作業を、この新セッションで引き継いでいます。以下が中断時点の状態です:**\n` +
  `- 直近 ${N_RECENT_L2} ターンの会話本文 (L2)\n` +
  `- それ以前の要約 (L1)\n` +
  `- L3 (ツール入出力・思考) の参照一覧 (本文は別途取り出す)\n` +
  `\n` +
  `応答の冒頭でユーザーに「前の作業を ${turnCount} ターン分引き継ぎました」と報告してください。` +
  `作業方針は前セッションのものを踏襲し、中断地点から自然に続行してください。`;

const ACTIVE_WORK_READING_CONTRACT =
  `\n` +
  `**読み方の契約:**\n` +
  `- これは単なる過去ログではなく、現在進行中の作業を再開するための active work context です。\n` +
  `- L2 は古い順に並んだ作業履歴です。後の発言・判断・TODO は前の仮説や作業方針を上書きし得ます。\n` +
  `- すべての L2 行を現在も正しい事実として扱わず、最新の L2 を優先して現在状態を推定してください。\n` +
  `- 不足している tool output / 詳細根拠が必要なときだけ、L3 references の \`throughline detail <時刻>\` を使って取得してください。`;

const CONTINUATION_REMINDER =
  '**再開指示:** 上記の L1 / L2 を、現在タスクに使う作業コンテキストとして扱ってください。' +
  '最新の L2 から次の一手を決め、中断地点から続行してください。' +
  '古い仮説や未完了 TODO は、後続の判断で上書きされ得ます。';

const NORMAL_HEADER = '## Throughline: セッション記憶';

/**
 * L1 + L2 + L3 references 注入テキストを組み立てる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   isInheritance: boolean,
 *   excludeOriginId?: string | null,
 *   inflightMemo?: string | null,  // 互換のため受け取るが新仕様では使用しない
 * }} params
 * @returns {string | null}
 */
export function buildResumeContext(
  db,
  { sessionId, isInheritance, excludeOriginId = null, inflightMemo: _ignoredMemo = null },
) {
  // handoff-record は Codex 側でも使うので signature 維持。inflightMemo / latestThinking は
  // 新仕様の注入テキストには使わない (L2 全文で十分という判断)。
  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
  });
  if (!record) return null;

  const turnCount = record.stats.preservedContextRows;
  const header = isInheritance
    ? RESUME_HEADER_TEMPLATE(turnCount) + ACTIVE_WORK_READING_CONTRACT
    : NORMAL_HEADER;
  const lines = [header];

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

  if (record.references.l3.length > 0) {
    lines.push('');
    lines.push('### L3 詳細参照 (本文は注入されていません)');
    lines.push('必要なときだけ以下のコマンドで取得してください:');
    for (const ref of record.references.l3) {
      const time = formatTime(ref.createdAt);
      lines.push(`- [${time}] ${ref.kind}: \`throughline detail ${time}\``);
    }
  }

  lines.push('');
  lines.push(CONTINUATION_REMINDER);

  return lines.join('\n');
}
