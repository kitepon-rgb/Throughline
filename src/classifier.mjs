/**
 * classifier.mjs — ヒューリスティック L2 分類器
 *
 * ツール実行結果やターン内容から L2 カテゴリを判定する。
 * LLM 不使用（トークンゼロ）。
 *
 * カテゴリ:
 *   DECISION   — 技術的な決定（「〜に決めた」「〜を採用」「〜を使う」）
 *   CONSTRAINT — 禁止・制限（「〜は使えない」「〜禁止」「〜に失敗」）
 *   IMPL       — 完了済み作業（Write/Edit ツール、「実装済み」「完了」）
 *   ISSUE      — バグ・未解決（exit code ≠ 0、「エラー」「失敗」「TODO」）
 *   CONTEXT    — 背景・要件（その他）
 */

import { createHash } from 'crypto';

// ---- 判定パターン ----

const DECISION_PATTERNS = [
  /に決めた|を採用|を選択|を使う|を使用する|ことにした|方針:/i,
  /\bDECISION\b(?![\/:])|decided|choosing|adopted/i,
  /設計思想|アーキテクチャ|方式:/,
];

const CONSTRAINT_PATTERNS = [
  /は使えない|使用不可|禁止|制限|対応していない|できない/,
  /CONSTRAINT|forbidden|prohibited|not allowed|blocked/i,
  /エラー.*失敗|失敗.*エラー/,
  /ポート.*使用不可|FW制限|ファイアウォール/,
];

// アシスタントテキスト向け IMPL パターン（厳格版）
// 単なる「完了」「全通過」では反応しない。「〇〇を実装/追加/作成した」型の完了宣言のみ。
const IMPL_PATTERNS = [
  /を(実装|作成|追加|修正|更新)(した|しました|済み|完了)/,
  /実装済み|更新済み|追加済み|作成済み/,
  /IMPL:|implemented:|✅.{0,40}(完了|done|実装|稼働|済み)/i,
];

const ISSUE_PATTERNS = [
  /TODO|FIXME|HACK|XXX/,
  /バグ|エラー|失敗|問題|不具合|要確認|要修正|動いていない|動かない|機能していない/,
  // 英語パターン（ISSUE 単語は除外 — 自己言及テキストで誤検知が多い）
  /\bbug\b|error|failed|broken|investigate/i,
];

/**
 * ISSUE 否定パターン — これらが含まれる場合は解決済み・過去の話として ISSUE 判定を抑制する。
 * アシスタントのテキスト分類時のみ使用。
 */
const ISSUE_NEGATION_PATTERNS = [
  /修正(済み|した|しました|完了)|解決(済み|した|しました|完了)|直した/,
  /fixed|resolved|solved|patched/i,
  // 「〜が失敗していたが、修正した」のような "問題 + 解決完了" を一文で述べるパターン
  // 注意: 「解決」単体は不可（「解決していない」が誤マッチするため）。完了形のみ許可。
  /(失敗|エラー|問題|バグ|不具合).{0,40}(修正済み|修正した|修正しました|解決済み|解決した|解決しました|直した|fixed)/,
  /(修正済み|修正した|修正しました|解決済み|解決した|解決しました|直した|fixed).{0,40}(失敗|エラー|問題|バグ|不具合)/,
  // 「仮説だったが否定された」「そうではなかった」系
  /ではありません(でした)?|ではなかった|そうではない|でした(?:が|。)|ことがわかりました/,
  // 「〜という仮説・懸念」—実際には起きていないことを示す
  /仮説|懸念|かもしれない(?:が|と思)|と思われた(?:が|。)/,
  // 「〇〇をチェック/確認/調査します」— 問題の報告ではなく調査行為
  /(?:問題|課題|エラー|バグ).{0,15}(?:をチェック|を確認|を調査|を検討|を整理)/,
  // 「バグです。修正します。」— 問題を宣言して同ターンで対処を表明（アクション済み扱い）
  /(?:バグ|エラー|問題|不具合).{0,30}(?:修正します|解決します|直します|対応します|修正する)/,
  // 「〜が失敗するため/なので/から」— 失敗が理由節として使われている（決定の根拠）
  /(?:失敗|エラー|問題|不具合).{0,20}(?:ため|ので|から)(?:、|。|\s)/,
];

/**
 * 過去文脈パターン — 過去の出来事を説明している段落を示す。
 * アシスタントのテキスト分類時のみ使用。
 */
