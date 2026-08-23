/**
 * os/macos-terminal.mjs — macOS Terminal.app で対話 process を立てる
 *
 * 2 つの起動形を提供する (どちらも osascript 経由):
 *   - runTerminalScriptDetached: launch script の path を quoted form で exec
 *     (grok-continue が使う detached 起動)
 *   - runTerminalDoScript: shell command 1 行を do script で実行 (codex resume 用)
 *
 * macOS 以外では呼ばないこと。platform gate は呼び出し元の責務
 * (explicit error にするため、ここで silent no-op にしない)。
 */
import { spawn, spawnSync } from 'node:child_process';

import { appleString } from './shell.mjs';

export function appleScriptForTerminalExec(launchScriptPath) {
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script "exec " & quoted form of ${JSON.stringify(launchScriptPath)}`,
    'end tell',
    '',
  ].join('\n');
}

export function runTerminalScriptDetached({ launchFile, spawnImpl = spawn }) {
  const child = spawnImpl('osascript', ['-e', appleScriptForTerminalExec(launchFile)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref?.();
  return child;
}

export function runTerminalDoScript(shellCommand, { spawnImpl = spawnSync } = {}) {
  return spawnImpl('osascript', [], {
    input: `tell application "Terminal"
  activate
  do script ${appleString(shellCommand)}
end tell
`,
    encoding: 'utf8',
  });
}
