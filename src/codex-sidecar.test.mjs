import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_SIDECAR_STATUS,
  diagnoseCodexSidecar,
  inferWorkflowForPreset,
  runCodexSidecarDryRun,
  shouldShellWrapSidecarCommand,
} from './codex-sidecar.mjs';

function makeExecutable(dir, name, body) {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, body);
  if (process.platform === 'win32') {
    const path = join(dir, `${name}.cmd`);
    writeFileSync(path, `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
    writeFileSync(join(dir, `${name}.ps1`), `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} @args\nexit $LASTEXITCODE\n`);
    return path;
  }
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

test('diagnoseCodexSidecar: disabled env is explicit disabled status', () => {
  const result = diagnoseCodexSidecar({
    projectPath: '/repo',
    env: { ...process.env, THROUGHLINE_CODEX_SIDECAR_DISABLED: '1' },
  });

  assert.equal(result.status, CODEX_SIDECAR_STATUS.DISABLED);
  assert.equal(result.reason, 'disabled_by_env');
});

test('diagnoseCodexSidecar: missing command is unavailable, not configured', () => {
  const result = diagnoseCodexSidecar({
    projectPath: '/repo',
    command: '/definitely/missing/codex-sidecar',
  });

  assert.equal(result.status, CODEX_SIDECAR_STATUS.UNAVAILABLE);
  assert.equal(result.reason, 'command_not_found');
});

test('diagnoseCodexSidecar: non-zero diagnostics is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-fail-'));
  try {
    const bin = makeExecutable(
      dir,
      'fake-sidecar',
      "process.stderr.write('bad config'); process.exit(7);\n",
    );
    const result = diagnoseCodexSidecar({
      projectPath: '/repo',
      command: bin,
    });

    assert.equal(result.status, CODEX_SIDECAR_STATUS.UNAVAILABLE);
    assert.equal(result.reason, 'diagnostics_failed');
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /bad config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnoseCodexSidecar: zero diagnostics is configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-ok-'));
  try {
    const bin = makeExecutable(
      dir,
      'fake-sidecar',
      "process.stdout.write(`ok diagnostics for ${process.argv.slice(2).join(' ')}\\n`);\n",
    );
    const result = diagnoseCodexSidecar({
      projectPath: '/repo',
      preset: 'review',
      command: bin,
    });

    assert.equal(result.status, CODEX_SIDECAR_STATUS.CONFIGURED);
    assert.equal(result.reason, 'diagnostics_passed');
    assert.match(result.stdout, /diagnostics --project \/repo --preset review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inferWorkflowForPreset: maps known presets without guessing unavailable workflows', () => {
  assert.equal(inferWorkflowForPreset('review'), 'review');
  assert.equal(inferWorkflowForPreset('risk-check'), 'risk-check');
  assert.equal(inferWorkflowForPreset('summarize-l1'), 'explore');
  assert.equal(inferWorkflowForPreset('custom-review-preset'), 'review');
});

test('shouldShellWrapSidecarCommand: wraps npm bin shims on Windows only', () => {
  assert.equal(shouldShellWrapSidecarCommand('win32'), true);
  assert.equal(shouldShellWrapSidecarCommand('linux'), false);
  assert.equal(shouldShellWrapSidecarCommand('darwin'), false);
});

test('runCodexSidecarDryRun: emits a dry-run request for review preset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-dry-run-'));
  try {
    const argsFile = join(dir, 'args.txt');
    const bin = makeExecutable(
      dir,
      'fake-sidecar',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
process.stdout.write('{"status":"dry-run","workflow":"review","normalizedRequest":{"dryRun":true}}\\n');
`,
    );
    const result = runCodexSidecarDryRun({
      projectPath: '/repo',
      preset: 'review',
      command: bin,
      prompt: 'review prompt',
      turnTimeoutMs: 12345,
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(result.workflow, 'review');
    const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      'review',
      '--project',
      '/repo',
      '--preset',
      'review',
      '--dry-run',
      '--turn-timeout-ms',
      '12345',
      'review prompt',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexSidecarDryRun: infers risk-check workflow from preset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-risk-dry-run-'));
  try {
    const argsFile = join(dir, 'args.txt');
    const bin = makeExecutable(
      dir,
      'fake-sidecar',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join('\\n') + '\\n');
process.stdout.write('{"status":"dry-run","workflow":"risk-check","normalizedRequest":{"dryRun":true}}\\n');
`,
    );
    const result = runCodexSidecarDryRun({
      projectPath: '/repo',
      preset: 'risk-check',
      command: bin,
      contextFile: '/tmp/context.json',
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(result.workflow, 'risk-check');
    const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      'risk-check',
      '--project',
      '/repo',
      '--preset',
      'risk-check',
      '--dry-run',
      '--context-file',
      '/tmp/context.json',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
