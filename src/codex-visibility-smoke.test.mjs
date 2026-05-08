import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-visible-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-visible-project-'));
}

function makeFakeCodexAppServer(dir) {
  const script = join(dir, 'fake-codex-app-server.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let injectedText = '';
let resumeAfterInject = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    if (msg.method === 'thread/resume' && injectedText) resumeAfterInject = true;
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }] } } });
  } else if (msg.method === 'thread/inject_items') {
    injectedText = JSON.stringify(msg.params);
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [{ id: 'turn-1' }, { id: 'memory' }] } } });
  } else if (msg.method === 'turn/start') {
    const marker = resumeAfterInject ? 'TL_CLI_RESUME_AFTER_INJECT' : injectedText.includes('Codex memo smoke') ? 'TL_CLI_MEMO' : 'TL_CLI_VISIBLE';
    send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-2', itemId: 'item-1', delta: marker } });
    send({ id: msg.id, result: { turn: { id: 'turn-2' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?codexVisible=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-visible', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-visible', 'codex:thread-visible', 1, 'assistant',
               'visible smoke body', 3, 1000)`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runSmoke(home, project, args = [], extraEnv = {}, input = undefined) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-visibility-smoke', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...extraEnv,
      },
      encoding: 'utf8',
      input,
    },
  );
}

test('codex-visibility-smoke refuses without explicit experimental env', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-visible',
      '--marker',
      'TL_CLI_VISIBLE',
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'refused');
    assert.equal(payload.reason, 'experimental_env_required');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-visibility-smoke runs marker smoke with fake app-server', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const fake = makeFakeCodexAppServer(project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-visible',
        '--marker',
        'TL_CLI_VISIBLE',
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'visible');
    assert.equal(payload.reason, 'marker_found_in_agent_message');
    assert.equal(payload.threadId, 'thread-visible');
    assert.equal(payload.injectSent, true);
    assert.equal(payload.turnStartSent, true);
    assert.match(payload.agentText, /TL_CLI_VISIBLE/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-visibility-smoke includes Codex-primary memo stdin in injected memory', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const fake = makeFakeCodexAppServer(project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-visible',
        '--marker',
        'TL_CLI_MEMO',
        '--codex-app-server-bin',
        fake,
        '--memo-stdin',
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE: '1' },
      'Codex memo smoke: continue from the explicit memo.',
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'visible');
    assert.match(payload.agentText, /TL_CLI_MEMO/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-visibility-smoke can resume after inject before marker turn', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const fake = makeFakeCodexAppServer(project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-visible',
        '--marker',
        'TL_CLI_RESUME_AFTER_INJECT',
        '--codex-app-server-bin',
        fake,
        '--resume-after-inject',
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'visible');
    assert.equal(payload.resumeAfterInject, true);
    assert.equal(payload.postInjectResumedTurns, 1);
    assert.match(payload.agentText, /TL_CLI_RESUME_AFTER_INJECT/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
