#!/usr/bin/env node
/**
 * Throughline — hooks インストーラー
 *
 * 使い方:
 *   node install.mjs          # hooks をインストール
 *   node install.mjs --uninstall  # hooks を削除
 *
 * 書き込み先: .claude/settings.json
 * - ECC 設定（extraKnownMarketplaces, enabledPlugins）は保持する
 * - env ブロックは設定しない（CLAUDE_AUTOCOMPACT_PCT_OVERRIDE は使わない）
 * - 冪等（何度実行しても同じ結果）
 *
 * 設計: /clear-safe パターン
 *   PostToolUse      → L3 キャプチャ
 *   Stop             → L1 生成・確定
 *   UserPromptSubmit → L1+L2 再注入（/clear 後に自動復元）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const projectRoot = resolve(__dir);

const settingsPath = join(projectRoot, '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`settings.json の読み込みに失敗: ${e.message}\n`);
    process.exit(1);
  }
}

function writeSettings(obj) {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n');
}

// Throughline が管理するコマンド一覧
const SC_COMMANDS = [
  'node src/detail-capture.mjs',
  'node src/turn-processor.mjs',
  'node src/context-injector.mjs',
];

const SC_HOOKS = {
  PostToolUse: {
    matcher: 'Bash|Write|Edit|Read|Grep|Glob',
    hooks: [{ type: 'command', command: 'node src/detail-capture.mjs' }],
  },
  Stop: {
    hooks: [{ type: 'command', command: 'node src/turn-processor.mjs' }],
  },
  UserPromptSubmit: {
    hooks: [{ type: 'command', command: 'node src/context-injector.mjs' }],
  },
};

// --- アンインストール ---
if (uninstall) {
  const current = readSettings();
  const existingHooks = current.hooks ?? {};
  const scSet = new Set(SC_COMMANDS);

  for (const [key, groups] of Object.entries(existingHooks)) {
    existingHooks[key] = groups.filter(group =>
      !(group.hooks ?? []).some(h => scSet.has(h.command))
    );
    if (existingHooks[key].length === 0) delete existingHooks[key];
  }

  if (Object.keys(existingHooks).length === 0) {
    delete current.hooks;
  } else {
    current.hooks = existingHooks;
  }

  writeSettings(current);
  console.log('Throughline hooks を削除しました。');
  console.log(`  ${settingsPath}`);
  process.exit(0);
}

// --- インストール ---
const current = readSettings();
const existingHooks = current.hooks ?? {};

for (const [key, entry] of Object.entries(SC_HOOKS)) {
  const list = existingHooks[key] ?? [];
  const cmd = entry.hooks[0].command;
  const alreadyExists = list.some(group =>
    (group.hooks ?? []).some(h => h.command === cmd)
  );
  if (!alreadyExists) {
    existingHooks[key] = [entry, ...list];
  }
}

current.hooks = existingHooks;
writeSettings(current);

console.log('Throughline hooks をインストールしました。');
console.log(`  ${settingsPath}`);
console.log('');
console.log('有効な hooks:');
console.log('  PostToolUse      → node src/detail-capture.mjs   (L3 キャプチャ)');
console.log('  Stop             → node src/turn-processor.mjs   (L1 生成)');
console.log('  UserPromptSubmit → node src/context-injector.mjs (L1+L2 再注入)');
console.log('');
console.log('NOTE: UserPromptSubmit フックの動作は要確認。');
console.log('  spike/test-userpromptsubmit.mjs でスパイクを実行してください。');
console.log('');
console.log('  アンインストール: node install.mjs --uninstall');
