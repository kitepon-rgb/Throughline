import { runCodexRestoreSourceAudit } from '../codex-restore-source-audit.mjs';
import { defaultCodexHome } from '../codex-thread-index.mjs';
import { resolveCodexThreadIdentity } from '../codex-thread-identity.mjs';

function parseArgs(args) {
  const out = {
    codexThreadId: null,
    codexHome: defaultCodexHome(),
    json: false,
    vscodeStorageRoots: null,
    vscodeExtensionRoots: null,
    vscodeSettingsRoots: null,
    vscodeLogRoots: null,
    maxStorageFiles: 5000,
    maxStorageFileBytes: 2 * 1024 * 1024,
    maxStorageMatches: 50,
    maxExtensionFiles: 5000,
    maxExtensionFileBytes: 2 * 1024 * 1024,
    maxExtensionMatches: 100,
    maxExtensionSourceSnippets: 40,
    maxSettingsFiles: 100,
    maxSettingsFileBytes: 256 * 1024,
    maxSettingsMatches: 20,
    maxLogFiles: 2000,
    maxLogFileBytes: 2 * 1024 * 1024,
    maxLogMatches: 50,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--codex-thread-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-thread-id requires a thread id');
      out.codexThreadId = value;
    } else if (arg === '--codex-home') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-home requires a path');
      out.codexHome = value;
    } else if (arg === '--vscode-storage-root') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--vscode-storage-root requires a path');
      out.vscodeStorageRoots = [...(out.vscodeStorageRoots ?? []), value];
    } else if (arg === '--vscode-extension-root') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--vscode-extension-root requires a path');
      out.vscodeExtensionRoots = [...(out.vscodeExtensionRoots ?? []), value];
    } else if (arg === '--vscode-settings-root') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--vscode-settings-root requires a path');
      out.vscodeSettingsRoots = [...(out.vscodeSettingsRoots ?? []), value];
    } else if (arg === '--vscode-log-root') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--vscode-log-root requires a path');
      out.vscodeLogRoots = [...(out.vscodeLogRoots ?? []), value];
    } else if (arg === '--max-storage-files') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-storage-files must be a non-negative integer');
      }
      out.maxStorageFiles = value;
    } else if (arg === '--max-storage-file-bytes') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--max-storage-file-bytes must be a positive integer');
      }
      out.maxStorageFileBytes = value;
    } else if (arg === '--max-storage-matches') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-storage-matches must be a non-negative integer');
      }
      out.maxStorageMatches = value;
    } else if (arg === '--max-extension-files') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-extension-files must be a non-negative integer');
      }
      out.maxExtensionFiles = value;
    } else if (arg === '--max-extension-file-bytes') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--max-extension-file-bytes must be a positive integer');
      }
      out.maxExtensionFileBytes = value;
    } else if (arg === '--max-extension-matches') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-extension-matches must be a non-negative integer');
      }
      out.maxExtensionMatches = value;
    } else if (arg === '--max-extension-source-snippets') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-extension-source-snippets must be a non-negative integer');
      }
      out.maxExtensionSourceSnippets = value;
    } else if (arg === '--max-settings-files') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-settings-files must be a non-negative integer');
      }
      out.maxSettingsFiles = value;
    } else if (arg === '--max-settings-file-bytes') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--max-settings-file-bytes must be a positive integer');
      }
      out.maxSettingsFileBytes = value;
    } else if (arg === '--max-settings-matches') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-settings-matches must be a non-negative integer');
      }
      out.maxSettingsMatches = value;
    } else if (arg === '--max-log-files') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-log-files must be a non-negative integer');
      }
      out.maxLogFiles = value;
    } else if (arg === '--max-log-file-bytes') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--max-log-file-bytes must be a positive integer');
      }
      out.maxLogFileBytes = value;
    } else if (arg === '--max-log-matches') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-log-matches must be a non-negative integer');
      }
      out.maxLogMatches = value;
    } else if (arg === '--json') {
      out.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex restore source audit');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  thread:       ${result.threadId ?? 'unknown'}`);
  lines.push(`  proof scope:  ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe: ${result.restartSafe ? 'yes' : 'no'}`);
  if (result.rollout) {
    lines.push(`  rollout:      ${result.rollout.path}`);
    lines.push(`  restore safety: ${result.rollout.restoreSafety?.status ?? 'unknown'}`);
  }
  if (result.summary) {
    lines.push(`  session index has thread: ${result.summary.sessionIndexContainsThreadId ? 'yes' : 'no'}`);
    lines.push(`  Codex state thread rows:  ${result.summary.codexStateThreadMatches}`);
    lines.push(`  Codex state conclusion:   ${result.summary.codexStateConclusion}`);
    lines.push(`  VS Code storage searched: ${result.summary.vscodeStorageSearched ? 'yes' : 'no'}`);
    lines.push(`  VS Code storage matches:  ${result.summary.vscodeStorageMatches}`);
    lines.push(`  VS Code storage sqlite DBs: ${result.summary.vscodeStorageSqliteDatabases ?? 0}`);
    lines.push(
      `  VS Code storage sqlite matches: ${result.summary.vscodeStorageSqliteDatabaseMatches ?? 0}`,
    );
    lines.push(`  VS Code extension searched: ${result.summary.vscodeExtensionSearched ? 'yes' : 'no'}`);
    lines.push(`  VS Code extension matches:  ${result.summary.vscodeExtensionMatches}`);
    lines.push(`  VS Code extension source snippets: ${result.summary.vscodeExtensionSourceSnippetCount}`);
    lines.push(`  VS Code extension conclusion: ${result.summary.vscodeExtensionConclusion}`);
    lines.push(
      `  VS Code reconnect resume via rollout path: ${
        result.summary.vscodeExtensionSourceFacts?.reconnectResumeViaAppServerRolloutPath ? 'yes' : 'no'
      }`,
    );
    lines.push(`  VS Code settings searched: ${result.summary.vscodeSettingsSearched ? 'yes' : 'no'}`);
    lines.push(
      `  VS Code follow-up queue default: ${
        result.summary.vscodeExtensionFollowUpQueueModeDefault?.values?.join(', ') || 'unknown'
      }`,
    );
    lines.push(
      `  VS Code follow-up queue setting: ${
        result.summary.vscodeSettingsFollowUpQueueMode?.status ?? 'unknown'
      }`,
    );
    lines.push(`  VS Code logs searched:     ${result.summary.vscodeLogSearched ? 'yes' : 'no'}`);
    lines.push(`  VS Code log matches:       ${result.summary.vscodeLogMatches}`);
    lines.push(`  VS Code log thread id matches: ${result.summary.vscodeLogThreadIdMatches ?? 0}`);
    lines.push(`  VS Code log retained text matches: ${result.summary.vscodeLogRetainedTextMatches ?? 0}`);
    lines.push(`  VS Code log patch apply failures: ${result.summary.vscodeLogPatchApplyFailures ?? 0}`);
    if (
      result.summary.vscodeLogPatchApplyFailureFirstTimestamp ||
      result.summary.vscodeLogPatchApplyFailureLastTimestamp
    ) {
      lines.push(
        `  VS Code log patch apply failure window: ${
          result.summary.vscodeLogPatchApplyFailureFirstTimestamp ?? 'unknown'
        } -> ${result.summary.vscodeLogPatchApplyFailureLastTimestamp ?? 'unknown'}`,
      );
    }
    lines.push(
      `  VS Code log thread stream signals: ${
        result.summary.vscodeLogThreadStreamStateSignals ?? 0
      }`,
    );
    lines.push(
      `  VS Code thread stream patch path: ${
        result.summary.vscodeThreadStreamPatchApplyPathPresent ? 'yes' : 'no'
      }`,
    );
    lines.push(
      `  VS Code thread stream patch failure signal: ${
        result.summary.vscodeThreadStreamPatchFailureSignal ? 'yes' : 'no'
      }`,
    );
    lines.push(
      `  VS Code rollback projection candidate: ${
        result.summary.vscodeRollbackNonResurrectionProjectionPathPresent ? 'yes' : 'no'
      }`,
    );
    const projectionCandidates = result.summary.vscodeRollbackNonResurrectionProjectionCandidates ?? [];
    if (projectionCandidates.length > 0) {
      lines.push(`  VS Code rollback projection candidates: ${projectionCandidates.join(', ')}`);
    }
    const signals = result.summary.vscodeExtensionRestorePathSignals;
    if (signals) {
      lines.push(
        `  VS Code extension app-server restore signals: ${
          signals.hasAppServerRestoreSignals ? 'yes' : 'no'
        }`,
      );
      lines.push(
        `  VS Code extension webview persistence signals: ${
          signals.hasWebviewPersistenceSignals ? 'yes' : 'no'
        }`,
      );
      lines.push(
        `  VS Code extension follow-up queue signals: ${
          signals.hasFollowUpQueueSignals ? 'yes' : 'no'
        }`,
      );
    }
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-restore-source-audit] ${msg}\n`);
    process.exit(1);
  }

  parsed = {
    ...parsed,
    ...resolveCodexThreadIdentity({ host: 'codex', codexThreadId: parsed.codexThreadId }, process.env),
  };

  if (!parsed.codexThreadId) {
    const result = {
      status: 'refused',
      reason: 'codex_thread_id_required',
      proofScope: 'none',
      restartSafe: false,
    };
    if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`[codex-restore-source-audit] ${result.reason}\n`);
    process.exit(1);
  }

  const result = runCodexRestoreSourceAudit({
    threadId: parsed.codexThreadId,
    codexHome: parsed.codexHome,
    projectPath: process.cwd(),
    vscodeStorageRoots: parsed.vscodeStorageRoots ?? undefined,
    vscodeExtensionRoots: parsed.vscodeExtensionRoots ?? undefined,
    maxStorageFiles: parsed.maxStorageFiles,
    maxStorageFileBytes: parsed.maxStorageFileBytes,
    maxStorageMatches: parsed.maxStorageMatches,
    maxExtensionFiles: parsed.maxExtensionFiles,
    maxExtensionFileBytes: parsed.maxExtensionFileBytes,
    maxExtensionMatches: parsed.maxExtensionMatches,
    maxExtensionSourceSnippets: parsed.maxExtensionSourceSnippets,
    vscodeSettingsRoots: parsed.vscodeSettingsRoots ?? undefined,
    vscodeLogRoots: parsed.vscodeLogRoots ?? undefined,
    maxSettingsFiles: parsed.maxSettingsFiles,
    maxSettingsFileBytes: parsed.maxSettingsFileBytes,
    maxSettingsMatches: parsed.maxSettingsMatches,
    maxLogFiles: parsed.maxLogFiles,
    maxLogFileBytes: parsed.maxLogFileBytes,
    maxLogMatches: parsed.maxLogMatches,
  });

  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(result.status === 'restore-source-audit-complete' ? 0 : 1);
}

export const _internal = {
  parseArgs,
};
