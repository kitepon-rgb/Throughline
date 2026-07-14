import { createHash } from 'node:crypto';

export function normalizeAuditorBody(value) {
  return String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function hashAuditorBody(value) {
  return createHash('sha256').update(normalizeAuditorBody(value), 'utf8').digest('hex');
}
