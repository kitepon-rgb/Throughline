import { renderCodexNewThreadHandoff } from './codex-handoff.mjs';
import { estimateTokens } from './token-estimator.mjs';

export const DEFAULT_CODEX_HANDOFF_MAX_PROMPT_CHARS = 12_000;

function assertMaxPromptChars(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxPromptChars must be a positive integer');
  }
}

function addCheck(checks, { id, status, reason }) {
  checks.push({ id, status, reason });
}

/**
 * 新仕様: 各 L1/L2 行末尾の `(詳細：…)` suffix を抽出する。
 * 旧版の `throughline detail HH:MM:SS` 列挙は廃止 (groupL3ByTurn が turn 単位で集約)。
 */
function findDetailSuffixes(text) {
  return text.match(/\(詳細：[^)]+\)/g) ?? [];
}

export function buildCodexHandoffSmoke(
  record,
  {
    maxPromptChars = DEFAULT_CODEX_HANDOFF_MAX_PROMPT_CHARS,
    maxDetailRefs,
    maxRecentBodies,
    maxBodyChars,
    includePrompt = false,
  } = {},
) {
  if (!record) {
    throw new Error('buildCodexHandoffSmoke: record is required');
  }
  assertMaxPromptChars(maxPromptChars);

  const prompt = renderCodexNewThreadHandoff(record, {
    maxDetailRefs,
    maxRecentBodies,
    maxBodyChars,
  });
  const checks = [];
  const detailSuffixes = findDetailSuffixes(prompt);

  addCheck(checks, {
    id: 'new_thread_handoff_header',
    status: prompt.includes('## Throughline: New Codex Thread Handoff') ? 'pass' : 'fail',
    reason: 'prompt must use the fresh-thread handoff header',
  });
  addCheck(checks, {
    id: 'current_task_reading_contract',
    status: /current-task context/.test(prompt) ? 'pass' : 'fail',
    reason: 'prompt must frame memory as current-task context',
  });
  addCheck(checks, {
    id: 'source_session_present',
    status: prompt.includes(`Throughline session: ${record.session.id}`) ? 'pass' : 'fail',
    reason: 'prompt must name the source Throughline session',
  });
  addCheck(checks, {
    id: 'start_instruction_present',
    status: prompt.includes('### Start Instruction') ? 'pass' : 'fail',
    reason: 'prompt must include an explicit start instruction',
  });
  addCheck(checks, {
    id: 'current_thread_not_mutated',
    status: /Do not mutate the original Codex thread/.test(prompt) ? 'pass' : 'fail',
    reason: 'prompt must preserve the current-thread mutation boundary',
  });
  addCheck(checks, {
    id: 'active_l2_surface_present',
    status:
      record.memory.recentBodies.length === 0 || prompt.includes('### Recent Active Thread (L2)')
        ? 'pass'
        : 'fail',
    reason: 'prompt must include recent L2 when the record has active bodies',
  });
  addCheck(checks, {
    id: 'not_developer_message_json',
    status: /"role"\s*:\s*"developer"/.test(prompt) ? 'fail' : 'pass',
    reason: 'fresh-thread prompt must not be a developer-message JSON item',
  });
  addCheck(checks, {
    id: 'not_full_active_work_renderer',
    status: prompt.includes('## Throughline: Active Work Context') ? 'fail' : 'pass',
    reason: 'fresh-thread smoke must not accidentally use the full active-work renderer',
  });
  // 旧 `detail_commands_deduplicated` check は L3 の literal command 列挙を
  // dedup するためのもの。新版は groupL3ByTurn が構造的に turn 単位に集約するため
  // 不要。「L3 が存在すれば suffix も存在する」は localizeL3Part の挙動次第で
  // 偽陽性 (例: tool_output だけの turn は label が null で suffix 空) になるので
  // smoke check には入れない。
  addCheck(checks, {
    id: 'prompt_size_within_limit',
    status: prompt.length <= maxPromptChars ? 'pass' : 'fail',
    reason: `prompt must be at or below ${maxPromptChars} chars`,
  });

  const failing = checks.filter((check) => check.status !== 'pass');
  const result = {
    status: failing.length === 0 ? 'ready' : 'not-ready',
    reason:
      failing.length === 0
        ? 'fresh_thread_handoff_prompt_ready'
        : 'fresh_thread_handoff_prompt_failed_checks',
    sessionId: record.session.id,
    sourceAgent: record.source.adapter,
    promptChars: prompt.length,
    maxPromptChars,
    estimatedTokens: estimateTokens(prompt),
    l1Summaries: record.memory.l1Summaries.length,
    recentBodies: record.memory.recentBodies.length,
    l3References: record.references.l3.length,
    // 新仕様: per-line `(詳細：…)` suffix の出現回数 (turn 単位に集約済み)。
    // 旧 renderedDetailCommands / uniqueRenderedDetailCommands は廃止。
    renderedDetailSuffixes: detailSuffixes.length,
    checks,
  };

  if (includePrompt) {
    result.prompt = prompt;
  }

  return result;
}
