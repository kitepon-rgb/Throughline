import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeToL1 } from './haiku-summarizer.mjs';

function makeBin(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

test('summarizeToL1: returns empty fallback for blank input', () => {
  const result = summarizeToL1('', {
    projectPath: '/repo',
    env: { ...process.env, THROUGHLINE_CODEX_SIDECAR_DISABLED: '1' },
  });

  assert.equal(result.summary, '(no content)');
  assert.equal(result.fromFallback, true);
  assert.equal(result.source, 'empty');
});

test('summarizeToL1: recursion guard returns raw L2 without spawning sidecar or haiku', () => {
  const result = summarizeToL1('raw turn text', {
    projectPath: '/repo',
    env: {
      ...process.env,
      THROUGHLINE_IN_HAIKU_SUBPROCESS: '1',
    },
  });

  assert.equal(result.summary, 'raw turn text');
  assert.equal(result.fromFallback, true);
  assert.equal(result.source, 'recursion_guard');
});

test('summarizeToL1: uses codex-sidecar when diagnostics and run both succeed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-sidecar-ok-'));
  try {
    const sidecar = makeBin(
      dir,
      'codex-sidecar',
      `#!/usr/bin/env bash
if [ "$1" = "diagnostics" ]; then
  printf '{"status":"ok"}\\n'
  exit 0
fi
printf '{"status":"ok","summary":"sidecar summary"}\\n'
exit 0
`,
    );

    const result = summarizeToL1('long enough turn text', {
      projectPath: '/repo',
      env: {
        ...process.env,
        THROUGHLINE_CODEX_SIDECAR_BIN: sidecar,
      },
    });

    assert.equal(result.summary, 'sidecar summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'codex-sidecar');
    assert.equal(result.sidecarReason, 'sidecar_ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: accepts stable SidecarResult summary without status field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-sidecar-result-'));
  try {
    const sidecar = makeBin(
      dir,
      'codex-sidecar',
      `#!/usr/bin/env bash
if [ "$1" = "diagnostics" ]; then
  printf '{"status":"ok"}\\n'
  exit 0
fi
printf '{"summary":"stable sidecar summary","confidence":{"level":"high"},"recommendedNextAction":"continue"}\\n'
exit 0
`,
    );

    const result = summarizeToL1('long enough turn text', {
      projectPath: '/repo',
      env: {
        ...process.env,
        THROUGHLINE_CODEX_SIDECAR_BIN: sidecar,
      },
    });

    assert.equal(result.summary, 'stable sidecar summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'codex-sidecar');
    assert.equal(result.sidecarReason, 'sidecar_ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: when sidecar is disabled, keeps current Haiku-compatible path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-haiku-'));
  try {
    makeBin(
      dir,
      'claude',
      `#!/usr/bin/env bash
cat >/dev/null
printf 'haiku summary\\n'
`,
    );

    const result = summarizeToL1('long enough turn text', {
      projectPath: '/repo',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        THROUGHLINE_CODEX_SIDECAR_DISABLED: '1',
      },
    });

    assert.equal(result.summary, 'haiku summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'haiku');
    assert.equal(result.sidecarReason, 'sidecar_disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: sidecar run failure keeps current Haiku-compatible path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-sidecar-fail-'));
  try {
    const sidecar = makeBin(
      dir,
      'codex-sidecar',
      `#!/usr/bin/env bash
if [ "$1" = "diagnostics" ]; then
  printf '{"status":"ok"}\\n'
  exit 0
fi
printf 'sidecar failed\\n' >&2
exit 42
`,
    );
    makeBin(
      dir,
      'claude',
      `#!/usr/bin/env bash
cat >/dev/null
printf 'haiku after sidecar failure\\n'
`,
    );

    const result = summarizeToL1('long enough turn text', {
      projectPath: '/repo',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        THROUGHLINE_CODEX_SIDECAR_BIN: sidecar,
      },
    });

    assert.equal(result.summary, 'haiku after sidecar failure');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'haiku');
    assert.equal(result.sidecarReason, 'sidecar_run_failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
