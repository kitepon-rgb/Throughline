#!/usr/bin/env node
/**
 * throughline install / uninstall
 *
 * デフォルト: ~/.claude/settings.json（グローバル、全プロジェクトに適用）
 * --project : .claude/settings.json（プロジェクトローカル）
 * --uninstall: hook を削除
 *
 * 登録コマンドは PATH 解決型 (throughline <subcommand>) を使う。
 * node のインストール先や OS が変わっても PATH さえ通れば動く。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLASH_COMMANDS_SRC = join(PACKAGE_ROOT, '.claude', 'commands');
const SC_SLASH_COMMAND_FILES = ['tl.md', 'sc-detail.md'];

// Throughline が管理する hook コマンド一覧
// schema v4 以降: PostToolUse (capture-tool) は廃止。Stop 内で L2/L3 を一括処理する。
const SC_COMMANDS = [
  'throughline process-turn',
  'throughline session-start',
  'throughline prompt-submit',
  // 旧コマンド（アンインストール時に除去する）
  'throughline inject-context',
  'throughline capture-tool',
  'node src/detail-capture.mjs',
  'node src/classifier.mjs',
  'node src/turn-processor.mjs',
  'node src/context-injector.mjs',
];

const SC_HOOKS = {
  SessionStart: {
    hooks: [{ type: 'command', command: 'throughline session-start' }],
  },
  Stop: {
    hooks: [{ type: 'command', command: 'throughline process-turn', async: true }],
  },
  UserPromptSubmit: {
    hooks: [{ type: 'command', command: 'throughline prompt-submit' }],
  },
};

function resolveSettingsPath(args) {
  if (args.includes('--project')) {
    return join(process.cwd(), '.claude', 'settings.json');
  }
  return join(homedir(), '.claude', 'settings.json');
}

function resolveCommandsDir(args) {
  if (args.includes('--project')) {
    return join(process.cwd(), '.claude', 'commands');
  }
  return join(homedir(), '.claude', 'commands');
}

function installSlashCommands(commandsDir) {
  if (!existsSync(SLASH_COMMANDS_SRC)) {
    return { installed: [], skipped: 'source-missing' };
  }
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });
  const installed = [];
  for (const name of SC_SLASH_COMMAND_FILES) {
    const src = join(SLASH_COMMANDS_SRC, name);
    if (!existsSync(src)) continue;
    const dest = join(commandsDir, name);
    copyFileSync(src, dest);
    installed.push(name);
  }
  return { installed, skipped: null };
}

function uninstallSlashCommands(commandsDir) {
  const removed = [];
  if (!existsSync(commandsDir)) return removed;
  for (const name of SC_SLASH_COMMAND_FILES) {
    const dest = join(commandsDir, name);
    if (existsSync(dest)) {
      unlinkSync(dest);
      removed.push(name);
    }
  }
  return removed;
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function writeSettings(settingsPath, obj) {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n');
}

export async function run(args = []) {
  const uninstall = args.includes('--uninstall');
  const settingsPath = resolveSettingsPath(args);
  const commandsDir = resolveCommandsDir(args);
  const current = readSettings(settingsPath);
  const existingHooks = current.hooks ?? {};
  const scSet = new Set(SC_COMMANDS);

  if (uninstall) {
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

    writeSettings(settingsPath, current);
    const removedCommands = uninstallSlashCommands(commandsDir);
    console.log('Throughline hooks を削除しました。');
    console.log(`  ${settingsPath}`);
    if (removedCommands.length > 0) {
      console.log(`  slash commands 削除: ${removedCommands.join(', ')} (${commandsDir})`);
    }
    return;
  }

  // インストール
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
  writeSettings(settingsPath, current);
  const { installed: installedCommands, skipped } = installSlashCommands(commandsDir);

  const scope = args.includes('--project') ? 'プロジェクトローカル' : 'グローバル（全プロジェクト）';
  console.log(`Throughline hooks をインストールしました [${scope}]`);
  console.log(`  ${settingsPath}`);
  console.log('');
  console.log('有効な hooks:');
  console.log('  SessionStart     → throughline session-start  (セッション記録・バトン消費・引き継ぎ注入)');
  console.log('  Stop             → throughline process-turn   (L1 要約 + L2 本文保存 + L3 詳細保存)');
  console.log('  UserPromptSubmit → throughline prompt-submit  (/tl バトン書き込み)');
  console.log('');
  if (installedCommands.length > 0) {
    console.log(`slash commands を配置しました: ${installedCommands.map(n => '/' + n.replace(/\.md$/, '')).join(', ')}`);
    console.log(`  ${commandsDir}`);
    console.log('');
  } else if (skipped === 'source-missing') {
    console.log('注意: パッケージ内に slash commands のソースが見つからないためスキップしました。');
    console.log('');
  }
  console.log('  アンインストール: throughline uninstall');
}
