/**
 * throughline doctor — 環境チェック
 *
 * チェック項目:
 *   - Node.js バージョン >= 22.5
 *   - node:sqlite が使えるか
 *   - ~/.throughline/throughline.db が書き込み可能か
 *   - ~/.claude/settings.json に Throughline hook が登録されているか
 */

import { existsSync, accessSync, readFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const GREEN = '\x1b[32m✓\x1b[0m';
const RED = '\x1b[31m✗\x1b[0m';
const YELLOW = '\x1b[33m!\x1b[0m';

async function check(label, fn) {
  try {
    const result = await fn();
    if (result === false) {
      console.log(`${YELLOW} ${label}`);
    } else {
      console.log(`${GREEN} ${label}${result ? ': ' + result : ''}`);
    }
    return true;
  } catch (err) {
    console.log(`${RED} ${label}: ${err.message}`);
    return false;
  }
}

export async function run() {
  console.log('throughline doctor\n');

  // Node.js バージョン
  await check('Node.js >= 22.5', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(`Node.js ${process.versions.node} — 22.5 以上が必要`);
    }
    return process.versions.node;
  });

  // node:sqlite
  await check('node:sqlite が使えるか', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync(':memory:').close();
    return 'ok';
  });

  // DB ディレクトリ
  const dbDir = join(homedir(), '.throughline');
  const dbPath = join(dbDir, 'throughline.db');
  await check('~/.throughline/ ディレクトリ', () => {
    if (!existsSync(dbDir)) throw new Error('ディレクトリが存在しない（初回実行前）');
    accessSync(dbDir, constants.W_OK);
    return dbDir;
  });

  // DB ファイル
  await check('throughline.db', () => {
    if (!existsSync(dbPath)) return false; // 未作成（初回前）
    accessSync(dbPath, constants.W_OK);
    return dbPath;
  });

  // hook 登録確認（グローバルまたはプロジェクトローカル）
  const globalSettings = join(homedir(), '.claude', 'settings.json');
  const localSettings = join(process.cwd(), '.claude', 'settings.json');
  await check('Throughline hook が登録されているか', () => {
    function hasHook(filePath) {
      if (!existsSync(filePath)) return false;
      const settings = JSON.parse(readFileSync(filePath, 'utf8'));
      return Object.values(settings.hooks ?? {}).flat().some(group =>
        (group.hooks ?? []).some(h => h.command?.includes('throughline'))
      );
    }
    if (hasHook(globalSettings)) return 'グローバル (~/.claude/settings.json)';
    if (hasHook(localSettings)) return 'プロジェクトローカル (.claude/settings.json)';
    throw new Error('登録なし — throughline install を実行してください');
  });

  // PATH 上に throughline があるか
  await check('throughline コマンドが PATH で見つかるか', () => {
    try {
      const which = process.platform === 'win32' ? 'where throughline' : 'which throughline';
      const result = execSync(which, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return result.split(/\r?\n/)[0];
    } catch {
      throw new Error('見つからない — npm install -g throughline を実行してください');
    }
  });

  console.log('');
}
