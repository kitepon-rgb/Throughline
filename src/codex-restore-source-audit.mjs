import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildCodexRolloutTrimSource } from './codex-rollout-memory.mjs';
import { defaultCodexHome } from './codex-thread-index.mjs';

const DEFAULT_MAX_STORAGE_FILES = 5000;
const DEFAULT_MAX_STORAGE_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_MATCHES = 50;
const DEFAULT_MAX_EXTENSION_FILES = 5000;
const DEFAULT_MAX_EXTENSION_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EXTENSION_MATCHES = 100;
const DEFAULT_MAX_EXTENSION_SOURCE_SNIPPETS = 40;
const DEFAULT_EXTENSION_SOURCE_SNIPPET_CHARS = 240;
const DEFAULT_MAX_SETTINGS_FILES = 100;
const DEFAULT_MAX_SETTINGS_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_SETTINGS_MATCHES = 20;
const DEFAULT_MAX_LOG_FILES = 2000;
const DEFAULT_MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOG_MATCHES = 50;
const MIN_RESTORE_TEXT_NEEDLE_CHARS = 20;

const VSCODE_EXTENSION_RESTORE_PATTERNS = Object.freeze([
  { id: 'thread_read', label: 'Codex app-server thread/read', pattern: 'thread/read' },
  { id: 'thread_resume', label: 'Codex app-server thread/resume', pattern: 'thread/resume' },
  { id: 'thread_turns_list', label: 'Codex app-server thread/turns/list', pattern: 'thread/turns/list' },
  { id: 'thread_compact_start', label: 'Codex app-server thread/compact/start', pattern: 'thread/compact/start' },
  { id: 'thread_rollback', label: 'Codex app-server thread/rollback', pattern: 'thread/rollback' },
  { id: 'mark_need_resume_after_reconnect', label: 'VS Code reconnect marks conversations needing resume', pattern: 'markAllConversationsNeedResumeAfterReconnect' },
  { id: 'needs_resume', label: 'VS Code needs_resume state', pattern: 'needs_resume' },
  { id: 'persisted_atom', label: 'Codex webview persisted atom prefix', pattern: 'codex:persisted-atom:' },
  { id: 'follow_up_queue_setting', label: 'Codex follow-up queue setting', pattern: 'chatgpt.followUpQueueMode' },
  { id: 'send_follow_up_message', label: 'Codex send follow-up message action', pattern: 'send-follow-up-message' },
  { id: 'steering_user_message', label: 'Codex steering user message item', pattern: 'steeringUserMessage' },
  { id: 'compacted_replacement_history', label: 'Codex compacted replacement_history text', pattern: 'replacement_history' },
  {
    id: 'patch_apply_failure_log',
    label: 'VS Code patch apply failure log source',
    pattern: 'Failed to apply patches for',
  },
]);

const VSCODE_EXTENSION_SOURCE_FACT_PATTERNS = Object.freeze([
  {
    id: 'thread_resume_uses_null_history',
    label: 'thread/resume request passes history:null',
    requiredPatterns: ['thread/resume', 'history:null'],
  },
  {
    id: 'thread_resume_uses_rollout_path',
    label: 'thread/resume request can pass rolloutPath as path',
    requiredPatterns: ['thread/resume', 'rolloutPath'],
  },
  {
    id: 'reconnect_command_marks_threads_need_resume',
    label: 'reconnect command marks conversations as needing resume',
    requiredPatterns: [
      'mark-all-conversations-need-resume-after-reconnect-for-host',
      'markAllConversationsNeedResumeAfterReconnect',
    ],
  },
  {
    id: 'steering_user_message_has_restore_message',
    label: 'steeringUserMessage carries restoreMessage',
    requiredPatterns: ['steeringUserMessage', 'restoreMessage'],
  },
  {
    id: 'owner_broadcasts_thread_state_patches',
    label: 'owner broadcasts conversation state patches over thread-stream-state-changed',
    requiredPatterns: ['broadcastIpcStatePatches', 'thread-stream-state-changed', 'patches:t'],
  },
  {
    id: 'follower_applies_thread_state_patches',
    label: 'follower applies thread-stream-state-changed patches to conversation state',
    requiredPatterns: ['handleThreadStreamStateChanged', 'sn(n,t.patches)'],
  },
  {
    id: 'patch_apply_failure_logged_in_thread_stream_handler',
    label: 'thread-stream-state-changed patch apply failure is logged',
    requiredPatterns: ['handleThreadStreamStateChanged', 'Failed to apply patches for'],
  },
  {
    id: 'replacement_history_filter_candidate',
    label: 'replacement_history appears with a filter candidate',
    nearPatternSets: [{ patterns: ['replacement_history', 'filter'] }],
  },
  {
    id: 'replacement_history_tombstone_candidate',
    label: 'replacement_history appears with a tombstone candidate',
    nearPatternSets: [{ patterns: ['replacement_history', 'tombstone'] }],
  },
  {
    id: 'restore_message_suppression_candidate',
    label: 'restoreMessage appears with a suppression candidate',
    nearPatternSets: [{ patterns: ['restoreMessage', 'suppress'] }],
  },
  {
    id: 'restore_message_exclusion_candidate',
    label: 'restoreMessage appears with an exclusion candidate',
    nearPatternSets: [{ patterns: ['restoreMessage', 'exclude'] }],
  },
  {
    id: 'restore_message_projection_candidate',
    label: 'restoreMessage appears with a projection candidate',
    nearPatternSets: [{ patterns: ['restoreMessage', 'projection'] }],
  },
  {
    id: 'rolled_back_tombstone_candidate',
    label: 'thread_rolled_back appears with a tombstone candidate',
    nearPatternSets: [{ patterns: ['thread_rolled_back', 'tombstone'] }],
  },
]);

