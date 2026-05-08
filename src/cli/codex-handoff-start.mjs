import { getDb } from '../db.mjs';
import { buildHandoffRecord } from '../handoff-record.mjs';
import { renderCodexNewThreadHandoff } from '../codex-handoff.mjs';
import { buildCodexHandoffSmoke } from '../codex-handoff-smoke.mjs';
import { buildCodexHandoffModelSmokePrompt } from '../codex-handoff-model-smoke.mjs';
import { estimateTokens } from '../token-estimator.mjs';

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

function parseNonNegativeInteger(args, index, flag) {
  const value = Number(args[index]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveInteger(args, index, flag) {
  const value = Number(args[index]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(args) {
  const out = {
    sessionId: null,
    json: false,
    printPrompt: false,
    memoStdin: false,
    maxPromptChars: undefined,
    maxDetailRefs: undefined,
    maxRecentBodies: undefined,
    maxBodyChars: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--session requires a session id');
      }
      out.sessionId = value;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--print-prompt') {
      out.printPrompt = true;
    } else if (arg === '--memo-stdin') {
      out.memoStdin = true;
    } else if (arg === '--max-prompt-chars') {
      out.maxPromptChars = parsePositiveInteger(args, ++i, '--max-prompt-chars');
    } else if (arg === '--max-detail-refs') {
      out.maxDetailRefs = parseNonNegativeInteger(args, ++i, '--max-detail-refs');
    } else if (arg === '--max-recent-bodies') {
      out.maxRecentBodies = parseNonNegativeInteger(args, ++i, '--max-recent-bodies');
    } else if (arg === '--max-body-chars') {
      out.maxBodyChars = parseNonNegativeInteger(args, ++i, '--max-body-chars');
    } else if (!arg.startsWith('-') && !out.sessionId) {
      out.sessionId = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function findLatestCodexSessionId(db, projectPath) {
  const row = db
    .prepare(
      `SELECT session_id
       FROM sessions
       WHERE lower(project_path) = lower(?)
         AND session_id LIKE 'codex:%'
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(projectPath);
  return row?.session_id ?? null;
}

function limitArgs(parsed, { includeMaxPromptChars = false } = {}) {
  const args = [];
  if (includeMaxPromptChars && parsed.maxPromptChars !== undefined) {
    args.push('--max-prompt-chars', String(parsed.maxPromptChars));
  }
  if (parsed.maxDetailRefs !== undefined) {
    args.push('--max-detail-refs', String(parsed.maxDetailRefs));
  }
  if (parsed.maxRecentBodies !== undefined) {
    args.push('--max-recent-bodies', String(parsed.maxRecentBodies));
  }
  if (parsed.maxBodyChars !== undefined) {
    args.push('--max-body-chars', String(parsed.maxBodyChars));
  }
  return args;
}

function memoArgs(parsed) {
  return parsed.memoStdin ? ['--memo-stdin'] : [];
}

function commandFor(parts) {
  return parts.join(' ');
}

function buildGuidance({ sessionId, parsed, handoffSmoke, handoffPrompt }) {
  const smokeArgs = limitArgs(parsed, { includeMaxPromptChars: true });
  const handoffArgs = limitArgs(parsed);
  const modelPrompt = buildCodexHandoffModelSmokePrompt({
    handoffPrompt,
    marker: 'TL_CODEX_HANDOFF_START_SMOKE',
  });
  const commands = {
    structuralSmoke: commandFor([
      'throughline',
      'codex-handoff-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--json',
    ]),
    modelSmokeDryRun: commandFor([
      'throughline',
      'codex-handoff-model-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--dry-run',
      '--json',
    ]),
    renderPrompt: commandFor([
      'throughline',
      'codex-resume',
      '--session',
      sessionId,
      '--format',
      'handoff',
      ...handoffArgs,
      ...memoArgs(parsed),
    ]),
    liveModelSmoke: commandFor([
      'THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1',
      'throughline',
      'codex-handoff-model-smoke',
      '--session',
      sessionId,
      ...smokeArgs,
      ...memoArgs(parsed),
      '--json',
    ]),
  };
  const ready = handoffSmoke.status === 'ready';
  return {
    status: ready ? 'ready' : 'not-ready',
    reason: ready ? 'fresh_thread_handoff_start_ready' : 'handoff_smoke_not_ready',
    sessionId,
    mutatesCurrentThread: false,
    startThreadManually: true,
    handoffSmoke,
    modelPromptChars: modelPrompt.length,
    estimatedModelPromptTokens: estimateTokens(modelPrompt),
    memoStdin: parsed.memoStdin,
    memoReplayNote: parsed.memoStdin
      ? 'Commands include --memo-stdin; pipe the same memo when replaying them.'
      : null,
    commands,
    steps: ready
      ? [
          'Run the structural smoke command if you want to re-check the handoff prompt.',
          'Run the model smoke dry-run command if you want to inspect the Codex exec boundary without starting a model turn.',
          'Render the handoff prompt with the render prompt command, or pass --print-prompt to this command.',
          ...(parsed.memoStdin
            ? ['When replaying individual commands, pipe the same memo because they include --memo-stdin.']
            : []),
          'Start a new Codex thread and provide the handoff prompt as the opening context.',
        ]
      : [
          'Fix the failing handoff smoke checks before starting a new Codex thread.',
          'This handoff command does not run current-thread trim; use trim --execute --host codex for guarded current-thread rollback / inject.',
        ],
  };
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex handoff start');
  lines.push('');
  lines.push(`  status:            ${result.status}`);
  lines.push(`  reason:            ${result.reason}`);
  lines.push(`  session:           ${result.sessionId}`);
  lines.push(`  mutates thread:    ${result.mutatesCurrentThread ? 'yes' : 'no'}`);
  lines.push(`  handoff smoke:     ${result.handoffSmoke.status}`);
  lines.push(`  prompt chars:      ${result.handoffSmoke.promptChars}/${result.handoffSmoke.maxPromptChars}`);
  lines.push(`  model prompt:      ${result.modelPromptChars}`);
  if (result.memoReplayNote) {
    lines.push(`  memo replay:       ${result.memoReplayNote}`);
  }
  lines.push('');
  lines.push('  commands:');
  lines.push(`    structural smoke:    ${result.commands.structuralSmoke}`);
  lines.push(`    model smoke dry-run: ${result.commands.modelSmokeDryRun}`);
  lines.push(`    render prompt:       ${result.commands.renderPrompt}`);
  lines.push(`    live model smoke:    ${result.commands.liveModelSmoke}`);
  lines.push('');
  lines.push('  steps:');
  for (const step of result.steps) {
    lines.push(`    - ${step}`);
  }
  if (result.prompt) {
    lines.push('');
    lines.push(result.prompt);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-handoff-start] ${msg}\n`);
    process.exit(1);
  }

  const inflightMemo = parsed.memoStdin ? await readStdin() : null;
  const db = getDb();
  const sessionId = parsed.sessionId ?? findLatestCodexSessionId(db, process.cwd());
  if (!sessionId) {
    process.stderr.write(
      '[codex-handoff-start] no Codex session found for this project. Pass --session codex:<thread-id> explicitly.\n',
    );
    process.exit(1);
  }

  const record = buildHandoffRecord(db, {
    sessionId,
    isInheritance: false,
    inflightMemo,
  });
  if (!record) {
    process.stderr.write(`[codex-handoff-start] no handoff memory found for session ${sessionId}\n`);
    process.exit(1);
  }

  const smokeOptions = {
    maxPromptChars: parsed.maxPromptChars,
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  };
  const handoffSmoke = buildCodexHandoffSmoke(record, smokeOptions);
  const handoffPrompt = renderCodexNewThreadHandoff(record, {
    maxDetailRefs: parsed.maxDetailRefs,
    maxRecentBodies: parsed.maxRecentBodies,
    maxBodyChars: parsed.maxBodyChars,
  });
  const result = buildGuidance({
    sessionId,
    parsed,
    handoffSmoke,
    handoffPrompt,
  });
  if (parsed.printPrompt) {
    result.prompt = handoffPrompt;
  }

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'ready' ? 0 : 1);
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
