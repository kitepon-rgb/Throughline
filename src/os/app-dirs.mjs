/**
 * os/app-dirs.mjs — OS別のユーザー設定/状態ベースディレクトリ解決
 *
 * LOCALAPPDATA（Windows）と XDG_CONFIG_HOME / XDG_STATE_HOME（POSIX）の
 * フォールバック組み立てが runtime-error-store と completed-turn-receipts に
 * 別々に書かれていたため、ここへ集約する。最終的なアプリ別 join は呼び出し側が持つ。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

function homeOf(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

export function windowsLocalAppData(env = process.env) {
  return env.LOCALAPPDATA || join(homeOf(env), 'AppData', 'Local');
}

export function xdgConfigHome(env = process.env) {
  return env.XDG_CONFIG_HOME || join(homeOf(env), '.config');
}

export function xdgStateHome(env = process.env) {
  return env.XDG_STATE_HOME || join(homeOf(env), '.local', 'state');
}