const VSCODE_ROLLBACK_NON_RESURRECTION_SOURCE_FACT_IDS = Object.freeze([
  'replacement_history_filter_candidate',
  'replacement_history_tombstone_candidate',
  'restore_message_suppression_candidate',
  'restore_message_exclusion_candidate',
  'restore_message_projection_candidate',
  'rolled_back_tombstone_candidate',
]);

const VSCODE_LOG_SIGNAL_PATTERNS = Object.freeze([
  {
    id: 'patch_apply_failure',
    label: 'VS Code failed to apply conversation patches for thread',
    buildPattern: (threadId) => `Failed to apply patches for conversationId=${threadId}`,
  },
  {
    id: 'thread_stream_state_broadcast',
    label: 'VS Code thread stream state broadcast',
    pattern: 'thread-stream-state-changed',
  },
  {
    id: 'replacement_history',
    label: 'Codex compacted replacement_history text in logs',
    pattern: 'replacement_history',
  },
]);

export function runCodexRestoreSourceAudit({
  threadId,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  vscodeStorageRoots = defaultVsCodeStorageRoots(),
  vscodeExtensionRoots = defaultVsCodeExtensionRoots(),
  vscodeSettingsRoots = defaultVsCodeSettingsRoots(),
  vscodeLogRoots = defaultVsCodeLogRoots(),
  maxStorageFiles = DEFAULT_MAX_STORAGE_FILES,
  maxStorageFileBytes = DEFAULT_MAX_STORAGE_FILE_BYTES,
  maxStorageMatches = DEFAULT_MAX_STORAGE_MATCHES,
  maxExtensionFiles = DEFAULT_MAX_EXTENSION_FILES,
  maxExtensionFileBytes = DEFAULT_MAX_EXTENSION_FILE_BYTES,
  maxExtensionMatches = DEFAULT_MAX_EXTENSION_MATCHES,
  maxExtensionSourceSnippets = DEFAULT_MAX_EXTENSION_SOURCE_SNIPPETS,
  maxSettingsFiles = DEFAULT_MAX_SETTINGS_FILES,
  maxSettingsFileBytes = DEFAULT_MAX_SETTINGS_FILE_BYTES,
  maxSettingsMatches = DEFAULT_MAX_SETTINGS_MATCHES,
  maxLogFiles = DEFAULT_MAX_LOG_FILES,
  maxLogFileBytes = DEFAULT_MAX_LOG_FILE_BYTES,
  maxLogMatches = DEFAULT_MAX_LOG_MATCHES,
} = {}) {
  assertNonEmptyString(threadId, 'threadId');
  assertNonEmptyString(codexHome, 'codexHome');
  assertNonEmptyString(projectPath, 'projectPath');
  assertNonNegativeInteger(maxStorageFiles, 'maxStorageFiles');
  assertPositiveInteger(maxStorageFileBytes, 'maxStorageFileBytes');
  assertNonNegativeInteger(maxStorageMatches, 'maxStorageMatches');
  assertNonNegativeInteger(maxExtensionFiles, 'maxExtensionFiles');
  assertPositiveInteger(maxExtensionFileBytes, 'maxExtensionFileBytes');
  assertNonNegativeInteger(maxExtensionMatches, 'maxExtensionMatches');
  assertNonNegativeInteger(maxExtensionSourceSnippets, 'maxExtensionSourceSnippets');
  assertNonNegativeInteger(maxSettingsFiles, 'maxSettingsFiles');
  assertPositiveInteger(maxSettingsFileBytes, 'maxSettingsFileBytes');
  assertNonNegativeInteger(maxSettingsMatches, 'maxSettingsMatches');
  assertNonNegativeInteger(maxLogFiles, 'maxLogFiles');
  assertPositiveInteger(maxLogFileBytes, 'maxLogFileBytes');
  assertNonNegativeInteger(maxLogMatches, 'maxLogMatches');

  const trimSource = buildCodexRolloutTrimSource({
    threadId,
    codexHome,
    projectPath,
    sourceReason: 'restore_source_audit_rollout',
  });

  if (!trimSource) {
    return {
      status: 'refused',
      reason: 'codex_rollout_source_required',
      threadId,
      proofScope: 'local_restore_source_inventory_only',
      restartSafe: false,
    };
  }

  const needles = buildRestoreNeedles({ threadId, restoreSafety: trimSource.restoreSafety });
  const sessionIndex = inspectSessionIndex({ codexHome, threadId });
  const stateDatabases = inspectCodexStateDatabases({ codexHome, threadId });
  const vscodeStorage = inspectStorageRoots({
    roots: vscodeStorageRoots,
    needles,
    maxFiles: maxStorageFiles,
    maxFileBytes: maxStorageFileBytes,
    maxMatches: maxStorageMatches,
  });
  const vscodeExtension = inspectVsCodeExtensionRoots({
    roots: vscodeExtensionRoots,
    maxFiles: maxExtensionFiles,
    maxFileBytes: maxExtensionFileBytes,
    maxMatches: maxExtensionMatches,
    maxSourceSnippets: maxExtensionSourceSnippets,
  });
  const vscodeSettings = inspectVsCodeSettingsRoots({
    roots: vscodeSettingsRoots,
    maxFiles: maxSettingsFiles,
    maxFileBytes: maxSettingsFileBytes,
    maxMatches: maxSettingsMatches,
  });
  const vscodeLogs = inspectVsCodeLogRoots({
    roots: vscodeLogRoots,
    needles,
    threadId,
    maxFiles: maxLogFiles,
    maxFileBytes: maxLogFileBytes,
    maxMatches: maxLogMatches,
  });

  return {
    status: 'restore-source-audit-complete',
    reason: 'local_restore_sources_inspected',
    proofScope: 'local_restore_source_inventory_only',
    restartSafe: false,
    threadId,
    rollout: {
      status: 'present',
      path: trimSource.rolloutPath,
      capturedTurns: trimSource.capturedTurns,
      restoreSafety: trimSource.restoreSafety,
    },
    sessionIndex,
    stateDatabases,
    vscodeStorage,
    vscodeExtension,
    vscodeSettings,
    vscodeLogs,
    summary: summarizeAudit({
      sessionIndex,
      stateDatabases,
      vscodeStorage,
      vscodeExtension,
      vscodeSettings,
      vscodeLogs,
    }),
  };
}

