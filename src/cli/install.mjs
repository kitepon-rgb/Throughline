#!/usr/bin/env node
/**
 * throughline install / uninstall
 *
 * デフォルト: ~/.claude/settings.json（グローバル、全プロジェクトに適用）
 * --project : .claude/settings.json（プロジェクトローカル）
 * --uninstall: hook を削除
 *
 * Claude-facing hook は従来通り PATH 解決型 (throughline <subcommand>) を使う。
 * Codex-facing hook は VSCode App Server の PATH 差分を避けるため、絶対 node + CLI
 * script path で登録する。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLASH_COMMANDS_SRC = join(PACKAGE_ROOT, '.claude', 'commands');
const SC_SLASH_COMMAND_FILES = ['tl.md', 'sc-detail.md'];
const CODEX_SKILLS_SRC = join(PACKAGE_ROOT, 'codex', 'skills');
const CODEX_SKILL_NAMES = ['throughline'];
const CODEX_HOOKS_RELATIVE_PATH = ['.codex', 'hooks.json'];
const CODEX_CONFIG_RELATIVE_PATH = ['.codex', 'config.toml'];

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

const CODEX_COMMANDS = [
  'throughline codex-hook stop',
];

function quoteCommandPath(p) {
  return /\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

export function buildCodexStopHookCommand({
  nodePath = process.execPath,
  cliScriptPath = join(PACKAGE_ROOT, 'bin', 'throughline.mjs'),
} = {}) {
  return `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} codex-hook stop`;
}

export function isThroughlineCodexStopCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/["']/g, '');
  return (
    normalized === 'throughline codex-hook stop' ||
    normalized.includes('throughline codex-hook stop') ||
    normalized.includes('throughline.mjs codex-hook stop')
  );
}

function createCodexHooks() {
  return {
    Stop: {
      hooks: [
        {
          type: 'command',
          command: buildCodexStopHookCommand(),
          timeoutSec: 300,
          async: false,
          statusMessage: null,
        },
      ],
    },
  };
}

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

function resolveCodexHooksPath() {
  return join(homedir(), ...CODEX_HOOKS_RELATIVE_PATH);
}

function resolveCodexConfigPath() {
  return join(homedir(), ...CODEX_CONFIG_RELATIVE_PATH);
}

function resolveCodexSkillsDir() {
  return join(homedir(), '.codex', 'skills');
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

function copyDirectory(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dest);
    } else if (entry.isFile()) {
      copyFileSync(src, dest);
    }
  }
}

function installCodexSkills(skillsDir) {
  if (!existsSync(CODEX_SKILLS_SRC)) {
    return { installed: [], skipped: 'source-missing' };
  }
  mkdirSync(skillsDir, { recursive: true });
  const installed = [];
  for (const name of CODEX_SKILL_NAMES) {
    const src = join(CODEX_SKILLS_SRC, name);
    if (!existsSync(src)) continue;
    const dest = join(skillsDir, name);
    rmSync(dest, { recursive: true, force: true });
    copyDirectory(src, dest);
    installed.push(name);
  }
  return { installed, skipped: null };
}

function uninstallCodexSkills(skillsDir) {
  const removed = [];
  for (const name of CODEX_SKILL_NAMES) {
    const dest = join(skillsDir, name);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * PATH 上で 'throughline' (Windows なら .cmd / .ps1 / .exe) が解決できるかを確認する。
 *
 * 解決できない場合 hook (`throughline session-start` 等) は command not found で
 * silent fail する。npm の global prefix bin が PATH に通っていない (Linux/WSL2 の
 * `~/.npm-global` 設定派が `.profile` だけに PATH を書いて `.bashrc` に書き忘れる
 * パターンなど) と、ユーザーは「入れたのに何も起きない」状態に陥る。
 *
 * 戻り値: 解決できた絶対パス、見つからなければ null。
 */
export function resolveThroughlineOnPath(env = process.env) {
  const pathEnv = env.PATH || env.Path || '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `throughline${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function emitPathWarning() {
  const lines = [
    '',
    '警告: PATH 上で `throughline` コマンドが解決できません。',
    '      hooks は PATH 経由で `throughline` を呼び出すため、このままでは静かに失敗します。',
    '',
    '対処:',
    '  1) npm の global prefix を確認:  npm prefix -g',
    '  2) その bin ディレクトリを PATH に追加',
    '',
  ];
  if (process.platform === 'win32') {
    lines.push('     Windows: 環境変数 PATH に %APPDATA%\\npm を追加');
  } else {
    lines.push('     bash:   ~/.bashrc に  export PATH="$(npm prefix -g)/bin:$PATH"  を追記');
    lines.push('     zsh:    ~/.zshrc に同じ行を追記');
  }
  lines.push('');
  lines.push('  3) シェルを開き直して `throughline doctor` で確認');
  lines.push('');
  process.stderr.write(lines.join('\n'));
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

function ensureCodexHooksFeature(configPath) {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === '[features]');
  let updated;

  if (sectionStart === -1) {
    const prefix = existing.trimEnd();
    updated = `${prefix}${prefix ? '\n\n' : ''}[features]\ncodex_hooks = true\n`;
  } else {
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }

    const codexHooksLine = lines
      .slice(sectionStart + 1, sectionEnd)
      .findIndex((line) => /^\s*codex_hooks\s*=/.test(line));
    if (codexHooksLine === -1) {
      lines.splice(sectionStart + 1, 0, 'codex_hooks = true');
    } else {
      lines[sectionStart + 1 + codexHooksLine] = 'codex_hooks = true';
    }
    updated = lines.join('\n').replace(/\n*$/, '\n');
  }

  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, updated);
}

