function parseArgs(argv) {
  const out = {
    event: null,
    codexThreadId: null,
    codexHome: null,
    projectPath: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !out.event) {
      out.event = arg;
    } else if (arg === '--codex-thread-id') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-thread-id requires an id');
      out.codexThreadId = value;
    } else if (arg === '--codex-home') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-home requires a path');
      out.codexHome = value;
    } else if (arg === '--project') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--project requires a path');
      out.projectPath = value;
    } else if (arg === '--json') {
      out.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!out.event) out.event = 'stop';
  if (!['stop', 'user-prompt-submit', 'post-tool-use'].includes(out.event)) {
    throw new Error(`unknown Codex hook event: ${out.event}`);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePayload(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    throw new Error(`failed to parse Codex hook stdin JSON: ${msg}`);
  }
}

function codexHomeFromTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== 'string') return null;
  const marker = `${process.platform === 'win32' ? '\\' : '/'}sessions${process.platform === 'win32' ? '\\' : '/'}`;
  const idx = transcriptPath.indexOf(marker);
  if (idx <= 0) return null;
  return transcriptPath.slice(0, idx);
}

function suppressExperimentalWarnings() {
  if (process.env.THROUGHLINE_SHOW_EXPERIMENTAL_WARNINGS === '1') return;
  process.on('warning', (warning) => {
    if (warning?.name === 'ExperimentalWarning') return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

export function codexContextOutput(text, eventName = 'UserPromptSubmit') {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  });
}

function renderAutoRefreshContext({ usage, decision, threadId, eventName = 'UserPromptSubmit' }) {
  const tokens = Number(usage?.tokens);
  const contextWindowSize = Number(usage?.contextWindowSize);
  const ratio = Number(decision?.ratio);
  const percent = Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : 'unknown';
  const timing =
    eventName === 'PostToolUse'
      ? 'Before continuing the current tool loop, run the installed $throughline workflow now.'
      : 'Before answering the user prompt, run the installed $throughline workflow now.';
  return [
    '[throughline] Codex context refresh threshold reached for this current session.',
    `Thread: ${threadId}`,
    `Usage: ${Number.isFinite(tokens) ? tokens : 'unknown'} / ${Number.isFinite(contextWindowSize) ? contextWindowSize : 'unknown'} (${percent}); threshold ${(decision.threshold * 100).toFixed(0)}%.`,
    '',
    timing,
    'Execute exactly:',
    'throughline trim --execute --host codex --all --json',
    '',
    'Report only the execution status, whether rollback/inject were sent, durable evidence if present, and the selected memory session; then continue from the refreshed context.',
    'This trigger was computed from the current Codex rollout token_count, not from token-monitor output.',
  ].join('\n');
}

async function captureCodexHookSession({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  summarize = true,
} = {}) {
  const [
    { getDb },
    { captureCodexRolloutToDb },
    { resolveCodexThreadIdentity },
    { summarizeCodexSession },
    { writeSessionState },
    { ensureMonitorTaskFile },
    { buildCodexMonitorUsage },
  ] = await Promise.all([
    import('../db.mjs'),
    import('../codex-capture.mjs'),
    import('../codex-thread-identity.mjs'),
    import('./codex-summarize.mjs'),
    import('../state-file.mjs'),
    import('../vscode-task.mjs'),
    import('../codex-usage.mjs'),
  ]);
  const actualDb = db ?? getDb();
  const identity = resolveCodexHookThreadIdentity({ args, payload, env, resolveCodexThreadIdentity });

  if (!identity.codexThreadId) {
    return {
      status: 'skipped',
      reason: 'codex_thread_id_not_available',
      db: actualDb,
      identity,
      projectPath: null,
      codexHome: null,
      captured: null,
      summarized: null,
      monitorState: null,
      usage: null,
    };
  }

  const projectPath =
    args.projectPath ??
    (typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  const codexHome =
    args.codexHome ??
    codexHomeFromTranscriptPath(payload.transcript_path ?? payload.transcriptPath) ??
    undefined;

  const ensureTask = ensureMonitorTask ?? ensureMonitorTaskFile;
  try {
    ensureTask({ cwd: projectPath, env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook:vscode-task] ${msg}\n`);
  }

  const captured = captureCodexRolloutToDb(actualDb, {
    threadId: identity.codexThreadId,
    codexHome,
    projectPath,
  });

  if (captured.status !== 'captured') {
    return {
      status: 'skipped',
      reason: captured.reason ?? 'codex_capture_not_available',
      db: actualDb,
      identity,
      projectPath,
      codexHome,
      captured,
      summarized: null,
      monitorState: null,
      usage: null,
    };
  }

  const usage = (buildMonitorUsage ?? buildCodexMonitorUsage)(captured.rolloutPath);
  let monitorState = null;
  try {
    monitorState = {
      sessionId: captured.sessionId,
      host: 'codex',
      projectPath: captured.projectPath ?? projectPath,
      transcriptPath: null,
      rolloutPath: captured.rolloutPath ?? null,
      pid: process.pid,
      usage,
    };
    (writeMonitorState ?? writeSessionState)(monitorState);
  } catch (err) {
    monitorState = null;
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook:monitor-state] ${msg}\n`);
  }

  const summarized = summarize
    ? summarizeCodexSession(actualDb, {
        sessionId: captured.sessionId,
        projectPath: captured.projectPath ?? projectPath,
        max: 1,
        env,
      })
    : null;

  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    db: actualDb,
    identity,
    projectPath,
    codexHome,
    captured,
    summarized,
    monitorState,
    usage,
  };
}

export async function runCodexStopHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
  runAutoRefresh = null,
} = {}) {
  const [{ runCodexAutoRefresh }, capturedState] = await Promise.all([
    import('../codex-auto-refresh.mjs'),
    captureCodexHookSession({
      args,
      payload,
      env,
      db,
      writeMonitorState,
      ensureMonitorTask,
      buildMonitorUsage,
      summarize: true,
    }),
  ]);

  if (capturedState.status !== 'ok') {
    return {
      status: capturedState.status,
      reason: capturedState.reason,
      codexThreadIdSource: capturedState.identity?.codexThreadIdSource,
      captured: capturedState.captured,
      summarized: capturedState.summarized,
    };
  }

  let autoRefresh = null;
  try {
    autoRefresh = await (runAutoRefresh ?? runCodexAutoRefresh)({
      db: capturedState.db,
      threadId: capturedState.identity.codexThreadId,
      codexThreadIdSource: capturedState.identity.codexThreadIdSource,
      codexHome: capturedState.codexHome,
      projectPath: capturedState.captured.projectPath ?? capturedState.projectPath,
      sessionId: capturedState.captured.sessionId,
      usage: capturedState.usage,
      command: env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    autoRefresh = {
      status: 'error',
      reason: 'auto_refresh_failed',
      message: msg,
    };
    process.stderr.write(`[codex-hook:auto-refresh] ${msg}\n`);
  }

  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    codexThreadIdSource: capturedState.identity.codexThreadIdSource,
    captured: capturedState.captured,
    summarized: capturedState.summarized,
    monitorState: capturedState.monitorState,
    autoRefresh,
  };
}

export async function runCodexUserPromptSubmitHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
} = {}) {
  return runCodexContextRefreshInstructionHook({
    eventName: 'UserPromptSubmit',
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
  });
}

