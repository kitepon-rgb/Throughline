import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-restore-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-restore-project-'));
}

function makeFakeCodexAppServer(
  dir,
  {
    turnCounts = [22, 22],
    turnsListCounts = null,
    supportsTurnsList = true,
    retainedText = null,
    retainedTextLocation = 'itemText',
  } = {},
) {
  const script = join(dir, 'fake-codex-restore-app-server.mjs');
  const state = join(dir, 'fake-codex-restore-state.json');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const statePath = ${JSON.stringify(state)};
const turnCounts = ${JSON.stringify(turnCounts)};
const turnsListCounts = ${JSON.stringify(turnsListCounts)};
const supportsTurnsList = ${JSON.stringify(supportsTurnsList)};
const retainedText = ${JSON.stringify(retainedText)};
const retainedTextLocation = ${JSON.stringify(retainedTextLocation)};
let launches = 0;
if (existsSync(statePath)) launches = JSON.parse(readFileSync(statePath, 'utf8')).launches;
const turnCount = turnCounts[Math.min(launches, turnCounts.length - 1)];
const turnsListCountSource = Array.isArray(turnsListCounts) ? turnsListCounts : turnCounts;
const turnsListCount = turnsListCountSource[Math.min(launches, turnsListCountSource.length - 1)];
writeFileSync(statePath, JSON.stringify({ launches: launches + 1 }));
function buildTurn(index) {
  const turn = { id: 'turn-' + (index + 1) };
  if (retainedText && index === 0) {
    if (retainedTextLocation === 'aggregatedOutput') {
      turn.items = [{ type: 'commandExecution', aggregatedOutput: retainedText }];
    } else if (retainedTextLocation === 'replacementHistory') {
      turn.replacement_history = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: retainedText }],
        },
      ];
    } else {
      turn.items = [{ type: 'userMessage', text: retainedText }];
    }
  }
  return turn;
}
const turns = Array.from({ length: turnCount }, (_, index) => buildTurn(index));
const listedTurns = Array.from({ length: turnsListCount }, (_, index) => buildTurn(index));
const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns } } });
  } else if (supportsTurnsList && msg.method === 'thread/turns/list') {
    send({ id: msg.id, result: { data: listedTurns, nextCursor: null, backwardsCursor: null } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function runRestoreSmoke(home, codexHome, project, args = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-restore-smoke', ...args],
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

function writeCodexRollout(codexHome, { project, threadId, turnCount, restoreRisk = false }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '07');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-07T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-07T00:00:00.000Z',
        cwd: project,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    },
  ];

  for (let turn = 1; turn <= turnCount; turn++) {
    rows.push({
      timestamp: `2026-05-07T00:00:${String(turn).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `restore smoke user turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:${String(turn).padStart(2, '0')}.100Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:${String(turn).padStart(2, '0')}.200Z`,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: `restore smoke assistant turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:${String(turn).padStart(2, '0')}.300Z`,
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
  }

  if (restoreRisk) {
    const riskyText = `restore smoke user turn ${turnCount}`;
    rows.push({
      timestamp: '2026-05-07T00:01:00.000Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: riskyText }],
          },
        ],
      },
    });
    rows.push({
      timestamp: '2026-05-07T00:01:00.100Z',
      type: 'event_msg',
      payload: { type: 'thread_rolled_back', num_turns: 1 },
    });
    rows.push({
      timestamp: '2026-05-07T00:01:00.200Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: riskyText },
    });
  }

  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

test('codex-restore-smoke refuses without explicit experimental env', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runRestoreSmoke(home, codexHome, project, ['--codex-thread-id', 'thread-restore', '--json']);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'refused');
    assert.equal(payload.reason, 'experimental_env_required');
    assert.equal(payload.restartSafe, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke reports stable fresh app-server restore counts', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000001';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 22 });
    const fake = makeFakeCodexAppServer(project, { turnCounts: [22, 22] });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--json'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restart-stable');
    assert.equal(payload.reason, 'fresh_app_server_restore_counts_stable');
    assert.equal(payload.proofScope, 'app_server_process_restart_only');
    assert.equal(payload.restartSafe, false);
    assert.equal(payload.expectedTurns, 22);
    assert.equal(payload.observations.length, 2);
    assert.equal(payload.observations[0].turnCountCheck.status, 'match');
    assert.equal(payload.observations[1].turnCountCheck.status, 'match');
    assert.equal(payload.observations[0].turnsListTurns, 22);
    assert.equal(payload.observations[0].turnsListComplete, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke reports mismatch when fresh app-server restore counts drift', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000002';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 22 });
    const fake = makeFakeCodexAppServer(project, { turnCounts: [22, 21] });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--json'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restart-mismatch');
    assert.equal(payload.reason, 'fresh_app_server_restore_counts_mismatch');
    assert.equal(payload.restartSafe, false);
    assert.equal(payload.observations[1].turnCountCheck.status, 'mismatch');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke reports mismatch when thread turns/list differs from read and resume', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000004';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 22 });
    const fake = makeFakeCodexAppServer(project, { turnCounts: [22, 22], turnsListCounts: [21, 21] });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--json'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restart-mismatch');
    assert.equal(payload.observations[0].readTurns, 22);
    assert.equal(payload.observations[0].resumedTurns, 22);
    assert.equal(payload.observations[0].turnsListTurns, 21);
    assert.equal(payload.observations[0].turnCountCheck.status, 'mismatch');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke reports structured error when thread turns/list is unavailable', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000005';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 22 });
    const fake = makeFakeCodexAppServer(project, {
      turnCounts: [22, 22],
      supportsTurnsList: false,
    });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--json'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restore-smoke-error');
    assert.equal(payload.reason, 'app_server_restore_request_failed');
    assert.match(payload.error, /thread\/turns\/list/);
    assert.equal(payload.restartSafe, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke refuses before app-server when rollout restore safety is risky', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000003';
  try {
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const fake = makeFakeCodexAppServer(project, { turnCounts: [22, 22] });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--json'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'refused');
    assert.equal(payload.reason, 'restore_safety_risk');
    assert.equal(payload.restoreSafety.status, 'risk');
    assert.equal(payload.restartSafe, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke can inspect risky rollout read-only and report app-server response text matches', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000006';
  const retainedText = 'restore smoke user turn 22';
  try {
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const fake = makeFakeCodexAppServer(project, {
      turnCounts: [22, 22],
      turnsListCounts: [22, 22],
      retainedText,
    });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      [
        '--codex-thread-id',
        threadId,
        '--codex-app-server-bin',
        fake,
        '--inspect-risky-rollout',
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restore-text-retained');
    assert.equal(payload.reason, 'restore_text_seen_in_app_server_response');
    assert.equal(payload.restoreSafety.status, 'risk');
    assert.equal(payload.restoreSafetyRiskInspected, true);
    assert.equal(payload.restartSafe, false);
    assert.equal(payload.restoreTextNeedles.length, 1);
    assert.equal(payload.restoreTextMatchCheck.status, 'matches-found');
    assert.deepEqual(payload.restoreTextMatchCheck.sources[0], {
      source: 'thread_read',
      cycles: [1, 2],
      matchedNeedleIds: ['retained_rollback_text_1'],
      samplePaths: ['$.thread.turns[0].items[0].text'],
      locationKinds: ['item_text_field'],
      locationRisks: ['direct_turn_text_candidate'],
      blockingKinds: ['item_text_field'],
      nonBlockingKinds: [],
      hasBlockingCandidates: true,
    });
    assert.equal(payload.restoreTextMatchCheck.hasBlockingCandidates, true);
    assert.deepEqual(payload.restoreTextMatchCheck.blockingKinds, ['item_text_field']);
    assert.deepEqual(payload.restoreTextMatchCheck.locationRisks, [
      'direct_turn_text_candidate',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[1].samplePaths, [
      '$.thread.turns[0].items[0].text',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[1].locationKinds, [
      'item_text_field',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[2].samplePaths, [
      '$[0].items[0].text',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[2].locationKinds, [
      'item_text_field',
    ]);
    assert.equal(payload.observations[0].responseTextMatches.status, 'matches-found');
    assert.deepEqual(
      payload.observations[0].responseTextMatches.sources.map((source) => source.source),
      ['thread_read', 'thread_resume', 'thread_turns_list'],
    );
    assert.equal(
      payload.observations[0].responseTextMatches.matchedNeedles[0].id,
      'retained_rollback_text_1',
    );
    assert.deepEqual(
      payload.observations[0].responseTextMatches.sources[0].matches[0].locations.map(
        (location) => location.path,
      ),
      ['$.thread.turns[0].items[0].text'],
    );
    assert.deepEqual(
      payload.observations[0].responseTextMatches.sources[0].matches[0].locations.map(
        (location) => location.kind,
      ),
      ['item_text_field'],
    );
    assert.deepEqual(
      payload.observations[0].responseTextMatches.sources[0].matches[0].locations.map(
        (location) => location.risk,
      ),
      ['direct_turn_text_candidate'],
    );
    assert.deepEqual(
      payload.observations[0].responseTextMatches.sources[0].matches[0].locations.map(
        (location) => location.blockingCandidate,
      ),
      [true],
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke text output summarizes risky response text matches', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000007';
  const retainedText = 'restore smoke user turn 22';
  try {
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const fake = makeFakeCodexAppServer(project, {
      turnCounts: [22, 22],
      turnsListCounts: [22, 22],
      retainedText,
    });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      ['--codex-thread-id', threadId, '--codex-app-server-bin', fake, '--inspect-risky-rollout'],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /status:\s+app-server-restore-text-retained/);
    assert.match(result.stdout, /restore safety risk inspected read-only: yes/);
    assert.match(
      result.stdout,
      /restore text match check: matches-found 1 needle sources=thread_read,thread_resume,thread_turns_list/,
    );
    assert.match(result.stdout, /paths=thread_read:\$\.thread\.turns\[0\]\.items\[0\]\.text/);
    assert.match(result.stdout, /kinds=item_text_field/);
    assert.match(result.stdout, /risks=direct_turn_text_candidate/);
    assert.match(result.stdout, /blocking-candidates=item_text_field/);
    assert.match(
      result.stdout,
      /response text matches: matches-found 1 needle sources=thread_read,thread_resume,thread_turns_list/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke separates quoted output matches from blocking restore matches', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000008';
  const retainedText = 'restore smoke user turn 22';
  try {
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const fake = makeFakeCodexAppServer(project, {
      turnCounts: [22, 22],
      turnsListCounts: [22, 22],
      retainedText,
      retainedTextLocation: 'aggregatedOutput',
    });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      [
        '--codex-thread-id',
        threadId,
        '--codex-app-server-bin',
        fake,
        '--inspect-risky-rollout',
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restore-text-quoted');
    assert.equal(
      payload.reason,
      'restore_text_seen_only_in_quoted_or_output_response_fields',
    );
    assert.equal(payload.restoreTextMatchCheck.status, 'matches-found');
    assert.equal(payload.restoreTextMatchCheck.hasBlockingCandidates, false);
    assert.deepEqual(payload.restoreTextMatchCheck.blockingKinds, []);
    assert.deepEqual(payload.restoreTextMatchCheck.nonBlockingKinds, ['aggregated_output']);
    assert.deepEqual(payload.restoreTextMatchCheck.locationRisks, [
      'quoted_or_tool_output_context',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[0].samplePaths, [
      '$.thread.turns[0].items[0].aggregatedOutput',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[0].locationKinds, [
      'aggregated_output',
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('codex-restore-smoke classifies replacement_history matches as durable restore sources', () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfdef-0000-7000-8000-000000000009';
  const retainedText = 'restore smoke user turn 22';
  try {
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const fake = makeFakeCodexAppServer(project, {
      turnCounts: [22, 22],
      turnsListCounts: [22, 22],
      retainedText,
      retainedTextLocation: 'replacementHistory',
    });
    const result = runRestoreSmoke(
      home,
      codexHome,
      project,
      [
        '--codex-thread-id',
        threadId,
        '--codex-app-server-bin',
        fake,
        '--inspect-risky-rollout',
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'app-server-restore-text-retained');
    assert.equal(payload.restoreTextMatchCheck.hasBlockingCandidates, true);
    assert.deepEqual(payload.restoreTextMatchCheck.blockingKinds, ['replacement_history']);
    assert.deepEqual(payload.restoreTextMatchCheck.locationRisks, [
      'durable_restore_source',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[0].samplePaths, [
      '$.thread.turns[0].replacement_history[0].content[0].text',
    ]);
    assert.deepEqual(payload.restoreTextMatchCheck.sources[0].locationKinds, [
      'replacement_history',
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
