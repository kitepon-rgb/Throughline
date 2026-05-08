import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-trim-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-trim-project-'));
}

function makeFakeCodexAppServer(
  dir,
  {
    allowMutation = false,
    threadId = '019dfabf-thread',
    turnCount = 2,
    delayedInjectVisibilityReads = 0,
    durableRolloutPath = null,
    durableRolloutAppendDelayMs = 0,
    injectCreatesTurn = true,
    injectResponseIncludesTurns = true,
    injectResponseAdvertisesPendingTurn = false,
    hostRemediationPrimitive = true,
    hostResumeHistoryCandidate = hostRemediationPrimitive,
  } = {},
) {
  const script = join(dir, 'fake-codex-app-server.mjs');
  const log = join(dir, 'fake-codex-app-server.log');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = ${JSON.stringify(log)};
const allowMutation = ${JSON.stringify(allowMutation)};
const threadId = ${JSON.stringify(threadId)};
const durableRolloutPath = ${JSON.stringify(durableRolloutPath)};
const durableRolloutAppendDelayMs = ${JSON.stringify(durableRolloutAppendDelayMs)};
const injectCreatesTurn = ${JSON.stringify(injectCreatesTurn)};
const injectResponseIncludesTurns = ${JSON.stringify(injectResponseIncludesTurns)};
const injectResponseAdvertisesPendingTurn = ${JSON.stringify(injectResponseAdvertisesPendingTurn)};
const hostRemediationPrimitive = ${JSON.stringify(hostRemediationPrimitive)};
const hostResumeHistoryCandidate = ${JSON.stringify(hostResumeHistoryCandidate)};
let turns = Array.from({ length: ${JSON.stringify(turnCount)} }, (_, index) => ({ id: 'turn-' + (index + 1) }));
let pendingInjectedTurn = null;
let delayedInjectVisibilityReads = ${JSON.stringify(delayedInjectVisibilityReads)};
const rl = createInterface({ input: process.stdin });

if (process.argv.includes('generate-json-schema')) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  if (!outDir) process.exit(2);
  mkdirSync(outDir + '/v2', { recursive: true });
  const methods = [
    'initialize',
    'thread/read',
    'thread/resume',
    'thread/rollback',
    'thread/inject_items',
    'thread/compact/start',
  ];
  if (hostRemediationPrimitive) methods.push('thread/history/clear');
  writeFileSync(outDir + '/ClientRequest.json', JSON.stringify({ enum: methods }, null, 2));
  writeFileSync(
    outDir + '/v2/ThreadResumeParams.json',
    JSON.stringify(
      {
        properties: {
          history: {
            description: hostResumeHistoryCandidate
              ? 'test-only history candidate'
              : '[UNSTABLE] FOR CODEX CLOUD - DO NOT USE',
          },
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function appendRollout(payload) {
  if (!durableRolloutPath) return;
  const row = JSON.stringify({
    timestamp: '2026-05-06T00:42:00.000Z',
    ...payload,
  }) + '\\n';
  if (durableRolloutAppendDelayMs > 0) {
    const code = 'setTimeout(() => { require("node:fs").appendFileSync('
      + JSON.stringify(durableRolloutPath)
      + ', '
      + JSON.stringify(row)
      + '); }, '
      + String(durableRolloutAppendDelayMs)
      + ');';
    spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  appendFileSync(durableRolloutPath, row);
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  appendFileSync(log, msg.method + '\\n');
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/codex' } });
  } else if (msg.method === 'thread/read') {
    if (pendingInjectedTurn && delayedInjectVisibilityReads <= 0) {
      turns = [...turns, pendingInjectedTurn];
      pendingInjectedTurn = null;
    } else if (pendingInjectedTurn) {
      delayedInjectVisibilityReads--;
    }
    send({ id: msg.id, result: { thread: { id: threadId, turns } } });
  } else if (msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: threadId, turns } } });
  } else if (msg.method === 'thread/rollback') {
    if (!allowMutation) {
      appendFileSync(log, 'UNEXPECTED_MUTATION:' + msg.method + '\\n');
      send({ id: msg.id, error: { code: -32000, message: 'mutation must not be called' } });
      return;
    }
    turns = turns.slice(0, Math.max(0, turns.length - msg.params.numTurns));
    appendRollout({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: msg.params.numTurns } });
    send({ id: msg.id, result: { thread: { id: threadId, turns } } });
  } else if (msg.method === 'thread/inject_items') {
    if (!allowMutation) {
      appendFileSync(log, 'UNEXPECTED_MUTATION:' + msg.method + '\\n');
      send({ id: msg.id, error: { code: -32000, message: 'mutation must not be called' } });
      return;
    }
    const injected = msg.params.items?.[0]?.content?.[0]?.text ?? '';
    appendFileSync(log, 'INJECT_TEXT:' + injected.replace(/\\n/g, ' ') + '\\n');
    appendRollout({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: injected }],
      },
    });
    pendingInjectedTurn = injectCreatesTurn ? { id: 'injected-memory' } : null;
    if (pendingInjectedTurn && delayedInjectVisibilityReads <= 0) {
      turns = [...turns, pendingInjectedTurn];
      pendingInjectedTurn = null;
    }
    const injectResponseTurns =
      injectResponseAdvertisesPendingTurn && pendingInjectedTurn
        ? [...turns, pendingInjectedTurn]
        : turns;
    send({
      id: msg.id,
      result: injectResponseIncludesTurns ? { thread: { id: threadId, turns: injectResponseTurns } } : {},
    });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?trimCli=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('sess-trim-cli', ?, 'active', 1, 2)`,
    ).run(project);
    for (const sessionId of [
      'sess-trim-cli',
      'codex:019dfabf-thread',
      'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
    ]) {
      if (sessionId !== 'sess-trim-cli') {
        db.prepare(
          `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
           VALUES (?, ?, 'active', 1, 1)`,
        ).run(sessionId, project);
      }
      for (let turn = 1; turn <= 22; turn++) {
        db.prepare(
          `INSERT INTO bodies
             (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 1, ?)`,
        ).run(sessionId, sessionId, turn, `assistant body ${turn}`, turn * 1000);
      }
    }
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

async function seedEmptyDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?trimCliEmpty=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('sess-empty-codex', ?, 'active', 1, 2)`,
    ).run(project);
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runTrim(home, project, args = [], input = null, extraEnv = {}) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'bin/throughline.mjs'), 'trim', ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...extraEnv,
    },
    input,
    encoding: 'utf8',
  });
}

