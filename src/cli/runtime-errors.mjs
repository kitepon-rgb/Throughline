import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  getRuntimeErrorDiagnostics,
  readRuntimeErrorSnapshot,
  reopenRuntimeError,
  resolveRuntimeError,
} from '../runtime-error-store.mjs';

const USAGE = 'usage: throughline runtime-errors <snapshot|diagnostics|ack|resolve|reopen|compact> [arguments] --json';

export function parseArgs(argv = []) {
  const command = argv[0];
  if (!['snapshot', 'diagnostics', 'ack', 'resolve', 'reopen', 'compact'].includes(command)) {
    throw new TypeError(USAGE);
  }
  const options = { command, json: false, afterCursor: 0, limit: 256, value: null };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json' && !options.json) {
      options.json = true;
    } else if (command === 'snapshot' && arg === '--after-cursor' && argv[index + 1]) {
      options.afterCursor = parseInteger(argv[++index], '--after-cursor');
    } else if (command === 'snapshot' && arg === '--limit' && argv[index + 1]) {
      options.limit = parseInteger(argv[++index], '--limit');
    } else if (['ack', 'resolve', 'reopen'].includes(command) && options.value === null && !arg.startsWith('-')) {
      options.value = arg;
    } else {
      throw new TypeError(USAGE);
    }
  }
  if (!options.json || (['ack', 'resolve', 'reopen'].includes(command) && options.value === null)) {
    throw new TypeError(USAGE);
  }
  return options;
}

export function run(argv = [], dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch {
    process.stderr.write(`[runtime-errors] ${USAGE}\n`);
    return 2;
  }

  try {
    const env = dependencies.env ?? process.env;
    let result;
    if (options.command === 'snapshot') {
      result = (dependencies.readSnapshot ?? readRuntimeErrorSnapshot)({
        env,
        afterCursor: options.afterCursor,
        limit: options.limit,
      });
    } else if (options.command === 'diagnostics') {
      result = (dependencies.getDiagnostics ?? getRuntimeErrorDiagnostics)({ env });
    } else if (options.command === 'ack') {
      result = (dependencies.acknowledge ?? acknowledgeRuntimeErrors)(
        parseInteger(options.value, 'cursor'),
        { env },
      );
    } else if (options.command === 'resolve') {
      result = (dependencies.resolve ?? resolveRuntimeError)(options.value, { env });
    } else if (options.command === 'reopen') {
      result = (dependencies.reopen ?? reopenRuntimeError)(options.value, { env });
    } else {
      result = (dependencies.compact ?? compactRuntimeErrors)({ env });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    process.stderr.write('[runtime-errors] operation_failed\n');
    return 1;
  }
}

function parseInteger(value, name) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError(`${name} invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} invalid`);
  return parsed;
}

export const _internal = { USAGE };
