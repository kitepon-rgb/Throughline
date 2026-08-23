/**
 * hosts/identity.mjs — ベンダー (hook host) 識別の唯一の正本
 *
 * Throughline は Claude / Codex / Grok の 3 hook host を同じ SQLite に保存する。
 * host の見分け方は session_id prefix だけであり、その prefix 定義と判定関数を
 * このファイルに一元化する。共有コード (hook 入口・monitor・state-file・
 * predecessor 検索) は文字列リテラルを直接持たず、必ずここを参照する。
 *
 * 新しい host を足す場合はここへ prefix / host 名を追加し、
 * `src/hosts/<host>.mjs` に adapter を実装する。
 */

export const CLAUDE_HOST = 'claude';
export const CODEX_HOST = 'codex';
export const GROK_HOST = 'grok';

export const CODEX_SESSION_PREFIX = 'codex:';
export const GROK_SESSION_PREFIX = 'grok:';

/**
 * Claude session は prefix を持たない。auto handoff の前任検索 (Claude 専用) は
 * この一覧の prefix を持つ session を除外する。
 */
export const NON_CLAUDE_SESSION_PREFIXES = Object.freeze([
  CODEX_SESSION_PREFIX,
  GROK_SESSION_PREFIX,
]);

/**
 * state ファイルに保存できる host 値。Grok session は Claude 互換 hook 経路で
 * 保存されるため state 上は 'claude' として扱う (既存挙動)。
 */
export const KNOWN_STATE_HOSTS = Object.freeze([CLAUDE_HOST, CODEX_HOST]);

export function isCodexSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(CODEX_SESSION_PREFIX);
}

export function isGrokSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(GROK_SESSION_PREFIX);
}

/**
 * session_id から hook host を返す。prefix なしは Claude。
 * @param {string} sessionId
 * @returns {'claude'|'codex'|'grok'}
 */
export function hostOfSessionId(sessionId) {
  if (isCodexSessionId(sessionId)) return CODEX_HOST;
  if (isGrokSessionId(sessionId)) return GROK_HOST;
  return CLAUDE_HOST;
}

export function buildCodexThroughlineSessionId(threadId) {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('threadId is required');
  }
  return `${CODEX_SESSION_PREFIX}${threadId.trim()}`;
}

export function codexSessionIdToThreadId(sessionId) {
  if (!isCodexSessionId(sessionId)) return null;
  return sessionId.slice(CODEX_SESSION_PREFIX.length) || null;
}

export function grokBareSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return sessionId.startsWith(GROK_SESSION_PREFIX)
    ? sessionId.slice(GROK_SESSION_PREFIX.length)
    : sessionId;
}