export async function runCodexPostToolUseHook({
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
} = {}) {
  return runCodexContextRefreshInstructionHook({
    eventName: 'PostToolUse',
    args,
    payload,
    env,
    db,
    writeMonitorState,
    ensureMonitorTask,
    buildMonitorUsage,
  });
}

async function runCodexContextRefreshInstructionHook({
  eventName,
  args = {},
  payload = {},
  env = process.env,
  db = null,
  writeMonitorState = null,
  ensureMonitorTask = null,
  buildMonitorUsage = null,
} = {}) {
  const [{ evaluateCodexAutoRefreshUsage }, capturedState] = await Promise.all([
    import('../codex-auto-refresh.mjs'),
    captureCodexHookSession({
      args,
      payload,
      env,
      db,
      writeMonitorState,
      ensureMonitorTask,
      buildMonitorUsage,
      summarize: false,
    }),
  ]);

  if (capturedState.status !== 'ok') {
    return {
      status: capturedState.status,
      reason: capturedState.reason,
      codexThreadIdSource: capturedState.identity?.codexThreadIdSource,
      captured: capturedState.captured,
      monitorState: capturedState.monitorState,
      autoRefreshPrompt: null,
    };
  }

  const decision = evaluateCodexAutoRefreshUsage(capturedState.usage);
  if (!decision.shouldRefresh) {
    return {
      status: 'ok',
      reason: 'codex_rollout_captured',
      codexThreadIdSource: capturedState.identity.codexThreadIdSource,
      captured: capturedState.captured,
      monitorState: capturedState.monitorState,
      autoRefreshPrompt: {
        status: 'skipped',
        reason: decision.reason,
        decision,
      },
    };
  }

  const context = renderAutoRefreshContext({
    usage: capturedState.usage,
    decision,
    threadId: capturedState.identity.codexThreadId,
    eventName,
  });
  return {
    status: 'ok',
    reason: 'codex_rollout_captured',
    codexThreadIdSource: capturedState.identity.codexThreadIdSource,
    captured: capturedState.captured,
    monitorState: capturedState.monitorState,
    autoRefreshPrompt: {
      status: 'ready',
      reason: 'threshold_reached',
      decision,
      context,
      output: codexContextOutput(context, eventName),
    },
  };
}