export function defaultVsCodeStorageRoots(env = process.env) {
  const explicit = env.THROUGHLINE_VSCODE_STORAGE_ROOTS;
  if (explicit) {
    return explicit
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const home = homedir();
  const roots = [
    join(home, '.config', 'Code', 'User', 'globalStorage'),
    join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
    join(home, '.vscode-server', 'data', 'User', 'globalStorage'),
    join(home, '.vscode-server', 'data', 'User', 'workspaceStorage'),
    join(home, '.vscode-server-insiders', 'data', 'User', 'globalStorage'),
    join(home, '.vscode-server-insiders', 'data', 'User', 'workspaceStorage'),
  ];

  if (env.VSCODE_PORTABLE) {
    roots.push(join(env.VSCODE_PORTABLE, 'user-data', 'User', 'globalStorage'));
    roots.push(join(env.VSCODE_PORTABLE, 'user-data', 'User', 'workspaceStorage'));
  }

  return [...new Set(roots)];
}

export function defaultVsCodeExtensionRoots(env = process.env) {
  const explicit = env.THROUGHLINE_VSCODE_EXTENSION_ROOTS;
  if (explicit) {
    return explicit
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const home = homedir();
  const roots = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode-server', 'extensions'),
    join(home, '.vscode-server-insiders', 'extensions'),
  ];

  if (env.VSCODE_PORTABLE) {
    roots.push(join(env.VSCODE_PORTABLE, 'extensions'));
  }

  return [...new Set(roots)];
}

export function defaultVsCodeSettingsRoots(env = process.env) {
  const explicit = env.THROUGHLINE_VSCODE_SETTINGS_ROOTS;
  if (explicit) {
    return explicit
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const home = homedir();
  const roots = [
    join(home, '.config', 'Code', 'User'),
    join(home, '.config', 'Code - Insiders', 'User'),
    join(home, '.vscode-server', 'data', 'User'),
    join(home, '.vscode-server-insiders', 'data', 'User'),
  ];

  if (env.VSCODE_PORTABLE) {
    roots.push(join(env.VSCODE_PORTABLE, 'user-data', 'User'));
  }

  return [...new Set(roots)];
}

export function defaultVsCodeLogRoots(env = process.env) {
  const explicit = env.THROUGHLINE_VSCODE_LOG_ROOTS;
  if (explicit) {
    return explicit
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const home = homedir();
  const roots = [
    join(home, '.config', 'Code', 'logs'),
    join(home, '.config', 'Code - Insiders', 'logs'),
    join(home, '.vscode-server', 'data', 'logs'),
    join(home, '.vscode-server-insiders', 'data', 'logs'),
  ];

  if (env.VSCODE_PORTABLE) {
    roots.push(join(env.VSCODE_PORTABLE, 'user-data', 'logs'));
  }

  return [...new Set(roots)];
}

function inspectSessionIndex({ codexHome, threadId }) {
  const path = join(codexHome, 'session_index.jsonl');
  if (!existsSync(path)) {
    return { status: 'missing', path, containsThreadId: false };
  }

  let rows = 0;
  let match = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows++;
    try {
      const row = JSON.parse(line);
      if (row?.id === threadId) {
        match = {
          id: row.id,
          threadName: row.thread_name ?? null,
          updatedAt: row.updated_at ?? null,
        };
      }
    } catch {
      // Session index corruption is not fatal; rollout is the authoritative candidate source.
    }
  }

  return {
    status: match ? 'present' : 'not-found',
    path,
    rows,
    containsThreadId: Boolean(match),
    match,
  };
}

function inspectCodexStateDatabases({ codexHome, threadId }) {
  if (!existsSync(codexHome)) {
    return { status: 'missing', codexHome, databases: [] };
  }

  const files = readdirSync(codexHome)
    .filter((name) => /^state(?:_\d+)?\.sqlite$/.test(name))
    .map((name) => join(codexHome, name));

  const databases = files.map((path) => inspectCodexStateDatabase({ path, threadId }));
  const threadMatches = databases.reduce((sum, db) => sum + (db.threadRows?.length ?? 0), 0);
  const turnBodyStores = databases.filter((db) => db.hasLikelyTurnBodyStore).map((db) => db.path);

  return {
    status: databases.length > 0 ? 'present' : 'missing',
    codexHome,
    databases,
    threadMatches,
    hasLikelyTurnBodyStore: turnBodyStores.length > 0,
    conclusion:
      turnBodyStores.length > 0
        ? 'state_database_may_include_turn_bodies'
        : 'state_database_appears_metadata_only',
  };
}

function inspectCodexStateDatabase({ path, threadId }) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name);
    const tableColumns = Object.fromEntries(
      tables.map((table) => [table, db.prepare(`pragma table_info(${quoteIdent(table)})`).all()]),
    );
    const likelyThreadBodyTables = tables.filter((table) =>
      isLikelyThreadBodyTable(table, tableColumns[table] ?? []),
    );
    const contentTableMatches = likelyThreadBodyTables.map((table) =>
      countThreadLinkedRows({
        db,
        table,
        columns: tableColumns[table] ?? [],
        threadId,
      }),
    );
    const threadRows = tables.includes('threads')
      ? selectThreadRows({
          db,
          columns: tableColumns.threads ?? [],
          threadId,
        })
      : [];
    const matchingContentTables = contentTableMatches.filter((entry) => entry.rows > 0);

    return {
      status: 'ok',
      path,
      tables,
      likelyThreadBodyTables,
      contentTableMatches,
      hasLikelyTurnBodyStore: matchingContentTables.length > 0,
      threadRows,
    };
  } catch (err) {
    return {
      status: 'error',
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isLikelyThreadBodyTable(table, columns) {
  if (table === 'threads') return false;
  const names = columns.map((column) => column.name);
  const hasThreadLink = names.some((name) => /^(thread_id|assigned_thread_id|codex_thread_id)$/.test(name));
  const hasBodyLikeColumn = names.some((name) =>
    /(^|_)(message|content|body|history|item|memory|summary|row_json|result_json)($|_)/i.test(name),
  );
  return hasThreadLink && hasBodyLikeColumn;
}

function countThreadLinkedRows({ db, table, columns, threadId }) {
  const threadColumn = columns
    .map((column) => column.name)
    .find((name) => /^(thread_id|assigned_thread_id|codex_thread_id)$/.test(name));
  if (!threadColumn) return { table, threadColumn: null, rows: 0 };

  const row = db
    .prepare(
      `select count(*) as rows from ${quoteIdent(table)} where ${quoteIdent(threadColumn)} = ?`,
    )
    .get(threadId);
  return {
    table,
    threadColumn,
    rows: Number(row?.rows) || 0,
  };
}

function selectThreadRows({ db, columns, threadId }) {
  const names = new Set(columns.map((column) => column.name));
  const selected = ['id', 'rollout_path', 'source', 'cwd', 'title', 'updated_at'].filter((name) =>
    names.has(name),
  );
  if (!names.has('id') || selected.length === 0) return [];

  return db
    .prepare(`select ${selected.map(quoteIdent).join(', ')} from threads where id = ? limit 5`)
    .all(threadId);
}

function buildRestoreNeedles({ threadId, restoreSafety }) {
  const needles = [{ id: 'thread_id', label: 'Codex thread id', value: threadId }];
  let index = 1;
  for (const entry of restoreSafety?.retainedTexts ?? []) {
    const value = normalizeRestoreTextNeedle(entry.textPreview);
    if (value.length < MIN_RESTORE_TEXT_NEEDLE_CHARS) continue;
    needles.push({
      id: `retained_rollback_text_${index++}`,
      label: 'rollback text retained in compacted replacement history',
      value,
    });
  }
  return needles;
}

function normalizeRestoreTextNeedle(value) {
  return String(value ?? '').replace(' [truncated]', '').replace(/\s+/g, ' ').trim();
}

function inspectStorageRoots({ roots, needles, maxFiles, maxFileBytes, maxMatches }) {
  const rootResults = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const matches = [];
  const sqliteDatabases = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      rootResults.push({ path: root, status: 'missing' });
      continue;
    }

    const beforeFiles = filesScanned;
    const beforeMatches = matches.length;
    for (const file of walkFiles(root)) {
      if (filesScanned >= maxFiles || matches.length >= maxMatches) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes) continue;

      filesScanned++;
      bytesScanned += stat.size;
      const hitIds = fileNeedleHits(file, needles);
      if (hitIds.length > 0) {
        matches.push({ path: file, size: stat.size, needles: hitIds });
      }
      if (isLikelySqliteStorageFile(file)) {
        sqliteDatabases.push(inspectSqliteStorageFile({ path: file, needles }));
      }
    }

    rootResults.push({
      path: root,
      status: 'searched',
      filesScanned: filesScanned - beforeFiles,
      matches: matches.length - beforeMatches,
    });
    if (truncated) break;
  }

  return {
    status: rootResults.some((root) => root.status === 'searched') ? 'searched' : 'missing',
    roots: rootResults,
    filesScanned,
    bytesScanned,
    matches,
    sqliteDatabases,
    sqliteDatabaseMatches: sqliteDatabases.reduce(
      (sum, database) => sum + (database.matches?.length ?? 0),
      0,
    ),
    truncated,
    limits: { maxFiles, maxFileBytes, maxMatches },
  };
}

