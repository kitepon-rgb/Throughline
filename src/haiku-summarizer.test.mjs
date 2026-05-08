import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    hostMode: 'claude-primary',
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
      hostMode: 'claude-primary',
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
      hostMode: 'claude-primary',
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
      hostMode: 'claude-primary',
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
      hostMode: 'claude-primary',
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

test('summarizeToL1: unknown host mode is an explicit error', () => {
  assert.throws(
    () =>
      summarizeToL1('long enough turn text', {
        projectPath: '/repo',
        env: { ...process.env, THROUGHLINE_CODEX_SIDECAR_DISABLED: '1' },
      }),
    /requires hostMode/,
  );
});

test('summarizeToL1: codex-primary uses Codex CLI backend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-codex-'));
  try {
    const argsFile = join(dir, 'args.txt');
    const stdinFile = join(dir, 'stdin.txt');
    const codex = makeBin(
      dir,
      'codex',
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argsFile}"
cat > "${stdinFile}"
printf 'codex summary\\n'
`,
    );

    const result = summarizeToL1('long enough turn text', {
      hostMode: 'codex-primary',
      projectPath: dir,
      env: {
        ...process.env,
        THROUGHLINE_CODEX_CLI_BIN: codex,
      },
    });

    assert.equal(result.summary, 'codex summary');
    assert.equal(result.fromFallback, false);
    assert.equal(result.source, 'codex-cli');
    const argsText = readFileSync(argsFile, 'utf8').trim();
    const argv = argsText.split('\n');
    assert.deepEqual(argv.slice(0, 8), [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
    ]);
    assert.equal(argv[8], dir);
    assert.match(argsText, /Output contract/);
    assert.equal(readFileSync(stdinFile, 'utf8'), 'long enough turn text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeToL1: codex-primary failure is not hidden by fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-l1-codex-fail-'));
  try {
    const codex = makeBin(
      dir,
      'codex',
      `#!/usr/bin/env bash
printf 'codex failed\\n' >&2
exit 42
`,
    );
    makeBin(
      dir,
      'claude',
      `#!/usr/bin/env bash
printf 'should not run\\n'
`,
    );

    assert.throws(
      () =>
        summarizeToL1('long enough turn text', {
          hostMode: 'codex-primary',
          projectPath: dir,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            THROUGHLINE_CODEX_CLI_BIN: codex,
          },
        }),
      (err) => {
        assert.equal(err.source, 'codex-cli');
        assert.equal(err.reason, 'codex_cli_failed');
        assert.equal(err.exitCode, 42);
        assert.match(err.stderr, /codex failed/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
