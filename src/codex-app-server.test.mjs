import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  buildThreadTurnsListRequest,
  buildTurnStartRequest,
  compareTurnCounts,
  encodeAppServerMessage,
  parseAppServerLine,
  runCodexModelVisibilitySmoke,
  runCodexRollbackModelVisiblePrepare,
  runCodexRollbackModelVisibleVerify,
  runCodexTrimPreflight,
  summarizeAppServerStderr,
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

  assert.deepEqual(buildThreadTurnsListRequest({ id: 'turns-list', threadId, limit: 50 }), {
    id: 'turns-list',
    method: CODEX_APP_SERVER_METHODS.threadTurnsList,
    params: { threadId, limit: 50, sortDirection: 'asc' },
  });

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

test('summarizeAppServerStderr: compacts repeated unknown-turn item warnings', () => {
  const stderr = [
    '2026-05-06T00:00:00Z  WARN codex_app_server_protocol::protocol::thread_history: dropping turn-scoped item for unknown turn id `turn-a` item_id="call_1"',
    '2026-05-06T00:00:01Z  WARN codex_app_server_protocol::protocol::thread_history: dropping turn-scoped item for unknown turn id `turn-a` item_id="call_2"',
    'unrelated warning',
    '2026-05-06T00:00:02Z  WARN codex_app_server_protocol::protocol::thread_history: dropping turn-scoped item for unknown turn id `turn-a` item_id="call_3"',
    '',
  ].join('\n');

  assert.equal(
    summarizeAppServerStderr(stderr),
    [
      '2026-05-06T00:00:00Z  WARN codex_app_server_protocol::protocol::thread_history: dropping turn-scoped item for unknown turn id `turn-a` item_id="call_1"',
      'unrelated warning',
      '[throughline] suppressed 2 repeated Codex app-server unknown-turn item warnings for turn turn-a',
      '',
    ].join('\n'),
  );
});

