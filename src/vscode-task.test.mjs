import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMonitorTaskFile,
  detectVsCode,
  detectJsoncFeatures,
  detectIndent,
  hasMonitorTask,
  buildMonitorTask,
  buildSetupNotice,
} from './vscode-task.mjs';

const VSCODE_ENV = { TERM_PROGRAM: 'vscode' };
const FAKE_BIN = '/fake/abs/path/bin/throughline.mjs';

function mkTmpCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'throughline-vscode-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// --- detectVsCode ---

test('detectVsCode: TERM_PROGRAM=vscode is detected', () => {
  assert.equal(detectVsCode({ TERM_PROGRAM: 'vscode' }), true);
});

test('detectVsCode: VSCODE_PID is detected', () => {
  assert.equal(detectVsCode({ VSCODE_PID: '123' }), true);
});

test('detectVsCode: VSCODE_IPC_HOOK_CLI is detected', () => {
  assert.equal(detectVsCode({ VSCODE_IPC_HOOK_CLI: '/tmp/sock' }), true);
});

test('detectVsCode: empty env is not detected', () => {
  assert.equal(detectVsCode({}), false);
});

test('detectVsCode: unrelated TERM_PROGRAM is not detected', () => {
  assert.equal(detectVsCode({ TERM_PROGRAM: 'iTerm.app' }), false);
});

// --- detectJsoncFeatures ---

test('detectJsoncFeatures: plain JSON is not JSONC', () => {
  assert.equal(detectJsoncFeatures('{"version":"2.0.0","tasks":[]}'), false);
});

test('detectJsoncFeatures: line comment is JSONC', () => {
  assert.equal(detectJsoncFeatures('{\n  // comment\n  "tasks": []\n}'), true);
});

test('detectJsoncFeatures: block comment is JSONC', () => {
  assert.equal(detectJsoncFeatures('{\n  /* block */\n  "tasks": []\n}'), true);
});

test('detectJsoncFeatures: trailing comma in array is JSONC', () => {
  assert.equal(detectJsoncFeatures('{"tasks":[1,2,]}'), true);
});

test('detectJsoncFeatures: trailing comma in object is JSONC', () => {
  assert.equal(detectJsoncFeatures('{"a":1,}'), true);
});

test('detectJsoncFeatures: // inside string literal is not JSONC', () => {
  assert.equal(detectJsoncFeatures('{"url":"http://example.com"}'), false);
});

test('detectJsoncFeatures: /* inside string literal is not JSONC', () => {
  assert.equal(detectJsoncFeatures('{"note":"/* not a comment */"}'), false);
});

test('detectJsoncFeatures: escaped quote inside string does not confuse scanner', () => {
  assert.equal(detectJsoncFeatures('{"s":"quote\\"inside"}'), false);
});

// --- detectIndent ---

test('detectIndent: 2-space indent detected', () => {
  assert.equal(detectIndent('{\n  "a": 1\n}'), '  ');
});

test('detectIndent: 4-space indent detected', () => {
  assert.equal(detectIndent('{\n    "a": 1\n}'), '    ');
});

test('detectIndent: tab indent detected', () => {
  assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
});

test('detectIndent: default to 2 spaces when no indent found', () => {
  assert.equal(detectIndent('{"a":1}'), '  ');
});

// --- hasMonitorTask ---

test('hasMonitorTask: returns true when label matches', () => {
  assert.equal(
    hasMonitorTask({ tasks: [{ label: 'Throughline Monitor' }] }),
    true,
  );
});

test('hasMonitorTask: returns true when command contains throughline monitor (label renamed)', () => {
  assert.equal(
    hasMonitorTask({
      tasks: [{ label: 'Renamed', command: '/abs/path/throughline', args: ['monitor'] }],
    }),
    true,
  );
});

test('hasMonitorTask: returns true when args contains throughline monitor', () => {
  assert.equal(
    hasMonitorTask({
      tasks: [{ command: '/usr/bin/node', args: ['/p/bin/throughline.mjs', 'monitor'] }],
    }),
    true,
  );
});

test('hasMonitorTask: returns false for unrelated tasks', () => {
  assert.equal(
    hasMonitorTask({ tasks: [{ label: 'Build', command: 'make' }] }),
    false,
  );
});

test('hasMonitorTask: handles missing tasks array', () => {
  assert.equal(hasMonitorTask({}), false);
  assert.equal(hasMonitorTask({ tasks: null }), false);
});

