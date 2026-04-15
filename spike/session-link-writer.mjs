// Stop フック追加: 毎ターン末尾で旧 session_id を state ファイルに書き込む
import { readStdinSync, writeState, appendLog } from './session-link-common.mjs';

const raw = readStdinSync();
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  appendLog({ op: 'write-error', reason: 'parse-failed', raw: raw.slice(0, 200) });
  process.exit(0);
}

const session_id = parsed?.session_id;
const transcript_path = parsed?.transcript_path || null;
const cwd = parsed?.cwd || process.cwd();

if (!session_id) {
  appendLog({ op: 'write-error', reason: 'no-session-id', parsed });
  process.exit(0);
}

const state = {
  old_session_id: session_id,
  transcript_path,
  cwd,
  ts: Date.now(),
  state: 'open',
};

try {
  writeState(cwd, state);
  appendLog({ op: 'write', cwd, old_session_id: session_id, transcript_path });
} catch (e) {
  appendLog({ op: 'write-error', reason: String(e), cwd, session_id });
}

process.exit(0);