test('summarizeAppServerStderr: caps very large app-server stderr', () => {
  const stderr = `warning ${'x'.repeat(5000)}`;

  const summarized = summarizeAppServerStderr(stderr);

  assert(summarized.length < stderr.length);
  assert.match(summarized, /\[throughline\] truncated \d+ chars of Codex app-server stderr/);
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

test('runCodexModelVisibilitySmoke injects developer memory and detects marker in agent delta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-visible-smoke-'));
  try {
    const script = join(dir, 'fake-codex-app-server.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'thread/inject_items') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }, { id: 'memory' }] } } });
  } else if (msg.method === 'turn/start') {
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-2', itemId: 'item-1', delta: 'TL_VISIBLE_MARKER' } });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-2' } } });
    send({ id: msg.id, result: { turn: { id: 'turn-2' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
    );
    chmodSync(script, 0o755);

    const result = await runCodexModelVisibilitySmoke({
      threadId: 'thread-visible',
      cwd: process.cwd(),
      memoryText: 'developer memory containing TL_VISIBLE_MARKER',
      marker: 'TL_VISIBLE_MARKER',
      command: script,
    });

    assert.equal(result.status, 'visible');
    assert.equal(result.reason, 'marker_found_in_agent_message');
    assert.equal(result.injectSent, true);
    assert.equal(result.turnStartSent, true);
    assert.match(result.agentText, /TL_VISIBLE_MARKER/);
    assert.deepEqual(result.notifications, ['item/agentMessage/delta', 'turn/completed']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexModelVisibilitySmoke can resume after inject before marker turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-visible-resume-smoke-'));
  try {
    const script = join(dir, 'fake-codex-app-server.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let injected = false;
let resumedAfterInject = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'thread/resume') {
    if (injected) resumedAfterInject = true;
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }, { id: 'resume' }] } } });
  } else if (msg.method === 'thread/inject_items') {
    injected = true;
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }, { id: 'memory' }] } } });
  } else if (msg.method === 'turn/start') {
    const delta = resumedAfterInject ? 'TL_VISIBLE_AFTER_RESUME' : 'missing';
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-2', itemId: 'item-1', delta } });
    send({ id: msg.id, result: { turn: { id: 'turn-2' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
    );
    chmodSync(script, 0o755);

    const result = await runCodexModelVisibilitySmoke({
      threadId: 'thread-visible',
      cwd: process.cwd(),
      memoryText: 'developer memory containing TL_VISIBLE_AFTER_RESUME',
      marker: 'TL_VISIBLE_AFTER_RESUME',
      command: script,
      resumeAfterInject: true,
    });

    assert.equal(result.status, 'visible');
    assert.equal(result.resumeAfterInject, true);
    assert.equal(result.postInjectResumedTurns, 2);
    assert.match(result.agentText, /TL_VISIBLE_AFTER_RESUME/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexRollbackModelVisiblePrepare starts a marker turn and rolls it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-model-visible-prepare-'));
  try {
    const script = join(dir, 'fake-codex-app-server.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let turns = [{ id: 'turn-1' }];
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns } } });
  } else if (msg.method === 'turn/start') {
    turns = [...turns, { id: 'marker-turn' }];
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'marker-turn' } } });
    send({ id: msg.id, result: { turn: { id: 'marker-turn' } } });
  } else if (msg.method === 'thread/rollback') {
    turns = turns.slice(0, Math.max(0, turns.length - msg.params.numTurns));
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
    );
    chmodSync(script, 0o755);

    const result = await runCodexRollbackModelVisiblePrepare({
      threadId: 'thread-rollback-visible',
      cwd: process.cwd(),
      marker: 'TL_ROLLBACK_MODEL_VISIBLE_PREPARE',
      command: script,
    });

    assert.equal(result.status, 'prepared');
    assert.equal(result.reason, 'controlled_marker_turn_started_and_rolled_back');
    assert.equal(result.restartSafe, false);
    assert.equal(result.setupTurnStartSent, true);
    assert.equal(result.setupTurnCompletedObserved, true);
    assert.equal(result.rollbackSent, true);
    assert.equal(result.beforeTurns, 1);
    assert.equal(result.afterRollbackTurns, 1);
    assert.deepEqual(result.notifications, ['turn/completed']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexRollbackModelVisibleVerify reports not-reproduced without putting full marker in prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-model-visible-verify-hidden-'));
  try {
    const script = join(dir, 'fake-codex-app-server.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'turn/start') {
    const prompt = JSON.stringify(msg.params.input);
    if (prompt.includes('TL_ROLLBACK_MODEL_VISIBLE_SECRET')) {
      send({ id: msg.id, error: { code: -32000, message: 'full marker leaked into prompt' } });
      return;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-2', itemId: 'item-1', delta: 'TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE' } });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-2' } } });
    send({ id: msg.id, result: { turn: { id: 'turn-2' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
    );
    chmodSync(script, 0o755);

    const result = await runCodexRollbackModelVisibleVerify({
      threadId: 'thread-rollback-visible',
      cwd: process.cwd(),
      marker: 'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
      command: script,
    });

    assert.equal(result.status, 'not-reproduced');
    assert.equal(result.reason, 'model_reported_rolled_back_marker_not_visible');
    assert.equal(result.promptIncludesMarker, false);
    assert.equal(result.rolledBackMarkerModelVisible, false);
    assert.equal(result.modelReportedNotVisible, true);
    assert.deepEqual(result.observedMarkers, ['TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE']);
    assert.match(result.agentText, /TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexRollbackModelVisibleVerify reports reproduced when model returns the hidden marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-model-visible-verify-visible-'));
  try {
    const script = join(dir, 'fake-codex-app-server.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'turn/start') {
    const prompt = JSON.stringify(msg.params.input);
    if (prompt.includes('TL_ROLLBACK_MODEL_VISIBLE_SECRET')) {
      send({ id: msg.id, error: { code: -32000, message: 'full marker leaked into prompt' } });
      return;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-2', itemId: 'item-1', delta: 'TL_ROLLBACK_MODEL_VISIBLE_SECRET' } });
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-2' } } });
    send({ id: msg.id, result: { turn: { id: 'turn-2' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
    );
    chmodSync(script, 0o755);

    const result = await runCodexRollbackModelVisibleVerify({
      threadId: 'thread-rollback-visible',
      cwd: process.cwd(),
      marker: 'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
      command: script,
    });

    assert.equal(result.status, 'reproduced');
    assert.equal(result.reason, 'rolled_back_marker_returned_by_model');
    assert.equal(result.promptIncludesMarker, false);
    assert.equal(result.rolledBackMarkerModelVisible, true);
    assert.equal(result.modelReportedNotVisible, false);
    assert.deepEqual(result.observedMarkers, ['TL_ROLLBACK_MODEL_VISIBLE_SECRET']);
    assert.match(result.agentText, /TL_ROLLBACK_MODEL_VISIBLE_SECRET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
