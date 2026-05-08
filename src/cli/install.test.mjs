import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexPostToolUseHookCommand,
  buildCodexStopHookCommand,
  buildCodexUserPromptSubmitHookCommand,
  run,
  resolveThroughlineOnPath,
} from './install.mjs';

function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tl-install-test-'));
  const origUserprofile = process.env.USERPROFILE;
  const origHome = process.env.HOME;
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  const resolved = homedir();
  return {
    dir,
    resolved,
    restore() {
      if (origUserprofile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserprofile;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function silence() {
  const origLog = console.log;
  const origErr = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  console.error = () => {};
  process.stderr.write = () => true;
  process.stdout.write = () => true;
  return () => {
    console.log = origLog;
    console.error = origErr;
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
  };
}

test('global install copies Throughline slash commands to ~/.claude/commands/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    const sc = join(home.dir, '.claude', 'commands', 'sc-detail.md');
    const trim = join(home.dir, '.claude', 'commands', 'tl-trim.md');
    assert.ok(existsSync(tl), 'tl.md should be installed globally');
    assert.ok(existsSync(sc), 'sc-detail.md should be installed globally');
    assert.ok(!existsSync(trim), 'tl-trim.md should NOT be installed (deprecated in v0.4.0)');
    const tlBody = readFileSync(tl, 'utf8');
    assert.match(tlBody, /Throughline/, 'tl.md content should be real');
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks?.UserPromptSubmit, 'UserPromptSubmit hook should be registered');
  } finally {
    unsilence();
    home.restore();
  }
});

test('project install copies commands to cwd/.claude/commands/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'tl-install-proj-'));
  const origCwd = process.cwd();
  process.chdir(projectDir);
  const unsilence = silence();
  try {
    await run(['--project']);
    const tl = join(projectDir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl), 'tl.md should be installed in project');
    const globalTl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(!existsSync(globalTl), '--project should NOT touch global dir');
    assert.ok(!existsSync(join(home.dir, '.codex', 'hooks.json')), '--project should NOT touch global Codex hooks');
    assert.ok(!existsSync(join(home.dir, '.codex', 'skills', 'throughline')), '--project should NOT touch global Codex skills');
  } finally {
    unsilence();
    process.chdir(origCwd);
    home.restore();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('global install registers Codex session hooks and enables hooks features', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    const codexHook = hooks.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedStopCommand);
    assert.ok(codexHook, 'Codex Stop should have absolute throughline.mjs codex-hook stop');
    assert.equal(codexHook.async, false, 'Codex Stop hook should be synchronous for Codex');
    assert.equal(codexHook.timeoutSec, 300, 'Codex Stop hook should allow summarizer time');
    const promptHook = hooks.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedPromptCommand);
    assert.ok(promptHook, 'Codex UserPromptSubmit should have absolute throughline.mjs codex-hook user-prompt-submit');
    assert.equal(promptHook.async, false, 'Codex UserPromptSubmit hook should be synchronous for context injection');
    assert.equal(promptHook.timeoutSec, 30, 'Codex UserPromptSubmit hook should be short');
    const postToolUseHook = hooks.hooks.PostToolUse
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === expectedPostToolUseCommand);
    assert.ok(postToolUseHook, 'Codex PostToolUse should have absolute throughline.mjs codex-hook post-tool-use');
    assert.equal(postToolUseHook.async, false, 'Codex PostToolUse hook should be synchronous for context injection');
    assert.equal(postToolUseHook.timeoutSec, 30, 'Codex PostToolUse hook should be short');
    const config = readFileSync(join(home.dir, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /^\[features\]\ncodex_hooks = true/m);
    assert.match(config, /^hooks = true/m);
  } finally {
    unsilence();
    home.restore();
  }
});

test('global install copies Throughline Codex skill to ~/.codex/skills/', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const skill = join(home.dir, '.codex', 'skills', 'throughline', 'SKILL.md');
    const metadata = join(home.dir, '.codex', 'skills', 'throughline', 'agents', 'openai.yaml');
    assert.ok(existsSync(skill), 'Throughline Codex skill should be installed globally');
    assert.ok(existsSync(metadata), 'Throughline Codex skill UI metadata should be installed globally');
    const skillBody = readFileSync(skill, 'utf8');
    const metadataBody = readFileSync(metadata, 'utf8');
    assert.match(skillBody, /name: throughline/);
    assert.match(skillBody, /Bare "\$throughline"/);
    assert.match(skillBody, /throughline trim --execute --host codex --all/);
    assert.match(skillBody, /do not run doctor \/ dry-run \/ handoff \/ preflight first/);
    assert.match(metadataBody, /scripted current-thread rollback \+ Throughline memory inject/);
    assert.doesNotMatch(metadataBody, /preview blocked Codex trim/);
    assert.doesNotMatch(metadataBody, /inspect guarded Codex trim/);
  } finally {
    unsilence();
    home.restore();
  }
});

