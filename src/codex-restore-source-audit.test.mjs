import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { runCodexRestoreSourceAudit } from './codex-restore-source-audit.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeCodexRollout(codexHome, { project, threadId, turnCount = 2 }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '07');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-07T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-07T00:00:00.000Z',
        cwd: project,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    },
  ];

  for (let turn = 1; turn <= turnCount; turn++) {
    rows.push({
      timestamp: `2026-05-07T00:00:0${turn}.000Z`,
      type: 'event_msg',
      payload: { type: 'user_message', message: `restore audit user ${turn}` },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${turn}.100Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${turn}.200Z`,
      type: 'event_msg',
      payload: { type: 'agent_message', message: `restore audit assistant ${turn}` },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${turn}.300Z`,
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
  }

  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function writeSessionIndex(codexHome, threadId) {
  writeFileSync(
    join(codexHome, 'session_index.jsonl'),
    JSON.stringify({
      id: threadId,
      thread_name: 'restore source audit thread',
      updated_at: '2026-05-07T00:00:10Z',
    }) + '\n',
  );
}

function writeStateDatabase(codexHome, { threadId, rolloutPath, project }) {
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec(`
    create table threads (
      id text primary key,
      rollout_path text,
      source text,
      cwd text,
      title text,
      updated_at text
    );
  `);
  db.prepare(
    'insert into threads (id, rollout_path, source, cwd, title, updated_at) values (?, ?, ?, ?, ?, ?)',
  ).run(threadId, rolloutPath, 'vscode', project, 'restore source audit thread', '2026-05-07T00:00:10Z');
  db.close();
}

test('runCodexRestoreSourceAudit inventories rollout, session index, state DB, and VS Code storage', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const storage = makeTempDir('tl-audit-storage-');
  const extensionRoot = makeTempDir('tl-audit-extension-');
  const settingsRoot = makeTempDir('tl-audit-settings-');
  const logRoot = makeTempDir('tl-audit-logs-');
  const threadId = '019dfdef-0000-7000-8000-000000000101';
  try {
    const rolloutPath = writeCodexRollout(codexHome, { project, threadId });
    writeSessionIndex(codexHome, threadId);
    writeStateDatabase(codexHome, { threadId, rolloutPath, project });
    writeFileSync(join(storage, 'state.vscdb'), `cached thread ${threadId}`);
    writeFileSync(
      join(extensionRoot, 'extension.js'),
      [
        'client.request("thread/read")',
        'client.request("thread/resume", { threadId, history:null, path: state.rolloutPath ?? null })',
        'commands.registerCommand("mark-all-conversations-need-resume-after-reconnect-for-host", () => markAllConversationsNeedResumeAfterReconnect())',
        'markAllConversationsNeedResumeAfterReconnect()',
        'window.localStorage.setItem("codex:persisted-atom:x", "1")',
        '"chatgpt.followUpQueueMode"',
        '"send-follow-up-message"',
        '{ type:"steeringUserMessage", restoreMessage: "previous user text" }',
        'const projected = replacement_history.filter((item) => !item.tombstone)',
        'function broadcastIpcStatePatches(){ dispatchMessageFromView("thread-stream-state-changed",{change:{type:"patches",patches:t}}) }',
        'function handleThreadStreamStateChanged(){ try { sn(n,t.patches) } catch (e) { warning("Failed to apply patches for") } }',
      ].join('\n'),
    );
    writeFileSync(
      join(extensionRoot, 'package.json'),
      JSON.stringify({
        contributes: {
          configuration: {
            properties: {
              'chatgpt.followUpQueueMode': { default: 'queue' },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(settingsRoot, 'settings.json'),
      JSON.stringify({ 'chatgpt.followUpQueueMode': 'queue' }),
    );
    writeFileSync(join(logRoot, 'extension.log'), `restored thread ${threadId}`);

    const result = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [storage],
      vscodeExtensionRoots: [extensionRoot],
      vscodeSettingsRoots: [settingsRoot],
      vscodeLogRoots: [logRoot],
    });

    assert.equal(result.status, 'restore-source-audit-complete');
    assert.equal(result.restartSafe, false);
    assert.equal(result.proofScope, 'local_restore_source_inventory_only');
    assert.equal(result.rollout.capturedTurns, 2);
    assert.equal(result.sessionIndex.containsThreadId, true);
    assert.equal(result.stateDatabases.threadMatches, 1);
    assert.equal(result.stateDatabases.conclusion, 'state_database_appears_metadata_only');
    assert.equal(result.vscodeStorage.matches.length, 1);
    assert.deepEqual(result.vscodeStorage.matches[0].needles, ['thread_id']);
    assert.equal(result.vscodeExtension.status, 'searched');
    assert.equal(result.vscodeExtension.evidence.thread_read, true);
    assert.equal(result.vscodeExtension.evidence.thread_resume, true);
    assert.equal(result.vscodeExtension.evidence.mark_need_resume_after_reconnect, true);
    assert.equal(result.vscodeExtension.evidence.persisted_atom, true);
    assert.equal(result.vscodeExtension.evidence.follow_up_queue_setting, true);
    assert.equal(result.vscodeExtension.evidence.send_follow_up_message, true);
    assert.equal(result.vscodeExtension.evidence.steering_user_message, true);
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.thread_resume_uses_null_history,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.thread_resume_uses_rollout_path,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.reconnect_command_marks_threads_need_resume,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.steering_user_message_has_restore_message,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.owner_broadcasts_thread_state_patches,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.follower_applies_thread_state_patches,
      true,
    );
    assert.equal(
      result.vscodeExtension.sourceFacts.evidence.patch_apply_failure_logged_in_thread_stream_handler,
      true,
    );
    assert.equal(result.vscodeExtension.sourceFacts.reconnectResumeViaAppServerRolloutPath, true);
    assert.equal(result.vscodeExtension.sourceFacts.threadStreamPatchApplyPathPresent, true);
    assert.equal(
      result.vscodeExtension.sourceFacts.rollbackNonResurrectionProjectionPathPresent,
      true,
    );
    assert.deepEqual(result.vscodeExtension.sourceFacts.rollbackNonResurrectionProjectionCandidates, [
      'replacement_history_filter_candidate',
      'replacement_history_tombstone_candidate',
    ]);
    assert.equal(
      result.vscodeExtension.sourceFacts.hypothesis,
      'reconnect_marks_threads_needing_app_server_resume_from_rollout_path',
    );
    const extensionMatch = result.vscodeExtension.matches.find((match) =>
      match.patterns.includes('thread_read'),
    );
    assert.ok(extensionMatch);
    assert.ok(extensionMatch.sourceSnippets.length > 0);
    assert.ok(extensionMatch.sourceSnippets.some((snippet) => snippet.pattern === 'thread_read'));
    assert.match(
      extensionMatch.sourceSnippets.find((snippet) => snippet.pattern === 'thread_read')?.excerpt ?? '',
      /thread\/read/,
    );
    assert.equal(result.vscodeExtension.restorePathSignals.hasWebviewPersistenceSignals, true);
    assert.equal(result.vscodeExtension.restorePathSignals.hasFollowUpQueueSignals, true);
    assert.equal(result.vscodeExtension.packageSettings.followUpQueueModeDefault.status, 'present');
    assert.deepEqual(result.vscodeExtension.packageSettings.followUpQueueModeDefault.values, ['queue']);
    assert.equal(result.vscodeSettings.followUpQueueMode.status, 'explicit');
    assert.deepEqual(result.vscodeSettings.followUpQueueMode.values, ['queue']);
    assert.equal(result.vscodeSettings.matches.length, 1);
    assert.equal(result.vscodeLogs.matches.length, 1);
    assert.deepEqual(result.vscodeLogs.matches[0].needles, ['thread_id']);
    assert.equal(
      result.vscodeExtension.conclusion,
      'vscode_extension_reconnect_appears_to_resume_threads_via_app_server',
    );
    assert.equal(result.summary.vscodeExtensionMatches, 2);
    assert.equal(result.summary.vscodeExtensionSourceFacts.reconnectResumeViaAppServerRolloutPath, true);
    assert.equal(result.summary.vscodeThreadStreamPatchApplyPathPresent, true);
    assert.equal(result.summary.vscodeThreadStreamPatchFailureSignal, false);
    assert.equal(result.summary.vscodeRollbackNonResurrectionProjectionPathPresent, true);
    assert.deepEqual(result.summary.vscodeRollbackNonResurrectionProjectionCandidates, [
      'replacement_history_filter_candidate',
      'replacement_history_tombstone_candidate',
    ]);
    assert.ok(result.summary.vscodeExtensionSourceSnippetCount > 0);
    assert.deepEqual(result.summary.vscodeExtensionFollowUpQueueModeDefault.values, ['queue']);
    assert.equal(result.summary.vscodeSettingsSearched, true);
    assert.equal(result.summary.vscodeSettingsFollowUpQueueMode.status, 'explicit');
    assert.equal(result.summary.vscodeLogSearched, true);
    assert.equal(result.summary.vscodeLogMatches, 1);
    assert.equal(result.summary.vscodeLogThreadIdMatches, 1);
    assert.equal(result.summary.vscodeLogRetainedTextMatches, 0);
    assert.equal(result.summary.vscodeLogPatchApplyFailures, 0);
    assert.equal(result.summary.vscodeLogPatchApplyFailureFirstTimestamp, null);
    assert.equal(result.summary.vscodeLogPatchApplyFailureLastTimestamp, null);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
    rmSync(extensionRoot, { recursive: true, force: true });
    rmSync(settingsRoot, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit classifies VS Code log restore signals', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const logRoot = makeTempDir('tl-audit-logs-');
  const threadId = '019dfdef-0000-7000-8000-000000000108';
  const retainedText = 'long retained rollback text visible in vscode log audit';
  try {
    writeRiskyRollbackRollout(codexHome, {
      project,
      threadId,
      userMessages: [retainedText],
    });
    writeFileSync(
      join(logRoot, 'Codex.log'),
      [
        `2026-05-07 00:35:35.339 [warning] Failed to apply patches for conversationId=${threadId} error={}`,
        '2026-05-07 00:35:36.168 [warning] Received broadcast but no handler is configured method=thread-stream-state-changed',
        `2026-05-07 00:35:37.000 [info] diagnostic retained text: ${retainedText}`,
        '2026-05-07 00:35:38.000 [info] replacement_history appeared in a diagnostic log line',
        `2026-05-07 00:35:39.101 [warning] Failed to apply patches for conversationId=${threadId} error={}`,
      ].join('\n'),
    );

    const result = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [],
      vscodeExtensionRoots: [],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [logRoot],
    });

    assert.equal(result.vscodeLogs.matches.length, 1);
    assert.deepEqual(
      [...new Set(result.vscodeLogs.matches[0].needles)].sort(),
      ['retained_rollback_text_1', 'thread_id'],
    );
    assert.equal(result.vscodeLogs.signals.threadIdMatches, 2);
    assert.equal(result.vscodeLogs.signals.retainedTextMatches, 1);
    assert.equal(result.vscodeLogs.signals.patchApplyFailures, 2);
    assert.equal(result.vscodeLogs.signals.threadStreamStateSignals, 1);
    assert.equal(result.vscodeLogs.signals.replacementHistorySignals, 1);
    const patchFailure = result.vscodeLogs.signalMatches.find(
      (match) => match.signal === 'patch_apply_failure',
    );
    assert.equal(patchFailure?.firstTimestamp, '2026-05-07 00:35:35.339');
    assert.equal(patchFailure?.lastTimestamp, '2026-05-07 00:35:39.101');
    assert.deepEqual(
      [...new Set(result.vscodeLogs.signalMatches.map((match) => match.signal))].sort(),
      ['patch_apply_failure', 'replacement_history', 'thread_stream_state_broadcast'],
    );
    assert.equal(result.summary.vscodeLogThreadIdMatches, 2);
    assert.equal(result.summary.vscodeLogRetainedTextMatches, 1);
    assert.equal(result.summary.vscodeLogPatchApplyFailures, 2);
    assert.equal(
      result.summary.vscodeLogPatchApplyFailureFirstTimestamp,
      '2026-05-07 00:35:35.339',
    );
    assert.equal(
      result.summary.vscodeLogPatchApplyFailureLastTimestamp,
      '2026-05-07 00:35:39.101',
    );
    assert.equal(result.summary.vscodeLogThreadStreamStateSignals, 1);
    assert.equal(result.summary.vscodeLogReplacementHistorySignals, 1);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit treats resume history alone as static evidence, not proof', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const extensionRoot = makeTempDir('tl-audit-extension-');
  const threadId = '019dfdef-0000-7000-8000-000000000105';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 1 });
    writeFileSync(join(extensionRoot, 'extension.js'), 'client.request("thread/resume")');

    const result = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [],
      vscodeExtensionRoots: [extensionRoot],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
    });

    assert.equal(result.restartSafe, false);
    assert.equal(result.vscodeExtension.evidence.thread_resume, true);
    assert.equal(
      result.vscodeExtension.sourceFacts.rollbackNonResurrectionProjectionPathPresent,
      false,
    );
    assert.equal(
      result.vscodeExtension.conclusion,
      'vscode_extension_references_app_server_thread_restore_methods',
    );
    assert.equal(result.proofScope, 'local_restore_source_inventory_only');
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit can suppress VS Code extension source snippets', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const extensionRoot = makeTempDir('tl-audit-extension-');
  const threadId = '019dfdef-0000-7000-8000-000000000106';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 1 });
    writeFileSync(join(extensionRoot, 'extension.js'), 'client.request("thread/resume")');

    const result = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [],
      vscodeExtensionRoots: [extensionRoot],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
      maxExtensionSourceSnippets: 0,
    });

    assert.equal(result.vscodeExtension.evidence.thread_resume, true);
    assert.equal(result.vscodeExtension.matches.length, 1);
    assert.deepEqual(result.vscodeExtension.matches[0].sourceSnippets, []);
    assert.equal(result.summary.vscodeExtensionSourceSnippetCount, 0);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit ignores short retained rollback text needles in VS Code storage search', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const storage = makeTempDir('tl-audit-storage-');
  const threadId = '019dfdef-0000-7000-8000-000000000104';
  const longText = 'long retained rollback text that should be searched uniquely';
  try {
    writeRiskyRollbackRollout(codexHome, {
      project,
      threadId,
      userMessages: ['go', longText],
    });
    writeFileSync(join(storage, 'short-only.txt'), 'go appears in many unrelated files');

    const shortOnly = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [storage],
      vscodeExtensionRoots: [],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
    });

    assert.equal(shortOnly.rollout.restoreSafety.status, 'risk');
    assert.equal(shortOnly.rollout.restoreSafety.rollbackTextRetainedInCompacted, 2);
    assert.equal(shortOnly.vscodeStorage.matches.length, 0);

    writeFileSync(join(storage, 'long.txt'), longText);
    const withLong = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [storage],
      vscodeExtensionRoots: [],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
    });

    assert.equal(withLong.vscodeStorage.matches.length, 1);
    assert.deepEqual(withLong.vscodeStorage.matches[0].needles, ['retained_rollback_text_1']);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit inventories SQLite-backed VS Code storage matches', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const storage = makeTempDir('tl-audit-storage-');
  const threadId = '019dfdef-0000-7000-8000-000000000107';
  const retainedText = 'long retained rollback text stored inside sqlite value';
  try {
    writeRiskyRollbackRollout(codexHome, {
      project,
      threadId,
      userMessages: [retainedText],
    });
    const db = new DatabaseSync(join(storage, 'state.vscdb'));
    db.exec('create table ItemTable (key text primary key, value text)');
    db.prepare('insert into ItemTable (key, value) values (?, ?)').run(
      `codex:persisted-atom:${threadId}`,
      JSON.stringify({ threadId, retainedText }),
    );
    db.close();

    const result = runCodexRestoreSourceAudit({
      threadId,
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [storage],
      vscodeExtensionRoots: [],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
    });

    assert.equal(result.vscodeStorage.sqliteDatabases.length, 1);
    assert.equal(result.vscodeStorage.sqliteDatabases[0].status, 'ok');
    assert.deepEqual(
      result.vscodeStorage.sqliteDatabases[0].tables.map((table) => table.name),
      ['ItemTable'],
    );
    assert.deepEqual(
      [...new Set(result.vscodeStorage.sqliteDatabases[0].matches.map((match) => match.needle))].sort(),
      ['retained_rollback_text_1', 'thread_id'],
    );
    assert.equal(result.summary.vscodeStorageSqliteDatabases, 1);
    assert.equal(result.summary.vscodeStorageSqliteDatabaseMatches, 3);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});

