import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

function runTrim(home, project, args = [], input = null) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'bin/throughline.mjs'), 'trim', ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
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
