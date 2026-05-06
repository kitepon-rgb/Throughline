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
  findMonitorTaskIndex,
  isMonitorTaskBroken,
  buildMonitorTask,
  buildSetupNotice,
  shouldRecommendGitignore,
} from './vscode-task.mjs';

const VSCODE_ENV = {
  TERM_PROGRAM: 'vscode',
  THROUGHLINE_SUPPRESS_VSCODE_NOTICES: '1',
};
// Production notices are Claude-facing additional context. Tests keep them
// silent by default and opt in only when asserting notice text.
const VSCODE_NOTICE_ENV = { TERM_PROGRAM: 'vscode' };
// 実在する絶対パスを使う。`isMonitorTaskBroken` が「絶対パス + 非存在」で broken 判定するので、
// 架空パスを使うと意図せず repaired ブランチに落ちてしまう。
const FAKE_BIN = process.execPath;

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

// --- findMonitorTaskIndex ---

test('findMonitorTaskIndex: returns index when label matches', () => {
  assert.equal(
    findMonitorTaskIndex({ tasks: [{ label: 'Build' }, { label: 'Throughline Monitor' }] }),
    1,
  );
});

test('findMonitorTaskIndex: returns -1 when no match', () => {
  assert.equal(findMonitorTaskIndex({ tasks: [{ label: 'Build' }] }), -1);
  assert.equal(findMonitorTaskIndex({}), -1);
});

// --- isMonitorTaskBroken ---

test('isMonitorTaskBroken: false when command is an existing absolute path', () => {
  assert.equal(
    isMonitorTaskBroken({ command: process.execPath, args: ['monitor'] }),
    false,
  );
});

test('isMonitorTaskBroken: true when command is a non-existent absolute path', () => {
  assert.equal(
    isMonitorTaskBroken({ command: '/definitely/does/not/exist/node', args: ['monitor'] }),
    true,
  );
});

test('isMonitorTaskBroken: false when command is a relative name (PATH-resolved)', () => {
  // ユーザーが手動で "node" / "throughline" に書き換えたケースは誤上書きしない
  assert.equal(
    isMonitorTaskBroken({ command: 'node', args: ['/x/throughline.mjs', 'monitor'] }),
    true, // args 側の絶対パスが壊れているので true
  );
  assert.equal(
    isMonitorTaskBroken({ command: 'throughline', args: ['monitor'] }),
    false,
  );
});

test('isMonitorTaskBroken: true when args contains non-existent absolute .mjs path', () => {
  assert.equal(
    isMonitorTaskBroken({
      command: process.execPath,
      args: ['/no/such/file/throughline.mjs', 'monitor'],
    }),
    true,
  );
});

test('isMonitorTaskBroken: false when args has only relative strings', () => {
  assert.equal(
    isMonitorTaskBroken({ command: process.execPath, args: ['monitor'] }),
    false,
  );
});

test('isMonitorTaskBroken: handles malformed task safely', () => {
  assert.equal(isMonitorTaskBroken(null), false);
  assert.equal(isMonitorTaskBroken({}), false);
  assert.equal(isMonitorTaskBroken({ command: 42 }), false);
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
          // 実在する絶対パスを使う。`/usr/bin/node` は WSL2 では実在するが
          // CI runner (Linux/macOS は /opt/hostedtoolcache, Windows は別) では
          // 存在しないので isMonitorTaskBroken が true になり repaired ブランチに落ちる。
          // process.execPath なら「いま走らせている node 自身の絶対パス」なので必ず実在する。
          command: process.execPath,
          // 相対パスにして broken 判定を避ける（このテストは「label renamed でも検出できるか」だけが論点）
          args: ['./throughline.mjs', 'monitor'],
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

// --- shouldRecommendGitignore ---

test('shouldRecommendGitignore: false when not a git repo (.git missing)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    assert.equal(shouldRecommendGitignore(dir), false);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: true when git repo has no .gitignore', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    assert.equal(shouldRecommendGitignore(dir), true);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: true when .gitignore does not list .vscode/tasks.json', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n');
    assert.equal(shouldRecommendGitignore(dir), true);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: false when .gitignore has .vscode/tasks.json', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.vscode/tasks.json\n');
    assert.equal(shouldRecommendGitignore(dir), false);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: false when .gitignore has .vscode/ (whole dir)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), '.vscode/\n');
    assert.equal(shouldRecommendGitignore(dir), false);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: false when .gitignore has .vscode (no slash)', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), '.vscode\n');
    assert.equal(shouldRecommendGitignore(dir), false);
  } finally {
    cleanup();
  }
});

test('shouldRecommendGitignore: ignores comments and negation lines', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));
    // 否定パターンは「除外しない」意図なので、推奨は引き続き出す
    writeFileSync(join(dir, '.gitignore'), '# comment\n!.vscode/tasks.json\n');
    assert.equal(shouldRecommendGitignore(dir), true);
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: gitignore recommendation notice ---

test('ensureMonitorTaskFile: created emits gitignore recommendation when .git exists and no .gitignore entry', () => {
  const { dir, cleanup } = mkTmpCwd();
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    mkdirSync(join(dir, '.git'));
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_NOTICE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'created');
  } finally {
    process.stdout.write = origWrite;
    cleanup();
  }
  const joined = captured.join('');
  assert.ok(joined.includes('.gitignore'), 'should emit gitignore recommendation');
  assert.ok(joined.includes('Reload Window'), 'should still emit setup notice');
});

test('ensureMonitorTaskFile: created does NOT emit gitignore recommendation when not a git repo', () => {
  const { dir, cleanup } = mkTmpCwd();
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_NOTICE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'created');
  } finally {
    process.stdout.write = origWrite;
    cleanup();
  }
  const joined = captured.join('');
  assert.ok(!joined.includes('gitignore'), 'should not mention gitignore for non-git dirs');
});

