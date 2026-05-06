import { listCodexThreadCandidates } from '../codex-thread-index.mjs';

function parseArgs(args) {
  const out = {
    json: false,
    allProjects: false,
    limit: 10,
    codexHome: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--all-projects') {
      out.allProjects = true;
    } else if (arg === '--limit') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--limit must be an integer >= 1');
      }
      out.limit = value;
    } else if (arg === '--codex-home') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error('--codex-home requires a path');
      }
      out.codexHome = value;
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
    process.stderr.write(`[codex-threads] ${msg}\n`);
    process.exit(1);
  }

  const candidates = listCodexThreadCandidates({
    codexHome: parsed.codexHome ?? undefined,
    projectPath: process.cwd(),
    allProjects: parsed.allProjects,
    limit: parsed.limit,
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify({ candidates }, null, 2) + '\n');
    process.exit(0);
  }

  process.stdout.write(renderReport(candidates, { allProjects: parsed.allProjects }) + '\n');
  process.exit(0);
}

function renderReport(candidates, { allProjects }) {
  const lines = [];
  lines.push('## Codex Thread Candidates');
  lines.push('');
  lines.push(`Scope: ${allProjects ? 'all projects' : 'current project'}`);
  lines.push('Read-only: yes');
  lines.push('');

  if (candidates.length === 0) {
    lines.push('No Codex rollout candidates found.');
    lines.push('Pass --all-projects to inspect other projects, or --codex-home <path> for a non-default CODEX_HOME.');
    return lines.join('\n');
  }

  for (const candidate of candidates) {
    lines.push(`- ${candidate.id}`);
    if (candidate.threadName) lines.push(`  name: ${candidate.threadName}`);
    lines.push(`  updated: ${candidate.updatedAt ?? 'unknown'}`);
    lines.push(`  cwd: ${candidate.cwd ?? 'unknown'}`);
    lines.push(`  rollout: ${candidate.rolloutPath}`);
  }

  lines.push('');
  lines.push('Use one candidate explicitly with throughline trim --host codex --codex-thread-id <id>.');
  lines.push('This command never selects a thread for automatic trim.');
  return lines.join('\n');
}
