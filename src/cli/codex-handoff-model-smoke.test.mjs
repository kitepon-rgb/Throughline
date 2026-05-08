import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-model-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-handoff-model-project-'));
}

function makeFakeCodexCli(dir) {
  const script = join(dir, 'fake-codex-cli.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? '';
if (!process.argv.includes('exec')) process.exit(7);
if (!process.argv.includes('--ephemeral')) process.exit(8);
if (!prompt.includes('latest handoff model body')) process.exit(9);
const marker = (prompt.match(/TL_CLI_HANDOFF_MODEL/) ?? [''])[0];
process.stdout.write(marker + '\\n');
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
    const mod = await import(`../db.mjs?codexHandoffModel=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-handoff-model', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-handoff-model', 'codex:thread-handoff-model', 1, 'assistant',
               'latest handoff model body', 4, 1000)`,
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
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-handoff-model-smoke', ...args],
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

test('codex-handoff-model-smoke refuses without explicit env', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-handoff-model',
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

test('codex-handoff-model-smoke dry-run does not require env or start Codex exec', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-handoff-model',
      '--marker',
      'TL_CLI_HANDOFF_MODEL_DRY_RUN',
      '--dry-run',
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'dry-run');
    assert.equal(payload.reason, 'codex_exec_not_started');
    assert.equal(payload.sessionId, 'codex:thread-handoff-model');
    assert.equal(payload.handoffSmoke.status, 'ready');
    assert.equal(payload.wouldRun, false);
    assert.equal(payload.mutatesCurrentThread, false);
    assert.equal(payload.markerVisible, false);
    assert.equal(payload.proofScope, 'dry_run_only');
    assert.equal(payload.commandPreview.at(-1), '<prompt>');
    assert.equal(payload.prompt, undefined);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-model-smoke dry-run can print the exact model prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(home, project, [
      '--session',
      'codex:thread-handoff-model',
      '--marker',
      'TL_CLI_HANDOFF_MODEL_PRINT',
      '--dry-run',
      '--print-prompt',
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'dry-run');
    assert.match(payload.prompt, /## Throughline: New Codex Thread Handoff/);
    assert.match(payload.prompt, /### Throughline Fresh-Thread Handoff Model Smoke/);
    assert.match(payload.prompt, /TL_CLI_HANDOFF_MODEL_PRINT/);
    assert.equal(payload.modelPromptChars, payload.prompt.length);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-model-smoke dry-run accepts Codex-primary memo on stdin', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-handoff-model',
        '--marker',
        'TL_CLI_HANDOFF_MODEL_MEMO',
        '--dry-run',
        '--memo-stdin',
        '--print-prompt',
        '--json',
      ],
      {},
      '**Next move**: memo-visible model smoke',
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'dry-run');
    assert.match(payload.prompt, /In-flight Memo/);
    assert.match(payload.prompt, /memo-visible model smoke/);
    assert.match(payload.prompt, /TL_CLI_HANDOFF_MODEL_MEMO/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-model-smoke runs fake ephemeral Codex exec smoke', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const fake = makeFakeCodexCli(project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-handoff-model',
        '--marker',
        'TL_CLI_HANDOFF_MODEL',
        '--codex-cli-bin',
        fake,
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'visible');
    assert.equal(payload.reason, 'marker_found_in_codex_exec_output');
    assert.equal(payload.sessionId, 'codex:thread-handoff-model');
    assert.equal(payload.handoffSmoke.status, 'ready');
    assert.equal(payload.proofScope, 'codex_exec_ephemeral_read_only');
    assert.equal(payload.mutatesCurrentThread, false);
    assert.match(payload.stdout, /TL_CLI_HANDOFF_MODEL/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-handoff-model-smoke refuses when structural handoff smoke is not ready', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const fake = makeFakeCodexCli(project);
    const result = runSmoke(
      home,
      project,
      [
        '--session',
        'codex:thread-handoff-model',
        '--max-prompt-chars',
        '50',
        '--codex-cli-bin',
        fake,
        '--json',
      ],
      { THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'refused');
    assert.equal(payload.reason, 'handoff_smoke_not_ready');
    assert.equal(payload.handoffSmoke.status, 'not-ready');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
