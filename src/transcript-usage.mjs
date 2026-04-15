/**
 * transcript-usage.mjs — Transcript JSONL の最新 assistant エントリから
 * Anthropic API の実測 usage を抽出する（length/4 ヒューリスティックを置き換え）
 *
 * 各 assistant エントリの構造:
 *   {
 *     type: "assistant",
 *     message: {
 *       model: "claude-opus-4-6[1m]",
 *       usage: {
 *         input_tokens: 1234,
 *         cache_creation_input_tokens: 567,
 *         cache_read_input_tokens: 890,
 *         output_tokens: 42
 *       }
 *     }
 *   }
 *
 * 現在の context 使用量 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * これは API が「このリクエストに投入された文脈サイズ」として返す実測値。
 *
 * 差分読みキャッシュ:
 *   path → { size, lastUsage, lastModel, lastReadAt }
 *   次回呼び出し時、size が不変ならキャッシュ値を返す。
 *   変化していれば全読みして末尾の assistant usage を更新。
 *   (差分 byte offset 読みは将来最適化。まずは全読みで正確性優先)
 */

import { readFileSync, statSync, existsSync } from 'node:fs';

/**
 * @typedef {Object} UsageSample
 * @property {number} tokens - 文脈使用量 (input + cache_creation + cache_read)
 * @property {string} model - モデル名 (e.g. "claude-opus-4-6[1m]")
 * @property {number} contextWindowSize - 推定コンテキスト上限 (200_000 or 1_000_000)
 * @property {number} outputTokens - output_tokens (参考)
 */

/**
 * モデル名 + 実測トークン数から context_window_size を推論する。
 *
 * 注意: Claude Code の transcript JSONL の `message.model` は base name のみで
 * `[1m]` サフィックスが含まれない（実測確認済み 2026-04-15）。slug/entrypoint/version にも
 * 1M コンテキスト識別子は無い。そのため純粋なモデル名推論では 1M セッションを検出できない。
 * 対策: 実測トークン数が 200k を超えていたら 1M コンテキストとみなす（事後検出）。
 *
 * @param {string} model
 * @param {number} [observedTokens=0]
 * @returns {number}
 */
export function inferContextWindowSize(model, observedTokens = 0) {
  // 明示的な [1m] サフィックスがあれば即 1M
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  // 事後検出: 200k を超えているなら 1M コンテキスト確定
  if (observedTokens > 200_000) return 1_000_000;
  return 200_000;
}

/** @type {Map<string, {size: number, sample: UsageSample|null}>} */
const cache = new Map();

/**
 * transcript JSONL から最新の assistant usage を抽出する
 * @param {string} transcriptPath
 * @returns {UsageSample | null}
 */
export function readLatestUsage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  const { size } = statSync(transcriptPath);
  const cached = cache.get(transcriptPath);
  if (cached && cached.size === size) {
    return cached.sample;
  }

  const raw = readFileSync(transcriptPath, 'utf8');
  let latest = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // JSONL 末尾の partial-write 行は skip する（JSONL 仕様上の許容）
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    const model = entry.message?.model ?? '';
    latest = {
      tokens,
      model,
      contextWindowSize: inferContextWindowSize(model, tokens),
      outputTokens: usage.output_tokens ?? 0,
    };
  }

  cache.set(transcriptPath, { size, sample: latest });
  return latest;
}

/** キャッシュを全削除（テスト用） */
export function clearUsageCache() {
  cache.clear();
}
