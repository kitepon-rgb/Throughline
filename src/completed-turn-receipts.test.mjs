import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COMPLETED_TURN_RECEIPT_LIMIT,
  COMPLETED_TURN_RECEIPT_STORE_SCHEMA,
  defaultCompletedTurnReceiptStorePath,
  writeCompletedTurnReceipt,
} from './completed-turn-receipts.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'throughline-completed-receipts-'));
  return { root, storePath: join(root, 'state', 'completed-turn-receipts.json') };
}

function input(index = 1) {
  return {
    projectPath: '/repo', targetSessionId: 'target', originSessionId: 'origin',
    userBody: `user ${index}`, assistantBody: `assistant ${index}`, completedAt: index,
  };
}

test('completed turn receipt: private atomic store records only identities and hashes', () => {
  const box = sandbox();
  try {
    const receipt = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    assert.equal(receipt.schema_version, '1.0');
    assert.equal(receipt.host, 'claude');
    assert.equal(receipt.sequence, 1);
    assert.match(receipt.project_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.user_sha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.assistant_sha256, /^[0-9a-f]{64}$/);
    const bytes = readFileSync(box.storePath, 'utf8');
    assert.doesNotMatch(bytes, /user 1|assistant 1|\/repo/);
    const stored = JSON.parse(bytes);
    assert.equal(stored.schema, COMPLETED_TURN_RECEIPT_STORE_SCHEMA);
    assert.equal(stored.history_floor, 1);
    assert.equal(stored.receipts.length, 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: same project/session/pair is idempotent and keeps its sequence', () => {
  const box = sandbox();
  try {
    const first = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    const retry = writeCompletedTurnReceipt({ ...input(), completedAt: 999 }, { storePath: box.storePath });
    assert.deepEqual(retry, first);
    const next = writeCompletedTurnReceipt(input(2), { storePath: box.storePath });
    assert.equal(next.sequence, 2);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: target変更を伴う同一origin/pairの再実行は冪等', () => {
  const box = sandbox();
  try {
    const first = writeCompletedTurnReceipt(input(), { storePath: box.storePath });
    const retriedAfterMerge = writeCompletedTurnReceipt({ ...input(), targetSessionId: 'merged-target' }, { storePath: box.storePath });
    assert.deepEqual(retriedAfterMerge, first);
    assert.equal(retriedAfterMerge.target_session_id, 'target', 'capture時targetを保持する');
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: project digest shares realpath canonicalization with the DB projection', {
  skip: process.platform === 'win32',
}, () => {
  const box = sandbox();
  const project = join(box.root, 'project');
  const alias = join(box.root, 'project-alias');
  try {
    mkdirSync(project);
    symlinkSync(project, alias);
    const direct = writeCompletedTurnReceipt({ ...input(), projectPath: project }, { storePath: box.storePath });
    const viaAlias = writeCompletedTurnReceipt({ ...input(), projectPath: alias }, { storePath: box.storePath });
    assert.deepEqual(viaAlias, direct);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: rejects symlinked store paths', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const target = join(box.root, 'target.json');
  try {
    mkdirSync(dirname(box.storePath), { recursive: true });
    symlinkSync(target, box.storePath);
    assert.throws(() => writeCompletedTurnReceipt(input(), { storePath: box.storePath }), /unsafe/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: bounded store drops only oldest receipts', () => {
  const box = sandbox();
  try {
    for (let index = 1; index <= COMPLETED_TURN_RECEIPT_LIMIT + 1; index++) {
      writeCompletedTurnReceipt({ ...input(index), targetSessionId: `target-${index}` }, { storePath: box.storePath });
    }
    const stored = JSON.parse(readFileSync(box.storePath, 'utf8'));
    assert.equal(stored.receipts.length, COMPLETED_TURN_RECEIPT_LIMIT);
    assert.equal(stored.history_floor, 2);
    assert.equal(stored.receipts[0].sequence, 2);
    assert.equal(stored.receipts.at(-1).sequence, COMPLETED_TURN_RECEIPT_LIMIT + 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: noisy project cannot evict another project anchor', () => {
  const box = sandbox();
  const env = { HOME: box.root, USERPROFILE: box.root, XDG_STATE_HOME: join(box.root, 'state-home') };
  try {
    const quiet = writeCompletedTurnReceipt({ ...input(), projectPath: '/quiet-project' }, { env });
    for (let index = 1; index <= COMPLETED_TURN_RECEIPT_LIMIT + 1; index++) {
      writeCompletedTurnReceipt({ ...input(index), projectPath: '/noisy-project', targetSessionId: `target-${index}` }, { env });
    }
    const quietStorePath = defaultCompletedTurnReceiptStorePath(quiet.project_sha256, env);
    const quietStore = JSON.parse(readFileSync(quietStorePath, 'utf8'));
    assert.equal(quietStore.receipts.length, 1);
    assert.equal(quietStore.receipts[0].sequence, 1);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: explicit store path rejects a second project', () => {
  const box = sandbox();
  try {
    writeCompletedTurnReceipt({ ...input(), projectPath: '/project-a' }, { storePath: box.storePath });
    assert.throws(
      () => writeCompletedTurnReceipt({ ...input(), projectPath: '/project-b' }, { storePath: box.storePath }),
      /schema invalid/,
    );
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: rejects sequence order corruption', () => {
  const box = sandbox();
  try {
    writeCompletedTurnReceipt(input(1), { storePath: box.storePath });
    writeCompletedTurnReceipt(input(2), { storePath: box.storePath });
    const store = JSON.parse(readFileSync(box.storePath, 'utf8'));
    [store.receipts[0], store.receipts[1]] = [store.receipts[1], store.receipts[0]];
    writeFileSync(box.storePath, `${JSON.stringify(store)}\n`);
    assert.throws(() => writeCompletedTurnReceipt(input(3), { storePath: box.storePath }), /uniqueness invalid/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test('completed turn receipt: Windows path uses LocalAppData', () => {
  const env = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\kite', LOCALAPPDATA: 'C:\\Users\\kite\\AppData\\Local' };
  const projectSha256 = 'a'.repeat(64);
  assert.equal(
    defaultCompletedTurnReceiptStorePath(projectSha256, env),
    join(env.LOCALAPPDATA, 'throughline', 'completed-turn-receipts', `${projectSha256}.json`),
  );
});
