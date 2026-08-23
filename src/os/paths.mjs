/**
 * os/paths.mjs — path 正規化の OS 依存部分
 *
 * Windows の filesystem は case-insensitive のため、比較・保存用の
 * 正規化 path は win32 でだけ小文字へ畳む。この判断が state-file と
 * project-path に別々に書かれていたため、ここへ集約する。
 */
import { platform } from 'node:os';

export function foldPathCaseForPlatform(path, { hostPlatform = platform() } = {}) {
  return hostPlatform === 'win32' ? path.toLowerCase() : path;
}

export function isWin32Platform(hostPlatform = platform()) {
  return hostPlatform === 'win32';
}