test('global install provisions VSCode monitor task for the current project when running under VSCode', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'tl-install-monitor-'));
  const origCwd = process.cwd();
  const origVscodePid = process.env.VSCODE_PID;
  process.chdir(projectDir);
  process.env.VSCODE_PID = '12345';
  const unsilence = silence();
  try {
    await run([]);
    const tasksPath = join(projectDir, '.vscode', 'tasks.json');
    assert.ok(existsSync(tasksPath), 'install should create current-project VSCode tasks.json');
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const task = tasks.tasks.find((t) => t.label === 'Throughline Monitor');
    assert.ok(task, 'Throughline Monitor task should be present');
    assert.deepEqual(task.args.slice(1), ['monitor']);
    assert.deepEqual(task.runOptions, { runOn: 'folderOpen' });
  } finally {
    unsilence();
    if (origVscodePid === undefined) delete process.env.VSCODE_PID;
    else process.env.VSCODE_PID = origVscodePid;
    process.chdir(origCwd);
    home.restore();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('global install preserves existing Codex hooks and is idempotent', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  mkdirSync(join(home.dir, '.codex'), { recursive: true });
  writeFileSync(
    join(home.dir, '.codex', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop',
                  timeoutSec: 5,
                  async: false,
                  statusMessage: null,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(home.dir, '.codex', 'config.toml'), '[features]\nother = true\n');
  const unsilence = silence();
  try {
    await run([]);
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const stopCommands = hooks.hooks.Stop.flatMap(g => g.hooks ?? []).map(h => h.command);
    const promptCommands = hooks.hooks.UserPromptSubmit.flatMap(g => g.hooks ?? []).map(h => h.command);
    const postToolUseCommands = hooks.hooks.PostToolUse.flatMap(g => g.hooks ?? []).map(h => h.command);
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    assert.ok(stopCommands.includes('/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop'));
    assert.equal(stopCommands.filter(c => c === expectedStopCommand).length, 1);
    assert.equal(promptCommands.filter(c => c === expectedPromptCommand).length, 1);
    assert.equal(postToolUseCommands.filter(c => c === expectedPostToolUseCommand).length, 1);
    assert.ok(!stopCommands.includes('throughline codex-hook stop'));
    assert.ok(!promptCommands.includes('throughline codex-hook user-prompt-submit'));
    assert.ok(!postToolUseCommands.includes('throughline codex-hook post-tool-use'));
    const config = readFileSync(join(home.dir, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /other = true/);
    assert.match(config, /codex_hooks = true/);
    assert.match(config, /hooks = true/);
  } finally {
    unsilence();
    home.restore();
  }
});

test('global install updates existing Throughline Codex hook shapes', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  mkdirSync(join(home.dir, '.codex'), { recursive: true });
  writeFileSync(
    join(home.dir, '.codex', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook user-prompt-submit',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook post-tool-use',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'throughline codex-hook stop',
                  timeoutSec: 300,
                  async: true,
                  statusMessage: null,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  const unsilence = silence();
  try {
    await run([]);
    const hooks = JSON.parse(readFileSync(join(home.dir, '.codex', 'hooks.json'), 'utf8'));
    const expectedStopCommand = buildCodexStopHookCommand();
    const expectedPromptCommand = buildCodexUserPromptSubmitHookCommand();
    const expectedPostToolUseCommand = buildCodexPostToolUseHookCommand();
    const codexHooks = hooks.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedStopCommand);
    assert.equal(codexHooks.length, 1);
    assert.equal(codexHooks[0].async, false);
    assert.equal(codexHooks[0].timeoutSec, 300);
    const promptHooks = hooks.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedPromptCommand);
    assert.equal(promptHooks.length, 1);
    assert.equal(promptHooks[0].async, false);
    assert.equal(promptHooks[0].timeoutSec, 30);
    const postToolUseHooks = hooks.hooks.PostToolUse
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === expectedPostToolUseCommand);
    assert.equal(postToolUseHooks.length, 1);
    assert.equal(postToolUseHooks[0].async, false);
    assert.equal(postToolUseHooks[0].timeoutSec, 30);
    assert.equal(
      hooks.hooks.Stop.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook stop').length,
      0,
    );
    assert.equal(
      hooks.hooks.UserPromptSubmit.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook user-prompt-submit').length,
      0,
    );
    assert.equal(
      hooks.hooks.PostToolUse.flatMap(g => g.hooks ?? []).filter(h => h.command === 'throughline codex-hook post-tool-use').length,
      0,
    );
  } finally {
    unsilence();
    home.restore();
  }
});

test('uninstall removes slash command files', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl), 'install should have placed tl.md');
    await run(['--uninstall']);
    assert.ok(!existsSync(tl), 'uninstall should remove tl.md');
    const sc = join(home.dir, '.claude', 'commands', 'sc-detail.md');
    assert.ok(!existsSync(sc), 'uninstall should remove sc-detail.md');
    const codexSkill = join(home.dir, '.codex', 'skills', 'throughline', 'SKILL.md');
    assert.ok(!existsSync(codexSkill), 'uninstall should remove Throughline Codex skill');
  } finally {
    unsilence();
    home.restore();
  }
});

