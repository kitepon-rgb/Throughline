/**
 * resume-context.mjs — 引継ぎ注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (auto path / baton path どちらでも同じ注入)
 *
 * 設計 (docs/02_clear_auto_handoff_plan.md):
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
 * 注入セクションを構造化して組み立てる（内部共通）。
 * buildResumeContext (無制限) と buildBudgetedResumeContext (予算付き) が共有する。
 *
 * @returns {{
 *   header: string,
 *   anchorLines: string[],
 *   l1Lines: string[],
 *   l2Lines: { text: string, time: string }[],
 * } | null}
 */
function buildResumeSections(db, { sessionId, isInheritance, excludeOriginId = null }) {
  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance,
    excludeOriginId,
  });
  if (!record) return null;

  const turnCount = record.stats.preservedContextRows;
  const header = isInheritance ? RESUME_HEADER_TEMPLATE(turnCount) : NORMAL_HEADER;

  const l3ByTurn = groupL3ByTurn(record.references.l3);

  // 現在地アンカー: 引き継ぎ時のみ、最新 user / assistant turn をヘッダ直下に再掲する。
  // L2 末尾アンカーだけだと、長い L2 で注意が前半に固着して話の流れを取り違える事例があった。
  const anchorLines = [];
  if (isInheritance && record.memory.recentBodies.length > 0) {
    const { latestUser, latestAssistant } = pickLatestExchange(record.memory.recentBodies);
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
  }

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

  // ターン内の最終 role 行 (通常 user→assistant 順なら assistant) にだけ suffix を出す。
  // L3 (思考 / ツール / hook 出力 / 画像) は turn_number 単位でしか紐付いていないので
  // 同じターンの user 行と assistant 行の両方に貼ると同じ内容が二度出て紛らわしい。
  const l2Lines = [];
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
    l2Lines.push({ text: `[${r.time}] [${r.role}]: ${r.text}${suffix}`, time: r.time });
  }

  return { header, anchorLines, l1Lines, l2Lines };
}

function joinSections({ header, anchorLines, l1Lines, l2Lines }, { l1Note = null, l2Note = null } = {}) {
  const lines = [header];
  if (anchorLines.length > 0) {
    lines.push('');
    lines.push('### 現在地 (直前のやりとり)');
    lines.push(...anchorLines);
  }
  if (l1Lines.length > 0 || l1Note) {
    lines.push('');
    lines.push('### それ以前の要約 (L1)');
    if (l1Note) lines.push(l1Note);
    lines.push(...l1Lines);
  }
  if (l2Lines.length > 0 || l2Note) {
    lines.push('');
    lines.push('### 直前の対話 (L2 / active work thread, 古い順)');
    if (l2Note) lines.push(l2Note);
    lines.push(...l2Lines.map((l) => l.text));
  }
  return lines.join('\n');
}

/**
 * L1 + L2 注入テキストを組み立てる（サイズ無制限）。L3 は本文ではなく
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
  const sections = buildResumeSections(db, { sessionId, isInheritance, excludeOriginId });
  if (!sections) return null;
  return joinSections(sections);
}

/**
 * hook stdout 注入の予算上限（文字数）。
 *
 * 実測 (2026-07-17, Claude Code 2.1.211 / ADR 0014):
 *   SessionStart / UserPromptSubmit の hook stdout は約 10,000 字を超えると
 *   file 化され、モデル可視は `<persisted-output>`（ファイルパス + 先頭 2KB preview）
 *   だけに劣化する。9,501 字は inline 通過、15,286 字は file 化を確認。
 *   全 transcript 実測では >10k の注入 12 件が 12 件とも劣化していた
 *   (v2.1.195 / 2026-06-28 以降)。安全側マージンとして 9,500 に設定。
 */
export const INJECTION_BUDGET_CHARS = 9_500;

// 予算超過時に注入へ入れる省略告知の予約分（この分を先に差し引いてから詰める）
const OMISSION_NOTE_RESERVE = 200;
// 最新 L2 行が単体で予算を超える場合に、切り詰めてでも入れる最小の残余
const MIN_TRUNCATED_L2_CHARS = 400;

