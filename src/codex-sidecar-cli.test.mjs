import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('codex-sidecar-diagnostics CLI exits 0 only for configured diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-cli-'));
  try {
    const bin = join(dir, 'fake-sidecar');
    writeFileSync(bin, '#!/usr/bin/env bash\nprintf "ok\\n"\nexit 0\n');
    chmodSync(bin, 0o755);

    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'bin/throughline.mjs'), 'codex-sidecar-diagnostics', '--project', '/repo'],
      {
        env: {
          ...process.env,
          THROUGHLINE_CODEX_SIDECAR_BIN: bin,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, 'configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-sidecar-dry-run CLI exits 0 for normalized dry-run request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-sidecar-dry-run-cli-'));
  try {
    const bin = join(dir, 'fake-sidecar');
    writeFileSync(
      bin,
      '#!/usr/bin/env bash\nprintf \'{"status":"dry-run","workflow":"risk-check","normalizedRequest":{"dryRun":true}}\\n\'\n',
    );
    chmodSync(bin, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'bin/throughline.mjs'),
        'codex-sidecar-dry-run',
        '--project',
        '/repo',
        '--preset',
        'risk-check',
        'check risks',
      ],
      {
        env: {
          ...process.env,
          THROUGHLINE_CODEX_SIDECAR_BIN: bin,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, 'dry-run');
    assert.equal(json.workflow, 'risk-check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
