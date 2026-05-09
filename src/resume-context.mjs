/**
 * resume-context.mjs — 引継ぎ注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (auto path / baton path どちらでも同じ注入)
 *
 * 設計 (docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md):
 *   - 注入順: ヘッダ + 読み方 → L1 要約 → L2 本文（一番下）
 *   - 直前の発話に Claude の attention が向くよう、L2 を末尾に置く
 *   - L3 は別セクションを設けず、対応する L1 / L2 行にインラインで
 *     `[→ throughline detail HH:MM:SS (kind …)]` ヒントを付ける
 *   - L2 全文があれば最後の assistant turn 自体に「次に何をしようとしていたか」が
 *     含まれるため、memo / thinking / 末尾の再開指示は注入しない
 *   - 各行頭に [HH:MM:SS] 時刻プレフィックス（L2 は body の created_at、
 *     L1 は元ターンの body 時刻が取れればそれ、なければ skeleton 時刻）
 *   - 現セッションのターンは注入しない（Claude Code 本体のコンテキストに既にあるため）
 *   - フレーミング: 「報告してください」のメタ命令は出さない。直前の対話の
 *     自然な続きとして応答させる
 */

import { buildHandoffRecord } from './handoff-record.mjs';
import { groupL3ByTurn, buildPartsSummary } from './l3-summary.mjs';

const RESUME_HEADER_TEMPLATE = (turnCount) =>
  `## Throughline: 中断した作業の再開（${turnCount} ターン分の文脈を保持）\n` +
  `\n` +
  `**読み方:**\n` +
  `- 直前の対話の自然な続きとして応答してください。\n` +
  '- **各ターンの詳細の取得方法**: **`Bash` ツールで `throughline detail HH:MM:SS` を実行** ' +
  `(該当ターンの本文＋詳細を stdout に返します)`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

/**
 * L1 + L2 注入テキストを組み立てる。L3 は本文ではなく
 * 各 L1 / L2 行末尾の inline hint として付与する。
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
  { sessionId, isInheritance, excludeOriginId = null, inflightMemo: _ignoredMemo = null },
) {
  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
  });
  if (!record) return null;

  const turnCount = record.stats.preservedContextRows;
  const header = isInheritance ? RESUME_HEADER_TEMPLATE(turnCount) : NORMAL_HEADER;
  const lines = [header];

  const l3ByTurn = groupL3ByTurn(record.references.l3);

  if (record.memory.l1Summaries.length > 0) {
    const l1Lines = [];
    for (const r of record.memory.l1Summaries) {
      if (!r.summary || r.summary === '(no content)') continue;
      const summary = r.summary.replace(/\n+/g, ' ').trim();
      const key = `${r.originSessionId}\x00${r.turnNumber}`;

      // body 時刻が引けた行だけ詳細呼び出しを案内する。引けない場合は
      // `[skeleton 時刻]` のままだと throughline detail が解決しないので suffix を出さない。
      const displayTime = r.bodyTime ?? r.time;
      const partCounts = l3ByTurn.get(key)?.partCounts ?? new Map();
      const suffix = r.bodyTime != null
        ? buildPartsSummary(partCounts, { includeBody: true })
        : '';

      l1Lines.push(`[${displayTime}] ${summary}${suffix}`);
    }
    if (l1Lines.length > 0) {
      lines.push('');
      lines.push('### それ以前の要約 (L1)');
      lines.push(...l1Lines);
    }
  }

  if (record.memory.recentBodies.length > 0) {
    lines.push('');
    lines.push('### 直前の対話 (L2 / active work thread, 古い順)');

    // ターン内の最終 role 行 (通常 user→assistant 順なら assistant) にだけ suffix を出す。
    // L3 (思考 / ツール / hook 出力 / 画像) は turn_number 単位でしか紐付いていないので
    // 同じターンの user 行と assistant 行の両方に貼ると同じ内容が二度出て紛らわしい。
    const lastIdxPerTurn = new Map();
    for (let i = 0; i < record.memory.recentBodies.length; i += 1) {
      const r = record.memory.recentBodies[i];
      if (!r.text) continue;
      const key = `${r.originSessionId}\x00${r.turnNumber}`;
      lastIdxPerTurn.set(key, i);
    }

    for (let i = 0; i < record.memory.recentBodies.length; i += 1) {
      const r = record.memory.recentBodies[i];
      if (!r.text) continue;
      const key = `${r.originSessionId}\x00${r.turnNumber}`;
      const isLastOfTurn = lastIdxPerTurn.get(key) === i;
      const partCounts = isLastOfTurn ? (l3ByTurn.get(key)?.partCounts ?? new Map()) : new Map();
      const suffix = buildPartsSummary(partCounts);
      lines.push(`[${r.time}] [${r.role}]: ${r.text}${suffix}`);
    }
  }

  return lines.join('\n');
}
