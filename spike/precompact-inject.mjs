#!/usr/bin/env node
/**
 * Throughline Phase 0 Spike — PreCompact additionalContext 注入テスト
 *
 * 検証する仮説:
 *   1. PreCompact hook の stdin にはどんな情報が来るか？
 *   2. stdout に JSON { additionalContext: "..." } を返すと Claude が受け取れるか？
 *   3. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10 は実際に機能するか？
 *      （このスクリプトが発火すること自体がその証拠になる）
 *
 * ログ: ~/.throughline/spike/precompact.log
 * 注入: stdout に additionalContext を書き出す
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logDir = join(homedir(), '.throughline', 'spike');
const logFile = join(logDir, 'precompact.log');

mkdirSync(logDir, { recursive: true });

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

  const claudeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE'))
  );

  const firedAt = new Date().toISOString();

  const entry = {
    hookType: 'PreCompact',
    timestamp: firedAt,
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
      // PreCompact 固有のフィールドを探す
      compact_reason: parsed.compact_reason ?? parsed.compactReason ?? parsed.reason ?? null,
      token_count: parsed.token_count ?? parsed.tokenCount ?? parsed.tokens ?? null,
    } : null,
  };

  appendFileSync(logFile, JSON.stringify(entry, null, 2) + '\n' + '─'.repeat(60) + '\n');

  // --- PoC: additionalContext を stdout に返す ---
  // Claude Code がこれを受け取ってコンパクション後のコンテキストに含めれば成功。
  // Claude のレスポンスで "Throughline Spike" というテキストが見えれば注入成功。
  const additionalContext = [
    '=== Throughline Spike: PreCompact Hook Fired ===',
    `Timestamp: ${firedAt}`,
    `Stdin keys: ${parsed ? Object.keys(parsed).join(', ') : '(parse failed: ' + parseError + ')'}`,
    '',
    '[SPIKE] これが見えれば additionalContext 注入は成功です。',
    '[SPIKE] セッション情報:',
    `  session_id: ${entry.summary?.session_id ?? 'N/A'}`,
    `  transcript_path: ${entry.summary?.transcript_path ?? 'N/A'}`,
    `  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: ${claudeEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? '(未設定)'}`,
    '=== End Spike Context ===',
  ].join('\n');

  // stdout に JSON を書き出す（PreCompact hook の戻り値仕様に従う）
  process.stdout.write(JSON.stringify({ additionalContext }));
  process.exit(0);
});

setTimeout(() => {
  appendFileSync(logFile, JSON.stringify({ hookType: 'PreCompact', error: 'timeout', timestamp: new Date().toISOString() }) + '\n');
  process.exit(0);
}, 30000);
