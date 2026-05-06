import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listCodexThreadCandidates, readSessionIndex } from './codex-thread-index.mjs';

test('readSessionIndex: reads JSONL rows and ignores corrupt rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  try {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      [
        '{"id":"thread-a","thread_name":"Work A","updated_at":"2026-05-06T01:00:00Z"}',
        '{broken',
        '{"id":"thread-b","thread_name":"Work B","updated_at":"2026-05-06T02:00:00Z"}',
        '',
      ].join('\n'),
    );

    const index = readSessionIndex(home);
    assert.equal(index.get('thread-a').thread_name, 'Work A');
    assert.equal(index.get('thread-b').updated_at, '2026-05-06T02:00:00Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('listCodexThreadCandidates: filters rollouts to current project and merges index metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-codex-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-project-'));
  const otherProject = mkdtempSync(join(tmpdir(), 'tl-codex-other-'));
  try {
    writeFileSync(
      join(home, 'session_index.jsonl'),
      '{"id":"019dfaba-f87e-7f41-a144-d5ca7c6dd7f9","thread_name":"Throughline work","updated_at":"2026-05-06T02:00:00Z"}\n',
    );
    writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-40-50',
      id: '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9',
      cwd: project,
    });
    writeRollout(home, {
      day: '06',
      started: '2026-05-06T09-41-50',
      id: '019dfabb-1111-7111-8111-111111111111',
      cwd: otherProject,
    });

    const candidates = listCodexThreadCandidates({ codexHome: home, projectPath: project });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9');
    assert.equal(candidates[0].threadName, 'Throughline work');
    assert.equal(candidates[0].cwd, project);
    assert.equal(candidates[0].matchesProject, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherProject, { recursive: true, force: true });
  }
});

function writeRollout(home, { day, started, id, cwd }) {
  const dir = join(home, 'sessions', '2026', '05', day);
  mkdirSync(dir, { recursive: true });
  const fileStarted = started.replace(/:/g, '-');
  writeFileSync(
    join(dir, `rollout-${fileStarted}-${id}.jsonl`),
    JSON.stringify({
      timestamp: '2026-05-06T00:40:54.808Z',
      type: 'session_meta',
      payload: {
        id,
        timestamp: '2026-05-06T00:40:50.588Z',
        cwd,
        source: 'vscode',
        cli_version: '0.128.0-alpha.1',
      },
    }) + '\n',
  );
}