// --- buildMonitorTask ---

test('buildMonitorTask: uses type=shell with provided bin as args[0] for PTY allocation', () => {
  const task = buildMonitorTask('/abs/bin/throughline.mjs');
  assert.equal(task.label, 'Throughline Monitor');
  assert.equal(task.type, 'shell');
  assert.equal(task.args[0], '/abs/bin/throughline.mjs');
  assert.deepEqual(task.args.slice(1), ['monitor']);
  assert.equal(task.runOptions.runOn, 'folderOpen');
  assert.equal(task.isBackground, true);
});

// --- ensureMonitorTaskFile: skip conditions ---

test('ensureMonitorTaskFile: opt_out via THROUGHLINE_NO_VSCODE=1', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: { ...VSCODE_ENV, THROUGHLINE_NO_VSCODE: '1' },
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'opt_out');
    assert.equal(existsSync(join(dir, '.vscode', 'tasks.json')), false);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: no_cwd when cwd does not exist', () => {
  const result = ensureMonitorTaskFile({
    cwd: '/definitely/does/not/exist/xyz123',
    env: VSCODE_ENV,
    throughlineBin: FAKE_BIN,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no_cwd');
});

test('ensureMonitorTaskFile: no_cwd when cwd is missing', () => {
  const result = ensureMonitorTaskFile({
    env: VSCODE_ENV,
    throughlineBin: FAKE_BIN,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no_cwd');
});

test('ensureMonitorTaskFile: not_vscode when no VSCode env vars', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: {},
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'not_vscode');
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: no_bin when throughlineBin is empty', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: '',
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'no_bin');
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: create path ---

test('ensureMonitorTaskFile: created when .vscode/ missing', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'created');
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    assert.equal(existsSync(tasksPath), true);
    const obj = JSON.parse(readFileSync(tasksPath, 'utf8'));
    assert.equal(obj.version, '2.0.0');
    assert.equal(obj.tasks.length, 1);
    assert.equal(obj.tasks[0].label, 'Throughline Monitor');
    assert.equal(obj.tasks[0].type, 'shell');
    assert.equal(obj.tasks[0].args[0], FAKE_BIN);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: created when .vscode/ exists but tasks.json missing', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'created');
    assert.equal(existsSync(join(dir, '.vscode', 'tasks.json')), true);
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: merge path ---

test('ensureMonitorTaskFile: merged preserves existing tasks and version', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const existing = {
      version: '2.0.0',
      tasks: [
        { label: 'Build', type: 'shell', command: 'make' },
        { label: 'Test', type: 'shell', command: 'make test' },
      ],
    };
    writeFileSync(join(dir, '.vscode', 'tasks.json'), JSON.stringify(existing, null, 2));
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'merged');
    const obj = JSON.parse(readFileSync(join(dir, '.vscode', 'tasks.json'), 'utf8'));
    assert.equal(obj.version, '2.0.0');
    assert.equal(obj.tasks.length, 3);
    assert.equal(obj.tasks[0].label, 'Build');
    assert.equal(obj.tasks[1].label, 'Test');
    assert.equal(obj.tasks[2].label, 'Throughline Monitor');
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: merged sets version when missing', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'tasks.json'), JSON.stringify({ tasks: [] }));
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'merged');
    const obj = JSON.parse(readFileSync(join(dir, '.vscode', 'tasks.json'), 'utf8'));
    assert.equal(obj.version, '2.0.0');
    assert.equal(obj.tasks.length, 1);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: merged preserves indent style (4 spaces)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const existing = { version: '2.0.0', tasks: [{ label: 'Build' }] };
    writeFileSync(
      join(dir, '.vscode', 'tasks.json'),
      JSON.stringify(existing, null, 4),
    );
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'merged');
    const text = readFileSync(join(dir, '.vscode', 'tasks.json'), 'utf8');
    assert.match(text, /^    "version"/m);
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: already_present ---

