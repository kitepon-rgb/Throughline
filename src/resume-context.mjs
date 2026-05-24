/**
 * resume-context.mjs — 引継ぎ注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (auto path / baton path どちらでも同じ注入)
 *
 * 設計 (docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md):
 *   - 注入順: ヘッダ + 読み方 → 現在地アンカー → L1 要約 → L2 本文（一番下）
 *   - 「現在地」アンカーは直前の user / assistant turn をヘッダ直下に再掲して
 *     最初の注意を最新ターンに固定する。L2 末尾アンカーは補強として残す。
 *     （L2 が長くなると末尾アンカーだけでは前半の古いターンに注意が固着し、
 *      話の流れを取り違える事例があった）
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
  `## Throughline: 直前スレッドの継続応答用コンテキスト（${turnCount} ターン分の文脈を保持）\n` +
  `\n` +
  `**応答の冒頭で必ず以下を 1 行宣言してください** (会話の継続性をユーザーに見せるため):\n` +
  `> 「Throughline で前のセッションから ${turnCount} ターン分の記憶を引き継いだ状態で続けます」\n` +
  `\n` +
  `**読み方 (重要):**\n` +
  `- 下記「現在地」「L1」「L2」は **あなた自身が直前にユーザーと交わした会話** です ` +
  `(画面が /clear されただけで、同じスレッドが継続しています)。\n` +
  `- ユーザーの次のメッセージは新規依頼ではなく、上記スレッドの **続き** です。\n` +
  `- 「続きよろしく」「OK」「次は？」のような短いメッセージは、**「現在地」の「直前のアシスタント」` +
  `が示した次の一手をそのまま実行** してください。\n` +
  `- **短文/相槌の判定**: 50 字以下、または「はい」「うん」「了解」「OK」「やって」「進めて」「続き」` +
  `「次」のような相槌/同意/促し語だけで構成されているメッセージは、新しい依頼ではなく ` +
  `**直前のアシスタントの提案に対する GO サイン** として扱ってください。\n` +
  `- 短文を受けたら **やってはいけないこと**: 「何の話ですか?」と聞き返す / 改めて選択肢を提示しなおす / ` +
  `直前のアシスタントが示した次の一手を無視して別の作業を始める。\n` +
  `- **古い番号リストの再実行禁止**: 過去ターンで提示した番号付き選択肢 (例: 1/2/3) を最新ユーザーが ` +
  `「2 をやれ」のように参照した場合、その項目が既に直前アシスタントターンで実装/実行済みなら、` +
  `再実行ではなく **結果確認・次の一手** として応答してください ` +
  `(最新アシスタント発話の指示が、過去ターンのリストへの参照より上位)。\n` +
  `- 「何のことですか？」「初めまして」「何を確認したいですか?」と返すのは適切ではありません ` +
  `(新規会話ではない)。\n` +
  '- **各ターンの詳細**: **`Bash` ツールで `throughline detail HH:MM:SS` を実行** ' +
  `(該当ターンの本文＋詳細を stdout に返します)`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

// 現在地アンカーは最新 user / assistant 本文を再掲する。長すぎると注入全体が膨らむので
// この文字数で打ち切り、全文は L2 セクション側を参照させる。
const ANCHOR_MAX_CHARS = 600;

function truncateForAnchor(text) {
  const normalized = text.replace(/\n+/g, ' ').trim();
  if (normalized.length <= ANCHOR_MAX_CHARS) return normalized;
  return normalized.slice(0, ANCHOR_MAX_CHARS) + ' …';
}

/**
 * recentBodies (古い順) から「直前のやりとり」アンカー用に
 * 最新の user / assistant 行をそれぞれ 1 件ずつ拾う。
 */
function pickLatestExchange(recentBodies) {
  let latestUser = null;
  let latestAssistant = null;
  for (let i = recentBodies.length - 1; i >= 0; i -= 1) {
    const r = recentBodies[i];
    if (!r.text) continue;
    if (r.role === 'assistant' && !latestAssistant) {
      latestAssistant = r;
    } else if (r.role === 'user' && !latestUser) {
      latestUser = r;
    }
    if (latestUser && latestAssistant) break;
  }
  return { latestUser, latestAssistant };
}

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

  // 現在地アンカー: 引き継ぎ時のみ、最新 user / assistant turn をヘッダ直下に再掲する。
  // L2 末尾アンカーだけだと、長い L2 で注意が前半に固着して話の流れを取り違える事例があった。
  if (isInheritance && record.memory.recentBodies.length > 0) {
    const { latestUser, latestAssistant } = pickLatestExchange(record.memory.recentBodies);
    const anchorLines = [];
    if (latestUser) {
      anchorLines.push(
        `**最新ユーザー指示** [${latestUser.time}]: ${truncateForAnchor(latestUser.text)}`,
      );
    }
    if (latestAssistant) {
      anchorLines.push(
        `**直前のアシスタント** [${latestAssistant.time}]: ${truncateForAnchor(latestAssistant.text)}`,
      );
    }
    if (anchorLines.length > 0) {
      lines.push('');
      lines.push('### 現在地 (直前のやりとり)');
      lines.push(...anchorLines);
    }
  }

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
