import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexHandoffModelSmokePrompt,
  runCodexHandoffModelSmoke,
} from './codex-handoff-model-smoke.mjs';

function makeFakeCodexCli(dir, { visible = true } = {}) {
  const script = join(dir, 'fake-codex-cli.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? '';
if (args[0] !== 'exec') process.exit(7);
if (!args.includes('--ephemeral')) process.exit(8);
if (!args.includes('--ignore-user-config')) process.exit(9);
if (!args.includes('--ignore-rules')) process.exit(10);
if (!args.includes('--sandbox') || !args.includes('read-only')) process.exit(11);
if (!prompt.includes('Throughline: New Codex Thread Handoff')) process.exit(12);
const marker = (prompt.match(/TL_FAKE_HANDOFF_[A-Z]+/) ?? [''])[0];
process.stdout.write(${JSON.stringify(visible)} ? marker + '\\n' : 'no marker\\n');
`,
  );
  chmodSync(script, 0o755);
  return script;
}

test('buildCodexHandoffModelSmokePrompt: appends exact marker instruction', () => {
  const prompt = buildCodexHandoffModelSmokePrompt({
    handoffPrompt: '## Throughline: New Codex Thread Handoff\nbody',
    marker: 'TL_FAKE_HANDOFF_READY',
  });

  assert.match(prompt, /Throughline: New Codex Thread Handoff/);
  assert.match(prompt, /Throughline Fresh-Thread Handoff Model Smoke/);
  assert.match(prompt, /Reply exactly with this marker and nothing else: TL_FAKE_HANDOFF_READY/);
});

test('runCodexHandoffModelSmoke: detects marker from ephemeral Codex exec output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-handoff-model-smoke-'));
  try {
    const fake = makeFakeCodexCli(dir);
    const prompt = buildCodexHandoffModelSmokePrompt({
      handoffPrompt: '## Throughline: New Codex Thread Handoff\nbody',
      marker: 'TL_FAKE_HANDOFF_READY',
    });
    const result = runCodexHandoffModelSmoke({
      prompt,
      marker: 'TL_FAKE_HANDOFF_READY',
      cwd: dir,
      command: fake,
    });

    assert.equal(result.status, 'visible');
    assert.equal(result.reason, 'marker_found_in_codex_exec_output');
    assert.equal(result.markerVisible, true);
    assert.match(result.stdout, /TL_FAKE_HANDOFF_READY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexHandoffModelSmoke: reports not-visible when marker is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-codex-handoff-model-smoke-'));
  try {
    const fake = makeFakeCodexCli(dir, { visible: false });
    const prompt = buildCodexHandoffModelSmokePrompt({
      handoffPrompt: '## Throughline: New Codex Thread Handoff\nbody',
      marker: 'TL_FAKE_HANDOFF_MISSING',
    });
    const result = runCodexHandoffModelSmoke({
      prompt,
      marker: 'TL_FAKE_HANDOFF_MISSING',
      cwd: dir,
      command: fake,
    });

    assert.equal(result.status, 'not-visible');
    assert.equal(result.reason, 'marker_missing_from_codex_exec_output');
    assert.equal(result.markerVisible, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
