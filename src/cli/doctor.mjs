/**
 * throughline doctor — 環境チェック + セッション診断
 *
 * 通常: throughline doctor
 *   - Node.js バージョン >= 22.5
 *   - node:sqlite が使えるか
 *   - ~/.throughline/throughline.db が書き込み可能か
 *   - ~/.claude/settings.json に Throughline hook が登録されているか
 *
 * セッション診断: throughline doctor --session <id-prefix>
 *   - 特定セッションの state ファイルと transcript JSONL の整合性をチェック
 *   - 「モニターが止まって見える」ときの真因切り分け用
 *     (本当にアイドルか、state の transcriptPath が古い JSONL を指しているか)
 */

import { existsSync, accessSync, readFileSync, constants, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { getStateDir } from '../state-file.mjs';
import { readLatestUsage } from '../transcript-usage.mjs';

const GREEN = '\x1b[32m✓\x1b[0m';
const RED = '\x1b[31m✗\x1b[0m';
const YELLOW = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

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

function parseArgs(argv) {
  const args = { session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--session requires a session id prefix');
      }
      args.session = value;
      i++;
    }
  }
  return args;
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatTs(ms) {
  if (!Number.isFinite(ms)) return '?';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + ' GB';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' MB';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' kB';
  return `${n} B`;
}

/**
 * transcript JSONL を末尾から走査して最後の assistant エントリの timestamp を返す。
 * JSONL は append-only だが巨大化しうるので、末尾 256 KB だけ読んで逆順走査する。
 * @param {string} transcriptPath
 * @returns {{ ts: number | null, usage: object | null }}
 */
function tailLatestAssistantTs(transcriptPath) {
  try {
    const stat = statSync(transcriptPath);
    // シンプル化: 現状の全ファイル read で十分（モニターも全 read している）。
    // 巨大 JSONL 対策は readLatestUsage 側の将来最適化に任せる。
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    let latestTs = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const ts = entry.timestamp ?? entry.ts ?? null;
      if (ts) {
        latestTs = typeof ts === 'string' ? Date.parse(ts) : ts;
        break;
      }
    }
    return { ts: latestTs, fileMtime: stat.mtimeMs, size: stat.size };
  } catch (err) {
    throw new Error(`transcript read failed: ${err.message}`);
  }
}

/**
 * 同じプロジェクトディレクトリ内の最新 JSONL を返す（transcript 差し替え検出用）。
 * state の transcriptPath と比較して、指し先が「最新」でなければズレている可能性。
 */
function findLatestJsonlInSameDir(transcriptPath) {
  try {
    const dir = dirname(transcriptPath);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    if (files.length === 0) return null;
    let best = null;
    for (const name of files) {
      const full = join(dir, name);
      try {
        const mt = statSync(full).mtimeMs;
        if (!best || mt > best.mtimeMs) best = { path: full, mtimeMs: mt };
      } catch {
        /* skip */
      }
    }
    return best;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 他ユーザー所有プロセスは生きている扱い
  }
}

