import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { sameProjectPath } from '../project-path.mjs';
import {
  buildBudgetedResumeContext,
  INJECTION_BUDGET_CHARS,
} from '../resume-context.mjs';

export const HANDOFF_CONTEXT_SCHEMA = 'throughline.handoff_context.v1';
export const HANDOFF_SUPPLEMENT_SCHEMA = 'throughline.handoff_supplement.v1';

export function parseArgs(argv = []) {
  const baseArgsInvalid =
    (argv.length !== 3 && argv.length !== 5) ||
    argv[0] !== '--session' ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[2] !== '--json';
  const supplementArgsValid = argv.length === 3 || (
    argv[3] === '--supplement-file' &&
    typeof argv[4] === 'string' &&
    argv[4].length > 0
  );
  if (baseArgsInvalid || !supplementArgsValid) {
    throw new TypeError('usage error');
  }
  return {
    sessionId: argv[1],
    supplementFile: argv.length === 5 ? argv[4] : null,
  };
}

export function renderHandoffSupplement(value, projectPath) {
  if (
    value?.schema !== HANDOFF_SUPPLEMENT_SCHEMA ||
    !isAbsolute(value.projectPath) ||
    !sameProjectPath(value.projectPath, projectPath) ||
    !Array.isArray(value.sections) ||
    value.sections.length === 0
  ) {
    throw new TypeError('invalid handoff supplement');
  }

  const sections = value.sections.map((section) => {
    if (
      typeof section?.title !== 'string' || section.title.length === 0 ||
      typeof section?.content !== 'string' || section.content.length === 0
    ) {
      throw new TypeError('invalid handoff supplement section');
    }
    return `### ${section.title}\n${section.content}`;
  });
  return ['## このBotの長期記憶と関連知識', ...sections].join('\n\n');
}

export function readHandoffContext(sessionId, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
  supplementFile = null,
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let supplementContext = null;
    if (supplementFile) {
      const row = db.prepare(
        'SELECT project_path FROM sessions WHERE session_id = ?',
      ).get(sessionId);
      if (!row?.project_path) return null;
      supplementContext = renderHandoffSupplement(
        JSON.parse(readFileSync(supplementFile, 'utf8')),
        row.project_path,
      );
    }

    const separator = supplementContext ? '\n\n' : '';
    const context = buildBudgetedResumeContext(db, {
      sessionId,
      isInheritance: true,
      maxChars: INJECTION_BUDGET_CHARS - (supplementContext?.length ?? 0) - separator.length,
    })?.text ?? null;
    if (!context && !supplementContext) return null;

    const combined = supplementContext && context
      ? `${supplementContext}${separator}${context}`
      : supplementContext ?? context;
    if (combined.length > INJECTION_BUDGET_CHARS) {
      throw new RangeError('handoff context exceeds injection budget');
    }
    return combined;
  } finally {
    db.close();
  }
}

export function readSessionProjectPath(sessionId, {
  dbPath = join(homedir(), '.throughline', 'throughline.db'),
} = {}) {
  if (!existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(
      'SELECT project_path FROM sessions WHERE session_id = ?',
    ).get(sessionId);
    const projectPath = row?.project_path;
    return typeof projectPath === 'string' && projectPath.length > 0
      ? projectPath
      : null;
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
  let supplementFile;
  try {
    ({ sessionId, supplementFile } = parseArgs(argv));
  } catch {
    stderr.write(
      'Usage: throughline handoff-context --session <id> --json [--supplement-file <path>]\n',
    );
    return 2;
  }

  let context;
  try {
    context = readContext(sessionId, { supplementFile });
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
