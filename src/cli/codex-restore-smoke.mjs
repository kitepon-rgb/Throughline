import { runCodexThreadRestoreSmoke } from '../codex-app-server.mjs';
import { buildCodexRolloutTrimSource } from '../codex-rollout-memory.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';

const CODEX_RESTORE_SMOKE_ENV = 'THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE';

function parseArgs(args) {
  const out = {
    codexThreadId: null,
    json: false,
    codexAppServerBin: null,
    timeoutMs: 60_000,
    requestTimeoutMs: 20_000,
    cycles: 2,
    turnsListLimit: 200,
    maxTurnsListPages: 50,
    inspectRiskyRollout: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-app-server-bin requires a command path');
      }
      out.codexAppServerBin = value;
    } else if (arg === '--timeout-ms') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--timeout-ms must be a positive integer');
      }
      out.timeoutMs = value;
    } else if (arg === '--request-timeout-ms') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--request-timeout-ms must be a positive integer');
      }
      out.requestTimeoutMs = value;
    } else if (arg === '--cycles') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 2) {
        throw new Error('--cycles must be an integer >= 2');
      }
      out.cycles = value;
    } else if (arg === '--turns-list-limit') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--turns-list-limit must be a positive integer');
      }
      out.turnsListLimit = value;
    } else if (arg === '--max-turns-list-pages') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--max-turns-list-pages must be a positive integer');
      }
      out.maxTurnsListPages = value;
    } else if (arg === '--inspect-risky-rollout') {
      out.inspectRiskyRollout = true;
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
  lines.push('throughline codex restore smoke');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  thread:       ${result.threadId ?? 'unknown'}`);
  lines.push(`  rollout:      ${result.rolloutPath ?? 'unknown'}`);
  lines.push(`  proof scope:  ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe: ${result.restartSafe ? 'yes' : 'no'}`);
  if (result.restoreSafety) {
    lines.push(`  restore safety: ${result.restoreSafety.status}`);
  }
  if (result.restoreSafetyRiskInspected) {
    lines.push('  restore safety risk inspected read-only: yes');
  }
  if (Number.isInteger(result.expectedTurns)) {
    lines.push(`  expected turns: ${result.expectedTurns}`);
  }
  const aggregateTextMatchSummary = formatResponseTextMatchSummary(result.restoreTextMatchCheck);
  if (aggregateTextMatchSummary) {
    lines.push(`  restore text match check: ${aggregateTextMatchSummary}`);
  }
  for (const observation of result.observations ?? []) {
    lines.push(
      `  cycle ${observation.cycle}: read=${observation.readTurns ?? 'unknown'} resume=${
        observation.resumedTurns ?? 'unknown'
      } turns/list=${observation.turnsListTurns ?? 'unknown'} check=${
        observation.turnCountCheck?.status ?? 'unknown'
      }`,
    );
    const textMatchSummary = formatResponseTextMatchSummary(observation.responseTextMatches);
    if (textMatchSummary) {
      lines.push(`    response text matches: ${textMatchSummary}`);
    }
  }
  return lines.join('\n');
}

function formatResponseTextMatchSummary(responseTextMatches) {
  if (!responseTextMatches) return null;
  const status = responseTextMatches.status ?? 'unknown';
  const matchedNeedles = responseTextMatches.matchedNeedles ?? [];
  const matchingSources = [
    ...new Set(
      (responseTextMatches.sources ?? [])
        .filter(
          (source) =>
            (source.matches ?? []).length > 0 || (source.matchedNeedleIds ?? []).length > 0,
        )
        .map((source) => source.source ?? source.id)
        .filter(Boolean),
    ),
  ];
  const parts = [status];
  if (matchedNeedles.length > 0) {
    parts.push(`${matchedNeedles.length} needle${matchedNeedles.length === 1 ? '' : 's'}`);
  }
  if (matchingSources.length > 0) {
    parts.push(`sources=${matchingSources.join(',')}`);
  }
  const pathsBySource = (responseTextMatches.sources ?? []).map((source) => {
    const paths =
      source.samplePaths ??
      [
        ...new Set(
          (source.matches ?? []).flatMap((match) =>
            (match.locations ?? []).map((location) => location.path),
          ),
        ),
      ];
    return {
      source: source.source ?? source.id,
      paths,
    };
  });
  const firstPathPerSource = pathsBySource
    .filter((entry) => entry.paths.length > 0)
    .map((entry) => `${entry.source}:${entry.paths[0]}`);
  const extraPaths = pathsBySource.flatMap((entry) =>
    entry.paths.slice(1, 3).map((path) => `${entry.source}:${path}`),
  );
  const samplePaths = [...firstPathPerSource, ...extraPaths].slice(0, 6);
  if (samplePaths.length > 0) {
    parts.push(`paths=${samplePaths.join(';')}`);
  }
  const locationKinds = [
    ...new Set(
      (responseTextMatches.sources ?? []).flatMap((source) => {
        if (source.locationKinds) return source.locationKinds;
        return (source.matches ?? []).flatMap((match) =>
          (match.locations ?? []).map((location) => location.kind).filter(Boolean),
        );
      }),
    ),
  ];
  if (locationKinds.length > 0) {
    parts.push(`kinds=${locationKinds.join(',')}`);
  }
  const locationRisks = [
    ...new Set(
      (responseTextMatches.sources ?? []).flatMap((source) => {
        if (source.locationRisks) return source.locationRisks;
        return (source.matches ?? []).flatMap((match) =>
          (match.locations ?? []).map((location) => location.risk).filter(Boolean),
        );
      }),
    ),
  ];
  if (locationRisks.length > 0) {
    parts.push(`risks=${locationRisks.join(',')}`);
  }
  const blockingKinds = [
    ...new Set(
      responseTextMatches.blockingKinds ??
        (responseTextMatches.sources ?? []).flatMap((source) => {
          if (source.blockingKinds) return source.blockingKinds;
          return (source.matches ?? []).flatMap((match) =>
            (match.locations ?? [])
              .filter((location) => location.blockingCandidate)
              .map((location) => location.kind),
          );
        }),
    ),
  ];
  if (responseTextMatches.hasBlockingCandidates === false) {
    parts.push('blocking-candidates=no');
  } else if (blockingKinds.length > 0) {
    parts.push(`blocking-candidates=${blockingKinds.join(',')}`);
  }
  if (responseTextMatches.reason) {
    parts.push(`reason=${responseTextMatches.reason}`);
  }
  return parts.join(' ');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-restore-smoke] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity({ host: 'codex', codexThreadId: parsed.codexThreadId }, process.env),
  };

  if (process.env[CODEX_RESTORE_SMOKE_ENV] !== '1') {
    const result = {
      status: 'refused',
      reason: 'experimental_env_required',
      requiredEnv: `${CODEX_RESTORE_SMOKE_ENV}=1`,
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-restore-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  if (!parsed.codexThreadId) {
    const result = {
      status: 'refused',
      reason: 'codex_thread_id_required',
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-restore-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  const trimSource = buildCodexRolloutTrimSource({
    threadId: parsed.codexThreadId,
    projectPath: process.cwd(),
    sourceReason:
      parsed.codexThreadIdSource && parsed.codexThreadIdSource.startsWith('env:')
        ? 'env_codex_thread_rollout'
        : 'explicit_codex_thread_rollout',
  });

  if (!trimSource) {
    const result = {
      status: 'refused',
      reason: 'codex_rollout_source_required',
      threadId: parsed.codexThreadId,
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-restore-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  if (trimSource.restoreSafety?.status === 'risk' && !parsed.inspectRiskyRollout) {
    const result = {
      status: 'refused',
      reason: 'restore_safety_risk',
      threadId: parsed.codexThreadId,
      rolloutPath: trimSource.rolloutPath,
      restoreSafety: trimSource.restoreSafety,
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(renderTextResult(result) + '\n');
    process.exit(1);
  }

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  let result;
  try {
    result = await runCodexThreadRestoreSmoke({
      threadId: parsed.codexThreadId,
      cwd: process.cwd(),
      expectedTurns: trimSource.capturedTurns,
      restoreTextNeedles: buildRestoreTextNeedles(trimSource.restoreSafety),
      command,
      timeoutMs: parsed.timeoutMs,
      requestTimeoutMs: parsed.requestTimeoutMs,
      cycles: parsed.cycles,
      turnsListLimit: parsed.turnsListLimit,
      maxTurnsListPages: parsed.maxTurnsListPages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorResult = {
      status: 'app-server-restore-smoke-error',
      reason: 'app_server_restore_request_failed',
      error: msg,
      threadId: parsed.codexThreadId,
      rolloutPath: trimSource.rolloutPath,
      restoreSafety: trimSource.restoreSafety,
      proofScope: 'app_server_process_restart_only',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(errorResult, null, 2) + '\n');
    else process.stdout.write(renderTextResult(errorResult) + '\n');
    process.exit(1);
  }
  const payload = {
    ...result,
    rolloutPath: trimSource.rolloutPath,
    restoreSafety: trimSource.restoreSafety,
    restoreSafetyRiskInspected: trimSource.restoreSafety?.status === 'risk' && parsed.inspectRiskyRollout,
  };

  if (parsed.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write(renderTextResult(payload) + '\n');
  process.exitCode =
    payload.status === 'app-server-restart-stable' && !payload.restoreSafetyRiskInspected ? 0 : 1;
}

function buildRestoreTextNeedles(restoreSafety) {
  const entries = restoreSafety?.retainedTexts ?? [];
  const seen = new Set();
  const needles = [];
  let index = 1;
  for (const entry of entries) {
    const value = normalizeRestoreTextNeedle(entry.textPreview);
    if (value.length < 20 || seen.has(value)) continue;
    seen.add(value);
    needles.push({
      id: `retained_rollback_text_${index++}`,
      textPreview: entry.textPreview,
      value,
    });
  }
  return needles;
}

function normalizeRestoreTextNeedle(value) {
  return String(value ?? '').replace(' [truncated]', '').replace(/\s+/g, ' ').trim();
}

export const _internal = {
  parseArgs,
  formatResponseTextMatchSummary,
};