function inspectVsCodeLogRoots({ roots, needles, threadId, maxFiles, maxFileBytes, maxMatches }) {
  const rootResults = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const matches = [];
  const signalMatches = [];
  const signalCounts = Object.fromEntries(VSCODE_LOG_SIGNAL_PATTERNS.map((signal) => [signal.id, 0]));
  let threadIdMatches = 0;
  let retainedTextMatches = 0;

  for (const root of roots) {
    if (!existsSync(root)) {
      rootResults.push({ path: root, status: 'missing' });
      continue;
    }

    const beforeFiles = filesScanned;
    const beforeMatches = matches.length + signalMatches.length;
    for (const file of walkFiles(root)) {
      if (filesScanned >= maxFiles || matches.length + signalMatches.length >= maxMatches) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes) continue;

      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      filesScanned++;
      bytesScanned += stat.size;
      const needleHits = textNeedleHitDetails(text, needles);
      if (needleHits.length > 0) {
        const hitIds = needleHits.map((hit) => hit.id);
        matches.push({ path: file, size: stat.size, needles: hitIds, needleHits });
        threadIdMatches += needleHits
          .filter((hit) => hit.id === 'thread_id')
          .reduce((sum, hit) => sum + hit.count, 0);
        retainedTextMatches += needleHits
          .filter((hit) => hit.id.startsWith('retained_rollback_text_'))
          .reduce((sum, hit) => sum + hit.count, 0);
      }

      const signals = logSignalHitDetails({ text, threadId, needleHits });
      for (const signal of signals) {
        if (matches.length + signalMatches.length >= maxMatches) {
          truncated = true;
          break;
        }
        signalMatches.push({ path: file, size: stat.size, ...signal });
        signalCounts[signal.signal] += signal.count;
      }
      if (truncated) break;
    }

    rootResults.push({
      path: root,
      status: 'searched',
      filesScanned: filesScanned - beforeFiles,
      matches: matches.length + signalMatches.length - beforeMatches,
    });
    if (truncated) break;
  }

  return {
    status: rootResults.some((root) => root.status === 'searched') ? 'searched' : 'missing',
    roots: rootResults,
    filesScanned,
    bytesScanned,
    matches,
    signalMatches,
    signals: {
      threadIdMatches,
      retainedTextMatches,
      patchApplyFailures: signalCounts.patch_apply_failure ?? 0,
      threadStreamStateSignals: signalCounts.thread_stream_state_broadcast ?? 0,
      replacementHistorySignals: signalCounts.replacement_history ?? 0,
      counts: signalCounts,
    },
    truncated,
    limits: { maxFiles, maxFileBytes, maxMatches },
  };
}

