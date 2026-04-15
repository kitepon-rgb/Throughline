#!/usr/bin/env node
/**
 * UserPromptSubmit 注入フォーマット確認スパイク
 *
 * 試すフォーマット（SPIKE_FORMAT 環境変数で切り替え）:
 *   1 → {"additionalContext": "..."}   （試行済み: 届かない）
 *   2 → 生テキスト出力（JSON なし）
 *   3 → {"systemPrompt": "..."}
 *   4 → {"content": "..."}
 *
 * 確認方法:
 *   Claude のコンテキストに "SPIKE_FMT<N>_MARKER" が見えれば成功。
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.throughline', 'spike');
const logPath = join(logDir, 'userpromptsubmit.log');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const entry = { timestamp: new Date().toISOString(), stdin: raw.slice(0, 200) };
  appendFileSync(logPath, JSON.stringify(entry) + '\n');

  const fmt = process.env.SPIKE_FORMAT ?? '2';
  const marker = `SPIKE_FMT${fmt}_MARKER`;

  if (fmt === '1') {
    // 試行済み: 届かない
    process.stdout.write(JSON.stringify({ additionalContext: marker }) + '\n');
  } else if (fmt === '2') {
    // 生テキスト
    process.stdout.write(marker + '\n');
  } else if (fmt === '3') {
    process.stdout.write(JSON.stringify({ systemPrompt: marker }) + '\n');
  } else if (fmt === '4') {
    process.stdout.write(JSON.stringify({ content: marker }) + '\n');
  }

  process.exit(0);
});
