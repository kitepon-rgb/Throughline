#!/usr/bin/env node
/**
 * UserPromptSubmit スパイク用インストーラー
 *
 * 使い方:
 *   node spike/install-userpromptsubmit-spike.mjs          # スパイク追加
 *   node spike/install-userpromptsubmit-spike.mjs --uninstall  # スパイク削除
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const projectRoot = resolve(__dir, '..');

const settingsPath = join(projectRoot, '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

let current = {};
if (existsSync(settingsPath)) {
  current = JSON.parse(readFileSync(settingsPath, 'utf8'));
}

const SPIKE_CMD = 'node spike/test-userpromptsubmit.mjs';

if (uninstall) {
  const hooks = current.hooks ?? {};
  if (hooks.UserPromptSubmit) {
    hooks.UserPromptSubmit = hooks.UserPromptSubmit.filter(group =>
      !(group.hooks ?? []).some(h => h.command === SPIKE_CMD)
    );
    if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;
  }
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');
  console.log('UserPromptSubmit スパイクを削除しました。');
  process.exit(0);
}

// 追加
const hooks = current.hooks ?? {};
const list = hooks.UserPromptSubmit ?? [];
const exists = list.some(g => (g.hooks ?? []).some(h => h.command === SPIKE_CMD));

if (!exists) {
  hooks.UserPromptSubmit = [
    { hooks: [{ type: 'command', command: SPIKE_CMD }] },
    ...list,
  ];
  current.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');
}

console.log('UserPromptSubmit スパイクをインストールしました。');
console.log('');
console.log('確認手順:');
console.log('  1. Claude Code を再起動');
console.log('  2. 何かメッセージを送信');
console.log('  3. node spike/read-logs.mjs で確認');
console.log('     ~/.throughline/spike/userpromptsubmit.log にログがあれば成功');
console.log('');
console.log('アンインストール: node spike/install-userpromptsubmit-spike.mjs --uninstall');
