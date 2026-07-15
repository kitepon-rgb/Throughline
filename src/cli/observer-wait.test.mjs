import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { OBSERVER_WAIT_SCHEMA } from '../observer-turn-wait.mjs';
import { parseArgs, run } from './observer-wait.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const AFTER = 'tlc1.after';

function streams() {
  return { stdout: { text: '', write(value) { this.text += value; } }, stderr: { text: '', write(value) { this.text += value; } } };
}

function fakeProcess({ ppid = 42, kill = () => {} } = {}) {
  const result = new EventEmitter();
  result.ppid = ppid;
  result.kill = kill;
  return result;
}

test('observer-wait strictly parses its public arguments', async () => {
  assert.deepEqual(parseArgs(['--project', '/repo', '--after-cursor', AFTER, '--timeout-seconds', '1', '--json']), {
    projectPath: '/repo', afterCursor: AFTER, timeoutSeconds: 1, json: true,
  });
  assert.equal(parseArgs(['--project', '/repo', '--after-cursor', AFTER, '--json']).timeoutSeconds, 3600);
  for (const argv of [
    ['--project', '/repo', '--project', '/repo', '--after-cursor', AFTER, '--json'],
    ['--project', '/repo', '--after-cursor', AFTER, '--json', '--json'],
    ['--project', '/repo', '--after-cursor', AFTER, '--timeout-seconds', '0', '--json'],
    ['--project', '/repo', '--after-cursor', AFTER, '--timeout-seconds', '3601', '--json'],
    ['--project', '/repo', '--after-cursor', AFTER, 'extra', '--json'],
    ['--project', '/repo', '--json'],
  ]) {
    const io = streams();
    assert.equal(await run(argv, { ...io }), 1);
    assert.equal(io.stdout.text, '');
    assert.deepEqual(JSON.parse(io.stderr.text), { schema: OBSERVER_WAIT_SCHEMA, status: 'error', code: 'E_OBSERVER_WAIT_ARGS', message: 'invalid observer-wait arguments' });
  }
});

test('observer-wait returns each known core status as successful JSON', async () => {
  for (const [status, throughCursor] of [['changed', 'tlc1.changed'], ['timeout', AFTER], ['resync_required', null], ['ambiguous_parent', null]]) {
    const io = streams();
    assert.equal(await run(['--project', '/repo', '--after-cursor', AFTER, '--json'], {
      ...io,
      validateProject: () => {},
      processRef: fakeProcess(),
      setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
      wait: async () => ({ schema: OBSERVER_WAIT_SCHEMA, status, afterCursor: AFTER, throughCursor }),
    }), 0);
    assert.deepEqual(JSON.parse(io.stdout.text), { schema: OBSERVER_WAIT_SCHEMA, status, afterCursor: AFTER, throughCursor });
    assert.equal(io.stderr.text, '');
  }
});

test('observer-wait maps project, cancel, and internal failures to fixed errors without leakage', async () => {
  for (const [dependencies, code] of [
    [{ validateProject: () => { throw new Error('/private/project'); } }, 'E_OBSERVER_WAIT_INPUT'],
    [{ wait: async () => { throw Object.assign(new Error('secret cursor'), { code: 'E_OBSERVER_WAIT_CANCELLED' }); } }, 'E_OBSERVER_WAIT_CANCELLED'],
    [{ wait: async () => { throw new Error('secret /private/cursor'); } }, 'E_OBSERVER_WAIT_INTERNAL'],
  ]) {
    const io = streams();
    assert.equal(await run(['--project', '/repo', '--after-cursor', AFTER, '--json'], {
      ...io, validateProject: () => {}, processRef: fakeProcess(),
      setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {}, ...dependencies,
    }), 1);
    assert.equal(io.stdout.text, '');
    assert.equal(JSON.parse(io.stderr.text).code, code);
    assert.doesNotMatch(io.stderr.text, /private|secret|cursor/i);
  }
});

test('observer-wait cancels on signals and removes listeners and parent watcher', async () => {
  for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) {
    const io = streams();
    const processRef = fakeProcess();
    let checkParent;
    let cleared = 0;
    const pending = run(['--project', '/repo', '--after-cursor', AFTER, '--json'], {
      ...io, validateProject: () => {}, processRef,
      setIntervalFn(callback) { checkParent = callback; return { unref() {} }; },
      clearIntervalFn() { cleared++; },
      wait: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'E_OBSERVER_WAIT_CANCELLED' })), { once: true })),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getEventListeners(processRef, 'SIGINT').length, 1);
    assert.equal(getEventListeners(processRef, 'SIGTERM').length, 1);
    assert.equal(getEventListeners(processRef, 'disconnect').length, 1);
    assert.equal(typeof checkParent, 'function');
    processRef.emit(event);
    assert.equal(await pending, 1);
    assert.equal(JSON.parse(io.stderr.text).code, 'E_OBSERVER_WAIT_CANCELLED');
    assert.equal(cleared, 1);
    assert.equal(getEventListeners(processRef, 'SIGINT').length, 0);
    assert.equal(getEventListeners(processRef, 'SIGTERM').length, 0);
    assert.equal(getEventListeners(processRef, 'disconnect').length, 0);
  }
});

test('observer-wait treats changed parent or ESRCH as cancellation but not EPERM', async () => {
  for (const [mode, kill] of [
    ['ppid', () => {}],
    ['esrch', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }],
  ]) {
    const io = streams();
    const processRef = fakeProcess({ kill });
    let checkParent;
    const pending = run(['--project', '/repo', '--after-cursor', AFTER, '--json'], {
      ...io, validateProject: () => {}, processRef,
      setIntervalFn(callback) { checkParent = callback; return { unref() {} }; }, clearIntervalFn: () => {},
      wait: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'E_OBSERVER_WAIT_CANCELLED' })), { once: true })),
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (mode === 'ppid') processRef.ppid = 1;
    checkParent();
    assert.equal(await pending, 1);
    assert.equal(JSON.parse(io.stderr.text).code, 'E_OBSERVER_WAIT_CANCELLED');
  }

  const io = streams();
  const processRef = fakeProcess({ kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
  let checkParent;
  const pending = run(['--project', '/repo', '--after-cursor', AFTER, '--json'], {
    ...io, validateProject: () => {}, processRef,
    setIntervalFn(callback) { checkParent = callback; return { unref() {} }; }, clearIntervalFn: () => {},
    wait: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'E_OBSERVER_WAIT_CANCELLED' })), { once: true })),
  });
  await new Promise((resolve) => setImmediate(resolve));
  checkParent();
  assert.equal(io.stderr.text, '');
  processRef.emit('disconnect');
  assert.equal(await pending, 1);
  assert.equal(JSON.parse(io.stderr.text).code, 'E_OBSERVER_WAIT_CANCELLED');
});

test('observer-wait bin dispatch and help use the JSON-only contract', async () => {
  const help = spawnSync(process.execPath, [BIN_PATH, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /throughline observer-wait --project <absolute-directory> --after-cursor <opaque> --json/);

  const root = await mkdtemp(join(tmpdir(), 'throughline-observer-wait-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  const codexHome = join(root, 'codex');
  const project = join(root, 'project');
  try {
    await Promise.all([mkdir(home), mkdir(state), mkdir(codexHome), mkdir(project)]);
    const result = spawnSync(process.execPath, [BIN_PATH, 'observer-wait', '--project', project, '--after-cursor', 'invalid', '--json'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, CODEX_HOME: codexHome },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.schema, OBSERVER_WAIT_SCHEMA);
    assert.equal(output.status, 'resync_required');
    assert.equal(output.throughCursor, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
