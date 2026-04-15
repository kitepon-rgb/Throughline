#!/usr/bin/env node
/**
 * throughline CLI ディスパッチャ
 * サブコマンドに応じて既存の hook スクリプトへ委譲する。
 *
 * 使い方:
 *   throughline install       # ~/.claude/settings.json に hook を登録
 *   throughline uninstall     # hook を削除
 *   throughline capture-tool  # PostToolUse hook (Claude Code から呼ばれる)
 *   throughline process-turn  # Stop hook (Claude Code から呼ばれる)
 *   throughline inject-context # UserPromptSubmit hook (Claude Code から呼ばれる)
 *   throughline session-start # SessionStart hook (Claude Code から呼ばれる)
 *   throughline doctor        # 環境チェック
 *   throughline status        # DB 統計表示
 *   throughline --version     # バージョン表示
 */

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'install':
    await (await import('../src/cli/install.mjs')).run(rest);
    break;
  case 'uninstall':
    await (await import('../src/cli/install.mjs')).run(['--uninstall', ...rest]);
    break;
  case 'capture-tool':
    await import('../src/detail-capture.mjs');
    break;
  case 'process-turn':
    await import('../src/turn-processor.mjs');
    break;
  case 'inject-context':
    await import('../src/context-injector.mjs');
    break;
  case 'session-start':
    await import('../src/session-start.mjs');
    break;
  case 'monitor':
    await import('../src/token-monitor.mjs');
    break;
  case 'doctor':
    await (await import('../src/cli/doctor.mjs')).run();
    break;
  case 'status':
    await (await import('../src/cli/status.mjs')).run();
    break;
  case '--version':
  case '-v': {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    console.log(pkg.version);
    break;
  }
  default:
    await showHelp();
}

async function showHelp() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const version = require('../package.json').version;
  console.log(`throughline v${version}

Usage:
  throughline install         Register hooks in ~/.claude/settings.json
  throughline uninstall       Remove hooks
  throughline monitor         Multi-session token monitor (use --all, --session <id>)
  throughline doctor          Check environment
  throughline status          Show DB statistics
  throughline --version       Show version

Hook subcommands (called by Claude Code):
  throughline capture-tool    PostToolUse hook
  throughline process-turn    Stop hook
  throughline inject-context  UserPromptSubmit hook
  throughline session-start   SessionStart hook
`);
}