test('trim CLI prints JSON dry-run plan for latest project session', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runTrim(home, project, ['--dry-run', '--host', 'claude', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.session.id, 'sess-trim-cli');
    assert.equal(plan.status, 'manual-only');
    assert.equal(plan.trim.capturedTurns, 22);
    assert.equal(plan.trim.rollbackTurns, 2);
    assert.equal(plan.trim.automaticExecutionAllowed, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI carries explicit Codex thread id in dry-run JSON', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runTrim(home, project, [
      '--dry-run',
      '--host',
      'codex',
      '--codex-thread-id',
      '019dfabf-thread',
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.hostIdentity, {
      host: 'codex',
      codexThreadId: '019dfabf-thread',
      explicit: true,
      reason: 'explicit_codex_thread_id',
    });
    assert.equal(plan.session.id, 'codex:019dfabf-thread');
    assert.equal(plan.trim.automaticExecutionAllowed, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI accepts --preview-max-chars for text dry-run reports', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runTrim(home, project, [
      '--dry-run',
      '--host',
      'codex',
      '--codex-thread-id',
      '019dfabf-thread',
      '--preview-max-chars',
      '120',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[preview truncated to 120 chars/);
    assert.match(result.stdout, /throughline codex-handoff-start --session codex:019dfabf-thread/);
    assert.match(result.stdout, /throughline codex-handoff-smoke --session codex:019dfabf-thread/);
    assert.match(result.stdout, /throughline codex-handoff-model-smoke --session codex:019dfabf-thread --dry-run --json/);
    assert.match(result.stdout, /throughline codex-resume --session codex:019dfabf-thread --format handoff/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI rejects invalid --preview-max-chars', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runTrim(home, project, ['--dry-run', '--preview-max-chars', '0']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--preview-max-chars must be a positive integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI uses explicit Codex rollout source when DB has no captured turns', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  try {
    await seedEmptyDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      turnCount: 22,
    });

    const result = runTrim(
      home,
      project,
      [
        '--dry-run',
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
        '--json',
      ],
      null,
      { CODEX_HOME: codexHome },
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.session.id, 'codex:019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
    assert.equal(plan.session.source, 'codex-rollout');
    assert.equal(plan.trim.source, 'codex-rollout');
    assert.equal(plan.trim.sourceReason, 'explicit_codex_thread_rollout');
    assert.equal(plan.trim.capturedTurns, 22);
    assert.equal(plan.trim.rollbackTurns, 2);
    assert.match(plan.memoryPreview.text, /Active Work Thread \(Codex Rollout\)/);
    assert.match(plan.memoryPreview.text, /codex user turn 22/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI uses env Codex thread id when no explicit thread id is passed', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });

    const result = runTrim(
      home,
      project,
      ['--dry-run', '--host', 'codex', '--json'],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_CODEX_THREAD_ID: threadId,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.hostIdentity, {
      host: 'codex',
      codexThreadId: threadId,
      explicit: false,
      reason: 'env_codex_thread_id',
      source: 'env:THROUGHLINE_CODEX_THREAD_ID',
    });
    assert.equal(plan.trim.source, 'codex-rollout');
    assert.equal(plan.trim.sourceReason, 'env_codex_thread_rollout');
    assert.equal(plan.trim.capturedTurns, 22);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI explicit Codex thread id overrides env thread id', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const explicitThreadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedEmptyDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId: explicitThreadId,
      turnCount: 22,
    });
    writeCodexRollout(codexHome, {
      project,
      threadId: '019dfabb-1111-7111-8111-111111111111',
      turnCount: 30,
    });

    const result = runTrim(
      home,
      project,
      [
        '--dry-run',
        '--host',
        'codex',
        '--codex-thread-id',
        explicitThreadId,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_CODEX_THREAD_ID: '019dfabb-1111-7111-8111-111111111111',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.hostIdentity, {
      host: 'codex',
      codexThreadId: explicitThreadId,
      explicit: true,
      reason: 'explicit_codex_thread_id',
    });
    assert.equal(plan.trim.capturedTurns, 22);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI refuses Claude non-dry-run automatic rollback/inject', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runTrim(home, project, ['--host', 'claude']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /automatic rollback\/inject is not implemented yet/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute does not require experimental env once --execute is explicit', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, { allowMutation: true });
    const result = runTrim(home, project, [
      '--host',
      'codex',
      '--codex-thread-id',
      '019dfabf-thread',
      '--execute',
      '--codex-app-server-bin',
      script,
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-sent-live-only');
    assert.equal(payload.reason, 'rollback_and_inject_sent_live_only');
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(existsSync(log), true, 'app-server should start for explicit execute');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute no longer blocks on missing host same-thread repair contract', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      hostRemediationPrimitive: false,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-sent-live-only');
    assert.equal(payload.reason, 'rollback_and_inject_sent_live_only');
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(existsSync(log), true, 'app-server mutation path should start without host repair primitive');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute does not require resume history as current-thread repair', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      hostRemediationPrimitive: false,
      hostResumeHistoryCandidate: true,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-sent-live-only');
    assert.equal(payload.reason, 'rollback_and_inject_sent_live_only');
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(existsSync(log), true, 'app-server mutation path should start without resume-history repair');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI preflight reads and resumes Codex thread without rollback or inject', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project);
    const result = runTrim(home, project, [
      '--host',
      'codex',
      '--codex-thread-id',
      '019dfabf-thread',
      '--preflight',
      '--codex-app-server-bin',
      script,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'preflight-ready');
    assert.equal(payload.preflight.rollbackSent, false);
    assert.equal(payload.preflight.injectSent, false);
    assert.equal(payload.preflight.readTurns, 2);
    assert.equal(payload.preflight.resumedTurns, 2);
    assert.equal(payload.preflight.rollbackRequestPreview.method, 'thread/rollback');
    assert.equal(payload.preflight.rollbackRequestPreview.params.numTurns, 2);

    const calledMethods = readFileSync(log, 'utf8');
    assert.match(calledMethods, /initialize/);
    assert.match(calledMethods, /thread\/read/);
    assert.match(calledMethods, /thread\/resume/);
    assert.doesNotMatch(calledMethods, /UNEXPECTED_MUTATION/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI preflight checks Codex rollout source against app-server turns', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, { threadId, turnCount: 22 });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--preflight',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { CODEX_HOME: codexHome },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'preflight-ready');
    assert.deepEqual(payload.preflight.turnCountCheck, {
      status: 'match',
      reason: 'rollout_and_app_server_turn_counts_match',
      expectedTurns: 22,
      readTurns: 22,
      resumedTurns: 22,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI preflight accepts env Codex thread id', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedEmptyDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, { threadId, turnCount: 22 });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--preflight',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: threadId,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'preflight-ready');
    assert.equal(payload.plan.hostIdentity.reason, 'env_codex_thread_id');
    assert.equal(payload.plan.hostIdentity.source, 'env:CODEX_THREAD_ID');
    assert.equal(payload.preflight.threadId, threadId);
    assert.equal(payload.preflight.turnCountCheck.status, 'match');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI preflight proceeds when rollout restore safety is risky', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const { script, log } = makeFakeCodexAppServer(project, {
      threadId,
      turnCount: 22,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--preflight',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'preflight-ready');
    assert.equal(payload.plan.trim.restoreSafety.status, 'risk');
    assert.equal(payload.preflight.rollbackSent, false);
    assert.equal(payload.preflight.injectSent, false);
    assert.equal(existsSync(log), true, 'app-server should start despite restore-safety diagnostics');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI preflight proceeds when compacted history already retains target text', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      retainedCompactedText: true,
    });
    const { script, log } = makeFakeCodexAppServer(project, {
      threadId,
      turnCount: 22,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--preflight',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'preflight-ready');
    assert.equal(payload.plan.trim.restoreSafety.status, 'ok');
    assert.equal(payload.plan.trim.plannedRollbackRestoreSafety.status, 'risk');
    assert.equal(
      payload.plan.trim.plannedRollbackRestoreSafety.risks[0].type,
      'planned_rollback_text_retained_in_compacted_replacement_history',
    );
    assert.equal(payload.preflight.rollbackSent, false);
    assert.equal(payload.preflight.injectSent, false);
    assert.equal(existsSync(log), true, 'app-server should start despite planned restore-safety diagnostics');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI execute refuses before rollback when rollout and app-server turn counts differ', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 21,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--keep-recent',
        '20',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { CODEX_HOME: codexHome, THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-refused');
    assert.equal(payload.reason, 'codex_rollout_app_server_turn_mismatch');
    assert.equal(payload.execution.rollbackSent, false);
    assert.equal(payload.execution.injectSent, false);
    assert.equal(payload.execution.turnCountCheck.status, 'mismatch');

    const calledMethods = readFileSync(log, 'utf8');
    assert.match(calledMethods, /thread\/read/);
    assert.match(calledMethods, /thread\/resume/);
    assert.doesNotMatch(calledMethods, /thread\/rollback/);
    assert.doesNotMatch(calledMethods, /thread\/inject_items/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI execute refuses rollout preview injection when Throughline DB memory is absent', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedEmptyDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { CODEX_HOME: codexHome, THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-refused');
    assert.equal(payload.reason, 'injectable_memory_required');
    assert.equal(payload.plan.memoryPreview.stats.source, 'codex-rollout');

    assert.equal(existsSync(log), false, 'app-server should not start without DB injectable memory');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI execute proceeds when rollout restore safety is risky', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
      restoreRisk: true,
    });
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1',
      },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-unverified');
    assert.equal(payload.reason, 'rollback_marker_not_observed_in_rollout');
    assert.equal(payload.plan.trim.restoreSafety.status, 'risk');
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(existsSync(log), true, 'app-server should start despite restore-safety diagnostics');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute rolls back then injects curated memory', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, { allowMutation: true });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-sent-live-only');
    assert.equal(payload.reason, 'rollback_and_inject_sent_live_only');
    assert.deepEqual(payload.durableVerification, {
      liveMutationSent: true,
      durableVerified: false,
      postInjectVisibilityStatus: 'match',
      restoreSafetyStatus: 'unknown',
      rolloutPath: null,
      rolloutChecked: false,
      postExecuteRestoreSafetyStatus: null,
      observedNewRollbackEvent: false,
      observedInjectedMemory: false,
      reasons: ['rollout_path_unavailable_for_durable_verification'],
    });
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(payload.execution.injectedItems, 1);
    assert.equal(payload.execution.afterTurns, 1);
    assert.equal(payload.execution.postInjectReadAttempts, 1);
    assert.equal(payload.execution.postInjectVisibilityCheck.status, 'match');
    assert.equal(payload.execution.postInjectVisibilityCheck.expectedTurns, 1);
    assert.equal(payload.plan.mode, 'execute');

    const calledMethods = readFileSync(log, 'utf8');
    assertInOrder(calledMethods, [
      'initialize\n',
      'thread/read\n',
      'thread/resume\n',
      'thread/rollback\n',
      'thread/inject_items\n',
      'thread/read\n',
    ]);
    assert.match(calledMethods, /INJECT_TEXT:## Throughline: Active Work Context/);
    assert.match(calledMethods, /Active Work Thread \(Recent L2\)/);
    assert.doesNotMatch(calledMethods, /UNEXPECTED_MUTATION/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute reports durable verified when rollout records rollback and injected memory', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    const rolloutPath = writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
      durableRolloutPath: rolloutPath,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-durable-verified');
    assert.equal(payload.reason, 'rollback_and_inject_durable_verified');
    assert.equal(payload.durableVerification.durableVerified, true);
    assert.equal(payload.durableVerification.rolloutPath, rolloutPath);
    assert.equal(payload.durableVerification.rolloutChecked, true);
    assert.equal(payload.durableVerification.postExecuteRestoreSafetyStatus, 'ok');
    assert.equal(payload.durableVerification.observedNewRollbackEvent, true);
    assert.equal(payload.durableVerification.observedInjectedMemory, true);
    assert.deepEqual(payload.durableVerification.reasons, ['rollout_durable_evidence_verified']);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute treats developer memory injection as item-level when it creates no turn', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    const rolloutPath = writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
      durableRolloutPath: rolloutPath,
      injectCreatesTurn: false,
      injectResponseIncludesTurns: false,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-durable-verified');
    assert.equal(payload.execution.rollbackResultTurns, 20);
    assert.equal(payload.execution.injectResultTurns, null);
    assert.deepEqual(payload.execution.postInjectVisibilityCheck, {
      status: 'match',
      reason: 'post_inject_turn_count_visible',
      expectedTurns: 20,
      actualTurns: 20,
    });
    assert.equal(payload.durableVerification.observedInjectedMemory, true);
    assert.deepEqual(payload.durableVerification.reasons, ['rollout_durable_evidence_verified']);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute polls rollout until delayed durable evidence appears', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    const rolloutPath = writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
      durableRolloutPath: rolloutPath,
      durableRolloutAppendDelayMs: 50,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-durable-verified');
    assert.equal(payload.durableVerification.durableVerified, true);
    assert.equal(payload.durableVerification.observedNewRollbackEvent, true);
    assert.equal(payload.durableVerification.observedInjectedMemory, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('trim CLI execute report says L3 bodies are not injected', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script } = makeFakeCodexAppServer(project, { allowMutation: true });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Status: execute-sent-live-only/);
    assert.match(result.stdout, /Durable verified: no/);
    assert.match(result.stdout, /Injected items: 1/);
    assert.match(result.stdout, /Injected memory source: throughline-db/);
    assert.match(
      result.stdout,
      /Memory contract: older L1 \+ latest 20 L2 full bodies \+ L3 references only/,
    );
    assert.match(result.stdout, /Recent L2 bodies: 20 rows \(latest 20 turns\)/);
    assert.match(result.stdout, /L3 bodies injected: no \(references only: 0\)/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute waits until injected Codex memory is visible', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      delayedInjectVisibilityReads: 1,
      injectResponseAdvertisesPendingTurn: true,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-sent-live-only');
    assert.equal(payload.execution.afterTurns, 1);
    assert.equal(payload.execution.postInjectReadAttempts, 2);
    assert.deepEqual(payload.execution.postInjectVisibilityCheck, {
      status: 'match',
      reason: 'post_inject_turn_count_visible',
      expectedTurns: 1,
      actualTurns: 1,
    });

    const calledMethods = readFileSync(log, 'utf8');
    assertInOrder(calledMethods, [
      'initialize\n',
      'thread/read\n',
      'thread/resume\n',
      'thread/rollback\n',
      'thread/inject_items\n',
      'thread/read\n',
      'thread/read\n',
    ]);
    assert.equal([...calledMethods.matchAll(/^thread\/read$/gm)].length, 3);
    assert.match(calledMethods, /INJECT_TEXT:## Throughline: Active Work Context/);
    assert.doesNotMatch(calledMethods, /UNEXPECTED_MUTATION/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI guarded execute reports unverified when injected memory visibility times out', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const { script, log } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      delayedInjectVisibilityReads: 10,
      injectResponseAdvertisesPendingTurn: true,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        '019dfabf-thread',
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-unverified');
    assert.equal(payload.reason, 'post_inject_turn_count_not_visible_after_reads');
    assert.deepEqual(payload.durableVerification, {
      liveMutationSent: true,
      durableVerified: false,
      postInjectVisibilityStatus: 'timeout',
      restoreSafetyStatus: 'unknown',
      rolloutPath: null,
      rolloutChecked: false,
      postExecuteRestoreSafetyStatus: null,
      observedNewRollbackEvent: false,
      observedInjectedMemory: false,
      reasons: [
        'post_inject_turn_count_not_visible_after_reads',
        'rollout_path_unavailable_for_durable_verification',
      ],
    });
    assert.equal(payload.execution.postInjectVisibilityCheck.status, 'timeout');

    const calledMethods = readFileSync(log, 'utf8');
    assert.match(calledMethods, /thread\/rollback/);
    assert.match(calledMethods, /thread\/inject_items/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI execute checks durable rollout evidence even when post-inject visibility times out', async () => {
  const home = makeTempHome();
  const codexHome = makeTempHome();
  const project = makeTempProject();
  const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
  try {
    await seedDb(home, project);
    const rolloutPath = writeCodexRollout(codexHome, {
      project,
      threadId,
      turnCount: 22,
    });
    const { script } = makeFakeCodexAppServer(project, {
      allowMutation: true,
      threadId,
      turnCount: 22,
      durableRolloutPath: rolloutPath,
      delayedInjectVisibilityReads: 10,
      injectResponseAdvertisesPendingTurn: true,
    });
    const result = runTrim(
      home,
      project,
      [
        '--host',
        'codex',
        '--codex-thread-id',
        threadId,
        '--execute',
        '--codex-app-server-bin',
        script,
        '--json',
      ],
      null,
      {
        CODEX_HOME: codexHome,
        THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE: '1',
      },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'execute-unverified');
    assert.equal(payload.reason, 'post_inject_turn_count_not_visible_after_reads');
    assert.equal(payload.durableVerification.postInjectVisibilityStatus, 'timeout');
    assert.equal(payload.durableVerification.rolloutPath, rolloutPath);
    assert.equal(payload.durableVerification.rolloutChecked, true);
    assert.equal(payload.durableVerification.postExecuteRestoreSafetyStatus, 'ok');
    assert.equal(payload.durableVerification.observedNewRollbackEvent, true);
    assert.equal(payload.durableVerification.observedInjectedMemory, true);
    assert.deepEqual(payload.durableVerification.reasons, ['post_inject_turn_count_not_visible_after_reads']);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

function assertInOrder(text, needles) {
  let offset = 0;
  for (const needle of needles) {
    const index = text.indexOf(needle, offset);
    assert.notEqual(index, -1, `missing ${needle.trim()} after offset ${offset}`);
    offset = index + needle.length;
  }
}

function writeCodexRollout(
  codexHome,
  { project, threadId, turnCount, restoreRisk = false, retainedCompactedText = false },
) {
  const dir = join(codexHome, 'sessions', '2026', '05', '06');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-06T09-40-50-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-06T00:40:50.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-06T00:40:50.000Z',
        cwd: project,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    },
  ];

  for (let turn = 1; turn <= turnCount; turn++) {
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `codex user turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.100Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.200Z`,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: `codex assistant turn ${turn}`,
      },
    });
    rows.push({
      timestamp: `2026-05-06T00:41:${String(turn).padStart(2, '0')}.300Z`,
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
  }

  if (retainedCompactedText) {
    rows.push({
      timestamp: '2026-05-06T00:41:59.000Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `codex user turn ${turnCount}` }],
          },
        ],
      },
    });
    rows.push({
      timestamp: '2026-05-06T00:41:59.100Z',
      type: 'event_msg',
      payload: { type: 'context_compacted' },
    });
  }

  if (restoreRisk) {
    const riskyText = `codex user turn ${turnCount}`;
    rows.push({
      timestamp: '2026-05-06T00:42:00.000Z',
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
      timestamp: '2026-05-06T00:42:00.100Z',
      type: 'event_msg',
      payload: { type: 'context_compacted' },
    });
    rows.push({
      timestamp: '2026-05-06T00:42:00.200Z',
      type: 'event_msg',
      payload: { type: 'thread_rolled_back', num_turns: 1 },
    });
    rows.push({
      timestamp: '2026-05-06T00:42:00.300Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: riskyText }],
      },
    });
    rows.push({
      timestamp: '2026-05-06T00:42:00.400Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: riskyText,
      },
    });
  }

  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

test('trim CLI accepts current-work memo on stdin for dry-run preview', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runTrim(
      home,
      project,
      ['--dry-run', '--host', 'claude', '--memo-stdin'],
      '**次の一手**: preserve current work framing',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /In-flight Memo/);
    assert.match(result.stdout, /preserve current work framing/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
