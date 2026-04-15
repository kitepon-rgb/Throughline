#!/usr/bin/env node
/**
 * SessionStart hook stdout 注入動作確認スパイク
 *
 * 確認項目:
 *   1. SessionStart の stdin 契約（どのフィールドが届くか）
 *   2. stdout に生テキストを書いたときにコンテキスト注入されるか
 *
 * ログ: ~/.throughline/spike/session-start.log
 *
 * 確認方法:
 *   このスクリプトが実行されると、Claude のコンテキストに
 *   "SESSIONSTART_SPIKE_MARKER_<timestamp>" が表示されれば注入成功。
 *   ログファイルで stdin 契約の詳細を確認。
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.throughline', 'spike');
const logPath = join(logDir, 'session-start.log');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const startedAt = new Date().toISOString();

// stdin を全部受け取る
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parseError = e.message;
  }

  // CLAUDE_ 環境変数を収集
  const claudeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE'))
  );

  const entry = {
    event: 'SessionStart',
    timestamp: startedAt,
    cwd: process.cwd(),
    claudeEnv,
    stdin: {
      raw: raw.slice(0, 2000),
      length: raw.length,
      parsed,
      parseError,
    },
    summary: parsed ? {
      keys: Object.keys(parsed),
      session_id: parsed.session_id ?? parsed.sessionId ?? null,
      transcript_path: parsed.transcript_path ?? parsed.transcriptPath ?? null,
    } : null,
  };

  appendFileSync(logPath, JSON.stringify(entry, null, 2) + '\n' + '─'.repeat(60) + '\n');

  // stdout 注入テスト: 生テキストを書いてコンテキストに注入されるか確認
  const marker = `SESSIONSTART_SPIKE_MARKER_${startedAt}`;
  process.stdout.write(
    `[Throughline SessionStart Spike] 注入テスト実行中。このテキストが見えれば stdout 注入成功。\nマーカー: ${marker}\n`
  );

  process.exit(0);
});

// 30秒タイムアウト保険
setTimeout(() => {
  appendFileSync(logPath, JSON.stringify({ event: 'SessionStart', error: 'timeout after 30s', timestamp: startedAt }) + '\n');
  process.exit(0);
}, 30000);
