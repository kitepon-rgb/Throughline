import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
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
