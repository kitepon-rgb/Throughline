import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  runCodexRollbackModelVisiblePrepare,
  runCodexRollbackModelVisibleVerify,
} from '../codex-app-server.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';

const EXPERIMENTAL_ENV = 'THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE';
const MARKER_PREFIX = 'TL_ROLLBACK_MODEL_VISIBLE_';
const NOT_VISIBLE_TOKEN = 'TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE';

function parseArgs(args) {
  const out = {
    mode: null,
    codexThreadId: null,
    marker: null,
    markerFile: null,
    markerPrefix: MARKER_PREFIX,
    markerPrefixExplicit: false,
    json: false,
    afterVsCodeRestart: false,
    codexAppServerBin: null,
    timeoutMs: 180_000,
    requestTimeoutMs: 150_000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prepare') {
      if (out.mode) throw new Error('pass only one of --prepare or --verify');
      out.mode = 'prepare';
    } else if (arg === '--verify') {
      if (out.mode) throw new Error('pass only one of --prepare or --verify');
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
    } else if (arg === '--marker-file') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--marker-file requires a path');
      }
      out.markerFile = value;
    } else if (arg === '--marker-prefix') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--marker-prefix requires a prefix string');
      }
      out.markerPrefix = value;
      out.markerPrefixExplicit = true;
    } else if (arg === '--after-vscode-restart') {
      out.afterVsCodeRestart = true;
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
  if (out.marker && out.markerFile) {
    throw new Error('pass only one of --marker or --marker-file');
  }
  if (out.mode === 'prepare' && out.markerFile && !out.marker && !out.markerPrefixExplicit) {
    out.markerPrefix = `${MARKER_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 8)}_`;
  }
  if (out.mode === 'prepare' && !out.marker) {
    out.marker = `${out.markerPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  }

  return out;
}

function markerFilePath(path) {
  return resolve(process.cwd(), path);
}

function readMarkerFile(path) {
  const raw = readFileSync(markerFilePath(path), 'utf8');
  try {
    const payload = JSON.parse(raw);
    if (typeof payload.marker === 'string' && payload.marker) {
      return {
        marker: payload.marker,
        markerPrefix:
          typeof payload.markerPrefix === 'string' && payload.markerPrefix
            ? payload.markerPrefix
            : MARKER_PREFIX,
      };
    }
  } catch {
    const marker = raw.trim();
    if (marker) return { marker, markerPrefix: MARKER_PREFIX };
  }
  throw new Error('--marker-file must contain a marker string or JSON with marker');
}

function writeMarkerFile(path, payload) {
  writeFileSync(markerFilePath(path), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex rollback model-visible smoke');
  lines.push('');
  lines.push(`  mode:          ${result.mode ?? 'unknown'}`);
  lines.push(`  status:        ${result.status}`);
  lines.push(`  reason:        ${result.reason}`);
  lines.push(`  thread:        ${result.threadId ?? 'unknown'}`);
  lines.push(`  marker:        ${result.marker ?? 'unknown'}`);
  lines.push(`  proof scope:   ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe:  ${result.restartSafe ? 'yes' : 'no'}`);
  if (result.afterVsCodeRestart !== undefined) {
    lines.push(`  after restart: ${result.afterVsCodeRestart ? 'yes' : 'no'}`);
  }
  if (result.promptIncludesMarker !== undefined) {
    lines.push(`  prompt includes marker: ${result.promptIncludesMarker ? 'yes' : 'no'}`);
  }
  if (result.rolledBackMarkerModelVisible !== undefined) {
    const visible =
      result.rolledBackMarkerModelVisible === true
        ? 'yes'
        : result.rolledBackMarkerModelVisible === false
        ? 'no'
        : 'unknown';
    lines.push(`  rolled-back marker visible: ${visible}`);
  }
  if (result.modelReportedNotVisible !== undefined) {
    lines.push(`  model reported not visible: ${result.modelReportedNotVisible ? 'yes' : 'no'}`);
  }
  if (result.setupTurnStartSent !== undefined) {
    lines.push(`  setup turn:    ${result.setupTurnStartSent ? 'started' : 'not-started'}`);
  }
  if (result.rollbackSent !== undefined) {
    lines.push(`  rollback:      ${result.rollbackSent ? 'sent' : 'not-sent'}`);
  }
  if (result.turnStartSent !== undefined) {
    lines.push(`  verify turn:   ${result.turnStartSent ? 'started' : 'not-started'}`);
  }
  if (Array.isArray(result.observedMarkers)) {
    lines.push(`  observed markers: ${result.observedMarkers.length}`);
  }
  if (result.agentText) {
    lines.push('');
    lines.push('agent text:');
    lines.push(result.agentText);
  }
  if (result.nextCommand) {
    lines.push('');
    lines.push('next command:');
    lines.push(result.nextCommand);
  }
  return lines.join('\n');
}

function requireExperimentalEnv(parsed) {
  if (process.env[EXPERIMENTAL_ENV] === '1') return null;
  return {
    mode: parsed.mode,
    status: 'refused',
    reason: 'experimental_env_required',
    requiredEnv: `${EXPERIMENTAL_ENV}=1`,
    proofScope: 'none',
    restartSafe: false,
  };
}

function buildNextCommand({ marker, markerFile, threadId, appServerBin }) {
  const parts = [
    `${EXPERIMENTAL_ENV}=1`,
    'throughline',
    'codex-rollback-model-visible-smoke',
    '--verify',
    '--codex-thread-id',
    threadId,
  ];
  if (markerFile) {
    parts.push('--marker-file', markerFile);
  } else {
    parts.push('--marker', marker);
  }
  parts.push('--after-vscode-restart');
  if (appServerBin) {
    parts.push('--codex-app-server-bin', appServerBin);
  }
  return parts.join(' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maybeRedactMarker(result, { markerFile, markerPrefix }) {
  if (!markerFile) return result;
  const redacted = {
    ...result,
    marker: '[redacted]',
    markerFile,
    markerRedacted: true,
  };
  if (Array.isArray(redacted.observedMarkers) && redacted.observedMarkers.length > 0) {
    redacted.observedMarkers = redacted.observedMarkers.map(() => '[redacted]');
  }
  if (typeof redacted.agentText === 'string' && typeof result.marker === 'string') {
    redacted.agentText = redacted.agentText.replaceAll(result.marker, '[redacted]');
    if (markerPrefix) {
      redacted.agentText = redacted.agentText.replace(
        new RegExp(`${escapeRegExp(markerPrefix)}[A-Za-z0-9_-]+`, 'g'),
        '[redacted]',
      );
    }
  }
  return redacted;
}

async function runPrepare(parsed) {
  const marker = parsed.marker;
  if (parsed.markerFile) {
    writeMarkerFile(parsed.markerFile, {
      marker,
      markerPrefix: parsed.markerPrefix,
      threadId: parsed.codexThreadId,
      preparedAt: new Date().toISOString(),
      mode: 'codex-rollback-model-visible-smoke',
    });
  }
  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const result = await runCodexRollbackModelVisiblePrepare({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    marker,
    command,
    timeoutMs: parsed.timeoutMs,
    requestTimeoutMs: parsed.requestTimeoutMs,
  });
  return {
    mode: 'prepare',
    ...result,
    nextCommand: buildNextCommand({
      marker,
      markerFile: parsed.markerFile,
      threadId: parsed.codexThreadId,
      appServerBin: parsed.codexAppServerBin,
    }),
  };
}

async function runVerify(parsed) {
  if (parsed.markerFile) {
    const markerPayload = readMarkerFile(parsed.markerFile);
    parsed.marker = markerPayload.marker;
    parsed.markerPrefix = markerPayload.markerPrefix;
  }
  if (!parsed.marker) {
    return {
      mode: 'verify',
      status: 'refused',
      reason: 'marker_required_for_verify',
      proofScope: 'none',
      restartSafe: false,
      threadId: parsed.codexThreadId,
    };
  }
  if (!parsed.marker.startsWith(parsed.markerPrefix)) {
    return {
      mode: 'verify',
      status: 'refused',
      reason: 'marker_prefix_mismatch',
      expectedPrefix: parsed.markerPrefix,
      proofScope: 'none',
      restartSafe: false,
      threadId: parsed.codexThreadId,
      marker: parsed.marker,
    };
  }

  const command = parsed.codexAppServerBin ?? process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex';
  const result = await runCodexRollbackModelVisibleVerify({
    threadId: parsed.codexThreadId,
    cwd: process.cwd(),
    marker: parsed.marker,
    markerPrefix: parsed.markerPrefix,
    notVisibleToken: NOT_VISIBLE_TOKEN,
    command,
    timeoutMs: parsed.timeoutMs,
    requestTimeoutMs: parsed.requestTimeoutMs,
  });
  return {
    mode: 'verify',
    afterVsCodeRestart: parsed.afterVsCodeRestart,
    ...result,
  };
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-rollback-model-visible-smoke] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity({ codexThreadId: parsed.codexThreadId }, process.env),
  };

  let result = requireExperimentalEnv(parsed);
  if (!result && !parsed.codexThreadId) {
    result = {
      mode: parsed.mode,
      status: 'refused',
      reason: 'codex_thread_id_required',
      proofScope: 'none',
      restartSafe: false,
    };
  }

  if (!result) {
    result = parsed.mode === 'prepare' ? await runPrepare(parsed) : await runVerify(parsed);
  }
  result = maybeRedactMarker(result, {
    markerFile: parsed.markerFile,
    markerPrefix: parsed.markerPrefix,
  });

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const stream = result.status === 'refused' ? process.stderr : process.stdout;
    stream.write(renderTextResult(result) + '\n');
  }

  const ok =
    (parsed.mode === 'prepare' && result.status === 'prepared') ||
    (parsed.mode === 'verify' && result.status === 'not-reproduced');
  process.exit(ok ? 0 : 1);
}

export const _internal = {
  parseArgs,
};
