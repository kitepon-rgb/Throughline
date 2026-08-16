import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const GROK_HANDOFF_SYNTHETIC_REASON = 'throughline_handoff';

function rowText(entry) {
  if (typeof entry?.content === 'string') return entry.content;
  if (Array.isArray(entry?.content)) {
    return entry.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  return '';
}

function parseLines(raw) {
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      rows.push({ type: 'unparsed', content: line });
    }
  }
  return rows;
}

/**
 * Insert Throughline resume text as a Grok synthetic user row immediately
 * before the latest <user_query>. Grok ignores UserPromptSubmit stdout.
 */
export function injectGrokHandoffContext(transcriptPath, injectionText) {
  if (!transcriptPath || typeof injectionText !== 'string' || injectionText.length === 0) {
    return { injected: false, reason: 'missing_path_or_text' };
  }

  const existing = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
  const rows = parseLines(existing);
  if (rows.some((row) => row.synthetic_reason === GROK_HANDOFF_SYNTHETIC_REASON)) {
    return { injected: false, reason: 'already_present' };
  }

  const reminder = {
    type: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${injectionText}\n</system-reminder>` }],
    synthetic_reason: GROK_HANDOFF_SYNTHETIC_REASON,
  };

  let insertAt = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'user' && rowText(rows[i]).includes('<user_query>')) {
      insertAt = i;
      break;
    }
  }
  rows.splice(insertAt, 0, reminder);

  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { injected: true, reason: null, insertAt };
}
