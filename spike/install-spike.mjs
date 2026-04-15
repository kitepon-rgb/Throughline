#!/usr/bin/env node
/**
 * Throughline Phase 0 Spike — 一時的な Hook インストーラー
 *
 * 使い方:
 *   node spike/install-spike.mjs          # スパイク hooks をインストール
 *   node spike/install-spike.mjs --uninstall  # スパイク hooks を削除
 *
 * 書き込み先: .claude/settings.json（プロジェクト固有設定）
 *   - Claude Code が hooks を読み込むのは settings.json のみ
 *   - settings.local.json は再起動時に hooks/env がリセットされるため使用不可
 *   - ECC 設定（extraKnownMarketplaces, enabledPlugins）は保持する
 *
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10 もここで設定して動作を確認する。
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const projectRoot = resolve(__dir, '..');  // spike/ の一つ上 = プロジェクトルート

const settingsPath = join(projectRoot, '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

// --- アンインストール ---
if (uninstall) {
  if (!existsSync(settingsPath)) {
    console.log('settings.local.json が存在しません。既にクリーンな状態です。');
    process.exit(0);
  }

  let current = {};
  try {
    current = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error('settings.local.json の読み込みに失敗:', e.message);
    process.exit(1);
  }

  // スパイク追加分を削除（ECC設定等は保持）
  delete current.hooks;
  delete current.env;

  // 削除後にキーが残っていればそのまま書き出す、全て消えた場合のみデフォルトに戻す
  if (Object.keys(current).length === 0) {
    // extraKnownMarketplaces, enabledPlugins, permissions 等も全て消えた場合
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: 'dontAsk' } }, null, 2) + '\n');
  } else {
    writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');
  }

  console.log('スパイク hooks を削除しました。');
  console.log(`  ${settingsPath}`);
  process.exit(0);
}

// --- インストール ---
let current = { permissions: { defaultMode: 'dontAsk' } };
if (existsSync(settingsPath)) {
  try {
    current = JSON.parse(readFileSync(settingsPath, 'utf8'));
    console.log('既存の settings.local.json を読み込みました。');
  } catch (e) {
    console.error('settings.local.json の読み込みに失敗（新規作成します）:', e.message);
  }
}

// スパイク用 hook コマンド（プロジェクトルート相対パスで記述）
const spikeCmds = {
  PostToolUse: `node spike/hook-logger.mjs PostToolUse`,
  Stop:        `node spike/hook-logger.mjs Stop`,
  PreCompact:  `node spike/precompact-inject.mjs`,
};

// 既存 hooks にスパイクを追記（重複は除去）
const existing = current.hooks ?? {};

const mergeHooks = (key, hookEntry) => {
  const existing_list = existing[key] ?? [];
  // 同じ command が既に登録されていれば追加しない
  const alreadyExists = existing_list.some(group =>
    (group.hooks ?? []).some(h => h.command === hookEntry.hooks[0].command)
  );
  if (alreadyExists) return existing_list;
  return [hookEntry, ...existing_list];
};

current.hooks = {
  PostToolUse: mergeHooks('PostToolUse', {
    matcher: 'Bash|Write|Edit|Read|Grep|Glob',
    hooks: [{ type: 'command', command: spikeCmds.PostToolUse }],
  }),
  Stop: mergeHooks('Stop', {
    hooks: [{ type: 'command', command: spikeCmds.Stop }],
  }),
  PreCompact: mergeHooks('PreCompact', {
    hooks: [{ type: 'command', command: spikeCmds.PreCompact }],
  }),
};

// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE の動作確認のため設定
current.env = { ...(current.env ?? {}), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '10' };

writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');

console.log('スパイク hooks をインストールしました。');
console.log(`  ${settingsPath}`);
console.log('');
console.log('確認手順:');
console.log('  1. このプロジェクトで Claude Code を再起動（settings 反映のため）');
console.log('  2. 何かツールを実行する（Bash、Read 等）→ PostToolUse ログが記録される');
console.log('  3. Claude の返答が完了する → Stop ログが記録される');
console.log('  4. /compact または自動コンパクト → PreCompact ログが記録される');
console.log('  5. node spike/read-logs.mjs でログを確認');
console.log('');
console.log('  アンインストール: node spike/install-spike.mjs --uninstall');
console.log('');
console.log('ログ出力先: ~/.throughline/spike/');
