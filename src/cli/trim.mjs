import { runCodexTrimExecution, runCodexTrimPreflight } from '../codex-app-server.mjs';
import { buildCodexRolloutTrimSource } from '../codex-rollout-memory.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';
import { getDb } from '../db.mjs';
import {
  DEFAULT_TRIM_KEEP_RECENT,
  buildTrimPlan,
  renderTrimDryRunReport,
} from '../trim-model.mjs';

async function readStdin() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });
  return raw;
}

function parseArgs(args) {
  const out = {
    dryRun: false,
    json: false,
    sessionId: null,
    host: 'unknown',
    keepRecent: DEFAULT_TRIM_KEEP_RECENT,
    trimAll: false,
    memoStdin: false,
    codexThreadId: null,
    preflight: false,
    execute: false,
    codexAppServerBin: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--host') {
      const value = args[++i];
      if (!['claude', 'codex', 'unknown'].includes(value)) {
        throw new Error('--host must be claude, codex, or unknown');
      }
      out.host = value;
    } else if (arg === '--keep-recent') {
      const value = args[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--keep-recent must be a non-negative integer');
      }
      out.keepRecent = parsed;
    } else if (arg === '--all') {
      out.trimAll = true;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--preflight') {
      out.preflight = true;
    } else if (arg === '--execute') {
      out.execute = true;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-app-server-bin requires a command path');
      }
      out.codexAppServerBin = value;
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[trim] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity(parsed, process.env),
  };

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const trimSource =
    parsed.host === 'codex' && parsed.codexThreadId
      ? buildCodexRolloutTrimSource({
          threadId: parsed.codexThreadId,
          projectPath: process.cwd(),
          sourceReason:
            parsed.codexThreadIdSource && parsed.codexThreadIdSource.startsWith('env:')
              ? 'env_codex_thread_rollout'
              : 'explicit_codex_thread_rollout',
        })
      : null;
  const plan = buildTrimPlan(db, {
    sessionId: parsed.sessionId,
    projectPath: process.cwd(),
    host: parsed.host,
    keepRecent: parsed.keepRecent,
    trimAll: parsed.trimAll,
    inflightMemo,
    codexThreadId: parsed.codexThreadId,
    codexThreadIdSource: parsed.codexThreadIdSource,
    trimSource,
  });

  if (!parsed.dryRun) {
    if (parsed.preflight && parsed.execute) {
      process.stderr.write('[trim] choose either --preflight or --execute, not both.\n');
      process.exit(1);
    }

    if (!parsed.preflight && !parsed.execute) {
      process.stderr.write(
        '[trim] automatic rollback/inject is not implemented yet. Re-run with --dry-run, --preflight, or guarded --execute.\n',
      );
      process.exit(1);
    }

    const result = parsed.preflight ? await runPreflight(parsed, plan) : await runExecute(parsed, plan);
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderTrimActionReport(result) + '\n');
    }
    process.exit(result.status === 'preflight-ready' || result.status === 'executed' ? 0 : 1);
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else {
    process.stdout.write(renderTrimDryRunReport(plan) + '\n');
  }

  process.exit(plan.status === 'unavailable' ? 1 : 0);
}

async function runExecute(parsed, plan) {
  if (process.env.THROUGHLINE_EXPERIMENTAL_CODEX_TRIM !== '1') {
    return {
      status: 'execute-refused',
      reason: 'experimental_env_required',
      requiredEnv: 'THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1',
      plan,
    };
  }

  const refusal = validateCodexAction(parsed, plan, 'execute');
  if (refusal) return refusal;

  if (!hasInjectableMemory(plan.memoryPreview?.text)) {
    return {
      status: 'execute-refused',
      reason: 'injectable_memory_required',
      plan,
    };
  }

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const execution = await runCodexTrimExecution({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    rollbackTurns: plan.trim.rollbackTurns,
    memoryText: plan.memoryPreview.text,
    expectedTurns: expectedCodexAppServerTurns(plan),
    command,
  });

  if (execution.status === 'refused') {
    return {
      status: 'execute-refused',
      reason: execution.reason,
      plan,
      execution,
    };
  }

  return {
    status: 'executed',
    reason: 'rollback_and_inject_sent',
    plan: {
      ...plan,
      mode: 'execute',
    },
    execution,
  };
}

