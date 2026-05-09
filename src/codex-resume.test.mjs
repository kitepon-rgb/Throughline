import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-resume-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-codex-resume-project-'));
}

async function seedDb(home, project) {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`./db.mjs?codexResume=${Date.now()}-${Math.random()}`);
    const db = mod.getDb();
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('codex:thread-resume', ?, 'active', 1, 2)`,
    ).run(project);
    db.prepare(
      `INSERT INTO skeletons
         (session_id, origin_session_id, turn_number, role, summary, created_at)
       VALUES ('codex:thread-resume', 'codex:thread-resume', 1, 'assistant',
               'older codex summary', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('codex:thread-resume', 'codex:thread-resume', 2, 'assistant',
               'latest codex body', 3, 2000)`,
    ).run();
    db.prepare(
      `INSERT INTO details
         (session_id, origin_session_id, turn_number, tool_name, input_text, output_text,
          token_count, created_at, kind, source_id)
       VALUES ('codex:thread-resume', 'codex:thread-resume', 2, 'exec_command',
               '{"cmd":"pwd"}', NULL, 3, 2000, 'tool_input', 'codex-tool-1')`,
    ).run();
    db.close();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function runResume(home, project, args = [], input = undefined) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-resume', ...args],
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

test('codex-resume prints active-work context text for explicit Codex session', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(home, project, ['--session', 'codex:thread-resume']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Throughline: Active Work Context/);
    assert.match(result.stdout, /Source agent: codex/);
    assert.match(result.stdout, /older codex summary/);
    assert.match(result.stdout, /latest codex body/);
    // 新仕様: 詳細取得方法は header の placeholder で announce
    assert.match(result.stdout, /throughline detail HH:MM:SS/);
    // 新仕様: L2 行末尾に inline `(詳細：…)` suffix (turn 2 の tool_input=exec_command 1 件)
    assert.match(result.stdout, /latest codex body \(詳細：exec_command\)/);
    // 旧 `### Detail References` セクションは廃止されている
    assert.ok(!result.stdout.includes('### Detail References'));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume can print a Codex developer message item JSON', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(home, project, [
      '--session',
      'codex:thread-resume',
      '--format',
      'item-json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const item = JSON.parse(result.stdout);
    assert.equal(item.type, 'message');
    assert.equal(item.role, 'developer');
    assert.equal(item.content[0].type, 'input_text');
    assert.match(item.content[0].text, /current-task context for continuation/);
    assert.match(item.content[0].text, /latest codex body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume can print a fresh-thread handoff prompt', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(home, project, [
      '--session',
      'codex:thread-resume',
      '--format',
      'handoff',
      '--max-detail-refs',
      '0',
      '--max-recent-bodies',
      '1',
      '--max-body-chars',
      '6',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Throughline: New Codex Thread Handoff/);
    assert.match(result.stdout, /fresh Codex thread without mutating the risky current thread/);
    assert.match(result.stdout, /older codex summary/);
    assert.match(result.stdout, /latest/);
    assert.match(result.stdout, /\[entry truncated to 6 chars\]/);
    assert.doesNotMatch(result.stdout, /codex body/);
    // 新仕様: 旧 Detail References セクションは廃止されたので「N detail commands
    // available; omitted」メッセージは出ない。--max-detail-refs はバリデーションだけ
    // 残る no-op フラグになっている。
    assert.ok(!result.stdout.includes('### Detail References'));
    assert.ok(!result.stdout.includes('detail commands available; omitted'));
    assert.doesNotMatch(result.stdout, /^\{/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume accepts Codex-primary in-flight memo on stdin', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(
      home,
      project,
      ['--session', 'codex:thread-resume', '--memo-stdin'],
      'Next: continue Codex memo surface',
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /### In-flight Memo/);
    assert.match(result.stdout, /Next: continue Codex memo surface/);
    assert.match(result.stdout, /latest codex body/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume rejects invalid handoff detail reference limit', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(home, project, [
      '--session',
      'codex:thread-resume',
      '--format',
      'handoff',
      '--max-detail-refs',
      '-1',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--max-detail-refs must be a non-negative integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume rejects invalid handoff body limits', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const recentBodies = runResume(home, project, [
      '--session',
      'codex:thread-resume',
      '--format',
      'handoff',
      '--max-recent-bodies',
      '-1',
    ]);
    assert.equal(recentBodies.status, 1);
    assert.match(recentBodies.stderr, /--max-recent-bodies must be a non-negative integer/);

    const bodyChars = runResume(home, project, [
      '--session',
      'codex:thread-resume',
      '--format',
      'handoff',
      '--max-body-chars',
      '-1',
    ]);
    assert.equal(bodyChars.status, 1);
    assert.match(bodyChars.stderr, /--max-body-chars must be a non-negative integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-resume uses latest Codex session for cwd when --session is omitted', async () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    await seedDb(home, project);
    const result = runResume(home, project);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Throughline session: codex:thread-resume/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
