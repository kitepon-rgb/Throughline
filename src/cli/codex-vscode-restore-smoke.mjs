import {
  buildCodexVsCodeRestoreSmokeMemory,
  buildCodexVsCodeRestoreSmokePrompt,
  inspectCodexVsCodeRestoreSmokeRollout,
  makeCodexVsCodeRestoreSmokeMarker,
} from '../codex-vscode-restore-smoke.mjs';
import { runCodexDeveloperMemoryInject } from '../codex-app-server.mjs';
import { defaultCodexHome } from '../codex-thread-index.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';

const CODEX_VSCODE_RESTORE_SMOKE_ENV = 'THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE';

function parseArgs(args) {
  const out = {
    mode: null,
    codexThreadId: null,
    marker: null,
    preparedAt: null,
    afterVsCodeRestart: false,
    json: false,
    codexHome: defaultCodexHome(),
    codexAppServerBin: null,
    timeoutMs: 60_000,
    requestTimeoutMs: 20_000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prepare') {
      out.mode = 'prepare';
    } else if (arg === '--verify') {
      out.mode = 'verify';
    } else if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-thread-id requires a thread id');
      }
      out.codexThreadId = value;
    } else if (arg === '--marker') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--marker requires a marker string');
      }
      out.marker = value;
    } else if (arg === '--prepared-at') {
      const value = args[++i];
      if (!value || value.startsWith('-') || Number.isNaN(Date.parse(value))) {
        throw new Error('--prepared-at requires an ISO timestamp');
      }
      out.preparedAt = value;
    } else if (arg === '--after-vscode-restart') {
      out.afterVsCodeRestart = true;
    } else if (arg === '--codex-home') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-home requires a path');
      }
      out.codexHome = value;
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
    } else if (arg === '--json') {
      out.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!out.mode) out.mode = 'verify';
  return out;
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex vscode restore smoke');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  thread:       ${result.threadId ?? 'unknown'}`);
  lines.push(`  marker:       ${result.marker ?? 'unknown'}`);
  lines.push(`  proof scope:  ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe: ${result.restartSafe ? 'yes' : 'no'}`);
  if (result.rolloutPath) lines.push(`  rollout:      ${result.rolloutPath}`);
  if (result.preparedAt) lines.push(`  prepared at:  ${result.preparedAt}`);
  if (result.prompt) {
    lines.push('');
    lines.push('VS Code prompt after reload/reconnect:');
    lines.push(result.prompt);
  }
  if (Array.isArray(result.assistantMarkerMatches)) {
    lines.push(`  assistant marker matches: ${result.assistantMarkerMatches.length}`);
    lines.push(`  user marker leaks:        ${result.userMarkerMatches.length}`);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-vscode-restore-smoke] ${msg}\n`);
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
    else process.stderr.write(`[codex-vscode-restore-smoke] ${result.reason}\n`);
    process.exit(1);
  }

  if (parsed.mode === 'prepare') {
    const result = await prepareSmoke(parsed);
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(renderTextResult(result) + '\n');
    process.exit(result.status === 'prepared' ? 0 : 1);
  }

  const result = verifySmoke(parsed);
  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'vscode-restart-visible' ? 0 : 1);
}

async function prepareSmoke(parsed) {
  if (process.env[CODEX_VSCODE_RESTORE_SMOKE_ENV] !== '1') {
    return {
      status: 'refused',
      reason: 'experimental_env_required',
      requiredEnv: `${CODEX_VSCODE_RESTORE_SMOKE_ENV}=1`,
      proofScope: 'none',
      restartSafe: false,
      threadId: parsed.codexThreadId,
    };
  }

  const marker = parsed.marker ?? makeCodexVsCodeRestoreSmokeMarker();
  const preparedAt = new Date().toISOString();
  const memoryText = buildCodexVsCodeRestoreSmokeMemory({ marker });
  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const inject = await runCodexDeveloperMemoryInject({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    memoryText,
    command,
    timeoutMs: parsed.timeoutMs,
    requestTimeoutMs: parsed.requestTimeoutMs,
  });

  return {
    status: 'prepared',
    reason: 'developer_memory_marker_injected',
    proofScope: 'pending_manual_vscode_reload',
    restartSafe: false,
    threadId: parsed.codexThreadId,
    marker,
    preparedAt,
    prompt: buildCodexVsCodeRestoreSmokePrompt(),
    verifyArgs: [
      'throughline',
      'codex-vscode-restore-smoke',
      '--verify',
      '--codex-thread-id',
      parsed.codexThreadId,
      '--marker',
      marker,
      '--prepared-at',
      preparedAt,
      '--after-vscode-restart',
    ],
    inject,
  };
}

function verifySmoke(parsed) {
  if (!parsed.marker) {
    return {
      status: 'refused',
      reason: 'marker_required',
      proofScope: 'none',
      restartSafe: false,
      threadId: parsed.codexThreadId,
    };
  }

  return inspectCodexVsCodeRestoreSmokeRollout({
    threadId: parsed.codexThreadId,
    marker: parsed.marker,
    codexHome: parsed.codexHome,
    projectPath: process.cwd(),
    preparedAt: parsed.preparedAt,
    afterVsCodeRestart: parsed.afterVsCodeRestart,
  });
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