async function runPreflight(parsed, plan) {
  const refusal = validateCodexAction(parsed, plan, 'preflight');
  if (refusal) return refusal;

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const preflight = await runCodexTrimPreflight({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    rollbackTurns: plan.trim.rollbackTurns,
    expectedTurns: expectedCodexAppServerTurns(plan),
    command,
  });
  const turnCountStatus = preflight.turnCountCheck?.status;
  if (turnCountStatus === 'mismatch' || turnCountStatus === 'unknown') {
    return {
      status: 'preflight-refused',
      reason: preflight.turnCountCheck.reason,
      plan,
      preflight,
    };
  }

  return {
    status: 'preflight-ready',
    reason: 'rollback_not_sent',
    plan,
    preflight,
  };
}

function validateCodexAction(parsed, plan, action) {
  if (parsed.host !== 'codex') {
    return {
      status: `${action}-refused`,
      reason: `${action}_requires_codex_host`,
      plan,
    };
  }

  if (!parsed.codexThreadId) {
    return {
      status: `${action}-refused`,
      reason: 'codex_thread_id_required',
      plan,
    };
  }

  if (plan.status === 'unavailable') {
    return {
      status: `${action}-refused`,
      reason: plan.reason,
      plan,
    };
  }

  if (plan.trim.rollbackTurns < 1) {
    return {
      status: `${action}-noop`,
      reason: 'nothing_to_trim',
      plan,
    };
  }

  return null;
}

function hasInjectableMemory(text) {
  return typeof text === 'string' && text.trim().length > 0 && text !== '(no captured memory available)';
}

function expectedCodexAppServerTurns(plan) {
  return plan?.trim?.source === 'codex-rollout' ? plan.trim.capturedTurns : null;
}

function renderTrimActionReport(result) {
  const lines = [];
  lines.push(result.status === 'executed' ? '## Throughline Trim Execute' : '## Throughline Trim Preflight');
  lines.push('');
  lines.push(`Status: ${result.status}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.requiredEnv) lines.push(`Required env: ${result.requiredEnv}`);

  if (result.preflight) {
    lines.push('');
    lines.push(`Codex thread: ${result.preflight.threadId}`);
    lines.push(`Read turns: ${result.preflight.readTurns ?? 'unknown'}`);
    lines.push(`Resumed turns: ${result.preflight.resumedTurns ?? 'unknown'}`);
    if (result.preflight.turnCountCheck) {
      lines.push(`Turn count check: ${result.preflight.turnCountCheck.status}`);
      lines.push(`Expected turns: ${result.preflight.turnCountCheck.expectedTurns ?? 'unchecked'}`);
    }
    lines.push(`Rollback sent: ${result.preflight.rollbackSent ? 'yes' : 'no'}`);
    lines.push(`Inject sent: ${result.preflight.injectSent ? 'yes' : 'no'}`);
    lines.push(`Rollback candidate turns: ${result.plan.trim.rollbackTurns}`);
  }

  if (result.execution) {
    lines.push('');
    lines.push(`Codex thread: ${result.execution.threadId}`);
    lines.push(`Read turns: ${result.execution.readTurns ?? 'unknown'}`);
    lines.push(`Resumed turns: ${result.execution.resumedTurns ?? 'unknown'}`);
    if (result.execution.turnCountCheck) {
      lines.push(`Turn count check: ${result.execution.turnCountCheck.status}`);
      lines.push(`Expected turns: ${result.execution.turnCountCheck.expectedTurns ?? 'unchecked'}`);
    }
    lines.push(`Rollback sent: ${result.execution.rollbackSent ? 'yes' : 'no'}`);
    lines.push(`Inject sent: ${result.execution.injectSent ? 'yes' : 'no'}`);
    lines.push(`Injected items: ${result.execution.injectedItems}`);
    lines.push(`Rollback candidate turns: ${result.plan.trim.rollbackTurns}`);
  }

  return lines.join('\n');
}
