import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENERATED_SCHEMA_MAX_BUFFER = 10 * 1024 * 1024;

export function runCodexHostPrimitiveAudit({
  command = 'codex',
  schemaDir = null,
  keepGeneratedSchema = false,
} = {}) {
  assertNonEmptyString(command, 'command');
  if (schemaDir !== null) assertNonEmptyString(schemaDir, 'schemaDir');

  const generatedDir = schemaDir ? null : mkdtempSync(join(tmpdir(), 'tl-codex-host-primitives-'));
  const root = schemaDir ?? generatedDir;
  let schemaSource = schemaDir ? 'provided-schema-dir' : 'generated-from-codex-cli';
  let generation = null;

  try {
    if (!schemaDir) {
      const outDir = join(root, 'schema');
      generation = generateSchema({ command, outDir });
      if (generation.status !== 'ok') {
        return {
          status: 'refused',
          reason: 'codex_app_server_schema_generation_failed',
          restartSafePrimitive: false,
          command,
          generation,
        };
      }
      schemaSource = 'generated-from-codex-cli';
      return classifyCodexHostPrimitiveSchema({
        schemaDir: outDir,
        schemaSource,
        command,
        generation,
        schemaRetained: Boolean(keepGeneratedSchema),
      });
    }

    return classifyCodexHostPrimitiveSchema({
      schemaDir: root,
      schemaSource,
      command,
      generation,
      schemaRetained: true,
    });
  } finally {
    if (generatedDir && !keepGeneratedSchema) {
      rmSync(generatedDir, { recursive: true, force: true });
    }
  }
}

export function classifyCodexHostPrimitiveSchema({
  schemaDir,
  schemaSource = 'schema-dir',
  command = 'codex',
  generation = null,
  schemaRetained = true,
} = {}) {
  assertNonEmptyString(schemaDir, 'schemaDir');
  const clientRequestPath = join(schemaDir, 'ClientRequest.json');
  const threadResumeParamsPath = join(schemaDir, 'v2', 'ThreadResumeParams.json');
  if (!existsSync(clientRequestPath)) {
    return {
      status: 'refused',
      reason: 'client_request_schema_missing',
      restartSafePrimitive: false,
      schemaDir,
      expectedPath: clientRequestPath,
    };
  }

  const clientRequestSchema = readJson(clientRequestPath);
  const methods = [...extractJsonRpcMethods(clientRequestSchema)].sort();
  const methodSet = new Set(methods);
  const resumeSchema = existsSync(threadResumeParamsPath) ? readJson(threadResumeParamsPath) : null;
  const resumeHistory = classifyResumeHistoryPrimitive(resumeSchema);
  const inPlaceHistoryRewriteMethods = methods.filter(isInPlaceHistoryRewriteMethod);
  const inPlaceCompactedHistoryClearMethods = methods.filter(isCompactedHistoryClearMethod);
  const inPlaceRestoreIsolationMethods = methods.filter(isRestoreIsolationOrProjectionMethod);
  const hasCurrentThreadRemediationPrimitive =
    inPlaceHistoryRewriteMethods.length > 0 ||
    inPlaceCompactedHistoryClearMethods.length > 0 ||
    inPlaceRestoreIsolationMethods.length > 0;

  const facts = {
    threadRollback: methodSet.has('thread/rollback'),
    threadInjectItems: methodSet.has('thread/inject_items'),
    threadCompactStart: methodSet.has('thread/compact/start'),
    threadRead: methodSet.has('thread/read'),
    threadTurnsList: methodSet.has('thread/turns/list'),
    threadStart: methodSet.has('thread/start'),
    threadFork: methodSet.has('thread/fork'),
    threadArchive: methodSet.has('thread/archive'),
    threadResume: methodSet.has('thread/resume'),
    threadResumeHistory: resumeHistory,
    inPlaceHistoryRewriteMethods,
    inPlaceCompactedHistoryClearMethods,
    inPlaceRestoreIsolationMethods,
    hasCurrentThreadRemediationPrimitive,
    hasCurrentThreadNonResurrectionPrimitive: hasCurrentThreadRemediationPrimitive,
  };

  const decisions = buildDecisions(facts);
  const repairContract = buildHostAgnosticRepairContract(facts);
  const status =
    hasCurrentThreadRemediationPrimitive || resumeHistory.supportedForThroughline
      ? 'host-primitive-audit-needs-live-validation'
      : 'host-primitive-audit-blocked';

  return {
    status,
    reason:
      status === 'host-primitive-audit-blocked'
        ? 'no_current_thread_restore_non_resurrection_primitive'
        : 'candidate_host_primitive_requires_live_validation',
    proofScope: 'codex_app_server_protocol_schema_only',
    restartSafePrimitive: false,
    command,
    schemaSource,
    schemaDir,
    schemaRetained,
    generation,
    methodCount: methods.length,
    methods,
    facts,
    decisions,
    repairContract,
    recommendation: {
      status: 'diagnostic-only',
      nextAction:
        'Use this audit as diagnostic evidence only; Codex trim execute and auto-refresh are no longer blocked on this schema-only contract.',
    },
  };
}