function isLikelySqliteStorageFile(path) {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  return ext === '.vscdb' || ext === '.sqlite' || ext === '.sqlite3' || ext === '.db';
}

function inspectSqliteStorageFile({ path, needles }) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tableNames = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name);
    const tables = [];
    const matches = [];
    for (const table of tableNames) {
      const columns = db.prepare(`pragma table_info(${quoteIdent(table)})`).all();
      const searchableColumns = columns
        .map((column) => ({
          name: column.name,
          type: String(column.type ?? ''),
        }))
        .filter((column) => isSqliteSearchableStorageColumn(column));
      tables.push({
        name: table,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type ?? '',
        })),
        searchableColumns: searchableColumns.map((column) => column.name),
      });

      for (const column of searchableColumns) {
        for (const needle of needles) {
          if (!needle.value) continue;
          const row = db
            .prepare(
              `select count(*) as rows from ${quoteIdent(table)} where instr(cast(${quoteIdent(
                column.name,
              )} as text), ?) > 0`,
            )
            .get(needle.value);
          const rows = Number(row?.rows) || 0;
          if (rows > 0) {
            matches.push({
              table,
              column: column.name,
              needle: needle.id,
              rows,
            });
          }
        }
      }
    }
    return {
      status: 'ok',
      path,
      tables,
      matches,
    };
  } catch (err) {
    return {
      status: 'error',
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function isSqliteSearchableStorageColumn(column) {
  const type = String(column.type ?? '').toLowerCase();
  if (!type) return true;
  return !/^(integer|int|real|float|double|numeric|boolean|bool|date|datetime)$/.test(type);
}

function inspectVsCodeExtensionRoots({ roots, maxFiles, maxFileBytes, maxMatches, maxSourceSnippets }) {
  const rootResults = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const matches = [];
  let sourceSnippetCount = 0;
  const packageSettings = [];
  const evidence = Object.fromEntries(
    VSCODE_EXTENSION_RESTORE_PATTERNS.map((pattern) => [pattern.id, false]),
  );
  const sourceFactEvidence = Object.fromEntries(
    VSCODE_EXTENSION_SOURCE_FACT_PATTERNS.map((fact) => [fact.id, false]),
  );

  for (const root of roots) {
    if (!existsSync(root)) {
      rootResults.push({ path: root, status: 'missing' });
      continue;
    }

    const beforeFiles = filesScanned;
    const beforeMatches = matches.length;
    for (const file of walkVsCodeExtensionFiles(root)) {
      if (filesScanned >= maxFiles || matches.length >= maxMatches) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes) continue;

      filesScanned++;
      bytesScanned += stat.size;
      const hit = filePatternHitDetails(file, VSCODE_EXTENSION_RESTORE_PATTERNS, {
        maxSourceSnippets: Math.max(0, maxSourceSnippets - sourceSnippetCount),
      });
      if (hit.patterns.length > 0) {
        for (const id of hit.patterns) evidence[id] = true;
        for (const id of hit.sourceFacts) sourceFactEvidence[id] = true;
        sourceSnippetCount += hit.sourceSnippets.length;
        matches.push({
          path: file,
          size: stat.size,
          patterns: hit.patterns,
          sourceSnippets: hit.sourceSnippets,
        });
      }
      const settings = basename(file) === 'package.json' ? readVsCodeExtensionPackageSettings(file) : null;
      if (settings?.followUpQueueModeDefault) {
        packageSettings.push({
          path: file,
          followUpQueueModeDefault: settings.followUpQueueModeDefault,
        });
      }
    }

    rootResults.push({
      path: root,
      status: 'searched',
      filesScanned: filesScanned - beforeFiles,
      matches: matches.length - beforeMatches,
    });
    if (truncated) break;
  }

  return {
    status: rootResults.some((root) => root.status === 'searched') ? 'searched' : 'missing',
    roots: rootResults,
    filesScanned,
    bytesScanned,
    matches,
    truncated,
    patterns: VSCODE_EXTENSION_RESTORE_PATTERNS,
    sourceFacts: summarizeVsCodeExtensionSourceFacts({
      evidence,
      sourceFactEvidence,
      packageSettings,
    }),
    evidence,
    packageSettings: {
      followUpQueueModeDefault:
        packageSettings.length > 0
          ? {
              status: 'present',
              values: [...new Set(packageSettings.map((entry) => entry.followUpQueueModeDefault))],
              sources: packageSettings,
            }
          : { status: 'not-found', values: [], sources: [] },
    },
    restorePathSignals: summarizeVsCodeRestorePathSignals(evidence),
    conclusion: summarizeVsCodeExtensionEvidence(evidence),
    sourceSnippetCount,
    limits: { maxFiles, maxFileBytes, maxMatches, maxSourceSnippets },
  };
}

function readVsCodeExtensionPackageSettings(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }

  const followUpQueueModeDefault =
    parsed?.contributes?.configuration?.properties?.['chatgpt.followUpQueueMode']?.default;
  if (typeof followUpQueueModeDefault !== 'string') return null;
  return { followUpQueueModeDefault };
}

