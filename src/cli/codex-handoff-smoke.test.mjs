import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-smoke-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-smoke-project-'));
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`../db.mjs?codexHandoffSmoke=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-handoff-smoke', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('codex:thread-handoff-smoke', 'codex:thread-handoff-smoke', 1, 'assistant',
               'older handoff smoke summary', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-handoff-smoke', 'codex:thread-handoff-smoke', 2, 'assistant',
               'latest handoff smoke body', 4, 2000)`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runSmoke(home, project, args = [], input = undefined) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-handoff-smoke', ...args],
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

test('codex-handoff-smoke validates latest Codex session as JSON', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, ['--json']);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.sessionId, 'codex:thread-handoff-smoke');
    assert.equal(payload.reason, 'fresh_thread_handoff_prompt_ready');
    assert.equal(payload.checks.every((check) => check.status === 'pass'), true);
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-smoke can print the generated prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-handoff-smoke',
      '--print-prompt',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /throughline codex handoff smoke/);
    assert.match(result.stdout, /status:\s+ready/);
    assert.match(result.stdout, /Throughline: New Codex Thread Handoff/);
    assert.match(result.stdout, /latest handoff smoke body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-smoke exits nonzero when prompt size check fails', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-handoff-smoke',
      '--max-prompt-chars',
      '50',
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'not-ready');
    assert.equal(
      payload.checks.find((check) => check.id === 'prompt_size_within_limit')?.status,
      'fail',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-smoke rejects invalid limits', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runSmoke(home, project, ['--max-prompt-chars', '0']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--max-prompt-chars must be a positive integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
