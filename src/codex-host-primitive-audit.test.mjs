import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyCodexHostPrimitiveSchema,
  extractJsonRpcMethods,
  runCodexHostPrimitiveAudit,
} from './codex-host-primitive-audit.mjs';

function makeSchemaDir({
  methods,
  resumeHistoryDescription = '[UNSTABLE] FOR CODEX CLOUD - DO NOT USE.',
  resumeRootDescription =
    'There are three ways to resume a thread. The precedence is: history > path > thread_id. If using history or path, the thread_id param will be ignored.',
}) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-host-primitive-test-'));
  mkdirSync(join(dir, 'v2'), { recursive: true });
  writeFileSync(
    join(dir, 'ClientRequest.json'),
    JSON.stringify({
      oneOf: methods.map((method) => ({
        type: 'object',
        properties: {
          method: {
            const: method,
          },
        },
      })),
    }),
  );
  writeFileSync(
    join(dir, 'v2', 'ThreadResumeParams.json'),
    JSON.stringify({
      description: resumeRootDescription,
      properties: {
        history: {
          description: resumeHistoryDescription,
        },
      },
    }),
  );
  return dir;
}

test('extractJsonRpcMethods collects method const and enum values', () => {
  const methods = extractJsonRpcMethods({
    oneOf: [
      { properties: { method: { const: 'thread/rollback' } } },
      { properties: { method: { enum: ['turn/start', 'plain'] } } },
    ],
  });

  assert.deepEqual([...methods].sort(), ['thread/rollback', 'turn/start']);
});

test('classifyCodexHostPrimitiveSchema blocks when only rollback/inject/new-thread primitives exist', () => {
  const dir = makeSchemaDir({
    methods: [
      'thread/start',
      'thread/resume',
      'thread/fork',
      'thread/archive',
      'thread/compact/start',
      'thread/rollback',
      'thread/inject_items',
      'thread/turns/list',
    ],
  });
  try {
    const result = classifyCodexHostPrimitiveSchema({ schemaDir: dir });

    assert.equal(result.status, 'host-primitive-audit-blocked');
    assert.equal(result.reason, 'no_current_thread_restore_non_resurrection_primitive');
    assert.equal(result.restartSafePrimitive, false);
    assert.equal(result.facts.threadRollback, true);
    assert.equal(result.facts.threadInjectItems, true);
    assert.equal(result.facts.threadResumeHistory.supportedForThroughline, false);
    assert.equal(result.facts.threadResumeHistory.reason, 'thread_resume_history_is_marked_do_not_use');
    assert.equal(result.facts.hasCurrentThreadRemediationPrimitive, false);
    assert.equal(result.facts.hasCurrentThreadNonResurrectionPrimitive, false);
    assert.equal(result.facts.threadTurnsList, true);
    assert.equal(
      result.repairContract.status,
      'blocked-missing-current-thread-non-resurrection-guarantee',
    );
    assert.equal(
      result.repairContract.criteria.find((entry) => entry.id === 'same_current_thread_repair_primitive')
        ?.status,
      'missing',
    );
    assert.equal(
      result.repairContract.criteria.find((entry) => entry.id === 'post_repair_host_read_verification')
        ?.status,
      'present',
    );
    assert.equal(
      result.decisions.find((entry) => entry.id === 'non_resurrection_guarantee_absent')?.status,
      'blocking',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCodexHostPrimitiveSchema surfaces a future current-thread rewrite candidate', () => {
  const dir = makeSchemaDir({
    methods: ['thread/rollback', 'thread/inject_items', 'thread/read', 'thread/history/replace'],
  });
  try {
    const result = classifyCodexHostPrimitiveSchema({ schemaDir: dir });

    assert.equal(result.status, 'host-primitive-audit-needs-live-validation');
    assert.deepEqual(result.facts.inPlaceHistoryRewriteMethods, ['thread/history/replace']);
    assert.equal(result.repairContract.status, 'candidate-requires-live-validation');
    assert.deepEqual(result.repairContract.currentThreadRepairCandidates, ['thread/history/replace']);
    assert.deepEqual(result.repairContract.restoreSourceDeletionCandidates, ['thread/history/replace']);
    assert.deepEqual(result.repairContract.restoreSourceIsolationCandidates, []);
    assert.equal(
      result.repairContract.criteria.find((entry) => entry.id === 'same_current_thread_repair_primitive')
        ?.status,
      'candidate',
    );
    assert.equal(
      result.repairContract.criteria.find((entry) => entry.id === 'restart_reconnect_non_resurrection_verification')
        ?.status,
      'requires-live-smoke',
    );
    assert.equal(result.recommendation.status, 'diagnostic-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCodexHostPrimitiveSchema accepts a future restore projection candidate', () => {
  const dir = makeSchemaDir({
    methods: [
      'thread/rollback',
      'thread/inject_items',
      'thread/read',
      'thread/restore/filter',
    ],
  });
  try {
    const result = classifyCodexHostPrimitiveSchema({ schemaDir: dir });

    assert.equal(result.status, 'host-primitive-audit-needs-live-validation');
    assert.deepEqual(result.facts.inPlaceRestoreIsolationMethods, ['thread/restore/filter']);
    assert.equal(result.repairContract.status, 'candidate-requires-live-validation');
    assert.deepEqual(result.repairContract.currentThreadRepairCandidates, ['thread/restore/filter']);
    assert.deepEqual(result.repairContract.restoreSourceDeletionCandidates, []);
    assert.deepEqual(result.repairContract.restoreSourceIsolationCandidates, ['thread/restore/filter']);
    assert.equal(
      result.repairContract.criteria.find(
        (entry) => entry.id === 'restore_source_non_resurrection_guarantee',
      )?.status,
      'candidate',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCodexHostPrimitiveSchema keeps resume history out of the repair contract', () => {
  const dir = makeSchemaDir({
    methods: ['thread/resume', 'thread/inject_items', 'thread/read'],
    resumeHistoryDescription: 'test-only history candidate',
    resumeRootDescription: 'test-only thread resume params',
  });
  try {
    const result = classifyCodexHostPrimitiveSchema({ schemaDir: dir });

    assert.equal(result.status, 'host-primitive-audit-needs-live-validation');
    assert.equal(result.facts.threadResumeHistory.supportedForThroughline, true);
    assert.deepEqual(result.repairContract.resumeHistoryCandidates, ['thread/resume(history)']);
    assert.equal(
      result.repairContract.status,
      'blocked-missing-current-thread-non-resurrection-guarantee',
    );
    assert.deepEqual(result.repairContract.currentThreadRepairCandidates, []);
    assert.equal(
      result.repairContract.criteria.find((entry) => entry.id === 'same_current_thread_repair_primitive')
        ?.status,
      'missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexHostPrimitiveAudit can read a provided schema directory without spawning codex', () => {
  const dir = makeSchemaDir({
    methods: ['thread/rollback', 'thread/inject_items'],
  });
  try {
    const result = runCodexHostPrimitiveAudit({
      command: '/missing/codex',
      schemaDir: dir,
    });

    assert.equal(result.status, 'host-primitive-audit-blocked');
    assert.equal(result.schemaSource, 'provided-schema-dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
