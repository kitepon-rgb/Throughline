import { inspectCodexVsCodeRollbackSmoke } from '../codex-vscode-rollback-smoke.mjs';
import { defaultCodexHome } from '../codex-thread-index.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';

function parseArgs(args) {
  const out = {
    codexThreadId: null,
    codexHome: defaultCodexHome(),
    afterVsCodeRestart: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verify') {
      continue;
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--codex-home') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-home requires a path');
      }
      out.codexHome = value;
    } else if (arg === '--after-vscode-restart') {
      out.afterVsCodeRestart = true;
    } else if (arg === '--json') {
      out.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex vscode rollback smoke');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  thread:       ${result.threadId ?? 'unknown'}`);
  lines.push(`  proof scope:  ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe: ${result.restartSafe ? 'yes' : 'no'}`);
  if (result.rolloutPath) lines.push(`  rollout:      ${result.rolloutPath}`);
  if (result.restoreSafety) {
    lines.push(`  restore safety: ${result.restoreSafety.status}`);
    lines.push(`  rollback events: ${result.stats?.rollbackEvents ?? 0}`);
    lines.push(`  rolled-back user messages: ${result.stats?.rolledBackUserMessages ?? 0}`);
    lines.push(`  user messages after rollback: ${result.stats?.userMessagesAfterRollback ?? 0}`);
    lines.push(
      `  rollback text retained in compacted: ${
        result.restoreSafety.rollbackTextRetainedInCompacted ?? 0
      }`,
    );
    lines.push(`  resurrected user messages: ${result.restoreSafety.resurrectedUserMessages ?? 0}`);
    if (Array.isArray(result.restoreSafety.risks) && result.restoreSafety.risks.length > 0) {
      lines.push(
        `  risks: ${result.restoreSafety.risks
          .map((risk) => `${risk.type}:${risk.count ?? 'unknown'}`)
          .join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-vscode-rollback-smoke] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity({ codexThreadId: parsed.codexThreadId }, process.env),
  };

  if (!parsed.codexThreadId) {
    const result = {
      status: 'refused',
      reason: 'codex_thread_id_required',
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-vscode-rollback-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  const result = inspectCodexVsCodeRollbackSmoke({
    threadId: parsed.codexThreadId,
    codexHome: parsed.codexHome,
    projectPath: process.cwd(),
    afterVsCodeRestart: parsed.afterVsCodeRestart,
  });
  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'vscode-restart-rollback-nonresurrection-visible' ? 0 : 1);
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
