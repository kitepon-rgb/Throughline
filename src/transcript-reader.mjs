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
