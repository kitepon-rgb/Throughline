import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-summarize-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-summarize-project-'));
}

function makeFakeCodexCli(dir) {
  const script = join(dir, 'fake-codex-cli.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  if (process.argv[2] !== 'exec') process.exit(7);
  if (!stdin.includes('[assistant]: assistant turn 1')) process.exit(8);
  process.stdout.write('fake codex l1 summary\\n');
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

async function seedDb(home, project, turnCount = 21) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?codexSummarize=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-summary', ?, 'active', 1, 2)`,
    ).run(project);
    const insert = db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-summary', 'codex:thread-summary', ?, ?, ?, 3, ?)`,
    );
    for (let turn = 1; turn <= turnCount; turn++) {
      insert.run(turn, 'user', `user turn ${turn}`, turn * 100);
      insert.run(turn, 'assistant', `assistant turn ${turn}`, turn * 100 + 1);
    }
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runSummarize(home, project, args = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-summarize', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
}

test('codex-summarize writes L1 skeleton through Codex CLI backend', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project, 21);
    const fake = makeFakeCodexCli(project);
    const result = runSummarize(
      home,
      project,
      ['--session', 'codex:thread-summary', '--json'],
      { THROUGHLINE_CODEX_CLI_BIN: fake },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'summarized');
    assert.equal(payload.reason, 'codex_cli_l1_written');
    assert.equal(payload.summarized[0].turnNumber, 1);
    assert.equal(payload.summarized[0].source, 'codex-cli');

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const mod = await import(`./db.mjs?codexSummarizeAssert=${Date.now()}-${Math.random()}`);
      const db = mod.getDb();
      const row = db.prepare('SELECT summary FROM skeletons WHERE turn_number = 1').get();
      assert.equal(row.summary, 'fake codex l1 summary');
      db.close();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-summarize skips sessions inside the L2 window', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project, 20);
    const result = runSummarize(home, project, ['--session', 'codex:thread-summary', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'skipped');
    assert.equal(payload.reason, 'within_l2_window');
    assert.deepEqual(payload.summarized, []);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
