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

  if (!parsed.dryRun) {
    process.stderr.write(
      '[trim] automatic rollback/inject is not implemented yet. Re-run with --dry-run.\n',
    );
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
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else {
    process.stdout.write(renderTrimDryRunReport(plan) + '\n');
  }

  process.exit(plan.status === 'unavailable' ? 1 : 0);
}