const PAST_CONTEXT_PATTERNS = [
  /ていた(?:が|ため|ので|から|[。、])/,  // 「失敗していたが」「出ていたため」
  /だった(?:が|ため|ので|から|[。、])/,  // 「問題だったが」
  /(?:以前|前回|過去|旧|当初)(?:は|に|の)/,  // 「以前は」「前回は」
  /原因は|理由は|なぜなら|というのも/,   // 説明口調
  /により(?:失敗|エラー|問題)/,          // 「〜により失敗していた」（原因説明）
  /^(?:なお|補足|ちなみに)[、:：]/,      // 補足・注記
  /^(?:確認|検証|スパイク|テスト)(?:した|の結果|により|で)/,  // 確認作業の報告
];

// ---- ツール名ベースの分類 ----

/** @param {string} toolName */
function classifyByTool(toolName) {
  if (['Write', 'Edit'].includes(toolName)) return 'IMPL';
  return null;
}

// ---- テキストベースの分類 ----

/** @param {string} text */
function classifyByText(text) {
  if (!text) return 'CONTEXT';
  for (const p of ISSUE_PATTERNS) if (p.test(text)) return 'ISSUE';
  for (const p of DECISION_PATTERNS) if (p.test(text)) return 'DECISION';
  for (const p of CONSTRAINT_PATTERNS) if (p.test(text)) return 'CONSTRAINT';
  for (const p of IMPL_PATTERNS) if (p.test(text)) return 'IMPL';
  return 'CONTEXT';
}

/**
 * アシスタントテキストの段落に特化した分類。
 * ISSUE 判定を厳格化：否定・過去文脈パターンがあれば ISSUE にしない。
 * @param {string} text
 * @returns {string} カテゴリ
 */
function classifyAssistantParagraph(text) {
  if (!text) return 'CONTEXT';

  const looksLikeIssue = ISSUE_PATTERNS.some((p) => p.test(text));
  if (looksLikeIssue) {
    // 解決済みまたは過去文脈なら ISSUE に昇格しない
    const isResolved = ISSUE_NEGATION_PATTERNS.some((p) => p.test(text));
    const isPastContext = PAST_CONTEXT_PATTERNS.some((p) => p.test(text));
    if (isResolved || isPastContext) {
      // ISSUE 以外のカテゴリで再判定（解決済みなら IMPL 扱いになることもある）
      for (const p of IMPL_PATTERNS) if (p.test(text)) return 'IMPL';
      for (const p of DECISION_PATTERNS) if (p.test(text)) return 'DECISION';
      return 'CONTEXT';
    }
    return 'ISSUE';
  }

  for (const p of DECISION_PATTERNS) if (p.test(text)) return 'DECISION';
  for (const p of CONSTRAINT_PATTERNS) if (p.test(text)) return 'CONSTRAINT';
  for (const p of IMPL_PATTERNS) if (p.test(text)) return 'IMPL';
  return 'CONTEXT';
}

// ---- 公開 API ----

/**
 * ツール実行結果から L2 判断を生成する。
 *
 * @param {{
 *   toolName: string,
 *   inputText: string,
 *   outputText: string,
 *   exitCode?: number
 * }} params
 * @returns {{category: string, content: string, contentHash: string} | null}
 *   null を返す場合は記録不要（CONTEXT で内容が薄い）
 */
export function classifyToolResult({ toolName, inputText, outputText, exitCode }) {
  // exit code ≠ 0 → ISSUE 確定
  if (exitCode != null && exitCode !== 0) {
    const content = `[${toolName}] exit_code=${exitCode}: ${truncate(inputText, 100)}`;
    return { category: 'ISSUE', content, contentHash: hash(content) };
  }

  const toolCategory = classifyByTool(toolName);
  if (toolCategory === 'IMPL') {
    const content = `${truncate(inputText, 120)} → 完了`;
    return { category: 'IMPL', content, contentHash: hash(content) };
  }

  // 出力テキストで判定
  const textCategory = classifyByText(outputText || inputText);
  if (textCategory === 'CONTEXT') return null; // 記録不要

  const content = truncate(outputText || inputText, 150);
  return { category: textCategory, content, contentHash: hash(content) };
}

/**
 * アシスタントの応答テキストから L2 判断を抽出する。
 *
 * @param {string} assistantText
 * @returns {Array<{category: string, content: string, contentHash: string}>}
 */
export function classifyAssistantText(assistantText) {
  if (!assistantText) return [];

  const results = [];
  // 段落ごとに分類
  const paragraphs = assistantText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  for (const para of paragraphs.slice(0, 10)) { // 最初の10段落のみ
    const category = classifyAssistantParagraph(para);
    if (category === 'CONTEXT') continue;

    const content = truncate(para, 150);
    const ch = hash(content);
    results.push({ category, content, contentHash: ch });
  }

  return results;
}

// ---- ユーティリティ ----

function truncate(text, maxLen) {
  if (!text) return '';
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + '...';
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