test('ensureMonitorTaskFile: already_present when label matches', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const existing = {
      version: '2.0.0',
      tasks: [{ label: 'Throughline Monitor', command: 'foo' }],
    };
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify(existing, null, 2));
    const beforeMtime = statSync(tasksPath).mtimeMs;

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'already_present');

    const afterMtime = statSync(tasksPath).mtimeMs;
    assert.equal(beforeMtime, afterMtime);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: already_present when command references throughline monitor (label renamed)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const existing = {
      version: '2.0.0',
      tasks: [
        {
          label: 'My Custom Monitor',
          type: 'process',
          command: '/usr/bin/node',
          args: ['/path/to/bin/throughline.mjs', 'monitor'],
        },
      ],
    };
    writeFileSync(join(dir, '.vscode', 'tasks.json'), JSON.stringify(existing, null, 2));

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'already_present');
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: second call is idempotent (already_present after created)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    const first = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(first.action, 'created');

    const tasksPath = join(dir, '.vscode', 'tasks.json');
    const mtimeAfterCreate = statSync(tasksPath).mtimeMs;

    const second = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(second.action, 'already_present');

    const mtimeAfterSecond = statSync(tasksPath).mtimeMs;
    assert.equal(mtimeAfterCreate, mtimeAfterSecond);
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: JSONC ---

test('ensureMonitorTaskFile: jsonc_unsupported for file with line comments', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const content = '{\n  // VSCode style comment\n  "version": "2.0.0",\n  "tasks": []\n}';
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    writeFileSync(tasksPath, content);

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'jsonc_unsupported');

    assert.equal(readFileSync(tasksPath, 'utf8'), content);
    assert.equal(existsSync(join(dir, '.vscode', '.throughline-jsonc-noted')), true);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: jsonc_unsupported for file with trailing commas', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const content = '{\n  "version": "2.0.0",\n  "tasks": [],\n}';
    writeFileSync(join(dir, '.vscode', 'tasks.json'), content);

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'jsonc_unsupported');
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: jsonc_unsupported marker suppresses stderr on 2nd call', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(
      join(dir, '.vscode', 'tasks.json'),
      '{\n  // JSONC\n  "tasks": []\n}',
    );

    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      const r1 = ensureMonitorTaskFile({
        cwd: dir,
        env: VSCODE_ENV,
        throughlineBin: FAKE_BIN,
      });
      assert.equal(r1.action, 'skipped');
      assert.equal(r1.reason, 'jsonc_unsupported');
      const firstCount = captured.length;
      assert.ok(firstCount > 0, 'first call should emit guidance');

      const r2 = ensureMonitorTaskFile({
        cwd: dir,
        env: VSCODE_ENV,
        throughlineBin: FAKE_BIN,
      });
      assert.equal(r2.action, 'skipped');
      assert.equal(r2.reason, 'jsonc_unsupported');
      assert.equal(captured.length, firstCount, 'second call should be silent');
    } finally {
      process.stderr.write = origWrite;
    }
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: parse errors ---

test('ensureMonitorTaskFile: parse_error for malformed JSON', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const content = '{"tasks":[broken';
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    writeFileSync(tasksPath, content);

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'parse_error');
    assert.equal(readFileSync(tasksPath, 'utf8'), content);
  } finally {
    cleanup();
  }
});

// --- buildSetupNotice ---

test('buildSetupNotice: returns notice text for created', () => {
  const text = buildSetupNotice('created');
  assert.ok(text && text.includes('<system-reminder>'));
  assert.ok(text.includes('Reload Window'));
  assert.ok(text.includes('tasks.json'));
  assert.ok(text.includes('ユーザー'));
});

test('buildSetupNotice: returns notice text for merged', () => {
  const text = buildSetupNotice('merged');
  assert.ok(text && text.includes('<system-reminder>'));
  assert.ok(text.includes('Reload Window'));
});

test('buildSetupNotice: returns null for already_present (silent idempotency)', () => {
  assert.equal(buildSetupNotice('already_present'), null);
});

test('buildSetupNotice: returns null for skipped', () => {
  assert.equal(buildSetupNotice('skipped'), null);
});

test('buildSetupNotice: ensureMonitorTaskFile writes notice to stdout on first creation', () => {
  const { dir, cleanup } = mkTmpCwd();
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    const r1 = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(r1.action, 'created');
    const r2 = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(r2.action, 'already_present');
  } finally {
    process.stdout.write = origWrite;
    cleanup();
  }
  const joined = captured.join('');
  assert.ok(joined.includes('<system-reminder>'), 'notice should be written on created');
  assert.ok(joined.includes('Reload Window'));
  // 2 回目 (already_present) では notice は出ない = created 分の 1 回のみ
  const count = (joined.match(/<system-reminder>/g) ?? []).length;
  assert.equal(count, 1, 'notice should be emitted exactly once (idempotency)');
});