function inspectVsCodeSettingsRoots({ roots, maxFiles, maxFileBytes, maxMatches }) {
  const rootResults = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const matches = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      rootResults.push({ path: root, status: 'missing' });
      continue;
    }

    const beforeFiles = filesScanned;
    const beforeMatches = matches.length;
    for (const file of candidateSettingsFiles(root)) {
      if (filesScanned >= maxFiles || matches.length >= maxMatches) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes) continue;

      filesScanned++;
      bytesScanned += stat.size;
      const followUpQueueMode = readFollowUpQueueModeSetting(file);
      if (followUpQueueMode.status === 'present') {
        matches.push({ path: file, size: stat.size, followUpQueueMode: followUpQueueMode.value });
      }
    }

    rootResults.push({
      path: root,
      status: 'searched',
      filesScanned: filesScanned - beforeFiles,
      matches: matches.length - beforeMatches,
    });
    if (truncated) break;
  }

  return {
    status: rootResults.some((root) => root.status === 'searched') ? 'searched' : 'missing',
    roots: rootResults,
    filesScanned,
    bytesScanned,
    matches,
    truncated,
    followUpQueueMode: {
      status: matches.length > 0 ? 'explicit' : 'not-configured',
      values: [...new Set(matches.map((match) => match.followUpQueueMode))],
    },
    limits: { maxFiles, maxFileBytes, maxMatches },
  };
}

function* candidateSettingsFiles(root) {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return;
  }

  if (stat.isFile()) {
    if (basename(root) === 'settings.json') yield root;
    return;
  }

  if (stat.isDirectory()) {
    yield join(root, 'settings.json');
  }
}

function readFollowUpQueueModeSetting(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'unreadable', value: null };
  }

  const match = text.match(/"chatgpt\.followUpQueueMode"\s*:\s*"([^"]+)"/);
  if (!match) return { status: 'not-found', value: null };
  return { status: 'present', value: match[1] };
}

function* walkFiles(root, { skipDirNames = new Set() } = {}) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue;
        stack.push(path);
      } else if (entry.isFile()) {
        yield path;
      }
    }
  }
}

function* walkVsCodeExtensionFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const likelyExtensionDirs = entries
    .filter((entry) => entry.isDirectory() && isLikelyCodexVsCodeExtensionName(entry.name))
    .map((entry) => join(root, entry.name));

  if (likelyExtensionDirs.length === 0) {
    yield* walkFiles(root, { skipDirNames: new Set(['node_modules', '.git']) });
    return;
  }

  for (const dir of likelyExtensionDirs) {
    yield* walkFiles(dir, { skipDirNames: new Set(['node_modules', '.git']) });
  }
}

function isLikelyCodexVsCodeExtensionName(name) {
  return /(^|\.)(openai|chatgpt|codex)(\.|-|$)/i.test(name);
}

function fileNeedleHits(path, needles) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return [];
  }

  const hits = [];
  for (const needle of needles) {
    if (!needle.value) continue;
    if (buffer.indexOf(Buffer.from(needle.value, 'utf8')) !== -1) {
      hits.push(needle.id);
    }
  }
  return hits;
}

function textNeedleHitDetails(text, needles) {
  const hits = [];
  for (const needle of needles) {
    if (!needle.value) continue;
    const count = countOccurrences(text, needle.value);
    if (count > 0) hits.push({ id: needle.id, count });
  }
  return hits;
}

