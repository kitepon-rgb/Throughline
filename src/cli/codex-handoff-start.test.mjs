import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-start-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-start-project-'));
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`../db.mjs?codexHandoffStart=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-handoff-start', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('codex:thread-handoff-start', 'codex:thread-handoff-start', 1, 'assistant',
               'older handoff start summary', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-handoff-start', 'codex:thread-handoff-start', 2, 'assistant',
               'latest handoff start body', 4, 2000)`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runStart(home, project, args = [], input = undefined) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-handoff-start', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      encoding: 'utf8',
      input,
    },
  );
}

test('codex-handoff-start prints guided ready JSON for latest Codex session', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, ['--json']);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.reason, 'fresh_thread_handoff_start_ready');
    assert.equal(payload.sessionId, 'codex:thread-handoff-start');
    assert.equal(payload.mutatesCurrentThread, false);
    assert.equal(payload.startThreadManually, true);
    assert.equal(payload.memoStdin, false);
    assert.equal(payload.memoReplayNote, null);
    assert.equal(payload.handoffSmoke.status, 'ready');
    assert.match(payload.commands.structuralSmoke, /codex-handoff-smoke --session codex:thread-handoff-start/);
    assert.match(payload.commands.modelSmokeDryRun, /codex-handoff-model-smoke --session codex:thread-handoff-start/);
    assert.match(payload.commands.modelSmokeDryRun, /--dry-run --json/);
    assert.match(payload.commands.renderPrompt, /codex-resume --session codex:thread-handoff-start --format handoff/);
    assert.match(payload.commands.liveModelSmoke, /THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1/);
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start can print the exact fresh-thread prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, [
      '--session',
      'codex:thread-handoff-start',
      '--print-prompt',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /throughline codex handoff start/);
    assert.match(result.stdout, /status:\s+ready/);
    assert.match(result.stdout, /commands:/);
    assert.match(result.stdout, /## Throughline: New Codex Thread Handoff/);
    assert.match(result.stdout, /latest handoff start body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start refuses when structural handoff smoke is not ready', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(home, project, [
      '--session',
      'codex:thread-handoff-start',
      '--max-prompt-chars',
      '50',
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'not-ready');
    assert.equal(payload.reason, 'handoff_smoke_not_ready');
    assert.equal(payload.handoffSmoke.status, 'not-ready');
    assert.match(payload.commands.renderPrompt, /codex-resume --session codex:thread-handoff-start/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start carries memo stdin into the printed prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(
      home,
      project,
      ['--session', 'codex:thread-handoff-start', '--memo-stdin', '--print-prompt'],
      '**Next move**: continue guided start',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /In-flight Memo/);
    assert.match(result.stdout, /continue guided start/);
    assert.match(result.stdout, /--memo-stdin/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-start propagates memo-stdin to replay commands in JSON guidance', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runStart(
      home,
      project,
      ['--session', 'codex:thread-handoff-start', '--memo-stdin', '--json'],
      '**Next move**: replay memo',
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.memoStdin, true);
    assert.match(payload.memoReplayNote, /pipe the same memo/);
    assert.match(payload.commands.structuralSmoke, /--memo-stdin --json/);
    assert.match(payload.commands.modelSmokeDryRun, /--memo-stdin --dry-run --json/);
    assert.match(payload.commands.renderPrompt, /--memo-stdin/);
    assert.match(payload.commands.liveModelSmoke, /--memo-stdin --json/);
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
