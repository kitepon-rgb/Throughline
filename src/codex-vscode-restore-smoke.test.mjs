import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCodexVsCodeRestoreSmokeMemory,
  buildCodexVsCodeRestoreSmokePrompt,
  inspectCodexVsCodeRestoreSmokeRollout,
} from './codex-vscode-restore-smoke.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-vscode-restore-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-vscode-restore-project-'));
}

function makeFakeCodexAppServer(dir) {
  const script = join(dir, 'fake-codex-vscode-restore-app-server.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let injected = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'thread/inject_items') {
    injected = true;
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }, { id: 'memory' }] } } });
  } else if (msg.method === 'turn/start') {
    send({ id: msg.id, error: { code: -32601, message: injected ? 'unexpected turn/start' : 'not injected' } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function runCli(home, codexHome, project, args = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-vscode-restore-smoke', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
}

function writeRollout(codexHome, { project, threadId, rows }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '07');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-07T00-00-00-${threadId}.jsonl`);
  const allRows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        cwd: project,
        source: 'vscode',
      },
    },
    ...rows,
  ];
  writeFileSync(path, allRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function event(timestamp, type, payload) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type,
      ...payload,
    },
  };
}

test('VS Code restore smoke memory uses active-work header and prompt does not leak marker', () => {
  const marker = 'TL_CODEX_VSCODE_RESTORE_TEST';
  const memory = buildCodexVsCodeRestoreSmokeMemory({ marker });
  const prompt = buildCodexVsCodeRestoreSmokePrompt();

  assert.match(memory, /^## Throughline: Active Work Context/);
  assert.match(memory, new RegExp(marker));
  assert.doesNotMatch(prompt, new RegExp(marker));
});

test('codex-vscode-restore-smoke prepare injects hidden marker memory behind explicit env', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const fake = makeFakeCodexAppServer(project);
  const threadId = '019dfdef-1000-7000-8000-000000000001';
  try {
    const refused = runCli(home, codexHome, project, [
      '--prepare',
      '--codex-thread-id',
      threadId,
      '--marker',
      'TL_CODEX_VSCODE_RESTORE_PREP',
      '--codex-app-server-bin',
      fake,
      '--json',
    ]);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).reason, 'experimental_env_required');

    const result = runCli(
      home,
      codexHome,
      project,
      [
        '--prepare',
        '--codex-thread-id',
        threadId,
        '--marker',
        'TL_CODEX_VSCODE_RESTORE_PREP',
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE: '1' },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'prepared');
    assert.equal(payload.restartSafe, false);
    assert.equal(payload.inject.status, 'injected');
    assert.equal(payload.prompt.includes(payload.marker), false);
    assert.deepEqual(payload.verifyArgs.slice(0, 3), [
      'throughline',
      'codex-vscode-restore-smoke',
      '--verify',
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('inspectCodexVsCodeRestoreSmokeRollout proves marker only with restart acknowledgement', () => {
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-1000-7000-8000-000000000002';
  const marker = 'TL_CODEX_VSCODE_RESTORE_VERIFY';
  const preparedAt = '2026-05-07T00:00:10.000Z';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      rows: [
        event('2026-05-07T00:00:11.000Z', 'user_message', {
          message:
            'Throughline VS Code restore smoke: Read the marker from your developer memory and reply with exactly that marker and nothing else.',
        }),
        event('2026-05-07T00:00:12.000Z', 'agent_message', { message: marker }),
      ],
    });

    const withoutAck = inspectCodexVsCodeRestoreSmokeRollout({
      threadId,
      codexHome,
      projectPath: project,
      marker,
      preparedAt,
    });
    assert.equal(withoutAck.status, 'marker-visible-restart-unacknowledged');
    assert.equal(withoutAck.restartSafe, false);

    const withAck = inspectCodexVsCodeRestoreSmokeRollout({
      threadId,
      codexHome,
      projectPath: project,
      marker,
      preparedAt,
      afterVsCodeRestart: true,
    });
    assert.equal(withAck.status, 'vscode-restart-visible');
    assert.equal(withAck.restartSafe, true);
    assert.equal(withAck.promptMatches.length, 1);
    assert.equal(withAck.assistantMarkerMatches.length, 1);
    assert.equal(withAck.userMarkerMatches.length, 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-vscode-restore-smoke verify rejects marker leaked in user prompt', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-1000-7000-8000-000000000003';
  const marker = 'TL_CODEX_VSCODE_RESTORE_LEAK';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      rows: [
        event('2026-05-07T00:00:11.000Z', 'user_message', {
          message: `Throughline VS Code restore smoke: reply with ${marker}`,
        }),
        event('2026-05-07T00:00:12.000Z', 'agent_message', { message: marker }),
      ],
    });

    const result = runCli(home, codexHome, project, [
      '--verify',
      '--codex-thread-id',
      threadId,
      '--marker',
      marker,
      '--prepared-at',
      '2026-05-07T00:00:10.000Z',
      '--after-vscode-restart',
      '--json',
    ]);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'invalid');
    assert.equal(payload.reason, 'marker_leaked_in_user_prompt');
    assert.equal(payload.restartSafe, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('inspectCodexVsCodeRestoreSmokeRollout rejects non-exact assistant marker mentions', () => {
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-1000-7000-8000-000000000004';
  const marker = 'TL_CODEX_VSCODE_RESTORE_MENTION';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      rows: [
        event('2026-05-07T00:00:11.000Z', 'user_message', {
          message:
            'Throughline VS Code restore smoke: Read the marker from your developer memory and reply with exactly that marker and nothing else.',
        }),
        event('2026-05-07T00:00:12.000Z', 'agent_message', {
          message: `I can see ${marker}, but this is not an exact marker-only answer.`,
        }),
      ],
    });

    const result = inspectCodexVsCodeRestoreSmokeRollout({
      threadId,
      codexHome,
      projectPath: project,
      marker,
      preparedAt: '2026-05-07T00:00:10.000Z',
      afterVsCodeRestart: true,
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.restartSafe, false);
    assert.equal(result.assistantMarkerMatches.length, 0);
    assert.equal(result.assistantMarkerMentions.length, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('inspectCodexVsCodeRestoreSmokeRollout rejects exact marker answer without smoke prompt', () => {
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-1000-7000-8000-000000000005';
  const marker = 'TL_CODEX_VSCODE_RESTORE_NO_PROMPT';
  try {
    writeRollout(codexHome, {
      project,
      threadId,
      rows: [event('2026-05-07T00:00:12.000Z', 'agent_message', { message: marker })],
    });

    const result = inspectCodexVsCodeRestoreSmokeRollout({
      threadId,
      codexHome,
      projectPath: project,
      marker,
      preparedAt: '2026-05-07T00:00:10.000Z',
      afterVsCodeRestart: true,
    });

    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'marker_answer_without_smoke_prompt');
    assert.equal(result.restartSafe, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