export async function run(argv = []) {
  suppressExperimentalWarnings();
  let parsed;
  let payload;
  try {
    parsed = parseArgs(argv);
    payload = parsePayload(await readStdin());
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-hook] ${msg}\n`);
    process.exit(1);
  }

  try {
    let result;
    if (parsed.event === 'user-prompt-submit') {
      result = await runCodexUserPromptSubmitHook({
        args: parsed,
        payload,
        env: process.env,
      });
    } else if (parsed.event === 'post-tool-use') {
      result = await runCodexPostToolUseHook({
        args: parsed,
        payload,
        env: process.env,
      });
    } else {
      result = await runCodexStopHook({
        args: parsed,
        payload,
        env: process.env,
      });
    }
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (result.autoRefreshPrompt?.output) {
      process.stdout.write(result.autoRefreshPrompt.output + '\n');
    }
    process.exit(result.status === 'ok' || result.status === 'skipped' ? 0 : 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'error',
            reason: err?.reason ?? 'codex_hook_failed',
            source: err?.source ?? null,
            message: msg,
            stderr: err?.stderr ?? '',
            exitCode: err?.exitCode ?? null,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`[codex-hook] ${msg}\n`);
    }
    process.exit(1);
  }
}

export const _internal = {
  codexHomeFromTranscriptPath,
  codexContextOutput,
  parseArgs,
  parsePayload,
  renderAutoRefreshContext,
  resolveCodexHookThreadIdentity,
};

function resolveCodexHookThreadIdentity({ args = {}, payload = {}, env, resolveCodexThreadIdentity }) {
  if (args.codexThreadId) {
    return resolveCodexThreadIdentity({ codexThreadId: args.codexThreadId }, env);
  }

  if (typeof payload.session_id === 'string' && payload.session_id) {
    return {
      codexThreadId: payload.session_id,
      codexThreadIdSource: 'payload:session_id',
    };
  }

  if (typeof payload.sessionId === 'string' && payload.sessionId) {
    return {
      codexThreadId: payload.sessionId,
      codexThreadIdSource: 'payload:sessionId',
    };
  }

  return resolveCodexThreadIdentity({ codexThreadId: null }, env);
}
