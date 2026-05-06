import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_APP_SERVER_METHODS,
  buildDeveloperMessageItem,
  buildInitializeRequest,
  buildInitializedNotification,
  buildTextInputItem,
  buildThreadInjectItemsRequest,
  buildThreadReadRequest,
  buildThreadResumeRequest,
  buildThreadRollbackRequest,
  buildTurnStartRequest,
  compareTurnCounts,
  encodeAppServerMessage,
  parseAppServerLine,
  runCodexTrimPreflight,
} from './codex-app-server.mjs';

test('encodeAppServerMessage writes one newline-delimited JSON object', () => {
  assert.equal(
    encodeAppServerMessage({ id: 1, method: 'initialize', params: { ok: true } }),
    '{"id":1,"method":"initialize","params":{"ok":true}}\n',
  );
});

test('parseAppServerLine parses responses, errors, notifications, and server requests', () => {
  assert.deepEqual(parseAppServerLine('{"id":1,"result":{"ok":true}}'), {
    kind: 'response',
    id: 1,
    result: { ok: true },
  });

  assert.deepEqual(parseAppServerLine('{"id":"x","error":{"code":-32600,"message":"bad"}}'), {
    kind: 'error',
    id: 'x',
    error: { code: -32600, message: 'bad', data: undefined },
  });

  assert.deepEqual(parseAppServerLine('{"method":"thread/status/changed","params":{}}'), {
    kind: 'notification',
    method: 'thread/status/changed',
    params: {},
  });

  assert.deepEqual(parseAppServerLine('{"id":2,"method":"client/request","params":{"a":1}}'), {
    kind: 'request',
    id: 2,
    method: 'client/request',
    params: { a: 1 },
  });
});

test('buildInitializeRequest opts into the experimental app-server API', () => {
  assert.deepEqual(buildInitializeRequest({ id: 'init-1', version: '1.2.3' }), {
    id: 'init-1',
    method: CODEX_APP_SERVER_METHODS.initialize,
    params: {
      clientInfo: {
        name: 'throughline',
        title: 'Throughline',
        version: '1.2.3',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    },
  });

  assert.deepEqual(buildInitializedNotification(), {
    method: CODEX_APP_SERVER_METHODS.initialized,
  });
});

test('thread request builders encode the verified rollback/inject flow', () => {
  const threadId = 'thread-1';
  assert.deepEqual(buildThreadReadRequest({ id: 1, threadId }), {
    id: 1,
    method: CODEX_APP_SERVER_METHODS.threadRead,
    params: { threadId, includeTurns: true },
  });

  assert.deepEqual(
    buildThreadResumeRequest({
      id: 2,
      threadId,
      cwd: '/repo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'gpt-5.5',
    }),
    {
      id: 2,
      method: CODEX_APP_SERVER_METHODS.threadResume,
      params: {
        threadId,
        cwd: '/repo',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        model: 'gpt-5.5',
        excludeTurns: false,
      },
    },
  );

  assert.deepEqual(buildThreadRollbackRequest({ id: 3, threadId, numTurns: 1 }), {
    id: 3,
    method: CODEX_APP_SERVER_METHODS.threadRollback,
    params: { threadId, numTurns: 1 },
  });

  const item = buildDeveloperMessageItem('active work marker');
  assert.deepEqual(buildThreadInjectItemsRequest({ id: 4, threadId, items: [item] }), {
    id: 4,
    method: CODEX_APP_SERVER_METHODS.threadInjectItems,
    params: { threadId, items: [item] },
  });
});

test('turn and item builders match the app-server shapes observed in the spike', () => {
  assert.deepEqual(buildTextInputItem('hello'), {
    type: 'text',
    text: 'hello',
    text_elements: [],
  });

  assert.deepEqual(buildDeveloperMessageItem('remember this'), {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'remember this' }],
  });

  assert.deepEqual(buildTurnStartRequest({ id: 1, threadId: 'thread-1', text: 'continue' }), {
    id: 1,
    method: CODEX_APP_SERVER_METHODS.turnStart,
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'continue', text_elements: [] }],
    },
  });
});

test('buildThreadRollbackRequest rejects numTurns below the documented minimum', () => {
  assert.throws(
    () => buildThreadRollbackRequest({ id: 1, threadId: 'thread-1', numTurns: 0 }),
    /numTurns must be an integer >= 1/,
  );
});

test('compareTurnCounts: reports match, mismatch, unchecked, and unknown states', () => {
  assert.deepEqual(
    compareTurnCounts({
      expectedTurns: 2,
      readTurns: 2,
      resumedTurns: 2,
    }),
    {
      status: 'match',
      reason: 'rollout_and_app_server_turn_counts_match',
      expectedTurns: 2,
      readTurns: 2,
      resumedTurns: 2,
    },
  );

  assert.equal(
    compareTurnCounts({
      expectedTurns: 3,
      readTurns: 2,
      resumedTurns: 2,
    }).status,
    'mismatch',
  );
  assert.equal(compareTurnCounts({ readTurns: 2, resumedTurns: 2 }).status, 'unchecked');
  assert.equal(compareTurnCounts({ expectedTurns: 2, readTurns: null, resumedTurns: 2 }).status, 'unknown');
});

test('compareTurnCounts: rejects invalid expected turn count', () => {
  assert.throws(
    () =>
      compareTurnCounts({
        expectedTurns: -1,
        readTurns: 2,
        resumedTurns: 2,
      }),
    /expectedTurns must be a non-negative integer/,
  );
});

test('runCodexTrimPreflight reports app-server spawn failure explicitly', async () => {
  await assert.rejects(
    () =>
      runCodexTrimPreflight({
        threadId: 'thread-1',
        cwd: process.cwd(),
        rollbackTurns: 1,
        command: `/tmp/throughline-missing-codex-app-server-${process.pid}`,
        requestTimeoutMs: 1_000,
      }),
    /codex app-server failed to start|codex app-server is unavailable/,
  );
});
