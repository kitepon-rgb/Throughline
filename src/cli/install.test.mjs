import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { run } from './install.mjs';

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
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = origLog;
    console.error = origErr;
  };
}

test('global install copies /tl and /sc-detail to ~/.claude/commands/', async () => {
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
    assert.ok(existsSync(tl), 'tl.md should be installed globally');
    assert.ok(existsSync(sc), 'sc-detail.md should be installed globally');
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
  } finally {
    unsilence();
    process.chdir(origCwd);
    home.restore();
    rmSync(projectDir, { recursive: true, force: true });
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
