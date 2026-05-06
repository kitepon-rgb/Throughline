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