function buildHostAgnosticRepairContract(facts) {
  const currentThreadRepairCandidates = [
    ...facts.inPlaceHistoryRewriteMethods,
    ...facts.inPlaceCompactedHistoryClearMethods,
    ...facts.inPlaceRestoreIsolationMethods,
  ];
  const resumeHistoryCandidates = facts.threadResumeHistory.supportedForThroughline
    ? ['thread/resume(history)']
    : [];
  const hasCurrentThreadRepairCandidate = currentThreadRepairCandidates.length > 0;
  const restoreSourceDeletionCandidates = [
    ...facts.inPlaceHistoryRewriteMethods,
    ...facts.inPlaceCompactedHistoryClearMethods,
  ];
  const restoreSourceIsolationCandidates = [...facts.inPlaceRestoreIsolationMethods];
  const nonResurrectionCandidates = [
    ...restoreSourceDeletionCandidates,
    ...restoreSourceIsolationCandidates,
  ];
  const readVerificationMethods = [
    ...(facts.threadRead ? ['thread/read'] : []),
    ...(facts.threadResume ? ['thread/resume'] : []),
    ...(facts.threadTurnsList ? ['thread/turns/list'] : []),
  ];

  const criteria = [
    {
      id: 'same_current_thread_repair_primitive',
      required: true,
      status: hasCurrentThreadRepairCandidate ? 'candidate' : 'missing',
      evidence: currentThreadRepairCandidates,
      message:
        'The repair path must mutate or replace the same host thread, not only create a new thread or handoff.',
    },
    {
      id: 'restore_source_non_resurrection_guarantee',
      required: true,
      status: nonResurrectionCandidates.length > 0 ? 'candidate' : 'missing',
      evidence: nonResurrectionCandidates,
      message:
        'The host must either delete/rewrite retained rollback sources or isolate/project them so rolled-back text cannot become model-visible again.',
    },
    {
      id: 'memory_reinjection_after_repair',
      required: true,
      status: facts.threadInjectItems ? 'present' : 'missing',
      evidence: facts.threadInjectItems ? ['thread/inject_items'] : [],
      message:
        'After repair, Throughline still needs an explicit memory injection primitive for the replacement active-work context.',
    },
    {
      id: 'post_repair_host_read_verification',
      required: true,
      status: readVerificationMethods.length > 0 ? 'present' : 'missing',
      evidence: readVerificationMethods,
      message:
        'The host must expose a way to read the repaired thread and verify that rolled-back user text did not reappear.',
    },
    {
      id: 'restart_reconnect_non_resurrection_verification',
      required: true,
      status: 'requires-live-smoke',
      evidence: [],
      message:
        'Schema evidence is not enough; a restart or reconnect smoke must prove retained rollback text stays absent.',
    },
    {
      id: 'host_agnostic_boundary',
      required: true,
      status: 'required',
      evidence: [],
      message:
        'VS Code diagnostics can collect incident evidence, but they cannot define or satisfy the repair primitive contract.',
    },
  ];

  const missingRequired = criteria.some((criterion) => criterion.required && criterion.status === 'missing');
  return {
    status: missingRequired
      ? 'blocked-missing-current-thread-non-resurrection-guarantee'
      : 'candidate-requires-live-validation',
    scope: 'host_agnostic_same_thread_repair_contract',
    currentThreadRepairCandidates,
    restoreSourceDeletionCandidates,
    restoreSourceIsolationCandidates,
    resumeHistoryCandidates,
    criteria,
  };
}