/**
 * 予算付き注入テキスト。優先順位:
 *   1. ヘッダ + 現在地アンカー（常に全文）
 *   2. L1 要約（新しい順に予算まで。落とした分は告知行）
 *   3. L2 本文（新しい順に予算まで詰めて古い順に出力。落とした分は告知行 +
 *      L1 / `throughline detail` への誘導）
 * 予算内に一切 L2 が入らない場合でも、最新 L2 行だけは切り詰めて入れる
 * （現在地の文脈をアンカー 600 字より厚く確保するため）。
 *
 * @returns {{
 *   text: string,
 *   totalChars: number,
 *   droppedL1Rows: number,
 *   droppedL2Rows: number,
 *   truncatedNewestL2: boolean,
 * } | null}
 */
export function buildBudgetedResumeContext(
  db,
  { sessionId, isInheritance, excludeOriginId = null, maxChars = INJECTION_BUDGET_CHARS },
) {
  const sections = buildResumeSections(db, { sessionId, isInheritance, excludeOriginId });
  if (!sections) return null;

  const lineCost = (s) => s.length + 1; // join('\n') 分

  // 固定部 (ヘッダ + アンカー) のコスト。セクション見出し・空行も概算に含める
  const fixedCost =
    lineCost(sections.header) +
    (sections.anchorLines.length > 0
      ? lineCost('') + lineCost('### 現在地 (直前のやりとり)') +
        sections.anchorLines.reduce((a, l) => a + lineCost(l), 0)
      : 0) +
    lineCost('') + lineCost('### それ以前の要約 (L1)') +
    lineCost('') + lineCost('### 直前の対話 (L2 / active work thread, 古い順)');

  let remaining = maxChars - fixedCost - OMISSION_NOTE_RESERVE;

  // L1: 新しい順 (配列末尾) に採用して古い順で出力
  const keptL1 = [];
  let droppedL1Rows = 0;
  for (let i = sections.l1Lines.length - 1; i >= 0; i -= 1) {
    const cost = lineCost(sections.l1Lines[i]);
    if (remaining - cost >= 0) {
      keptL1.unshift(sections.l1Lines[i]);
      remaining -= cost;
    } else {
      droppedL1Rows = i + 1;
      break;
    }
  }

  // L2: 新しい順に採用して古い順で出力
  const keptL2 = [];
  let droppedL2Rows = 0;
  let truncatedNewestL2 = false;
  for (let i = sections.l2Lines.length - 1; i >= 0; i -= 1) {
    const line = sections.l2Lines[i];
    const cost = lineCost(line.text);
    if (remaining - cost >= 0) {
      keptL2.unshift(line);
      remaining -= cost;
      continue;
    }
    // 最新行が単体で入らない場合だけ、切り詰めて確保する
    if (keptL2.length === 0 && remaining >= MIN_TRUNCATED_L2_CHARS) {
      const marker = ` …(予算超過で切詰め; 全文: throughline detail ${line.time})`;
      const keep = remaining - marker.length - 1;
      keptL2.unshift({ ...line, text: line.text.slice(0, keep) + marker });
      remaining = 0;
      truncatedNewestL2 = true;
      droppedL2Rows = i; // これより古い行は全部落ちる
      break;
    }
    droppedL2Rows = i + 1;
    break;
  }

  const l1Note =
    droppedL1Rows > 0
      ? `（注入予算 ${maxChars} 字超過のため古い L1 を ${droppedL1Rows} 行省略）`
      : null;
  const l2Note =
    droppedL2Rows > 0
      ? `（注入予算 ${maxChars} 字超過のため古い L2 を ${droppedL2Rows} 行省略 — ` +
        '上の L1 要約と `throughline detail HH:MM:SS` で参照できます）'
      : null;

  const text = joinSections(
    { header: sections.header, anchorLines: sections.anchorLines, l1Lines: keptL1, l2Lines: keptL2 },
    { l1Note, l2Note },
  );

  return {
    text,
    totalChars: text.length,
    droppedL1Rows,
    droppedL2Rows,
    truncatedNewestL2,
  };
}
