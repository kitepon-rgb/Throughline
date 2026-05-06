import { runCodexTrimPreflight } from '../codex-app-server.mjs';
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

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const plan = buildTrimPlan(db, {
    sessionId: parsed.sessionId,
    projectPath: process.cwd(),
    host: parsed.host,
    keepRecent: parsed.keepRecent,
    trimAll: parsed.trimAll,
    inflightMemo,
    codexThreadId: parsed.codexThreadId,
  });

  if (!parsed.dryRun) {
    if (!parsed.preflight) {
      process.stderr.write(
        '[trim] automatic rollback/inject is not implemented yet. Re-run with --dry-run or --preflight.\n',
      );
      process.exit(1);
    }
    const result = await runPreflight(parsed, plan);
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderTrimPreflightReport(result) + '\n');
    }
    process.exit(result.status === 'preflight-ready' ? 0 : 1);
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else {
    process.stdout.write(renderTrimDryRunReport(plan) + '\n');
  }

  process.exit(plan.status === 'unavailable' ? 1 : 0);
}

async function runPreflight(parsed, plan) {
  if (parsed.host !== 'codex') {
    return {
      status: 'preflight-refused',
      reason: 'preflight_requires_codex_host',
      plan,
    };
  }

  if (!parsed.codexThreadId) {
    return {
      status: 'preflight-refused',
      reason: 'codex_thread_id_required',
      plan,
    };
  }

  if (plan.status === 'unavailable') {
    return {
      status: 'preflight-refused',
      reason: plan.reason,
      plan,
    };
  }

  if (plan.trim.rollbackTurns < 1) {
    return {
      status: 'preflight-noop',
      reason: 'nothing_to_trim',
      plan,
    };
  }

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const preflight = await runCodexTrimPreflight({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    rollbackTurns: plan.trim.rollbackTurns,
    command,
  });

  return {
    status: 'preflight-ready',
    reason: 'rollback_not_sent',
    plan,
    preflight,
  };
}

function renderTrimPreflightReport(result) {
  const lines = [];
  lines.push('## Throughline Trim Preflight');
  lines.push('');
  lines.push(`Status: ${result.status}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);

  if (result.preflight) {
    lines.push('');
    lines.push(`Codex thread: ${result.preflight.threadId}`);
    lines.push(`Read turns: ${result.preflight.readTurns ?? 'unknown'}`);
    lines.push(`Resumed turns: ${result.preflight.resumedTurns ?? 'unknown'}`);
    lines.push(`Rollback sent: ${result.preflight.rollbackSent ? 'yes' : 'no'}`);
    lines.push(`Inject sent: ${result.preflight.injectSent ? 'yes' : 'no'}`);
    lines.push(`Rollback candidate turns: ${result.plan.trim.rollbackTurns}`);
  }

  return lines.join('\n');
}