test('ensureMonitorTaskFile: gitignore recommendation is emitted only once per project', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.git'));

    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    try {
      // 1 回目: created → gitignore 推奨が出る
      const r1 = ensureMonitorTaskFile({
        cwd: dir,
        env: VSCODE_NOTICE_ENV,
        throughlineBin: FAKE_BIN,
      });
      assert.equal(r1.action, 'created');
      const firstCount = captured.filter((s) => s.includes('gitignore')).length;
      assert.equal(firstCount, 1);

      // tasks.json を一度消して再 created 状況を作る
      // （実運用では already_present になるので現実的ではないが、marker の効きを見る）
      const tasksPath = join(dir, '.vscode', 'tasks.json');
      rmSync(tasksPath);
      const r2 = ensureMonitorTaskFile({
        cwd: dir,
        env: VSCODE_ENV,
        throughlineBin: FAKE_BIN,
      });
      assert.equal(r2.action, 'created');
      const secondCount = captured.filter((s) => s.includes('gitignore')).length;
      assert.equal(secondCount, 1, 'marker file should suppress 2nd recommendation');
    } finally {
      process.stdout.write = origWrite;
    }
  } finally {
    cleanup();
  }
});

// --- ensureMonitorTaskFile: cross-environment repair (地雷 4) ---

test('ensureMonitorTaskFile: repaired when existing task points to non-existent absolute paths', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    // 別 OS で生成されたタスク: command と args の絶対パスが現環境には存在しない
    const stale = {
      version: '2.0.0',
      tasks: [
        {
          label: 'Throughline Monitor',
          type: 'shell',
          command: '/old/env/node',
          args: ['/old/env/throughline.mjs', 'monitor'],
          presentation: { panel: 'dedicated', group: 'throughline' },
          isBackground: true,
        },
      ],
    };
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify(stale, null, 2));

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'repaired');

    const obj = JSON.parse(readFileSync(tasksPath, 'utf8'));
    assert.equal(obj.tasks.length, 1);
    const task = obj.tasks[0];
    // command と args は現環境向けに差し替わる
    assert.equal(task.command, process.execPath);
    assert.deepEqual(task.args, [FAKE_BIN, 'monitor']);
    // ユーザーカスタマイズ (presentation 等) は保持される
    assert.equal(task.label, 'Throughline Monitor');
    assert.deepEqual(task.presentation, { panel: 'dedicated', group: 'throughline' });
    assert.equal(task.isBackground, true);
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: repaired preserves other tasks in the file', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    const stale = {
      version: '2.0.0',
      tasks: [
        { label: 'Build', type: 'shell', command: 'make' },
        {
          label: 'Throughline Monitor',
          type: 'shell',
          command: '/old/env/node',
          args: ['/old/env/throughline.mjs', 'monitor'],
        },
        { label: 'Test', type: 'shell', command: 'npm test' },
      ],
    };
    writeFileSync(join(dir, '.vscode', 'tasks.json'), JSON.stringify(stale, null, 2));

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'repaired');

    const obj = JSON.parse(readFileSync(join(dir, '.vscode', 'tasks.json'), 'utf8'));
    assert.equal(obj.tasks.length, 3);
    assert.equal(obj.tasks[0].label, 'Build');
    assert.equal(obj.tasks[1].label, 'Throughline Monitor');
    assert.equal(obj.tasks[1].command, process.execPath);
    assert.equal(obj.tasks[2].label, 'Test');
  } finally {
    cleanup();
  }
});

test('ensureMonitorTaskFile: already_present (not repaired) when task points to existing paths', () => {
  const { dir, cleanup } = mkTmpCwd();
  try {
    mkdirSync(join(dir, '.vscode'));
    // command が現環境に存在するなら修復しない (process.execPath は必ず存在する)
    const valid = {
      version: '2.0.0',
      tasks: [
        {
          label: 'Throughline Monitor',
          type: 'shell',
          command: process.execPath,
          args: ['monitor'],
        },
      ],
    };
    const tasksPath = join(dir, '.vscode', 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify(valid, null, 2));
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

test('ensureMonitorTaskFile: repaired emits notice on stdout', () => {
  const { dir, cleanup } = mkTmpCwd();
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    mkdirSync(join(dir, '.vscode'));
    const stale = {
      version: '2.0.0',
      tasks: [
        {
          label: 'Throughline Monitor',
          command: '/old/env/node',
          args: ['/old/env/throughline.mjs', 'monitor'],
        },
      ],
    };
    writeFileSync(join(dir, '.vscode', 'tasks.json'), JSON.stringify(stale, null, 2));

    const result = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_NOTICE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(result.action, 'repaired');
  } finally {
    process.stdout.write = origWrite;
    cleanup();
  }
  const joined = captured.join('');
  assert.ok(joined.includes('<system-reminder>'), 'repaired should emit notice');
  assert.ok(joined.includes('自動修復'));
  assert.ok(joined.includes('Reload Window'));
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
        env: VSCODE_NOTICE_ENV,
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

test('buildSetupNotice: returns notice text for repaired', () => {
  const text = buildSetupNotice('repaired');
  assert.ok(text && text.includes('<system-reminder>'));
  assert.ok(text.includes('自動修復'));
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
      env: VSCODE_NOTICE_ENV,
      throughlineBin: FAKE_BIN,
    });
    assert.equal(r1.action, 'created');
    const r2 = ensureMonitorTaskFile({
      cwd: dir,
      env: VSCODE_NOTICE_ENV,
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
