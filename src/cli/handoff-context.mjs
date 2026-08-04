import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildBudgetedResumeContext } from '../resume-context.mjs';

export const HANDOFF_CONTEXT_SCHEMA = 'throughline.handoff_context.v1';

export function parseArgs(argv = []) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--session' ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[2] !== '--json'
  ) {
    throw new TypeError('usage error');
  }
  return { sessionId: argv[1] };
}

export function readHandoffContext(sessionId, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return buildBudgetedResumeContext(db, {
      sessionId,
      isInheritance: true,
    })?.text ?? null;
  } finally {
    db.close();
  }
}

export function run(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  readContext = readHandoffContext,
} = {}) {
  let sessionId;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch {
    stderr.write('Usage: throughline handoff-context --session <id> --json\n');
    return 2;
  }

  let context;
  try {
    context = readContext(sessionId);
  } catch {
    stderr.write('Throughline handoff context could not be read.\n');
    return 1;
  }
  if (!context) {
    stderr.write('Throughline handoff context is not available for that session.\n');
    return 1;
  }

  stdout.write(`${JSON.stringify({
    schema: HANDOFF_CONTEXT_SCHEMA,
    status: 'ready',
    sessionId,
    context,
  })}\n`);
  return 0;
}
