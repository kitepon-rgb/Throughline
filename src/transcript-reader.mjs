/**
 * transcript-reader.mjs
 * Claude Code のトランスクリプト JSONL を解析するモジュール。
 *
 * 実際のフォーマット（確認済み）:
 *   {type: "user",      message: {role: "user",      content: [{type:"text", text:"..."}]}, ...}
 *   {type: "assistant", message: {role: "assistant", content: [{type:"text", text:"..."}, {type:"thinking", ...}]}, ...}
 *   他に queue-operation, attachment, file-history-snapshot 等があるが無視する
 */

import { readFileSync, existsSync } from 'fs';

/**
 * content 配列からテキスト部分だけを結合する。
 * thinking ブロックは除外。
 * @param {unknown} content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return String(content ?? '');
}

/**
 * トランスクリプト JSONL ファイルを読んで全ターンを返す。
 * @param {string} transcriptPath
 * @returns {Array<{role: string, content: string, turn_number: number}>}
 */
export function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  // existsSync で早期 return 済み。ここでの read 失敗は権限エラー等の本物の異常なので throw させる (§0 ルール)
  const raw = readFileSync(transcriptPath, 'utf8');

  const turns = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // user / assistant エントリのみ対象
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const msg = entry.message;
    if (!msg || !msg.role || msg.content == null) continue;

    const text = extractText(msg.content);
    if (!text) continue;

    turns.push({
      role: msg.role,
      content: text,
      turn_number: turns.length,
    });
  }

  return turns;
}

/**
 * ANSI エスケープシーケンスを除去する。
 * ツール出力（特に Bash）にしばしば含まれる色コードを剥がす。
 * @param {string} s
 */
export function stripAnsi(s) {
  if (typeof s !== 'string') return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * tool_result の content フィールドを単一テキストに正規化する。
 * 実際のフォーマット:
 *   - string: そのまま
 *   - Array<{type:"text", text:string} | {type:"image", ...}>: text を結合、
 *     image は `[image]` プレースホルダ
 * @param {unknown} content
 * @returns {string}
 */
export function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b && b.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * transcript JSONL を 1 行ずつ解析して、生エントリ配列を返す。
 * 未知 type や parse 失敗は skip（§0 ルール: 上位で扱う）。
 *
 * @param {string} transcriptPath
 * @returns {Array<object>}
 */
export function readRawEntries(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const raw = readFileSync(transcriptPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 末尾 partial-write は JSONL 仕様上の許容
      continue;
    }
  }
  return entries;
}

/**
 * 現在の「論理ターン」を構成するエントリ範囲を切り出す。
 * 定義: 最後の assistant text ブロック (= Stop 時点の Claude 最終応答) を含むターン
 *       = 1 つ前の user text エントリの次から、最後の assistant エントリまで。
 *
 * 論理ターンの構造:
 *   user(text)                 ← このターンの開始
 *   assistant(thinking + tool_use)
 *   user(tool_result)
 *   assistant(text)            ← このターンの終わり
 *
 * 間にある attachment / system エントリも同範囲に含める。
 *
 * @param {Array<object>} entries readRawEntries の結果
 * @returns {Array<object>} 論理ターンに属するエントリのスライス
 */
export function sliceCurrentTurnEntries(entries) {
  if (!entries.length) return [];

  // 最後の assistant text ブロックを含むエントリを探す
  let lastAssistantTextIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const blocks = e.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)) {
      lastAssistantTextIdx = i;
      break;
    }
  }
  if (lastAssistantTextIdx < 0) return [];

  // そこから遡って、最後の user text ブロックを含むエントリを探す
  let userTextIdx = -1;
  for (let i = lastAssistantTextIdx - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;
    const blocks = e.message?.content;
    if (Array.isArray(blocks)) {
      if (blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)) {
        userTextIdx = i;
        break;
      }
    } else if (typeof blocks === 'string' && blocks.length > 0) {
      userTextIdx = i;
      break;
    }
  }
  if (userTextIdx < 0) return [];

  return entries.slice(userTextIdx, lastAssistantTextIdx + 1);
}

