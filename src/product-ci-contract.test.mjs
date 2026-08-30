import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('windows-native product CI uses PowerShell 7 only', () => {
  const source = readFileSync(new URL('../.github/workflows/product-full-ci.yml', import.meta.url), 'utf8');
  const windowsBlocks = source
    .split(/\n(?= {6}- name:)/)
    .filter((block) => block.includes("matrix.environment == 'windows-native'"));
  assert.equal(windowsBlocks.length, 3);
  for (const block of windowsBlocks) assert.match(block, /\n        shell: pwsh\n/);
  assert.match(windowsBlocks[0], /\$env:GITHUB_ENV/);
  assert.doesNotMatch(source, /Git\\bin\\bash|Git\/bin\/bash|shell:\s*(?:powershell|cmd)\b/i);
});
