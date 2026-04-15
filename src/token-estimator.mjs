/**
 * テキストのトークン数を推定する。
 *
 * GPT-4 の平均的な比率（4文字 ≒ 1トークン）を用いたヒューリスティック実装。
 * tiktoken への差し替えは Phase 3 で行う予定。
 *
 * @param {string | null | undefined} text
 * @returns {number} 推定トークン数（整数）
 */
export function estimateTokens(text) {
  if (text == null) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}
