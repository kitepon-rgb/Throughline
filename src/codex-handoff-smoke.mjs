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

function findDetailCommands(text) {
  const matches = text.match(/throughline detail \d\d:\d\d:\d\d/g) ?? [];
  return matches;
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
  const detailCommands = findDetailCommands(prompt);
  const uniqueDetailCommands = new Set(detailCommands);

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
  addCheck(checks, {
    id: 'detail_commands_deduplicated',
    status: detailCommands.length === uniqueDetailCommands.size ? 'pass' : 'fail',
    reason: 'handoff prompt should not repeat the same detail command',
  });
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
    renderedDetailCommands: detailCommands.length,
    uniqueRenderedDetailCommands: uniqueDetailCommands.size,
    checks,
  };

  if (includePrompt) {
    result.prompt = prompt;
  }

  return result;
}