function runSessionDiagnosis(prefix) {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) {
    console.log(`${RED} state ディレクトリが存在しません: ${stateDir}`);
    console.log(`${DIM}  → Throughline が一度も動作していない可能性。throughline install してから Claude Code を起動してください。${RESET}`);
    return;
  }
  const entries = readdirSync(stateDir)
    .filter((n) => n.endsWith('.json'))
    .filter((n) => n.startsWith(prefix) || n.replace(/\.json$/, '').startsWith(prefix));
  if (entries.length === 0) {
    console.log(`${RED} prefix "${prefix}" に一致する state ファイルが見つかりません`);
    console.log(`${DIM}  → ~/.throughline/state/ を ls して session_id を確認してください。${RESET}`);
    return;
  }
  if (entries.length > 1) {
    console.log(`${YELLOW} 複数のセッションが prefix に一致しました:`);
    for (const name of entries) console.log(`  - ${name}`);
    console.log(`${DIM}  → もう少し長い prefix を指定してください。${RESET}`);
    return;
  }

  const name = entries[0];
  const stateFile = join(stateDir, name);
  const sessionId = name.replace(/\.json$/, '');
  console.log(`${BOLD}[Session ${sessionId}]${RESET}\n`);

  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    console.log(`${RED} state ファイル読み込み失敗: ${err.message}`);
    return;
  }

  const now = Date.now();
  console.log(`  state file:       ${stateFile}`);
  console.log(`    updatedAt:      ${formatTs(state.updatedAt)} (${formatAgo(now - (state.updatedAt ?? 0))})`);
  console.log(`    projectPath:    ${state.projectPath ?? '(未設定)'}`);
  console.log(`    transcriptPath: ${state.transcriptPath ?? '(未設定)'}`);
  if (state.pid) {
    const alive = isPidAlive(state.pid);
    console.log(`    pid:            ${state.pid} (${alive ? 'alive' : 'dead'})`);
  }
  if (state.usage) {
    const u = state.usage;
    const pct = u.contextWindowSize ? Math.round((u.tokens / u.contextWindowSize) * 100) : 0;
    console.log(`    usage (snapshot): ${u.tokens?.toLocaleString()} tokens (${pct}% of ${u.contextWindowSize?.toLocaleString()})`);
    console.log(`                      model: ${u.model ?? '?'}`);
  } else {
    console.log(`    usage (snapshot): ${DIM}(未記録 — 旧バージョンで書かれた state、または Stop が 1 度も走っていない)${RESET}`);
  }
  console.log('');

  if (!state.transcriptPath) {
    console.log(`${YELLOW} transcriptPath が state に含まれていません — 診断不能`);
    return;
  }

  if (!existsSync(state.transcriptPath)) {
    console.log(`  transcript:       ${RED}存在しない${RESET}`);
    console.log(`${DIM}  → state の transcriptPath が古い or /clear で消えた可能性。新しい発話で state が再生成されます。${RESET}`);
    return;
  }

  let tail;
  try {
    tail = tailLatestAssistantTs(state.transcriptPath);
  } catch (err) {
    console.log(`  transcript:       ${RED}${err.message}${RESET}`);
    return;
  }
  console.log(`  transcript:`);
  console.log(`    size:           ${formatBytes(tail.size)}`);
  console.log(`    mtime:          ${formatTs(tail.fileMtime)} (${formatAgo(now - tail.fileMtime)})`);
  if (tail.ts) {
    console.log(`    latest assistant entry: ${formatTs(tail.ts)} (${formatAgo(now - tail.ts)})`);
  } else {
    console.log(`    latest assistant entry: ${DIM}(未検出 — usage 付きの assistant エントリがまだ無い)${RESET}`);
  }

  const live = readLatestUsage(state.transcriptPath);
  if (live) {
    const pct = live.contextWindowSize ? Math.round((live.tokens / live.contextWindowSize) * 100) : 0;
    console.log(`    usage (live):   ${live.tokens?.toLocaleString()} tokens (${pct}% of ${live.contextWindowSize?.toLocaleString()})`);
  }
  console.log('');

  // diagnosis
  console.log(`  diagnosis:`);
  const latestInDir = findLatestJsonlInSameDir(state.transcriptPath);
  if (latestInDir && latestInDir.path !== state.transcriptPath && latestInDir.mtimeMs > tail.fileMtime) {
    console.log(`    ${RED}state points to old JSONL${RESET}`);
    console.log(`      state:  ${state.transcriptPath} (${formatAgo(now - tail.fileMtime)})`);
    console.log(`      newer:  ${latestInDir.path} (${formatAgo(now - latestInDir.mtimeMs)})`);
    console.log(`${DIM}    → 次の発話で state が自動修復されます。それでも直らない場合は state ファイルを削除してください。${RESET}`);
  } else {
    console.log(`    ${GREEN}state and transcript are consistent${RESET}`);
  }
  const idleMs = now - tail.fileMtime;
  if (idleMs > 10 * 60 * 1000) {
    console.log(`    ${YELLOW}no transcript activity in ${formatAgo(idleMs)} — session likely idle${RESET}`);
    console.log(`${DIM}    → Claude Code でこのセッションが動いていれば transcript は必ず太ります。太っていないなら本当にアイドル。${RESET}`);
  }
  if (state.usage && live && state.usage.tokens !== live.tokens) {
    console.log(`    ${YELLOW}state.usage snapshot (${state.usage.tokens}) != live transcript (${live.tokens})${RESET}`);
    console.log(`${DIM}    → Stop が一度走った後に更に assistant エントリが追記された状態。次の Stop で揃います。${RESET}`);
  }
}

export async function run(argv = []) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[throughline doctor] ${err.message}\n`);
    process.exit(2);
  }

  if (args.session) {
    runSessionDiagnosis(args.session);
    return;
  }

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
  console.log(`${DIM}ヒント: 特定セッションが止まって見えるときは ${RESET}throughline doctor --session <id-prefix>${DIM} で診断できます。${RESET}`);
}

// テスト用エクスポート
export const _internal = {
  parseArgs,
  formatAgo,
  formatBytes,
  runSessionDiagnosis,
  isPidAlive,
  findLatestJsonlInSameDir,
};
