/**
 * os/open-url.mjs — deep link / URL を OS 既定の handler で開く
 *
 * darwin: `open` / win32: `cmd /c start` / その他: `xdg-open`。
 * 呼び出し元は result.status !== 0 を explicit failure として扱う。
 */
import { spawnSync } from 'node:child_process';

export function openUrlWithOsHandler(url, {
  platform = process.platform,
  spawnImpl = spawnSync,
} = {}) {
  if (platform === 'darwin') return spawnImpl('open', [url], { encoding: 'utf8' });
  if (platform === 'win32') return spawnImpl('cmd.exe', ['/c', 'start', '', url], { encoding: 'utf8' });
  return spawnImpl('xdg-open', [url], { encoding: 'utf8' });
}
