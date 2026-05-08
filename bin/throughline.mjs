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
 *   throughline codex-capture # Capture active Codex rollout turns into Throughline DB
 *   throughline codex-hook stop # Codex native Stop hook (capture + L1 summarize)
 *   throughline codex-summarize # Summarize captured Codex L2 turns into L1 via Codex CLI
 *   throughline codex-resume # Render Codex active-work context from DB
 *   throughline codex-handoff-smoke # Validate fresh-thread Codex handoff prompt
 *   throughline codex-handoff-model-smoke # Experimental ephemeral Codex exec handoff smoke
 *   throughline codex-handoff-start # Guided fresh-thread Codex handoff start
 *   throughline codex-visibility-smoke # Experimental model-visible Codex memory smoke
 *   throughline codex-rollback-model-visible-smoke # Controlled rollback visibility smoke
 *   throughline codex-restore-smoke # Experimental read-only app-server restart restore smoke
 *   throughline codex-restore-source-audit # Read-only local restore source inventory
 *   throughline codex-host-primitive-audit # Read-only Codex app-server primitive audit
 *   throughline codex-vscode-restore-smoke # Manual VS Code reload/reconnect restore smoke
 *   throughline codex-vscode-rollback-smoke # Manual rollback non-resurrection smoke
 *   throughline codex-threads # List read-only Codex thread id candidates
 *   throughline codex-sidecar-diagnostics # Check codex-sidecar availability
 *   throughline codex-sidecar-dry-run # Print normalized sidecar request
 *   throughline trim --execute --host codex # Codex same-thread guarded trim
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
  case 'handoff-preview':
    await (await import('../src/cli/handoff-preview.mjs')).run(rest);
    break;
  case 'codex-capture':
    await (await import('../src/cli/codex-capture.mjs')).run(rest);
    break;
  case 'codex-hook':
    await (await import('../src/cli/codex-hook.mjs')).run(rest);
    break;
  case 'codex-summarize':
    await (await import('../src/cli/codex-summarize.mjs')).run(rest);
    break;
  case 'codex-resume':
    await (await import('../src/cli/codex-resume.mjs')).run(rest);
    break;
  case 'codex-handoff-smoke':
    await (await import('../src/cli/codex-handoff-smoke.mjs')).run(rest);
    break;
  case 'codex-handoff-model-smoke':
    await (await import('../src/cli/codex-handoff-model-smoke.mjs')).run(rest);
    break;
  case 'codex-handoff-start':
    await (await import('../src/cli/codex-handoff-start.mjs')).run(rest);
    break;
  case 'codex-visibility-smoke':
    await (await import('../src/cli/codex-visibility-smoke.mjs')).run(rest);
    break;
  case 'codex-rollback-model-visible-smoke':
    await (await import('../src/cli/codex-rollback-model-visible-smoke.mjs')).run(rest);
    break;
  case 'codex-restore-smoke':
    await (await import('../src/cli/codex-restore-smoke.mjs')).run(rest);
    break;
  case 'codex-restore-source-audit':
    await (await import('../src/cli/codex-restore-source-audit.mjs')).run(rest);
    break;
  case 'codex-host-primitive-audit':
    await (await import('../src/cli/codex-host-primitive-audit.mjs')).run(rest);
    break;
  case 'codex-vscode-restore-smoke':
    await (await import('../src/cli/codex-vscode-restore-smoke.mjs')).run(rest);
    break;
  case 'codex-vscode-rollback-smoke':
    await (await import('../src/cli/codex-vscode-rollback-smoke.mjs')).run(rest);
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
  throughline handoff-preview   Print Codex-facing throughline_handoff JSON
  throughline codex-capture     Capture active Codex rollout turns into DB
                              (requires --codex-thread-id or env thread id)
  throughline codex-hook stop   Codex native Stop hook: capture rollout and
                              summarize old L2 turns into L1 via Codex CLI
  throughline codex-summarize   Summarize captured Codex L2 into L1 via Codex CLI
                              (requires a codex:<thread-id> session)
  throughline codex-resume      Render Codex active-work context from DB
                              (use --format handoff for a fresh-thread handoff)
                              (handoff accepts --max-recent-bodies,
                               --max-body-chars, and --max-detail-refs)
                              (use --format item-json for a developer message item)
                              (use --memo-stdin to prepend a current-work memo)
  throughline codex-handoff-smoke
                              Read-only validation that --format handoff is
                              pasteable as a fresh Codex thread start prompt
                              (use --print-prompt to include the prompt)
  throughline codex-handoff-model-smoke
                              Experimental: run the fresh-thread handoff prompt
                              through codex exec --ephemeral --sandbox read-only.
                              Use --dry-run to inspect readiness without model exec.
                              Use --print-prompt with --dry-run to include the prompt.
                              Use --memo-stdin to prepend current-work memo.
                              Live smoke requires THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1
  throughline codex-handoff-start
                              Guided read-only fresh-thread handoff start plan:
                              structural smoke, model-smoke dry-run boundary,
                              render command, optional --print-prompt, and
                              --memo-stdin replay guidance
  throughline codex-visibility-smoke
                              Experimental: inject Codex active-work memory and
                              start a marker-check model turn. Requires
                              THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1
                              (use --memo-stdin and --request-timeout-ms as needed)
                              (use --resume-after-inject to re-resume before turn/start)
  throughline codex-rollback-model-visible-smoke
                              Experimental controlled two-phase smoke for whether
                              a rolled-back user marker is still model-visible.
                              --prepare starts a marker turn and rolls it back.
                              --verify asks for only the marker prefix after
                              reload/reconnect. Requires
                              THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1
                              (use --marker-file to avoid leaking the full marker)
  throughline codex-restore-smoke
                              Experimental read-only smoke: start fresh app-server
                              processes and compare thread/read + thread/resume
                              + thread/turns/list counts with the rollout source. Requires
                              THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE=1
                              (use --inspect-risky-rollout only for read-only
                               risk-evidence inspection; it still exits nonzero)
  throughline codex-restore-source-audit
                              Read-only local inventory of Codex rollout,
                              session index, state sqlite, VS Code storage,
                              settings, logs, and extension restore-path signals.
                              Does not prove restart safety
  throughline codex-host-primitive-audit
                              Read-only Codex app-server schema audit for a
                              current-thread compacted-history remediation
                              primitive. Does not mutate threads
  throughline codex-vscode-restore-smoke
                              Manual two-phase VS Code reload/reconnect smoke.
                              --prepare injects a hidden marker developer memory
                              and requires
                              THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1.
                              --verify searches the rollout for the marker answer
  throughline codex-vscode-rollback-smoke
                              Manual rollback non-resurrection smoke.
                              --verify requires a rollback event, rolled-back
                              user text, a later user turn, restore safety ok,
                              and --after-vscode-restart for restart-safe proof
  throughline codex-threads     List read-only Codex thread id candidates
                              for --codex-thread-id
  throughline codex-sidecar-diagnostics
                              Check codex-sidecar diagnostics status
  throughline codex-sidecar-dry-run
                              Print normalized read-only sidecar request
  throughline trim --dry-run --host codex
                              Preview Codex same-thread context trim plan
                              (accepts --codex-thread-id <id> or
                              THROUGHLINE_CODEX_THREAD_ID / CODEX_THREAD_ID)
                              (text preview accepts --preview-max-chars <n>)
  throughline trim --preflight --host codex
                              Codex app-server read/resume guard; does not rollback
  throughline trim --execute --host codex
                              Codex rollback/inject guard; requires a Codex
                              thread id, injectable DB memory, and matching
                              rollout/app-server turns
  throughline doctor            Check environment
  throughline doctor --trim     Show trim host boundary diagnostics
  throughline doctor --codex    Show Codex primary diagnostics
  throughline status            Show DB statistics
  throughline --version         Show version

Hook subcommands (called by Claude Code / Codex):
  throughline session-start   SessionStart hook
  throughline process-turn    Stop hook
  throughline prompt-submit   UserPromptSubmit hook (/tl & /clear baton writer)
  throughline codex-hook stop Codex Stop hook
`);
}
