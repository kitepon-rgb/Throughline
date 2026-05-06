import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const CODEX_APP_SERVER_METHODS = Object.freeze({
  initialize: 'initialize',
  initialized: 'initialized',
  threadRead: 'thread/read',
  threadResume: 'thread/resume',
  threadRollback: 'thread/rollback',
  threadInjectItems: 'thread/inject_items',
  turnStart: 'turn/start',
});

export function encodeAppServerMessage(message) {
  if (!isRecord(message)) {
    throw new Error('encodeAppServerMessage: message must be an object');
  }
  return `${JSON.stringify(message)}\n`;
}

export function parseAppServerLine(line) {
  if (typeof line !== 'string') {
    throw new Error('parseAppServerLine: line must be a string');
  }

  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('parseAppServerLine: line must not be empty');
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    throw new Error(`parseAppServerLine: invalid JSON: ${msg}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('parseAppServerLine: decoded message must be an object');
  }

  if ('error' in parsed && 'id' in parsed) {
    if (!isRequestId(parsed.id) || !isRecord(parsed.error)) {
      throw new Error('parseAppServerLine: invalid error response');
    }
    const { code, message, data } = parsed.error;
    if (typeof code !== 'number' || typeof message !== 'string') {
      throw new Error('parseAppServerLine: invalid error response');
    }
    return {
      kind: 'error',
      id: parsed.id,
      error: { code, message, data },
    };
  }

  if ('result' in parsed && 'id' in parsed) {
    if (!isRequestId(parsed.id)) {
      throw new Error('parseAppServerLine: invalid response id');
    }
    return {
      kind: 'response',
      id: parsed.id,
      result: parsed.result,
    };
  }

  if (typeof parsed.method === 'string') {
    if ('id' in parsed) {
      if (!isRequestId(parsed.id)) {
        throw new Error('parseAppServerLine: invalid server request id');
      }
      return {
        kind: 'request',
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      };
    }
    return {
      kind: 'notification',
      method: parsed.method,
      params: parsed.params,
    };
  }

  throw new Error('parseAppServerLine: unrecognized message shape');
}

export function buildInitializeRequest({
  id,
  clientName = 'throughline',
  clientTitle = 'Throughline',
  version = '0.0.0',
  optOutNotificationMethods = [],
}) {
  assertRequestId(id, 'buildInitializeRequest');
  if (!Array.isArray(optOutNotificationMethods)) {
    throw new Error('buildInitializeRequest: optOutNotificationMethods must be an array');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.initialize,
    params: {
      clientInfo: {
        name: clientName,
        title: clientTitle,
        version,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods,
      },
    },
  };
}

export function buildInitializedNotification() {
  return {
    method: CODEX_APP_SERVER_METHODS.initialized,
  };
}

export function buildThreadReadRequest({ id, threadId, includeTurns = true }) {
  assertRequestId(id, 'buildThreadReadRequest');
  assertNonEmptyString(threadId, 'buildThreadReadRequest: threadId');
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadRead,
    params: {
      threadId,
      includeTurns: Boolean(includeTurns),
    },
  };
}

export function buildThreadResumeRequest({
  id,
  threadId,
  cwd,
  approvalPolicy = null,
  sandbox = null,
  model = null,
  excludeTurns = false,
}) {
  assertRequestId(id, 'buildThreadResumeRequest');
  assertNonEmptyString(threadId, 'buildThreadResumeRequest: threadId');
  return compactNullish({
    id,
    method: CODEX_APP_SERVER_METHODS.threadResume,
    params: compactNullish({
      threadId,
      cwd,
      approvalPolicy,
      sandbox,
      model,
      excludeTurns: Boolean(excludeTurns),
    }),
  });
}

export function buildThreadRollbackRequest({ id, threadId, numTurns }) {
  assertRequestId(id, 'buildThreadRollbackRequest');
  assertNonEmptyString(threadId, 'buildThreadRollbackRequest: threadId');
  if (!Number.isInteger(numTurns) || numTurns < 1) {
    throw new Error('buildThreadRollbackRequest: numTurns must be an integer >= 1');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadRollback,
    params: {
      threadId,
      numTurns,
    },
  };
}

export function buildThreadInjectItemsRequest({ id, threadId, items }) {
  assertRequestId(id, 'buildThreadInjectItemsRequest');
  assertNonEmptyString(threadId, 'buildThreadInjectItemsRequest: threadId');
  if (!Array.isArray(items)) {
    throw new Error('buildThreadInjectItemsRequest: items must be an array');
  }
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.threadInjectItems,
    params: {
      threadId,
      items,
    },
  };
}

export function buildTurnStartRequest({ id, threadId, text }) {
  assertRequestId(id, 'buildTurnStartRequest');
  assertNonEmptyString(threadId, 'buildTurnStartRequest: threadId');
  assertNonEmptyString(text, 'buildTurnStartRequest: text');
  return {
    id,
    method: CODEX_APP_SERVER_METHODS.turnStart,
    params: {
      threadId,
      input: [buildTextInputItem(text)],
    },
  };
}

export function buildTextInputItem(text) {
  assertNonEmptyString(text, 'buildTextInputItem: text');
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

export function buildDeveloperMessageItem(text) {
  assertNonEmptyString(text, 'buildDeveloperMessageItem: text');
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text }],
  };
}

export async function runCodexTrimPreflight({
  threadId,
  cwd,
  rollbackTurns,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexTrimPreflight: threadId');
  assertNonEmptyString(cwd, 'runCodexTrimPreflight: cwd');
  assertNonEmptyString(command, 'runCodexTrimPreflight: command');
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 1) {
    throw new Error('runCodexTrimPreflight: rollbackTurns must be an integer >= 1');
  }
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexTrimPreflight: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-trim',
        clientTitle: 'Throughline Trim',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        excludeTurns: false,
      }),
    );

    return {
      status: 'preflight-ready',
      threadId,
      rollbackSent: false,
      injectSent: false,
      readTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      rollbackRequestPreview: buildThreadRollbackRequest({
        id: 'rollback-preview',
        threadId,
        numTurns: rollbackTurns,
      }),
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

export async function runCodexTrimExecution({
  threadId,
  cwd,
  rollbackTurns,
  memoryText,
  command = 'codex',
  commandArgs = ['app-server', '--listen', 'stdio://'],
  timeoutMs = 30_000,
  requestTimeoutMs = 10_000,
} = {}) {
  assertNonEmptyString(threadId, 'runCodexTrimExecution: threadId');
  assertNonEmptyString(cwd, 'runCodexTrimExecution: cwd');
  assertNonEmptyString(command, 'runCodexTrimExecution: command');
  assertNonEmptyString(memoryText, 'runCodexTrimExecution: memoryText');
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 1) {
    throw new Error('runCodexTrimExecution: rollbackTurns must be an integer >= 1');
  }
  if (!Array.isArray(commandArgs)) {
    throw new Error('runCodexTrimExecution: commandArgs must be an array');
  }

  const client = startAppServerClient({
    command,
    args: commandArgs,
    cwd,
    timeoutMs,
    requestTimeoutMs,
  });

  try {
    await client.request(
      buildInitializeRequest({
        id: randomUUID(),
        clientName: 'throughline-trim',
        clientTitle: 'Throughline Trim',
      }),
    );
    client.notify(buildInitializedNotification());

    const beforeRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );
    const resumed = await client.request(
      buildThreadResumeRequest({
        id: randomUUID(),
        threadId,
        cwd,
        excludeTurns: false,
      }),
    );
    const rollback = await client.request(
      buildThreadRollbackRequest({
        id: randomUUID(),
        threadId,
        numTurns: rollbackTurns,
      }),
    );
    const inject = await client.request(
      buildThreadInjectItemsRequest({
        id: randomUUID(),
        threadId,
        items: [buildDeveloperMessageItem(memoryText)],
      }),
    );
    const afterRead = await client.request(
      buildThreadReadRequest({
        id: randomUUID(),
        threadId,
        includeTurns: true,
      }),
    );

    return {
      status: 'executed',
      threadId,
      rollbackSent: true,
      injectSent: true,
      injectedItems: 1,
      readTurns: countTurns(beforeRead),
      resumedTurns: countTurns(resumed),
      rollbackRequestedTurns: rollbackTurns,
      rollbackResultTurns: countTurns(rollback),
      injectResultTurns: countTurns(inject),
      afterTurns: countTurns(afterRead),
      notifications: [...new Set(client.notifications)],
      stderr: client.stderr,
    };
  } finally {
    await client.close();
  }
}

function startAppServerClient({ command, args, cwd, timeoutMs, requestTimeoutMs }) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  const pending = new Map();
  const notifications = [];

  const overallTimer = setTimeout(() => {
    if (!closed) {
      child.kill('SIGTERM');
    }
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = parseAppServerLine(line);
      } catch {
        continue;
      }

      if ((message.kind === 'response' || message.kind === 'error') && pending.has(message.id)) {
        const pendingRequest = pending.get(message.id);
        pending.delete(message.id);
        pendingRequest.finish(message);
      } else if (message.kind === 'notification') {
        notifications.push(message.method);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('exit', (code, signal) => {
    closed = true;
    clearTimeout(overallTimer);
    for (const [id, pendingRequest] of pending) {
      pending.delete(id);
      pendingRequest.reject(new Error(`codex app-server exited before response ${id}: code=${code} signal=${signal}`));
    }
  });

  return {
    notifications,
    get stderr() {
      return stderr;
    },
    request(message) {
      if (!isRequestId(message.id)) {
        throw new Error('app-server request message requires an id');
      }
      child.stdin.write(encodeAppServerMessage(message));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(message.id)) {
            pending.delete(message.id);
            reject(new Error(`timeout waiting for app-server response to ${message.method}`));
          }
        }, requestTimeoutMs);
        pending.set(message.id, {
          reject,
          finish(response) {
            clearTimeout(timer);
            if (response.kind === 'error') {
              reject(new Error(`${message.method}: ${JSON.stringify(response.error)}`));
            } else {
              resolve(response.result);
            }
          },
        });
      });
    },
    notify(message) {
      child.stdin.write(encodeAppServerMessage(message));
    },
    close() {
      clearTimeout(overallTimer);
      child.kill('SIGTERM');
      child.stdin.destroy();
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 1_000);
      });
    },
  };
}

function countTurns(result) {
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : result;
  return isRecord(thread) && Array.isArray(thread.turns) ? thread.turns.length : null;
}

function compactNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

function assertRequestId(id, caller) {
  if (!isRequestId(id)) {
    throw new Error(`${caller}: id must be a string or integer`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isRequestId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
