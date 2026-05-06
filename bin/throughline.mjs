#!/usr/bin/env node
/**
 * throughline CLI ディスパッチャ
 * サブコマンドに応じて既存の hook スクリプトへ委譲する。
 *
 * 使い方:
 *   throughline install       # ~/.claude/settings.json に hook を登録
 *   throughline uninstall     # hook を削除
 *   throughline process-turn  # Stop hook (Claude Code から呼ばれる)
 *   throughline session-start # SessionStart hook (Claude Code から呼ばれる)
 *   throughline detail <時刻> # L2+L3 詳細取得 (Claude が Bash 経由で呼ぶ想定)
 *   throughline handoff-preview # Codex-facing throughline_handoff JSON preview
 *   throughline codex-threads # List read-only Codex thread id candidates
 *   throughline codex-sidecar-diagnostics # Check codex-sidecar availability
 *   throughline codex-sidecar-dry-run # Print normalized sidecar request
 *   throughline trim --dry-run # Preview same-session context trim plan
 *   throughline doctor        # 環境チェック
 *   throughline status        # DB 統計表示
 *   throughline --version     # バージョン表示
 *
 * 注意: schema v4 で capture-tool (PostToolUse) は廃止。L2/L3 は Stop 内で一括処理。
 *        inject-context (UserPromptSubmit) も廃止。L1/L2 注入は SessionStart で 1 回のみ。
 */

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'install':
    await (await import('../src/cli/install.mjs')).run(rest);
    break;
  case 'uninstall':
    await (await import('../src/cli/install.mjs')).run(['--uninstall', ...rest]);
    break;
  case 'process-turn':
    await (await import('../src/turn-processor.mjs')).run();
    break;
  case 'session-start':
    await (await import('../src/session-start.mjs')).run();
    break;
  case 'prompt-submit':
    await (await import('../src/prompt-submit.mjs')).run();
    break;
  case 'monitor':
    (await import('../src/token-monitor.mjs')).main();
    break;
  case 'detail':
    (await import('../src/sc-detail.mjs')).run(rest);
    break;
  case 'save-inflight':
    await (await import('../src/cli/save-inflight.mjs')).run();
    break;
  case 'handoff-preview':
    await (await import('../src/cli/handoff-preview.mjs')).run(rest);
    break;
  case 'codex-threads':
    await (await import('../src/cli/codex-threads.mjs')).run(rest);
    break;
  case 'codex-sidecar-diagnostics':
    await (await import('../src/cli/codex-sidecar-diagnostics.mjs')).run(rest);
    break;
  case 'codex-sidecar-dry-run':
    await (await import('../src/cli/codex-sidecar-dry-run.mjs')).run(rest);
    break;
  case 'trim':
    await (await import('../src/cli/trim.mjs')).run(rest);
    break;
  case 'doctor':
    await (await import('../src/cli/doctor.mjs')).run(rest);
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
  throughline install           Register hooks in ~/.claude/settings.json
  throughline uninstall         Remove hooks
  throughline monitor           Multi-session token monitor (use --all, --session <id>)
  throughline detail <time>     Retrieve L2+L3 detail for a turn (e.g. 14:23:05 or 14:23-14:30)
  throughline save-inflight     Save in-flight memo (stdin) to the current /tl baton
  throughline handoff-preview   Print Codex-facing throughline_handoff JSON
  throughline codex-threads     List read-only Codex thread id candidates
                              for --codex-thread-id
  throughline codex-sidecar-diagnostics
                              Check codex-sidecar diagnostics status
  throughline codex-sidecar-dry-run
                              Print normalized read-only sidecar request
  throughline trim --dry-run   Preview same-session context trim plan
                              (Codex: accepts --codex-thread-id <id>)
  throughline trim --preflight
                              Codex-only app-server read/resume guard; does not rollback
  throughline trim --execute  Experimental Codex rollback/inject guard; requires
                              THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1 and --codex-thread-id
  throughline doctor            Check environment
  throughline doctor --trim     Show trim host boundary diagnostics
  throughline status            Show DB statistics
  throughline --version         Show version

Hook subcommands (called by Claude Code):
  throughline session-start   SessionStart hook
  throughline process-turn    Stop hook
  throughline prompt-submit   UserPromptSubmit hook (/tl baton writer)
`);
}
