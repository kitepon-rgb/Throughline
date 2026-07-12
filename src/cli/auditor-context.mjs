import {
  AUDITOR_CONTEXT_SCHEMA,
  deriveAuditorFreshnessExpectation,
  readAuditorContext,
} from '../auditor-context.mjs';

const ERROR_SCHEMA = AUDITOR_CONTEXT_SCHEMA;
const ARGS_ERROR = {
  schema: ERROR_SCHEMA,
  status: 'error',
  code: 'E_AUDITOR_CONTEXT_ARGS',
  message: 'invalid auditor-context arguments',
};
const INTERNAL_ERROR = {
  schema: ERROR_SCHEMA,
  status: 'error',
  code: 'E_AUDITOR_CONTEXT_INTERNAL',
  message: 'auditor context could not be read',
};

export function parseArgs(argv = []) {
  const out = {
    sessionId: null,
    projectRoot: null,
    expectedOriginSessionId: null,
    expectedTurnNumber: null,
    expectedUserSha256: null,
    expectedAssistantSha256: null,
    recentTurns: undefined,
    maxBodyChars: undefined,
    maxTotalChars: undefined,
    dbPath: undefined,
    host: null,
    transcriptPath: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new TypeError('missing option value');
    if (arg === '--session') out.sessionId = value;
    else if (arg === '--project') out.projectRoot = value;
    else if (arg === '--expected-origin-session') out.expectedOriginSessionId = value;
    else if (arg === '--expected-turn-number') out.expectedTurnNumber = parseNonNegativeInteger(value);
    else if (arg === '--expected-user-sha256') out.expectedUserSha256 = parseSha256(value);
    else if (arg === '--expected-assistant-sha256') out.expectedAssistantSha256 = parseSha256(value);
    else if (arg === '--recent-turns') out.recentTurns = parsePositiveInteger(value);
    else if (arg === '--max-body-chars') out.maxBodyChars = parsePositiveInteger(value);
    else if (arg === '--max-total-chars') out.maxTotalChars = parsePositiveInteger(value);
    else if (arg === '--db') out.dbPath = value;
    else if (arg === '--host' && (value === 'claude' || value === 'codex')) out.host = value;
    else if (arg === '--transcript') out.transcriptPath = value;
    else throw new TypeError('unknown option');
  }

  if (
    !out.json ||
    !out.sessionId ||
    !out.projectRoot ||
    !hasFreshnessSource(out)
  ) {
    throw new TypeError('missing required option');
  }
  return out;
}

export function run(argv = [], {
  read = readAuditorContext,
  deriveExpectation = deriveAuditorFreshnessExpectation,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    writeJson(stderr, ARGS_ERROR);
    return 1;
  }

  try {
    const derived = args.host
      ? deriveExpectation({ host: args.host, transcriptPath: args.transcriptPath, sessionId: args.sessionId })
      : null;
    const result = read({
      dbPath: args.dbPath,
      sessionId: args.sessionId,
      projectRoot: args.projectRoot,
      expectedOriginSessionId: derived?.expectedOriginSessionId ?? args.expectedOriginSessionId,
      expectedTurnNumber: derived?.expectedTurnNumber ?? args.expectedTurnNumber,
      expectedUserSha256: derived?.expectedUserSha256 ?? args.expectedUserSha256,
      expectedAssistantSha256: derived?.expectedAssistantSha256 ?? args.expectedAssistantSha256,
      recentTurns: args.recentTurns,
      maxBodyChars: args.maxBodyChars,
      maxTotalChars: args.maxTotalChars,
    });
    writeJson(stdout, result);
    return 0;
  } catch {
    writeJson(stderr, INTERNAL_ERROR);
    return 1;
  }
}

function hasFreshnessSource(args) {
  const hasTranscript = Boolean(args.host && args.transcriptPath);
  const hasExplicitPair = Boolean(
    args.expectedOriginSessionId &&
    args.expectedTurnNumber !== null &&
    args.expectedUserSha256 &&
    args.expectedAssistantSha256
  );
  return hasTranscript !== hasExplicitPair;
}

function parseNonNegativeInteger(value) {
  if (!/^\d+$/.test(value)) throw new TypeError('invalid integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('invalid integer');
  return parsed;
}

function parsePositiveInteger(value) {
  const parsed = parseNonNegativeInteger(value);
  if (parsed < 1) throw new TypeError('invalid integer');
  return parsed;
}

function parseSha256(value) {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new TypeError('invalid hash');
  return value.toLowerCase();
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}
