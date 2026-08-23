import { spawnPortableSync } from './os/portable-spawn-sync.mjs';
import { isWin32Platform } from './os/paths.mjs';

export const CODEX_SIDECAR_WORKFLOWS = Object.freeze([
  'review',
  'explore',
  'work',
  'opinion',
  'risk-check',
]);

export const CODEX_SIDECAR_STATUS = Object.freeze({
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
  CONFIGURED: 'configured',
  OPERATIONAL: 'operational',
  WORK_CAPABLE: 'work-capable',
});

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveCommand({ command, env }) {
  return command ?? env.THROUGHLINE_CODEX_SIDECAR_BIN ?? 'codex-sidecar';
}

export function shouldShellWrapSidecarCommand(platform = process.platform) {
  return isWin32Platform(platform);
}

export function runCodexSidecarCommand(command, args, options = {}) {
  return spawnPortableSync(command, args, options);
}

export function inferWorkflowForPreset(preset) {
  if (CODEX_SIDECAR_WORKFLOWS.includes(preset)) return preset;
  if (preset === 'summarize-l1') return 'explore';
  return 'review';
}

/**
 * Run codex-sidecar diagnostics without treating command presence as success.
 *
 * configured means diagnostics exited 0 for this repository. Any spawn failure
 * or non-zero diagnostics result is explicit unavailable, not a hidden fallback.
 *
 * @param {{
 *   projectPath: string,
 *   preset?: string,
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 * }} params
 */
export function diagnoseCodexSidecar({
  projectPath,
  preset = 'review',
  command = null,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!projectPath) {
    throw new Error('diagnoseCodexSidecar: projectPath is required');
  }

  if (env.THROUGHLINE_CODEX_SIDECAR_DISABLED === '1') {
    return {
      status: CODEX_SIDECAR_STATUS.DISABLED,
      reason: 'disabled_by_env',
      command: null,
      projectPath,
      preset,
    };
  }

  const resolvedCommand = resolveCommand({ command, env });
  const args = ['diagnostics', '--project', projectPath, '--preset', preset];
  const result = runCodexSidecarCommand(resolvedCommand, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
  });

  if (result.error) {
    return {
      status: CODEX_SIDECAR_STATUS.UNAVAILABLE,
      reason: result.error.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed',
      command: resolvedCommand,
      args,
      projectPath,
      preset,
      error: result.error.message,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  if (result.status !== 0) {
    return {
      status: CODEX_SIDECAR_STATUS.UNAVAILABLE,
      reason: 'diagnostics_failed',
      command: resolvedCommand,
      args,
      projectPath,
      preset,
      exitCode: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  return {
    status: CODEX_SIDECAR_STATUS.CONFIGURED,
    reason: 'diagnostics_passed',
    command: resolvedCommand,
    args,
    projectPath,
    preset,
    exitCode: 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build and execute a codex-sidecar dry-run request.
 *
 * This intentionally does not treat command presence as success. Callers get a
 * structured failed result on spawn / parse / non-zero cases.
 *
 * @param {{
 *   projectPath: string,
 *   workflow?: string,
 *   preset?: string,
 *   contextFile?: string | null,
 *   prompt?: string | null,
 *   turnTimeoutMs?: number | null,
 *   command?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 * }} params
 */
export function runCodexSidecarDryRun({
  projectPath,
  workflow = null,
  preset = 'review',
  contextFile = null,
  prompt = null,
  turnTimeoutMs = null,
  command = null,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!projectPath) {
    throw new Error('runCodexSidecarDryRun: projectPath is required');
  }

  const resolvedWorkflow = workflow ?? inferWorkflowForPreset(preset);
  if (!CODEX_SIDECAR_WORKFLOWS.includes(resolvedWorkflow)) {
    throw new Error(
      `runCodexSidecarDryRun: workflow must be one of ${CODEX_SIDECAR_WORKFLOWS.join(', ')}`,
    );
  }

  const resolvedCommand = resolveCommand({ command, env });
  const args = [
    resolvedWorkflow,
    '--project',
    projectPath,
    '--preset',
    preset,
    '--dry-run',
  ];
  if (contextFile) {
    args.push('--context-file', contextFile);
  }
  if (turnTimeoutMs !== null) {
    if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 1) {
      throw new Error('runCodexSidecarDryRun: turnTimeoutMs must be a positive integer');
    }
    args.push('--turn-timeout-ms', String(turnTimeoutMs));
  }
  if (prompt) {
    args.push(prompt);
  }

  const result = runCodexSidecarCommand(resolvedCommand, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
  });

  if (result.error) {
    return {
      status: 'failed',
      reason: result.error.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed',
      command: resolvedCommand,
      args,
      projectPath,
      workflow: resolvedWorkflow,
      preset,
      error: result.error.message,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  if (result.status !== 0) {
    return {
      status: 'failed',
      reason: 'dry_run_failed',
      command: resolvedCommand,
      args,
      projectPath,
      workflow: resolvedWorkflow,
      preset,
      exitCode: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  try {
    return {
      ...JSON.parse(result.stdout),
      command: resolvedCommand,
      args,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'invalid_json',
      command: resolvedCommand,
      args,
      projectPath,
      workflow: resolvedWorkflow,
      preset,
      error: err instanceof Error ? err.message : String(err),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
}
