#!/usr/bin/env node
/**
 * Throughline Phase 0 Spike — Hook Contract Logger
 *
 * PostToolUse と Stop の stdin 契約を実機確認するためのログキャプチャスクリプト。
 * キャプチャした JSON を ~/.throughline/spike/hooks.log に追記する。
 *
 * 使い方（install-spike.mjs 経由で設定される）:
 *   node spike/hook-logger.mjs PostToolUse
 *   node spike/hook-logger.mjs Stop
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const hookType = process.argv[2] || 'unknown';
const logDir = join(homedir(), '.throughline', 'spike');
const logFile = join(logDir, 'hooks.log');

mkdirSync(logDir, { recursive: true });

// stdin を全部受け取ってから処理
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parseError = e.message;
  }

  // CLAUDE_ 系の環境変数を全収集
  const claudeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE'))
  );

  const entry = {
    hookType,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    claudeEnv,
    stdin: {
      raw: raw.slice(0, 2000),    // 先頭 2000 文字のみ（大きい出力を切り捨て）
      length: raw.length,
      parsed,
      parseError,
    },
    // parsed から主要フィールドを展開して見やすくする
    summary: parsed ? {
      keys: Object.keys(parsed),
      session_id: parsed.session_id ?? parsed.sessionId ?? null,
      transcript_path: parsed.transcript_path ?? parsed.transcriptPath ?? null,
      tool_name: parsed.tool_name ?? parsed.toolName ?? null,
      tool_input_keys: parsed.tool_input ? Object.keys(parsed.tool_input) : null,
      has_tool_response: 'tool_response' in parsed || 'toolResponse' in parsed,
    } : null,
  };

  const separator = '\n' + '─'.repeat(60) + '\n';
  appendFileSync(logFile, JSON.stringify(entry, null, 2) + separator);

  // hook は必ず exit 0 で終了（失敗しても Claude Code の動作を阻害しない）
  process.exit(0);
});

// タイムアウト保険（30秒で強制終了）
setTimeout(() => {
  appendFileSync(logFile, JSON.stringify({ hookType, error: 'timeout after 30s', timestamp: new Date().toISOString() }) + '\n');
  process.exit(0);
}, 30000);
