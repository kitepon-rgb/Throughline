import { spawnSync } from 'node:child_process';

export const CODEX_HANDOFF_MODEL_SMOKE_ENV = 'THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE';
export const DEFAULT_CODEX_HANDOFF_MODEL_SMOKE_TIMEOUT_MS = 120_000;

function compactStderr(stderr) {
  if (!stderr) return '';
  const text = String(stderr);
  if (text.length <= 4_000) return text;
  return `${text.slice(0, 1_500)}\n...[stderr truncated]...\n${text.slice(-2_000)}`;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

export function buildCodexHandoffModelSmokePrompt({ handoffPrompt, marker }) {
  assertNonEmptyString(handoffPrompt, 'handoffPrompt');
  assertNonEmptyString(marker, 'marker');
  return [
    handoffPrompt,
    '',
    '### Throughline Fresh-Thread Handoff Model Smoke',
    'Read the handoff above as the initial context for a fresh Codex thread.',
    `Reply exactly with this marker and nothing else: ${marker}`,
  ].join('\n');
}

export function runCodexHandoffModelSmoke({
  prompt,
  marker,
  cwd,
  command = 'codex',
  timeoutMs = DEFAULT_CODEX_HANDOFF_MODEL_SMOKE_TIMEOUT_MS,
  env = process.env,
} = {}) {
  assertNonEmptyString(prompt, 'prompt');
  assertNonEmptyString(marker, 'marker');
  assertNonEmptyString(cwd, 'cwd');
  assertNonEmptyString(command, 'command');
  assertPositiveInteger(timeoutMs, 'timeoutMs');

  const result = spawnSync(
    command,
    [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      cwd,
      prompt,
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: process.platform === 'win32',
      env,
      cwd,
    },
  );

  const stdout = result.stdout ?? '';
  const stderr = compactStderr(result.stderr);
  if (result.error) {
    return {
      status: 'error',
      reason: result.error.name === 'TimeoutError' ? 'codex_cli_timeout' : 'codex_cli_spawn_error',
      marker,
      markerVisible: false,
      exitCode: result.status,
      signal: result.signal,
      stdout,
      stderr,
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      status: 'error',
      reason: 'codex_cli_failed',
      marker,
      markerVisible: false,
      exitCode: result.status,
      signal: result.signal,
      stdout,
      stderr,
    };
  }

  const markerVisible = stdout.includes(marker);
  return {
    status: markerVisible ? 'visible' : 'not-visible',
    reason: markerVisible ? 'marker_found_in_codex_exec_output' : 'marker_missing_from_codex_exec_output',
    marker,
    markerVisible,
    exitCode: result.status,
    signal: result.signal,
    stdout,
    stderr,
  };
}
