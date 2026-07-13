import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPortableSync } from './portable-spawn-sync.mjs';

test('spawnPortableSync: Windows cmd shim preserves argv boundaries and stdin', {
  skip: process.platform !== 'win32' ? 'Windows cmd shim contract' : undefined,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-portable-spawn-'));
  try {
    const child = join(dir, 'child.mjs');
    const command = join(dir, 'child.cmd');
    const powerShellShim = join(dir, 'child.ps1');
    writeFileSync(child, `
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));
});
`);
    writeFileSync(command, `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(child)} %*\r\n`);
    writeFileSync(powerShellShim, `& ${JSON.stringify(process.execPath)} ${JSON.stringify(child)} @args\nexit $LASTEXITCODE\n`);

    const result = spawnPortableSync(command, ['review prompt', 'a&b', '100%'], {
      encoding: 'utf8',
      input: 'stdin body',
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['review prompt', 'a&b', '100%'],
      input: 'stdin body',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
