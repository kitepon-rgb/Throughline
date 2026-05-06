import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function makeFakeCodexAppServer(dir, { allowMutation = false } = {}) {
  const script = join(dir, 'fake-codex-app-server.mjs');
  const log = join(dir, 'fake-codex-app-server.log');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = ${JSON.stringify(log)};
const allowMutation = ${JSON.stringify(allowMutation)};
const threadId = '019dfabf-thread';
let turns = [{ id: 'turn-1' }, { id: 'turn-2' }];
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  appendFileSync(log, msg.method + '\\n');
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/codex' } });
  } else if (msg.method === 'thread/read') {
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
    send({ id: msg.id, result: { thread: { id: threadId, turns } } });
  } else if (msg.method === 'thread/inject_items') {
    if (!allowMutation) {
      appendFileSync(log, 'UNEXPECTED_MUTATION:' + msg.method + '\\n');
      send({ id: msg.id, error: { code: -32000, message: 'mutation must not be called' } });
      return;
    }
    const injected = msg.params.items?.[0]?.content?.[0]?.text ?? '';
    appendFileSync(log, 'INJECT_TEXT:' + injected.replace(/\\n/g, ' ') + '\\n');
    turns = [...turns, { id: 'injected-memory' }];
    send({ id: msg.id, result: { thread: { id: threadId, turns } } });
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
    for (let turn = 1; turn <= 22; turn++) {
      db.prepare(
        `INSERT INTO bodies
           (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
         VALUES ('sess-trim-cli', 'sess-trim-cli', ?, 'assistant', ?, 1, ?)`,
      ).run(turn, `assistant body ${turn}`, turn * 1000);
    }
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
    assert.equal(plan.trim.automaticExecutionAllowed, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('trim CLI refuses non-dry-run execution until automatic trim integration exists', async () => {
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

test('trim CLI refuses guarded execute without experimental env', async () => {
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
    assert.equal(payload.status, 'execute-refused');
    assert.equal(payload.reason, 'experimental_env_required');
    assert.throws(() => readFileSync(log, 'utf8'), /ENOENT/);
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
      { THROUGHLINE_EXPERIMENTAL_CODEX_TRIM: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'executed');
    assert.equal(payload.execution.rollbackSent, true);
    assert.equal(payload.execution.injectSent, true);
    assert.equal(payload.execution.injectedItems, 1);
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
    assert.match(calledMethods, /INJECT_TEXT:## Throughline Trim Memory Preview/);
    assert.match(calledMethods, /Active Work Thread \(Recent L2\)/);
    assert.doesNotMatch(calledMethods, /UNEXPECTED_MUTATION/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
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
