import assert from 'node:assert/strict';
import test from 'node:test';

import { _internal } from './codex-host-primitive-audit.mjs';

test('codex-host-primitive-audit CLI parses schema and output options', () => {
  assert.deepEqual(
    _internal.parseArgs([
      '--json',
      '--codex-app-server-bin',
      '/tmp/codex',
      '--schema-dir',
      '/tmp/schema',
      '--keep-generated-schema',
    ]),
    {
      json: true,
      command: '/tmp/codex',
      schemaDir: '/tmp/schema',
      keepGeneratedSchema: true,
    },
  );
});

test('codex-host-primitive-audit text output shows diagnostic recommendation', () => {
  const text = _internal.renderTextResult({
    status: 'host-primitive-audit-blocked',
    reason: 'no_current_thread_restore_non_resurrection_primitive',
    proofScope: 'codex_app_server_protocol_schema_only',
    restartSafePrimitive: false,
    schemaRetained: true,
    schemaDir: '/tmp/schema',
    facts: {
      threadRollback: true,
      threadInjectItems: true,
      threadCompactStart: true,
      threadRead: false,
      threadTurnsList: true,
      threadResumeHistory: { reason: 'thread_resume_history_is_marked_do_not_use' },
      hasCurrentThreadRemediationPrimitive: false,
      hasCurrentThreadNonResurrectionPrimitive: false,
    },
    repairContract: {
      status: 'blocked-missing-current-thread-non-resurrection-guarantee',
      scope: 'host_agnostic_same_thread_repair_contract',
      criteria: [
        {
          id: 'same_current_thread_repair_primitive',
          status: 'missing',
          evidence: [],
        },
        {
          id: 'restore_source_non_resurrection_guarantee',
          status: 'missing',
          evidence: [],
        },
      ],
    },
    decisions: [{ id: 'non_resurrection_guarantee_absent', status: 'blocking' }],
    recommendation: {
      status: 'diagnostic-only',
      nextAction: 'do not enable',
    },
  });

  assert.match(text, /status:\s+host-primitive-audit-blocked/);
  assert.match(text, /current-thread non-resurrection:\s+absent/);
  assert.match(text, /repair contract: blocked-missing-current-thread-non-resurrection-guarantee/);
  assert.match(text, /repair criterion: same_current_thread_repair_primitive = missing/);
  assert.match(
    text,
    /repair criterion: restore_source_non_resurrection_guarantee = missing/,
  );
  assert.match(text, /decision: non_resurrection_guarantee_absent = blocking/);
});
