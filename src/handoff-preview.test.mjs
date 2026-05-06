import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-handoff-preview-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-handoff-preview-project-'));
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?handoffPreview=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('sess-preview', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('sess-preview', 'sess-preview', 1, 'assistant', 'preview body', 3, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO details
         (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
          token_count, created_at, kind, source_id)
       VALUES ('sess-preview', 'sess-preview', 1, 'Bash', '{"command":"pwd"}',
               NULL, 3, 1000, 'tool_input', 'toolu_preview')`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runPreview(home, project, args = []) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'handoff-preview', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      encoding: 'utf8',
    },
  );
}

test('handoff-preview prints throughline_handoff JSON for explicit session', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runPreview(home, project, [
      '--session',
      'sess-preview',
      '--host-mode',
      'unknown',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const block = JSON.parse(result.stdout);
    assert.equal(block.kind, 'throughline_handoff');
    assert.equal(block.data.sessionId, 'sess-preview');
    assert.equal(block.data.projectPath, project);
    assert.equal(block.data.hostMode, 'unknown');
    assert.equal(block.data.memory.recentBodies[0].text, 'preview body');
    assert.equal(block.data.detailReferences[0].sourceId, 'toolu_preview');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('handoff-preview uses latest session for cwd when --session is omitted', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runPreview(home, project);

    assert.equal(result.status, 0, result.stderr);
    const block = JSON.parse(result.stdout);
    assert.equal(block.data.sessionId, 'sess-preview');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