function logSignalHitDetails({ text, threadId, needleHits }) {
  const hasThreadContext = text.includes(threadId);
  const hasRetainedTextContext = needleHits.some((hit) => hit.id.startsWith('retained_rollback_text_'));
  const signals = [];
  for (const signal of VSCODE_LOG_SIGNAL_PATTERNS) {
    const pattern = signal.buildPattern ? signal.buildPattern(threadId) : signal.pattern;
    if (!pattern) continue;
    const index = text.indexOf(pattern);
    if (index === -1) continue;
    if (!signal.buildPattern && !hasThreadContext && !hasRetainedTextContext) continue;
    const occurrences = signalOccurrenceDetails(text, pattern);
    signals.push({
      signal: signal.id,
      count: occurrences.count,
      firstTimestamp: occurrences.firstTimestamp,
      lastTimestamp: occurrences.lastTimestamp,
      excerpt: sourceExcerpt(text, index, pattern.length),
    });
  }
  return signals;
}

function signalOccurrenceDetails(text, pattern) {
  const timestamps = [];
  let count = 0;
  let index = text.indexOf(pattern);
  while (index !== -1) {
    count++;
    const timestamp = timestampForLineAt(text, index);
    if (timestamp) timestamps.push(timestamp);
    index = text.indexOf(pattern, index + pattern.length);
  }
  return {
    count,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
  };
}

function timestampForLineAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEndIndex = text.indexOf('\n', index);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  return line.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\b/)?.[0] ?? null;
}

function countOccurrences(text, pattern) {
  if (!pattern) return 0;
  let count = 0;
  let index = text.indexOf(pattern);
  while (index !== -1) {
    count++;
    index = text.indexOf(pattern, index + pattern.length);
  }
  return count;
}

function filePatternHitDetails(path, patterns, { maxSourceSnippets }) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { patterns: [], sourceFacts: [], sourceSnippets: [] };
  }

  const hitIds = [];
  const sourceSnippets = [];
  for (const pattern of patterns) {
    const index = text.indexOf(pattern.pattern);
    if (index === -1) continue;
    hitIds.push(pattern.id);
    if (sourceSnippets.length < maxSourceSnippets) {
      sourceSnippets.push({
        pattern: pattern.id,
        excerpt: sourceExcerpt(text, index, pattern.pattern.length),
      });
    }
  }
  return {
    patterns: hitIds,
    sourceFacts: sourceFactHits(text),
    sourceSnippets,
  };
}

function sourceFactHits(text) {
  return VSCODE_EXTENSION_SOURCE_FACT_PATTERNS
    .filter((fact) => sourceFactMatches(text, fact))
    .map((fact) => fact.id);
}

function sourceFactMatches(text, fact) {
  if (fact.requiredPatterns?.every((pattern) => text.includes(pattern))) return true;
  return fact.nearPatternSets?.some((set) => patternSetAppearsNear(text, set)) ?? false;
}

function patternSetAppearsNear(text, { patterns, windowChars = 240 }) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const [anchor, ...rest] = patterns;
  for (const index of patternIndexes(text, anchor)) {
    const start = Math.max(0, index - windowChars);
    const end = Math.min(text.length, index + anchor.length + windowChars);
    const excerpt = text.slice(start, end);
    if (rest.every((pattern) => excerpt.includes(pattern))) return true;
  }
  return false;
}

function* patternIndexes(text, pattern) {
  if (!pattern) return;
  let index = text.indexOf(pattern);
  while (index !== -1) {
    yield index;
    index = text.indexOf(pattern, index + pattern.length);
  }
}