function installCodexHooks() {
  const hooksPath = resolveCodexHooksPath();
  const configPath = resolveCodexConfigPath();
  const current = readSettings(hooksPath);
  const existingHooks = current.hooks ?? {};
  const codexHooks = createCodexHooks();

  for (const [key, entry] of Object.entries(codexHooks)) {
    const list = existingHooks[key] ?? [];
    const preserved = [];
    for (const group of list) {
      const hooks = (group.hooks ?? []).filter(h => !isThroughlineCodexStopCommand(h.command));
      if (hooks.length > 0) preserved.push({ ...group, hooks });
    }
    existingHooks[key] = [entry, ...preserved];
  }

  current.hooks = existingHooks;
  writeSettings(hooksPath, current);
  ensureCodexHooksFeature(configPath);

  return { hooksPath, configPath };
}

function uninstallCodexHooks() {
  const hooksPath = resolveCodexHooksPath();
  if (!existsSync(hooksPath)) {
    return { hooksPath, removed: 0 };
  }

  const current = readSettings(hooksPath);
  const existingHooks = current.hooks ?? {};
  let removed = 0;

  for (const [key, groups] of Object.entries(existingHooks)) {
    existingHooks[key] = groups
      .map((group) => {
        const hooks = (group.hooks ?? []).filter((hook) => {
          const shouldRemove =
            CODEX_COMMANDS.includes(hook.command) ||
            isThroughlineCodexStopCommand(hook.command);
          if (shouldRemove) removed++;
          return !shouldRemove;
        });
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (existingHooks[key].length === 0) delete existingHooks[key];
  }

  if (Object.keys(existingHooks).length === 0) {
    delete current.hooks;
  } else {
    current.hooks = existingHooks;
  }

  writeSettings(hooksPath, current);
  return { hooksPath, removed };
}

export async function run(args = []) {
  const uninstall = args.includes('--uninstall');
  const settingsPath = resolveSettingsPath(args);
  const commandsDir = resolveCommandsDir(args);
  const codexSkillsDir = resolveCodexSkillsDir();
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
    const codex = args.includes('--project') ? null : uninstallCodexHooks();
    const removedCodexSkills = args.includes('--project') ? [] : uninstallCodexSkills(codexSkillsDir);
    console.log('Throughline hooks を削除しました。');
    console.log(`  ${settingsPath}`);
    if (removedCommands.length > 0) {
      console.log(`  slash commands 削除: ${removedCommands.join(', ')} (${commandsDir})`);
    }
    if (codex?.removed > 0) {
      console.log(`  Codex hooks 削除: ${codex.removed} (${codex.hooksPath})`);
    }
    if (removedCodexSkills.length > 0) {
      console.log(`  Codex skills 削除: ${removedCodexSkills.join(', ')} (${codexSkillsDir})`);
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
  const codex = args.includes('--project') ? null : installCodexHooks();
  const codexSkills = args.includes('--project') ? { installed: [], skipped: null } : installCodexSkills(codexSkillsDir);

  const scope = args.includes('--project') ? 'プロジェクトローカル' : 'グローバル（全プロジェクト）';
  console.log(`Throughline hooks をインストールしました [${scope}]`);
  console.log(`  ${settingsPath}`);
  if (codex) {
    console.log(`  ${codex.hooksPath}`);
    console.log(`  ${codex.configPath}`);
    if (codexSkills.installed.length > 0) {
      console.log(`  ${codexSkillsDir}`);
    }
  }
  console.log('');
  console.log('有効な hooks:');
  console.log('  SessionStart     → throughline session-start  (セッション記録・バトン消費・引き継ぎ注入)');
  console.log('  Stop             → throughline process-turn   (L1 要約 + L2 本文保存 + L3 詳細保存)');
  console.log('  UserPromptSubmit → throughline prompt-submit  (/tl & /clear バトン書き込み)');
  if (codex) {
    console.log(`  Codex Stop       → ${buildCodexStopHookCommand()} (Codex rollout capture + L1 要約)`);
  }
  console.log('');
  if (installedCommands.length > 0) {
    console.log(`slash commands を配置しました: ${installedCommands.map(n => '/' + n.replace(/\.md$/, '')).join(', ')}`);
    console.log(`  ${commandsDir}`);
    console.log('');
  } else if (skipped === 'source-missing') {
    console.log('注意: パッケージ内に slash commands のソースが見つからないためスキップしました。');
    console.log('');
  }
  if (codexSkills.installed.length > 0) {
    console.log(`Codex skills を配置しました: ${codexSkills.installed.map(n => '$' + n).join(', ')}`);
    console.log(`  ${codexSkillsDir}`);
    console.log('');
  } else if (codexSkills.skipped === 'source-missing') {
    console.log('注意: パッケージ内に Codex skills のソースが見つからないためスキップしました。');
    console.log('');
  }
  console.log('  アンインストール: throughline uninstall');

  if (!resolveThroughlineOnPath()) {
    emitPathWarning();
  }
}