/**
 * 論理ターン内の全エントリから L3 (details) 用の生レコードを抽出する。
 *
 * 返す各レコード:
 *   {
 *     kind: 'tool_input' | 'tool_output' | 'system',
 *     tool_name: string,       // 表示用。system は 'SystemReminder' 等
 *     source_id: string,       // 冪等再処理キー (tool_use.id / tool_use_id / uuid)
 *     input_text: string | null,
 *     output_text: string | null,
 *   }
 *
 * 分類ルール:
 *   - assistant の tool_use ブロック → tool_input (name, input を JSON 化して input_text に)
 *   - user の tool_result ブロック → tool_output (content を output_text に、ANSI 剥離)
 *   - assistant/user の thinking ブロック → 破棄
 *   - assistant/user の text ブロック → 扱わない（L2 bodies 側の責務）
 *   - attachment entry (hook_success) → system (hookName + content を出力に)
 *   - system entry (stop_hook_summary) → skip（hook タイミング情報で意味なし）
 *   - image ブロック → placeholder で kind='image'
 *
 * @param {Array<object>} turnEntries sliceCurrentTurnEntries の結果
 * @returns {Array<{kind: string, tool_name: string, source_id: string, input_text: string|null, output_text: string|null}>}
 */
export function extractDetailBlocks(turnEntries) {
  const out = [];
  // tool_use の name を後で tool_result にも添付するためのマップ
  const toolNameById = new Map();

  for (const e of turnEntries) {
    if (e.type === 'assistant') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || !b.type) continue;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolNameById.set(b.id, b.name ?? 'unknown');
          out.push({
            kind: 'tool_input',
            tool_name: b.name ?? 'unknown',
            source_id: b.id,
            input_text: JSON.stringify(b.input ?? null),
            output_text: null,
          });
        } else if (b.type === 'image') {
          out.push({
            kind: 'image',
            tool_name: 'image',
            source_id: null,
            input_text: null,
            output_text: '[image]',
          });
        }
        // text / thinking は扱わない
      }
    } else if (e.type === 'user') {
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || !b.type) continue;
        if (b.type === 'tool_result') {
          const toolUseId = b.tool_use_id ?? null;
          const toolName = toolUseId && toolNameById.has(toolUseId)
            ? toolNameById.get(toolUseId)
            : 'unknown';
          const rawOutput = normalizeToolResultContent(b.content);
          out.push({
            kind: 'tool_output',
            tool_name: toolName,
            source_id: toolUseId ? `${toolUseId}:result` : null,
            input_text: null,
            output_text: stripAnsi(rawOutput),
          });
        } else if (b.type === 'image') {
          out.push({
            kind: 'image',
            tool_name: 'image',
            source_id: null,
            input_text: null,
            output_text: '[image]',
          });
        }
        // text は扱わない
      }
    } else if (e.type === 'attachment') {
      // hook 実行結果。SessionStart/UserPromptSubmit 等の hook stdout が格納される
      const a = e.attachment;
      if (!a) continue;
      if (a.type === 'hook_success') {
        const content = a.content ?? a.stdout ?? '';
        out.push({
          kind: 'system',
          tool_name: `hook:${a.hookEvent ?? a.hookName ?? 'unknown'}`,
          source_id: e.uuid ?? null,
          input_text: a.command ?? null,
          output_text: stripAnsi(String(content)),
        });
      }
      // 他の attachment 種別は現状対象外
    }
    // type === 'system' (stop_hook_summary) や queue-operation / file-history-snapshot は skip
  }

  return out;
}

/**
 * 最後のターン（最後の user または assistant メッセージ）を返す。
 * @param {string} transcriptPath
 * @returns {{role: string, content: string, turn_number: number} | null}
 */
export function getLastTurn(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

/**
 * 最後の assistant ターンだけを返す。
 * @param {string} transcriptPath
 * @returns {{role: string, content: string, turn_number: number} | null}
 */
export function getLastAssistantTurn(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') return turns[i];
  }
  return null;
}

/**
 * 最後の assistant ターンと、それに対応する直前の user ターンをペアで返す。
 * Stop フックで L2 (bodies) に 1 往復分を保存するために使う。
 *
 * user メッセージには tool_result のような合成メッセージも混じるが、
 * readTranscript() は text ブロックだけを抽出しているので、text が
 * 空の user メッセージは自動的に除外されている（= tool_result のみの行は弾かれる）。
 *
 * @param {string} transcriptPath
 * @returns {{
 *   user: {role: string, content: string, turn_number: number} | null,
 *   assistant: {role: string, content: string, turn_number: number} | null
 * }}
 */
export function getLastTurnPair(transcriptPath) {
  const turns = readTranscript(transcriptPath);
  let assistantIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return { user: null, assistant: null };

  // assistant の直前の user ターンを探す
  let userTurn = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      userTurn = turns[i];
      break;
    }
  }

  return { user: userTurn, assistant: turns[assistantIdx] };
}
