import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATABASE_SCHEMA,
  FACTORY_DIAGNOSTICS_SCHEMA,
  buildFactoryDiagnostics,
} from './factory-diagnostics.mjs';
import { CURRENT_VERSION } from './db.mjs';

test('factory diagnostics: database label は DB 実体・対応 version と一致する', () => {
  const result = buildFactoryDiagnostics({
    database: {
      status: 'ready',
      schemaVersion: CURRENT_VERSION,
      supportedSchemaVersion: CURRENT_VERSION,
      handoffMemory: true,
    },
  });

  assert.equal(DATABASE_SCHEMA, `throughline.database.v${CURRENT_VERSION}`);
  assert.equal(result.databaseSchema.schema, `throughline.database.v${result.databaseSchema.databaseSchemaVersion}`);
  assert.equal(result.databaseSchema.databaseSchemaVersion, result.databaseSchema.supportedDatabaseSchemaVersion);
});

test('factory diagnostics: 未設定の native factory は not_applicable を成功へ丸めない', () => {
  const result = buildFactoryDiagnostics({
    version: '0.6.1',
    database: { status: 'not_applicable', reason: 'db_not_found', schemaVersion: null, handoffMemory: false },
    hooks: { status: 'not_applicable', claudeStatus: 'not_applicable', reason: 'hooks_not_registered', events: {} },
    thread: { status: 'not_applicable', reason: 'codex_thread_not_detected', rolloutAvailable: false },
  });

  assert.equal(result.schema, FACTORY_DIAGNOSTICS_SCHEMA);
  assert.equal(result.overall.status, 'not_applicable');
  assert.equal(result.readiness.capture.status, 'not_applicable');
  assert.equal(result.readiness.restore.status, 'not_applicable');
  assert.equal(result.readiness.handoff.status, 'not_applicable');
});

test('factory diagnostics: restore は実行していない smoke を ready にしない', () => {
  const result = buildFactoryDiagnostics({
    version: '0.6.1',
    database: { status: 'ready', reason: 'db_schema_supported', schemaVersion: 8, handoffMemory: true },
    hooks: {
      status: 'ready',
      claudeStatus: 'ready',
      reason: 'managed_hooks_ready',
      events: {
        userPromptSubmit: 'ready',
        postToolUse: 'ready',
        stop: 'ready',
      },
    },
    thread: { status: 'ready', reason: 'thread_and_rollout_detected', rolloutAvailable: true },
  });

  assert.equal(result.readiness.capture.status, 'ready');
  assert.equal(result.readiness.handoff.status, 'ready');
  assert.equal(result.readiness.restore.status, 'ready');
  assert.equal(result.evidence.restoreSmoke.status, 'unverified');
  assert.equal(result.overall.status, 'ready');
});

test('factory diagnostics: Claude connector 未検査は Codex-only ready snapshot を unverified にしない', () => {
  const result = buildFactoryDiagnostics({
    version: '0.6.2',
    database: { status: 'ready', schemaVersion: 8, supportedSchemaVersion: 8, handoffMemory: true },
    hooks: {
      status: 'ready',
      events: { userPromptSubmit: 'ready', postToolUse: 'ready', stop: 'ready' },
    },
    thread: { status: 'ready', rolloutAvailable: true },
  });

  assert.equal(result.hooks.status, 'ready');
  assert.equal(result.connectors.codex.status, 'ready');
  assert.equal(result.connectors.claude.status, 'unverified');
  assert.equal(result.connectors.claude.reason, 'diagnostic_unverified');
  assert.equal(result.overall.status, 'ready');
});

test('factory diagnostics: JSON に本文、秘密、絶対 path、生 state を含めない', () => {
  const secret = 'sk-test-very-secret';
  const body = 'ユーザーの prompt 本文';
  const absolutePath = '/Users/example/.throughline/state/session.json';
  const result = buildFactoryDiagnostics({
    version: '0.6.1',
    database: {
      status: 'unverified',
      reason: `db_open_failed:${secret}:${absolutePath}`,
      schemaVersion: 8,
      handoffMemory: false,
      rawState: { body, secret, absolutePath },
    },
    hooks: { status: 'unverified', claudeStatus: 'unverified', reason: `config_unreadable:${absolutePath}`, events: {} },
    thread: { status: 'unverified', reason: `rollout_unreadable:${body}`, rolloutAvailable: false },
  });

  const json = JSON.stringify(result);
  assert.doesNotMatch(json, new RegExp(secret));
  assert.doesNotMatch(json, new RegExp(body));
  assert.doesNotMatch(json, new RegExp(absolutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.databaseSchema.reason, 'diagnostic_unverified');
  assert.equal(result.hooks.reason, 'diagnostic_unverified');
  assert.equal(result.readiness.capture.reason, 'diagnostic_unverified');
});

test('factory diagnostics: known not_readyをunverifiedで隠さずDB schemaをoverallへ含める', () => {
  const result = buildFactoryDiagnostics({
    version: '0.6.1',
    database: { status: 'not_ready', schemaVersion: 7, handoffMemory: false },
    hooks: { status: 'ready', claudeStatus: 'ready', events: {} },
    thread: { status: 'ready', rolloutAvailable: true },
  });

  assert.equal(result.databaseSchema.status, 'not_ready');
  assert.equal(result.readiness.restore.status, 'not_ready');
  assert.equal(result.overall.status, 'not_ready');
});

test('factory diagnostics: project不一致threadのmemoryをhandoff readyにしない', () => {
  const result = buildFactoryDiagnostics({
    version: '0.6.1',
    database: { status: 'ready', schemaVersion: 8, supportedSchemaVersion: 8, handoffMemory: true },
    hooks: { status: 'ready', claudeStatus: 'ready', events: {} },
    thread: { status: 'not_ready', rolloutAvailable: false },
  });

  assert.equal(result.readiness.handoff.status, 'not_ready');
  assert.equal(result.overall.status, 'not_ready');
});
