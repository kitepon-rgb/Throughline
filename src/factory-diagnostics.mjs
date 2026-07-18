import { CURRENT_VERSION } from './db.mjs';

export const FACTORY_DIAGNOSTICS_SCHEMA = 'throughline.native_factory_diagnostics.v1';
export const DATABASE_SCHEMA = `throughline.database.v${CURRENT_VERSION}`;

const STATUSES = new Set(['ready', 'not_ready', 'not_applicable', 'unverified']);

function statusOf(value, fallback = 'unverified') {
  return STATUSES.has(value) ? value : fallback;
}

function publicReason(status) {
  if (status === 'ready') return 'ready';
  if (status === 'not_ready') return 'not_ready';
  if (status === 'not_applicable') return 'not_applicable';
  return 'diagnostic_unverified';
}

function aggregate(statuses) {
  const normalized = statuses.map((status) => statusOf(status));
  if (normalized.includes('not_ready')) return 'not_ready';
  if (normalized.includes('unverified')) return 'unverified';
  if (normalized.includes('ready')) return 'ready';
  return 'not_applicable';
}

/**
 * Native factory 用の公開可能な read-only readiness projection を組み立てる。
 * 入力に path、本文、例外を含めても、それらは出力へ移送しない。
 */
export function buildFactoryDiagnostics({ version, database = {}, hooks = {}, thread = {} } = {}) {
  const databaseStatus = statusOf(database.status);
  const hooksStatus = statusOf(hooks.status);
  const claudeConnectorStatus = statusOf(hooks.claudeStatus);
  const threadStatus = statusOf(thread.status);
  const rolloutAvailable = thread.rolloutAvailable === true;
  const handoffMemory = database.handoffMemory === true;

  const captureStatus =
    threadStatus === 'not_applicable'
      ? 'not_applicable'
      : threadStatus === 'ready' && rolloutAvailable
        ? 'ready'
        : threadStatus === 'not_ready'
          ? 'not_ready'
          : 'unverified';
  const restoreStatus =
    databaseStatus === 'not_applicable'
      ? 'not_applicable'
      : databaseStatus === 'not_ready'
        ? 'not_ready'
        : databaseStatus === 'ready'
          ? 'ready'
          : 'unverified';
  const restoreSmokeStatus = threadStatus === 'not_applicable' ? 'not_applicable' : 'unverified';
  const handoffStatus =
    threadStatus === 'not_applicable'
      ? 'not_applicable'
      : threadStatus === 'ready' && rolloutAvailable && databaseStatus === 'ready' && handoffMemory
        ? 'ready'
        : threadStatus === 'not_ready' || databaseStatus === 'not_ready' ||
            (databaseStatus === 'ready' && !handoffMemory)
          ? 'not_ready'
          : 'unverified';

  const stateSchemaStatus =
    databaseStatus === 'ready'
      ? 'ready'
      : databaseStatus === 'not_applicable'
        ? 'not_applicable'
        : databaseStatus === 'not_ready'
          ? 'not_ready'
          : 'unverified';

  return {
    schema: FACTORY_DIAGNOSTICS_SCHEMA,
    version: typeof version === 'string' && version.length > 0 ? version : 'unknown',
    overall: {
      status: aggregate([
        stateSchemaStatus,
        hooksStatus,
        captureStatus,
        restoreStatus,
        handoffStatus,
      ]),
    },
    databaseSchema: {
      schema: DATABASE_SCHEMA,
      status: stateSchemaStatus,
      databaseSchemaVersion: Number.isInteger(database.schemaVersion) ? database.schemaVersion : null,
      supportedDatabaseSchemaVersion: Number.isInteger(database.supportedSchemaVersion)
        ? database.supportedSchemaVersion
        : null,
      reason: publicReason(stateSchemaStatus),
    },
    hooks: {
      scope: 'codex',
      status: hooksStatus,
      reason: publicReason(hooksStatus),
      events: {
        userPromptSubmit: statusOf(hooks.events?.userPromptSubmit, hooksStatus),
        postToolUse: statusOf(hooks.events?.postToolUse, hooksStatus),
        stop: statusOf(hooks.events?.stop, hooksStatus),
      },
    },
    readiness: {
      capture: { status: captureStatus, reason: publicReason(captureStatus) },
      restore: { status: restoreStatus, reason: publicReason(restoreStatus) },
      handoff: { status: handoffStatus, reason: publicReason(handoffStatus) },
    },
    evidence: {
      restoreSmoke: { status: restoreSmokeStatus, reason: publicReason(restoreSmokeStatus) },
    },
    connectors: {
      claude: { status: claudeConnectorStatus, reason: publicReason(claudeConnectorStatus) },
      codex: { status: hooksStatus, reason: publicReason(hooksStatus) },
    },
  };
}
