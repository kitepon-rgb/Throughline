import { existsSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve, sep } from 'node:path';

export function normalizeProjectPathForCompare(value) {
  if (!value) return '';
  let resolved = resolve(String(value));
  try {
    if (existsSync(resolved)) resolved = realpathSync.native(resolved);
  } catch {
    // Fall back to the lexical path when the filesystem cannot resolve it.
  }
  let normalized = resolved.split(sep).join('/').replace(/\/+$/, '');
  if (platform() === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

export function sameProjectPath(a, b) {
  return normalizeProjectPathForCompare(a) === normalizeProjectPathForCompare(b);
}
