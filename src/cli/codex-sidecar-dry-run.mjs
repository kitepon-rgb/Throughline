import { inferWorkflowForPreset, runCodexSidecarDryRun } from '../codex-sidecar.mjs';

function parseArgs(args) {
  const out = {
    projectPath: process.cwd(),
    workflow: null,
    preset: 'review',
    contextFile: null,
    turnTimeoutMs: 30_000,
    promptParts: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--project requires a path');
      }
      out.projectPath = value;
    } else if (arg === '--workflow') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--workflow requires a value');
      }
      out.workflow = value;
    } else if (arg === '--preset') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--preset requires a value');
      }
      out.preset = value;
    } else if (arg === '--context-file') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--context-file requires a path');
      }
      out.contextFile = value;
    } else if (arg === '--turn-timeout-ms') {
      const value = args[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--turn-timeout-ms must be a positive integer');
      }
      out.turnTimeoutMs = parsed;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument: ${arg}`);
    } else {
      out.promptParts.push(arg);
    }
  }

  return {
    projectPath: out.projectPath,
    workflow: out.workflow ?? inferWorkflowForPreset(out.preset),
    preset: out.preset,
    contextFile: out.contextFile,
    turnTimeoutMs: out.turnTimeoutMs,
    prompt: out.promptParts.length > 0 ? out.promptParts.join(' ') : null,
  };
}

export function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-sidecar-dry-run] ${msg}\n`);
    process.exit(1);
  }

  const result = runCodexSidecarDryRun({
    projectPath: parsed.projectPath,
    workflow: parsed.workflow,
    preset: parsed.preset,
    contextFile: parsed.contextFile,
    prompt: parsed.prompt,
    turnTimeoutMs: parsed.turnTimeoutMs,
    timeoutMs: parsed.turnTimeoutMs + 5_000,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'dry-run' ? 0 : 1);
}
