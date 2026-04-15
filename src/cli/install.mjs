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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Throughline が管理する hook コマンド一覧
const SC_COMMANDS = [
  'throughline capture-tool',
  'throughline process-turn',
  'throughline inject-context',
  'throughline session-start',
  // 旧コマンド（アンインストール時に除去する）
  'node src/detail-capture.mjs',
  'node src/turn-processor.mjs',
  'node src/context-injector.mjs',
];

const SC_HOOKS = {
  SessionStart: {
    hooks: [{ type: 'command', command: 'throughline session-start' }],
  },
  PostToolUse: {
    matcher: 'Bash|Write|Edit|Read|Grep|Glob',
    hooks: [{ type: 'command', command: 'throughline capture-tool' }],
  },
  Stop: {
    hooks: [{ type: 'command', command: 'throughline process-turn' }],
  },
  UserPromptSubmit: {
    hooks: [{ type: 'command', command: 'throughline inject-context' }],
  },
};

function resolveSettingsPath(args) {
  if (args.includes('--project')) {
    return join(process.cwd(), '.claude', 'settings.json');
  }
  return join(homedir(), '.claude', 'settings.json');
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
    console.log('Throughline hooks を削除しました。');
    console.log(`  ${settingsPath}`);
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

  const scope = args.includes('--project') ? 'プロジェクトローカル' : 'グローバル（全プロジェクト）';
  console.log(`Throughline hooks をインストールしました [${scope}]`);
  console.log(`  ${settingsPath}`);
  console.log('');
  console.log('有効な hooks:');
  console.log('  SessionStart     → throughline session-start   (セッション記録)');
  console.log('  PostToolUse      → throughline capture-tool    (L3 キャプチャ)');
  console.log('  Stop             → throughline process-turn    (L1 生成)');
  console.log('  UserPromptSubmit → throughline inject-context  (L1+L2 再注入)');
  console.log('');
  console.log('  アンインストール: throughline uninstall');
}