function sourceExcerpt(text, index, length) {
  const halfWindow = Math.floor(DEFAULT_EXTENSION_SOURCE_SNIPPET_CHARS / 2);
  const start = Math.max(0, index - halfWindow);
  const end = Math.min(text.length, index + length + halfWindow);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${prefix}${excerpt}${suffix}`;
}

function summarizeVsCodeExtensionEvidence(evidence) {
  if (!evidence || Object.values(evidence).every((value) => !value)) {
    return 'no_vscode_extension_restore_patterns_found';
  }
  if (evidence.thread_resume && evidence.mark_need_resume_after_reconnect) {
    return 'vscode_extension_reconnect_appears_to_resume_threads_via_app_server';
  }
  if (evidence.thread_read || evidence.thread_resume || evidence.thread_turns_list) {
    return 'vscode_extension_references_app_server_thread_restore_methods';
  }
  if (evidence.persisted_atom) {
    return 'vscode_extension_webview_persistence_patterns_found';
  }
  return 'vscode_extension_restore_related_patterns_found';
}

function summarizeVsCodeRestorePathSignals(evidence) {
  const appServerRestore = [
    'thread_read',
    'thread_resume',
    'thread_turns_list',
    'thread_compact_start',
    'thread_rollback',
  ].filter((id) => evidence[id]);
  const reconnect = ['mark_need_resume_after_reconnect', 'needs_resume'].filter((id) => evidence[id]);
  const webviewPersistence = ['persisted_atom'].filter((id) => evidence[id]);
  const followUpQueue = [
    'follow_up_queue_setting',
    'send_follow_up_message',
    'steering_user_message',
  ].filter((id) => evidence[id]);

  return {
    appServerRestore,
    reconnect,
    webviewPersistence,
    followUpQueue,
    hasAppServerRestoreSignals: appServerRestore.length > 0,
    hasReconnectSignals: reconnect.length > 0,
    hasWebviewPersistenceSignals: webviewPersistence.length > 0,
    hasFollowUpQueueSignals: followUpQueue.length > 0,
  };
}

function summarizeVsCodeExtensionSourceFacts({ evidence, sourceFactEvidence, packageSettings }) {
  const followUpQueueModeDefaultValues = [
    ...new Set(packageSettings.map((entry) => entry.followUpQueueModeDefault)),
  ];
  const reconnectResumeViaAppServerRolloutPath =
    Boolean(sourceFactEvidence.thread_resume_uses_null_history) &&
    Boolean(sourceFactEvidence.thread_resume_uses_rollout_path) &&
    Boolean(sourceFactEvidence.reconnect_command_marks_threads_need_resume);
  const threadStreamPatchApplyPathPresent =
    Boolean(sourceFactEvidence.owner_broadcasts_thread_state_patches) &&
    Boolean(sourceFactEvidence.follower_applies_thread_state_patches) &&
    Boolean(sourceFactEvidence.patch_apply_failure_logged_in_thread_stream_handler);
  const rollbackNonResurrectionProjectionCandidates =
    VSCODE_ROLLBACK_NON_RESURRECTION_SOURCE_FACT_IDS.filter((id) =>
      Boolean(sourceFactEvidence[id]),
    );

  return {
    patterns: VSCODE_EXTENSION_SOURCE_FACT_PATTERNS,
    evidence: sourceFactEvidence,
    followUpQueueModeDefaultValues,
    reconnectResumeViaAppServerRolloutPath,
    threadStreamPatchApplyPathPresent,
    rollbackNonResurrectionProjectionPathPresent:
      rollbackNonResurrectionProjectionCandidates.length > 0,
    rollbackNonResurrectionProjectionCandidates,
    compactedReplacementHistoryPatternPresent: Boolean(evidence.compacted_replacement_history),
    hypothesis: reconnectResumeViaAppServerRolloutPath
      ? 'reconnect_marks_threads_needing_app_server_resume_from_rollout_path'
      : 'source_facts_insufficient_for_reconnect_resume_path_hypothesis',
  };
}

function summarizeAudit({
  sessionIndex,
  stateDatabases,
  vscodeStorage,
  vscodeExtension,
  vscodeSettings,
  vscodeLogs,
}) {
  return {
    sessionIndexContainsThreadId: sessionIndex.containsThreadId,
    codexStateThreadMatches: stateDatabases.threadMatches ?? 0,
    codexStateConclusion: stateDatabases.conclusion ?? 'not_inspected',
    vscodeStorageMatches: vscodeStorage.matches.length,
    vscodeStorageSearched: vscodeStorage.status === 'searched',
    vscodeStorageSqliteDatabases: vscodeStorage.sqliteDatabases?.length ?? 0,
    vscodeStorageSqliteDatabaseMatches: vscodeStorage.sqliteDatabaseMatches ?? 0,
    vscodeExtensionSearched: vscodeExtension.status === 'searched',
    vscodeExtensionMatches: vscodeExtension.matches.length,
    vscodeExtensionConclusion: vscodeExtension.conclusion,
    vscodeExtensionRestorePathSignals: vscodeExtension.restorePathSignals,
    vscodeExtensionSourceFacts: vscodeExtension.sourceFacts,
    vscodeExtensionFollowUpQueueModeDefault:
      vscodeExtension.packageSettings.followUpQueueModeDefault,
    vscodeExtensionSourceSnippetCount: vscodeExtension.sourceSnippetCount,
    vscodeSettingsSearched: vscodeSettings.status === 'searched',
    vscodeSettingsFollowUpQueueMode: vscodeSettings.followUpQueueMode,
    vscodeLogSearched: vscodeLogs.status === 'searched',
    vscodeLogMatches: vscodeLogs.matches.length,
    vscodeLogThreadIdMatches: vscodeLogs.signals?.threadIdMatches ?? 0,
    vscodeLogRetainedTextMatches: vscodeLogs.signals?.retainedTextMatches ?? 0,
    vscodeLogPatchApplyFailures: vscodeLogs.signals?.patchApplyFailures ?? 0,
    vscodeLogPatchApplyFailureFirstTimestamp: firstSignalTimestamp(
      vscodeLogs.signalMatches,
      'patch_apply_failure',
    ),
    vscodeLogPatchApplyFailureLastTimestamp: lastSignalTimestamp(
      vscodeLogs.signalMatches,
      'patch_apply_failure',
    ),
    vscodeLogThreadStreamStateSignals: vscodeLogs.signals?.threadStreamStateSignals ?? 0,
    vscodeLogReplacementHistorySignals: vscodeLogs.signals?.replacementHistorySignals ?? 0,
    vscodeThreadStreamPatchApplyPathPresent:
      vscodeExtension.sourceFacts?.threadStreamPatchApplyPathPresent ?? false,
    vscodeThreadStreamPatchFailureSignal:
      Boolean(vscodeExtension.sourceFacts?.threadStreamPatchApplyPathPresent) &&
      (vscodeLogs.signals?.patchApplyFailures ?? 0) > 0,
    vscodeRollbackNonResurrectionProjectionPathPresent:
      vscodeExtension.sourceFacts?.rollbackNonResurrectionProjectionPathPresent ?? false,
    vscodeRollbackNonResurrectionProjectionCandidates:
      vscodeExtension.sourceFacts?.rollbackNonResurrectionProjectionCandidates ?? [],
  };
}

function firstSignalTimestamp(signalMatches, signal) {
  const timestamps = (signalMatches ?? [])
    .filter((match) => match.signal === signal && match.firstTimestamp)
    .map((match) => match.firstTimestamp)
    .sort();
  return timestamps[0] ?? null;
}

function lastSignalTimestamp(signalMatches, signal) {
  const timestamps = (signalMatches ?? [])
    .filter((match) => match.signal === signal && match.lastTimestamp)
    .map((match) => match.lastTimestamp)
    .sort();
  return timestamps[timestamps.length - 1] ?? null;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
