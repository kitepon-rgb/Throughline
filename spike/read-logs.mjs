#!/usr/bin/env node
/**
 * Throughline Phase 0 Spike — ログビューワー
 *
 * キャプチャされた hooks ログを整形して表示する。
 * スパイク検証の結論（成功/失敗/未発火）も判定する。
 *
 * 使い方:
 *   node spike/read-logs.mjs          # 全ログ表示（最新5件）
 *   node spike/read-logs.mjs --all    # 全件表示
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const showAll = process.argv.includes('--all');
const logDir = join(homedir(), '.throughline', 'spike');
const hooksLogFile = join(logDir, 'hooks.log');
const precompactLogFile = join(logDir, 'precompact.log');

/** ログファイルを「─」区切りでエントリに分割してパース */
function parseLog(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split(/─{20,}\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      try {
        return JSON.parse(s);
      } catch {
        return { _raw: s };
      }
    });
}

function summarizeEntry(entry) {
  if (entry._raw) return `  [parse error] ${entry._raw.slice(0, 100)}`;

  const lines = [];
  lines.push(`  hookType    : ${entry.hookType}`);
  lines.push(`  timestamp   : ${entry.timestamp}`);
  lines.push(`  cwd         : ${entry.cwd}`);

  if (entry.claudeEnv && Object.keys(entry.claudeEnv).length > 0) {
    lines.push(`  claudeEnv   : ${JSON.stringify(entry.claudeEnv)}`);
  } else {
    lines.push(`  claudeEnv   : (none)`);
  }

  if (entry.summary) {
    lines.push(`  stdin.keys  : [${entry.summary.keys?.join(', ')}]`);
    if (entry.summary.session_id) lines.push(`  session_id  : ${entry.summary.session_id}`);
    if (entry.summary.transcript_path) lines.push(`  transcript  : ${entry.summary.transcript_path}`);
    if (entry.summary.tool_name) lines.push(`  tool_name   : ${entry.summary.tool_name}`);
    if (entry.summary.tool_input_keys) lines.push(`  input_keys  : [${entry.summary.tool_input_keys.join(', ')}]`);
    if (entry.summary.token_count) lines.push(`  token_count : ${entry.summary.token_count}`);
  } else if (entry.stdin?.parseError) {
    lines.push(`  stdin       : (parse error: ${entry.stdin.parseError})`);
    lines.push(`  stdin raw   : ${entry.stdin.raw.slice(0, 200)}`);
  }

  return lines.join('\n');
}

// --- 結果表示 ---
console.log('┌─────────────────────────────────────────────────────────');
console.log('│  Throughline Phase 0 Spike — Hook Contract Report');
console.log('└─────────────────────────────────────────────────────────');
console.log('');

// --- hooks.log（PostToolUse / Stop）---
console.log('■ PostToolUse / Stop ログ');
console.log(`  ファイル: ${hooksLogFile}`);

const hooksEntries = parseLog(hooksLogFile);
if (hooksEntries.length === 0) {
  console.log('  → 未発火。スパイク hooks をインストール後にツールを使ってください。');
  console.log('    node spike/install-spike.mjs');
} else {
  const postToolUse = hooksEntries.filter(e => e.hookType === 'PostToolUse');
  const stop = hooksEntries.filter(e => e.hookType === 'Stop');

  console.log(`  PostToolUse 発火回数: ${postToolUse.length}`);
  console.log(`  Stop        発火回数: ${stop.length}`);
  console.log('');

  const entriesToShow = showAll ? hooksEntries : hooksEntries.slice(-5);
  if (!showAll && hooksEntries.length > 5) {
    console.log(`  ※ 最新 5 件を表示（全 ${hooksEntries.length} 件）。--all で全件表示`);
  }

  for (const entry of entriesToShow) {
    console.log('  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄');
    console.log(summarizeEntry(entry));
  }
}

console.log('');
console.log('■ PreCompact ログ');
console.log(`  ファイル: ${precompactLogFile}`);

const precompactEntries = parseLog(precompactLogFile);
if (precompactEntries.length === 0) {
  console.log('  → 未発火。/compact を実行するか、自動コンパクトを待ってください。');
  console.log('    （CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10 が有効なら序盤で自動発火するはず）');
} else {
  console.log(`  PreCompact 発火回数: ${precompactEntries.length}`);
  console.log('');

  for (const entry of (showAll ? precompactEntries : precompactEntries.slice(-3))) {
    console.log('  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄');
    console.log(summarizeEntry(entry));
  }
}

console.log('');
console.log('─────────────────────────────────────────────────────────');
console.log('■ 検証チェックリスト');

const postCount = parseLog(hooksLogFile).filter(e => e.hookType === 'PostToolUse').length;
const stopCount = parseLog(hooksLogFile).filter(e => e.hookType === 'Stop').length;
const preCount = precompactEntries.length;

const sessionIdFound = parseLog(hooksLogFile).some(e => e.summary?.session_id);
const transcriptFound = parseLog(hooksLogFile).some(e => e.summary?.transcript_path);
const envOverrideFound = [...parseLog(hooksLogFile), ...precompactEntries]
  .some(e => e.claudeEnv?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);

const check = (ok, label) => console.log(`  ${ok ? '✓' : '✗'} ${label}`);

check(postCount > 0,     `PostToolUse hook が発火する (${postCount} 回)`);
check(stopCount > 0,     `Stop hook が発火する (${stopCount} 回)`);
check(sessionIdFound,    'stdin に session_id が含まれる');
check(transcriptFound,   'stdin に transcript_path が含まれる');
check(envOverrideFound,  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE が env に存在する');
check(preCount > 0,      `PreCompact hook が発火する (${preCount} 回)`);

console.log('');
if (postCount > 0 && stopCount > 0 && sessionIdFound && transcriptFound) {
  console.log('  → hooks 契約確認 OK: Phase 1 実装に進めます');
} else {
  console.log('  → まだ確認が必要です。スパイクを継続してください。');
}
console.log('');
