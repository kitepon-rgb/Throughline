import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'tl-hooks-home-'));
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'tl-hooks-project-'));
}

function childEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    THROUGHLINE_NO_VSCODE: '1',
  };
}

function runNode(args, { home, cwd = REPO_ROOT, input = '' }) {
  return spawnSync(process.execPath, args, {
    cwd,
    env: childEnv(home),
    input,
    encoding: 'utf8',
  });
}

function openDb(home) {
  return new DatabaseSync(join(home, '.throughline', 'throughline.db'));
}

test('hook modules can be imported without executing their hook body', () => {
  const home = makeTempHome();
  try {
    const result = runNode(
      [
        '--input-type=module',
        '-e',
        [
          "await import('./src/prompt-submit.mjs');",
          "await import('./src/session-start.mjs');",
          "await import('./src/turn-processor.mjs');",
        ].join('\n'),
      ],
      { home },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(home, '.throughline')),
      false,
      'importing hook modules should not create the real hook DB or state dir',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit subprocess writes a /tl baton into an isolated DB', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'old-session',
        cwd: project,
        prompt: '/tl',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT project_path, session_id FROM handoff_batons').get();
    assert.equal(row.project_path, project);
    assert.equal(row.session_id, 'old-session');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit subprocess writes a /clear baton (specific session marker)', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'cleared-session',
        cwd: project,
        prompt: '/clear',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT project_path, session_id FROM handoff_batons').get();
    assert.equal(row.project_path, project);
    assert.equal(row.session_id, 'cleared-session');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit: /clear baton overwrites previous /tl baton in same project', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const tl = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'session-A', cwd: project, prompt: '/tl' }),
    });
    assert.equal(tl.status, 0, tl.stderr);

    const clear = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({ session_id: 'session-B', cwd: project, prompt: '/clear' }),
    });
    assert.equal(clear.status, 0, clear.stderr);

    const db = openDb(home);
    const row = db.prepare('SELECT session_id FROM handoff_batons').get();
    assert.equal(row.session_id, 'session-B', 'most recent baton write wins');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('prompt-submit: non-baton prompt does not write any baton', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'session-X',
        cwd: project,
        prompt: 'hello world',
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    if (existsSync(join(home, '.throughline', 'throughline.db'))) {
      const db = openDb(home);
      const row = db.prepare('SELECT COUNT(*) AS n FROM handoff_batons').get();
      assert.equal(row.n, 0, 'a normal prompt must not create any baton');
      db.close();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('session-start subprocess consumes baton and injects inherited resume context', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const baton = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'old-session',
        cwd: project,
        prompt: '/tl',
      }),
    });
    assert.equal(baton.status, 0, baton.stderr);

    const db = openDb(home);
    db.prepare(
      `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
       VALUES ('old-session', ?, 'active', 1, 1)`,
    ).run(project);
    db.prepare(
      `INSERT INTO bodies
         (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES ('old-session', 'old-session', 1, 'assistant', 'old assistant body', 4, 2)`,
    ).run();
    db.close();

    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        source: 'startup',
      }),
    });

    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /old assistant body/);

    const after = openDb(home);
    const old = after
      .prepare("SELECT merged_into FROM sessions WHERE session_id = 'old-session'")
      .get();
    const batons = after.prepare('SELECT COUNT(*) AS c FROM handoff_batons').get();
    assert.equal(old.merged_into, 'new-session');
    assert.equal(batons.c, 0);
    after.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('session-start subprocess does not inject context when no baton exists', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    const started = runNode([join(REPO_ROOT, 'src/session-start.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'new-session',
        cwd: project,
        source: 'startup',
      }),
    });

    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, '');

    const db = openDb(home);
    const row = db
      .prepare("SELECT session_id, project_path FROM sessions WHERE session_id = 'new-session'")
      .get();
    assert.equal(row.session_id, 'new-session');
    assert.equal(row.project_path, project);
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('process-turn subprocess stores L2 bodies and L3 details in an isolated DB', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  const transcriptPath = join(project, 'transcript.jsonl');
  try {
    const entries = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run the check' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'asst-tool',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should inspect the output first' },
            {
              type: 'tool_use',
              id: 'toolu_check',
              name: 'Bash',
              input: { command: 'echo ok' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_check',
              content: 'ok\n',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 5,
            output_tokens: 10,
          },
          content: [{ type: 'text', text: 'check passed' }],
        },
      },
    ];
    writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n'));

    const result = runNode([join(REPO_ROOT, 'src/turn-processor.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'turn-session',
        cwd: project,
        transcript_path: transcriptPath,
      }),
    });

    assert.equal(result.status, 0, result.stderr);

    const db = openDb(home);
    const bodies = db
      .prepare('SELECT role, text FROM bodies ORDER BY role')
      .all()
      .map((row) => ({ role: row.role, text: row.text }));
    assert.deepEqual(bodies, [
      { role: 'assistant', text: 'check passed' },
      { role: 'user', text: 'run the check' },
    ]);

    const details = db
      .prepare('SELECT kind, tool_name, source_id, input_text, output_text FROM details ORDER BY id')
      .all();
    assert.equal(details.length, 3);
    assert.deepEqual(details.map((d) => d.kind), [
      'thinking',
      'tool_input',
      'tool_output',
    ]);
    assert.equal(details[0].source_id, 'asst-tool:thinking:0');
    assert.equal(details[0].output_text, 'I should inspect the output first');
    assert.equal(details[1].tool_name, 'Bash');
    assert.match(details[1].input_text, /echo ok/);
    assert.equal(details[2].tool_name, 'Bash');
    assert.equal(details[2].output_text, 'ok\n');
    db.close();
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Phase 0-5 spike (UserPromptSubmit) ----

