import { diagnoseCodexSidecar } from '../codex-sidecar.mjs';

function parseArgs(args) {
  const out = {
    projectPath: process.cwd(),
    preset: 'review',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--project requires a path');
      }
      out.projectPath = value;
    } else if (arg === '--preset') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--preset requires a value');
      }
      out.preset = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

export function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-sidecar-diagnostics] ${msg}\n`);
    process.exit(1);
  }

  const result = diagnoseCodexSidecar({
    projectPath: parsed.projectPath,
    preset: parsed.preset,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'configured' ? 0 : 1);
}