test('global uninstall removes only Throughline-managed Codex hook', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const hooksPath = join(home.dir, '.codex', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    hooks.hooks.Stop.push({
      hooks: [
        {
          type: 'command',
          command: '/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop',
          timeoutSec: 5,
          async: false,
          statusMessage: null,
        },
      ],
    });
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');

    await run(['--uninstall']);
    const after = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const stopCommands = after.hooks.Stop.flatMap(g => g.hooks ?? []).map(h => h.command);
    const promptCommands = after.hooks.UserPromptSubmit?.flatMap(g => g.hooks ?? []).map(h => h.command) ?? [];
    const postToolUseCommands = after.hooks.PostToolUse?.flatMap(g => g.hooks ?? []).map(h => h.command) ?? [];
    assert.ok(stopCommands.includes('/usr/bin/node /home/kite/.npm-global/bin/caveat codex-hook stop'));
    assert.ok(!stopCommands.includes('throughline codex-hook stop'));
    assert.ok(!stopCommands.some(c => c.includes('throughline.mjs codex-hook stop')));
    assert.ok(!promptCommands.includes('throughline codex-hook user-prompt-submit'));
    assert.ok(!promptCommands.some(c => c.includes('throughline.mjs codex-hook user-prompt-submit')));
    assert.ok(!postToolUseCommands.includes('throughline codex-hook post-tool-use'));
    assert.ok(!postToolUseCommands.some(c => c.includes('throughline.mjs codex-hook post-tool-use')));
  } finally {
    unsilence();
    home.restore();
  }
});

test('uninstall preserves unrelated slash commands in the same dir', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const otherCmd = join(home.dir, '.claude', 'commands', 'unrelated.md');
    writeFileSync(otherCmd, '# unrelated slash command\n');
    await run(['--uninstall']);
    assert.ok(existsSync(otherCmd), 'uninstall must not touch unrelated files');
  } finally {
    unsilence();
    home.restore();
  }
});

test('Claude Stop hook is registered with async:true so it does not block ターン完了 UX', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    const processTurnHook = settings.hooks.Stop
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline process-turn');
    assert.ok(processTurnHook, 'Stop should have throughline process-turn');
    assert.equal(processTurnHook.async, true, 'Stop hook must be async to avoid blocking ターン完了');
    const sessionStartHook = settings.hooks.SessionStart
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline session-start');
    assert.notEqual(sessionStartHook.async, true, 'SessionStart stays synchronous (needs to inject context before turn)');
    const promptSubmitHook = settings.hooks.UserPromptSubmit
      .flatMap(g => g.hooks ?? [])
      .find(h => h.command === 'throughline prompt-submit');
    assert.notEqual(promptSubmitHook.async, true, 'UserPromptSubmit stays synchronous (needs baton write committed before turn)');
  } finally {
    unsilence();
    home.restore();
  }
});

// --- resolveThroughlineOnPath (地雷 1: PATH 解決チェック) ---

test('resolveThroughlineOnPath: returns null when PATH is empty', () => {
  assert.equal(resolveThroughlineOnPath({ PATH: '' }), null);
  assert.equal(resolveThroughlineOnPath({}), null);
});

test('resolveThroughlineOnPath: returns null when not in any PATH directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-path-empty-'));
  try {
    assert.equal(resolveThroughlineOnPath({ PATH: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveThroughlineOnPath: finds throughline binary in PATH directory', () => {
  // Windows は PATHEXT 経由でしか見つからないので分岐
  const dir = mkdtempSync(join(tmpdir(), 'tl-path-found-'));
  try {
    if (process.platform === 'win32') {
      // PATHEXT は通常大文字 (.EXE;.CMD;.BAT) だが、resolveThroughlineOnPath が
      // 返すパスはその ext をそのまま join するため、書き込んだ実ファイル名 (小文字)
      // と厳密一致するよう小文字を渡す。Windows FS は case-insensitive で
      // existsSync は通る。
      const binPath = join(dir, 'throughline.cmd');
      writeFileSync(binPath, '@echo off\n');
      const result = resolveThroughlineOnPath({
        PATH: dir,
        PATHEXT: '.cmd',
      });
      assert.equal(result, binPath);
    } else {
      const binPath = join(dir, 'throughline');
      writeFileSync(binPath, '#!/bin/sh\n');
      const result = resolveThroughlineOnPath({ PATH: dir });
      assert.equal(result, binPath);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install is idempotent: second run keeps exactly one tl.md and one hook entry', async () => {
  const home = makeTempHome();
  if (home.resolved !== home.dir) {
    home.restore();
    return;
  }
  const unsilence = silence();
  try {
    await run([]);
    await run([]);
    const tl = join(home.dir, '.claude', 'commands', 'tl.md');
    assert.ok(existsSync(tl));
    const settings = JSON.parse(readFileSync(join(home.dir, '.claude', 'settings.json'), 'utf8'));
    const stopGroups = settings.hooks.Stop;
    const processTurnCount = stopGroups
      .flatMap(g => g.hooks ?? [])
      .filter(h => h.command === 'throughline process-turn')
      .length;
    assert.equal(processTurnCount, 1, 'double-install must not duplicate hook entries');
  } finally {
    unsilence();
    home.restore();
  }
});
