import { runCodexHostPrimitiveAudit } from '../codex-host-primitive-audit.mjs';

function parseArgs(args) {
  const out = {
    json: false,
    command: process.env.THROUGHLINE_CODEX_APP_SERVER_BIN ?? 'codex',
    schemaDir: null,
    keepGeneratedSchema: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--codex-app-server-bin') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--codex-app-server-bin requires a command path');
      out.command = value;
    } else if (arg === '--schema-dir') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--schema-dir requires a path');
      out.schemaDir = value;
    } else if (arg === '--keep-generated-schema') {
      out.keepGeneratedSchema = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function renderTextResult(result) {
  const lines = [];
  lines.push('throughline codex host primitive audit');
  lines.push('');
  lines.push(`  status:       ${result.status}`);
  lines.push(`  reason:       ${result.reason}`);
  lines.push(`  proof scope:  ${result.proofScope ?? 'none'}`);
  lines.push(`  restart safe: ${result.restartSafePrimitive ? 'yes' : 'no'}`);
  if (result.generation?.outDir) {
    lines.push(
      `  schema:       ${result.generation.outDir}${result.schemaRetained ? '' : ' (temporary, removed)'}`,
    );
  } else if (result.schemaDir) {
    lines.push(`  schema:       ${result.schemaDir}`);
  }
  if (result.facts) {
    const hasNonResurrection =
      result.facts.hasCurrentThreadNonResurrectionPrimitive ??
      result.facts.hasCurrentThreadRemediationPrimitive;
    lines.push('');
    lines.push(`  thread/rollback:        ${result.facts.threadRollback ? 'present' : 'absent'}`);
    lines.push(`  thread/inject_items:    ${result.facts.threadInjectItems ? 'present' : 'absent'}`);
    lines.push(`  thread/compact/start:   ${result.facts.threadCompactStart ? 'present' : 'absent'}`);
    lines.push(`  thread/read:            ${result.facts.threadRead ? 'present' : 'absent'}`);
    lines.push(`  thread/turns/list:      ${result.facts.threadTurnsList ? 'present' : 'absent'}`);
    lines.push(`  thread/resume(history): ${result.facts.threadResumeHistory?.reason ?? 'unknown'}`);
    lines.push(
      `  current-thread non-resurrection: ${hasNonResurrection ? 'candidate' : 'absent'}`,
    );
  }
  if (result.repairContract) {
    lines.push('');
    lines.push(`  repair contract: ${result.repairContract.status}`);
    lines.push(`  repair scope:    ${result.repairContract.scope}`);
    for (const criterion of result.repairContract.criteria ?? []) {
      const evidence =
        Array.isArray(criterion.evidence) && criterion.evidence.length > 0
          ? ` (${criterion.evidence.join(', ')})`
          : '';
      lines.push(`  repair criterion: ${criterion.id} = ${criterion.status}${evidence}`);
    }
  }
  for (const decision of result.decisions ?? []) {
    lines.push(`  decision: ${decision.id} = ${decision.status}`);
  }
  if (result.recommendation) {
    lines.push('');
    lines.push(`  recommendation: ${result.recommendation.status}`);
    lines.push(`  next: ${result.recommendation.nextAction}`);
  }
  return lines.join('\n');
}

export async function run(args) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[codex-host-primitive-audit] ${msg}\n`);
    process.exit(1);
  }

  const result = runCodexHostPrimitiveAudit(parsed);
  if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(renderTextResult(result) + '\n');
  process.exit(
    result.status === 'host-primitive-audit-blocked' ||
      result.status === 'host-primitive-audit-needs-live-validation'
      ? 0
      : 1,
  );
}

export const _internal = {
  parseArgs,
  renderTextResult,
};