function generateSchema({ command, outDir }) {
  const result = spawnSync(
    command,
    ['app-server', 'generate-json-schema', '--experimental', '--out', outDir],
    {
      encoding: 'utf8',
      maxBuffer: GENERATED_SCHEMA_MAX_BUFFER,
    },
  );

  return {
    status: result.status === 0 ? 'ok' : 'error',
    command,
    args: ['app-server', 'generate-json-schema', '--experimental', '--out', outDir],
    exitCode: result.status,
    signal: result.signal,
    stdout: clipOutput(result.stdout),
    stderr: clipOutput(result.stderr),
    outDir,
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function extractJsonRpcMethods(schema) {
  const methods = new Set();
  walk(schema, (value) => {
    if (typeof value === 'string' && value.includes('/')) methods.add(value);
  });
  return methods;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (typeof value.const === 'string') visit(value.const);
  if (Array.isArray(value.enum)) {
    for (const item of value.enum) visit(item);
  }
  for (const item of Object.values(value)) {
    walk(item, visit);
  }
}

function classifyResumeHistoryPrimitive(schema) {
  const rootDescription = String(schema?.description ?? '');
  const historyDescription = String(schema?.properties?.history?.description ?? '');
  const threadIdIgnored =
    /thread_id param will be ignored/i.test(rootDescription) ||
    /threadId param will be ignored/i.test(rootDescription);
  const doNotUse = /DO NOT USE/i.test(historyDescription);
  const present = Boolean(schema?.properties?.history);
  return {
    present,
    supportedForThroughline: present && !doNotUse && !threadIdIgnored,
    reason: !present
      ? 'thread_resume_history_param_absent'
      : doNotUse
        ? 'thread_resume_history_is_marked_do_not_use'
        : threadIdIgnored
          ? 'thread_resume_history_ignores_thread_id'
          : 'thread_resume_history_candidate_requires_live_validation',
    rootDescription: clipOutput(rootDescription, 800),
    historyDescription: clipOutput(historyDescription, 800),
  };
}

function isInPlaceHistoryRewriteMethod(method) {
  return (
    /^thread\/(history|turns?)\/(replace|rewrite|set|clear|delete|remove|truncate)$/.test(method) ||
    /^thread\/(replace|rewrite|clear|delete|remove|truncate)(_history)?$/.test(method)
  );
}

function isCompactedHistoryClearMethod(method) {
  return /thread\/.*compact.*(clear|delete|remove|rewrite|replace|reset)/.test(method);
}

function isRestoreIsolationOrProjectionMethod(method) {
  return /^thread\/.*(restore|resume|history|context|projection|visibility|rollback).*(isolate|exclude|filter|suppress|mask|tombstone|project|boundary|non[-_]?resurrect)/i.test(
    method,
  );
}

function buildDecisions(facts) {
  const decisions = [];
  decisions.push({
    id: 'rollback_present_but_not_sufficient',
    status: facts.threadRollback ? 'present-not-sufficient' : 'absent',
    message:
      'thread/rollback can prune active thread history, but the live incident showed rollback-targeted user text can remain in compacted.replacement_history.',
  });
  decisions.push({
    id: 'inject_present_but_append_only',
    status: facts.threadInjectItems ? 'present-not-remediation' : 'absent',
    message:
      'thread/inject_items appends model-visible memory and does not delete or rewrite retained compacted history.',
  });
  decisions.push({
    id: 'compaction_present_but_wrong_direction',
    status: facts.threadCompactStart ? 'present-not-remediation' : 'absent',
    message:
      'thread/compact/start starts another compaction turn; it is not a primitive for clearing existing compacted.replacement_history.',
  });
  decisions.push({
    id: 'fork_or_start_replacement_not_current_thread_repair',
    status: facts.threadStart || facts.threadFork ? 'available-new-thread-only' : 'absent',
    message:
      'thread/start or thread/fork can produce another thread, but Throughline cannot treat that as repairing the current VS Code thread unless the host switches current-thread identity safely.',
  });
  decisions.push({
    id: 'resume_history_not_supported_for_throughline',
    status: facts.threadResumeHistory.supportedForThroughline ? 'candidate' : 'blocked',
    message:
      'thread/resume(history) is not a current-thread repair primitive for Throughline when the schema marks it unstable/do-not-use or says thread_id is ignored.',
  });
  decisions.push({
    id: 'non_resurrection_guarantee_absent',
    status: facts.hasCurrentThreadNonResurrectionPrimitive ? 'candidate' : 'blocking',
    message:
      'No current-thread primitive was found that clears, rewrites, isolates, or projects retained rollback sources away from model-visible context.',
  });
  return decisions;
}

function clipOutput(value, max = 4000) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated]`;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
