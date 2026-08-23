import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { foldPathCaseForPlatform } from './os/paths.mjs';

export function normalizeProjectPathForCompare(value) {
  if (!value) return '';
  let resolved = resolve(String(value));
  try {
    if (existsSync(resolved)) resolved = realpathSync.native(resolved);
  } catch {
    // Fall back to the lexical path when the filesystem cannot resolve it.
  }
  const normalized = resolved.split(sep).join('/').replace(/\/+$/, '');
  return foldPathCaseForPlatform(normalized);
}

export function sameProjectPath(a, b) {
  return normalizeProjectPathForCompare(a) === normalizeProjectPathForCompare(b);
}