function seedMergedSession(home, sessionId, originId = 'orig-sess') {
  // DB を直接作って bodies に origin != session_id を入れ、spikeInject が
  // recentBodies を返せる状態にする。
  const dbPath = join(home, '.throughline', 'throughline.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE IF NOT EXISTS skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
    CREATE TABLE IF NOT EXISTS handoff_batons (
      project_path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO sessions (session_id, project_path, status, created_at, updated_at)
     VALUES (?, '/repo', 'active', 1, 2)`,
  ).run(sessionId);
  for (const r of [
    { turn: 1, role: 'user', text: 'past user turn', createdAt: 1000 },
    { turn: 2, role: 'assistant', text: 'past assistant turn', createdAt: 1100 },
  ]) {
    db.prepare(
      `INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(sessionId, originId, r.turn, r.role, r.text, r.createdAt);
  }
  db.close();
}

function touchSpikePromptFlag(home) {
  const flagPath = join(home, '.throughline', 'spike-prompt.flag');
  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, '', 'utf8');
}

function readPromptSpikeLog(home) {
  const path = join(home, '.throughline', 'logs', 'prompt-spike.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('Phase 0-5: spike SKIPS when marker file is absent', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-no-marker');
    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(transcriptPath, '', 'utf8');

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-no-marker',
        cwd: project,
        prompt: 'hello world',
        transcript_path: transcriptPath,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(transcriptPath, 'utf8'), '', 'transcript untouched');
    assert.equal(readPromptSpikeLog(home).length, 0, 'no spike log entry');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike LOGS skip_reason when transcript_path is missing in payload', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-no-tp');
    touchSpikePromptFlag(home);

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-no-tp',
        cwd: project,
        prompt: 'hello world',
        // transcript_path omitted
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const logs = readPromptSpikeLog(home);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].skip_reason, 'no_transcript_path_in_payload');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike INJECTS into JSONL chain-reachable from last uuid on first prompt', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-inject');
    touchSpikePromptFlag(home);

    // Pre-populate transcript with 1 attachment line (= simulates SessionStart hook output)
    const transcriptPath = join(project, 'transcript.jsonl');
    const attachmentLine = JSON.stringify({
      type: 'attachment',
      uuid: 'pre-attach-uuid',
      parentUuid: null,
    });
    writeFileSync(transcriptPath, attachmentLine + '\n', 'utf8');

    const result = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-inject',
        cwd: project,
        prompt: 'tell me the spike-tracer',
        transcript_path: transcriptPath,
        version: '2.1.145',
        gitBranch: 'main',
      }),
    });
    assert.equal(result.status, 0, result.stderr);

    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3, '1 preexisting + 2 spike lines');
    const firstSpike = JSON.parse(lines[1]);
    assert.equal(firstSpike.parentUuid, 'pre-attach-uuid', 'chain (b) from last attachment uuid');
    const lastSpike = JSON.parse(lines[2]);
    assert.match(
      lastSpike.message.content[0].text,
      /\[spike-tracer: [0-9a-f]{8}\]$/,
      'tracer in last assistant',
    );

    const logs = readPromptSpikeLog(home);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].parent_uuid_start, 'pre-attach-uuid');
    assert.equal(logs[0].appended, 2);
    assert.match(logs[0].tracer, /^[0-9a-f]{8}$/);

    // per-session marker created
    assert.ok(
      existsSync(join(home, '.throughline', 'spike-prompt-state', 'sess-inject')),
      'per-session marker created after successful spike',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: spike is IDEMPOTENT per session (second call is no-op)', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-idem');
    touchSpikePromptFlag(home);

    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'attachment', uuid: 'preU', parentUuid: null }) + '\n',
      'utf8',
    );

    const firstPayload = JSON.stringify({
      session_id: 'sess-idem',
      cwd: project,
      prompt: 'first',
      transcript_path: transcriptPath,
    });
    const secondPayload = JSON.stringify({
      session_id: 'sess-idem',
      cwd: project,
      prompt: 'second',
      transcript_path: transcriptPath,
    });

    const r1 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: firstPayload,
    });
    assert.equal(r1.status, 0, r1.stderr);
    const after1 = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim()).length;

    const r2 = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: secondPayload,
    });
    assert.equal(r2.status, 0, r2.stderr);
    const after2 = readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim()).length;

    assert.equal(after2, after1, 'second prompt did not append additional lines');
    assert.equal(readPromptSpikeLog(home).length, 1, 'only the first call logged');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase 0-5: /tl and /clear prompts do NOT trigger spike', () => {
  const home = makeTempHome();
  const project = makeTempProject();
  try {
    seedMergedSession(home, 'sess-slash');
    touchSpikePromptFlag(home);
    const transcriptPath = join(project, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'attachment', uuid: 'preU', parentUuid: null }) + '\n',
      'utf8',
    );

    const r = runNode([join(REPO_ROOT, 'src/prompt-submit.mjs')], {
      home,
      cwd: project,
      input: JSON.stringify({
        session_id: 'sess-slash',
        cwd: project,
        prompt: '/tl',
        transcript_path: transcriptPath,
      }),
    });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(readPromptSpikeLog(home).length, 0, 'no spike log for /tl');
    assert.ok(
      !existsSync(join(home, '.throughline', 'spike-prompt-state', 'sess-slash')),
      'per-session marker NOT created for /tl',
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