test('runCodexRestoreSourceAudit refuses when the rollout source is missing', () => {
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  try {
    const result = runCodexRestoreSourceAudit({
      threadId: '019dfdef-0000-7000-8000-000000000102',
      codexHome,
      projectPath: project,
      vscodeStorageRoots: [],
      vscodeExtensionRoots: [],
      vscodeSettingsRoots: [],
      vscodeLogRoots: [],
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'codex_rollout_source_required');
    assert.equal(result.restartSafe, false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function writeRiskyRollbackRollout(codexHome, { project, threadId, userMessages }) {
  const dir = join(codexHome, 'sessions', '2026', '05', '07');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-05-07T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: '2026-05-07T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        timestamp: '2026-05-07T00:00:00.000Z',
        cwd: project,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    },
  ];
  for (const [index, message] of userMessages.entries()) {
    rows.push({
      timestamp: `2026-05-07T00:00:0${index + 1}.000Z`,
      type: 'event_msg',
      payload: { type: 'user_message', message },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${index + 1}.100Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${index + 1}.200Z`,
      type: 'event_msg',
      payload: { type: 'agent_message', message: `answer ${index + 1}` },
    });
    rows.push({
      timestamp: `2026-05-07T00:00:0${index + 1}.300Z`,
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
  }
  rows.push({
    timestamp: '2026-05-07T00:00:10.000Z',
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: userMessages.map((text) => ({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      })),
    },
  });
  rows.push({
    timestamp: '2026-05-07T00:00:11.000Z',
    type: 'event_msg',
    payload: { type: 'thread_rolled_back', num_turns: userMessages.length },
  });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

test('codex-restore-source-audit CLI accepts env thread id and prints JSON', () => {
  const home = makeTempDir('tl-audit-home-');
  const codexHome = makeTempDir('tl-audit-codex-');
  const project = makeTempDir('tl-audit-project-');
  const extensionRoot = makeTempDir('tl-audit-empty-extension-');
  const threadId = '019dfdef-0000-7000-8000-000000000103';
  try {
    writeCodexRollout(codexHome, { project, threadId, turnCount: 1 });
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'bin/throughline.mjs'),
        'codex-restore-source-audit',
        '--codex-home',
        codexHome,
        '--vscode-extension-root',
        extensionRoot,
        '--json',
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_THREAD_ID: threadId,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'restore-source-audit-complete');
    assert.equal(payload.threadId, threadId);
    assert.equal(payload.rollout.capturedTurns, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(extensionRoot, { recursive: true, force: true });
  }
});
