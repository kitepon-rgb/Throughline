/**
 * L3 reference の表示集約ヘルパー (resume-context / codex-handoff 共通)
 *
 * 各 L1 / L2 行末尾に付ける `(詳細：…)` suffix の組み立てを担当する。
 * - hook 出力 (system) は noise なので suffix から除外する
 * - tool_input + tool_output は 1:1 なので tool 名 (例: Bash) で 1 つに集約する
 *   (count は tool_input 側だけで数える)
 * - mcp__ ツール名は末尾の関数名だけに短縮する (フルパスは namespace noise)
 * - 件数は >1 のときだけ ` ×N` で表示
 */

/**
 * MCP ツール名 (`mcp__plugin_..._playwright__browser_navigate`) を末尾の関数名
 * (`browser_navigate`) だけに短縮する。最後の `__` 以降を返す。
 */
export function shortenMcpToolName(toolName) {
  if (typeof toolName !== 'string') return toolName ?? 'tool';
  if (!toolName.startsWith('mcp__')) return toolName;
  const idx = toolName.lastIndexOf('__');
  return idx >= 0 && idx + 2 < toolName.length ? toolName.slice(idx + 2) : toolName;
}

/**
 * L3 kind + tool_name を AI が読みやすい日本語ラベルにする。
 * null を返した kind は suffix からスキップする (noise / 二重カウント回避)。
 */
export function localizeL3Part(kind, toolName) {
  if (kind === 'thinking') return '思考';
  if (kind === 'tool_input') return shortenMcpToolName(toolName);
  if (kind === 'tool_output') return null;
  if (kind === 'system') return null;
  if (kind === 'image') return '画像';
  return kind;
}

/**
 * L3 references を `(originSessionId, turnNumber)` でグルーピングし、
 * 表示ラベル (Bash / 思考 / 画像 など) ごとの件数を保つ。
 * Map の挿入順は created_at ASC のままなので、自然な発生順に並ぶ。
 */
export function groupL3ByTurn(l3Refs) {
  const map = new Map();
  for (const ref of l3Refs) {
    if (ref.originSessionId == null || ref.turnNumber == null) continue;
    const turnKey = `${ref.originSessionId}\x00${ref.turnNumber}`;
    let entry = map.get(turnKey);
    if (!entry) {
      entry = { partCounts: new Map() };
      map.set(turnKey, entry);
    }
    const label = localizeL3Part(ref.kind, ref.toolName);
    if (label == null) continue;
    entry.partCounts.set(label, (entry.partCounts.get(label) ?? 0) + 1);
  }
  return map;
}

/**
 * 1 ターン分の `(詳細：…)` suffix 文字列を組み立てる。
 * - L1 の場合は `本文` を先頭に置き「summary を超えた full body が引ける」ことを示す
 * - L2 の場合は body 自体は行内にあるので L3 部品だけ列挙
 * - 何も無いなら空文字 (suffix 自体を出さない)
 */
export function buildPartsSummary(partCounts, { includeBody = false } = {}) {
  const parts = [];
  if (includeBody) parts.push('本文');
  for (const [label, count] of partCounts) {
    parts.push(count > 1 ? `${label} ×${count}` : label);
  }
  if (parts.length === 0) return '';
  return ` (詳細：${parts.join(', ')})`;
}
