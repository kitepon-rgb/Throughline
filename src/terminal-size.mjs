/**
 * terminal-size.mjs — OSC 18t (CSI 18t) で端末に window 幅を問い合わせるユーティリティ
 *
 * 背景: Windows ConPTY + VSCode task terminal では `process.stdout.columns` が
 * 起動時のサイズで凍結し、panel の resize に追従しない。`process.stdout.on('resize')`
 * も発火しない。Node 側からは polling しても同じ値しか取れない。
 *
 * 対策: ANSI CSI 18t (`\x1b[18t`) シーケンスで端末に「今の幅は？」と直接訊く。
 * 対応端末 (xterm / VSCode 1.88+ / Windows Terminal 一部) は
 * `\x1b[8;rows;cols t` で stdin に返してくる。これを raw mode で受けてパースすれば
 * resize 後の真の columns が取れる。
 *
 * 非対応端末 (古い VSCode、ConEmu 等) は返事をしない。呼び出し側はタイムアウトで
 * フォールバック (従来の process.stdout.columns) に落とす。
 */

const CSI_QUERY_WINDOW_SIZE = '\x1b[18t';

// xterm.js / xterm は `\x1b[8;{rows};{cols}t` で返答する（CSI t ファミリ）。
// 稀に `\x1b[8;{rows};{cols};W t` のようにオプショナルトークンが混ざる端末もあるため
// 非貪欲マッチでターミネータ 't' までを拾う。
const RESPONSE_RE = /\x1b\[8;(\d+);(\d+)t/;

/**
 * 受信バッファからサイズ応答を抽出する。純粋関数なのでテスト可能。
 * @param {string} buf - 受信済みバイト列 (UTF-8 文字列化済み)
 * @returns {{ cols: number, rows: number, consumedEnd: number } | null}
 */
export function parseSizeResponse(buf) {
  const m = buf.match(RESPONSE_RE);
  if (!m) return null;
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return null;
  return { rows, cols, consumedEnd: m.index + m[0].length };
}

/**
 * OSC 18t クエリ機構を起動する。
 *
 * 契約:
 *  - stdin が TTY でない、または setRawMode が使えない環境では `{ supported: false }` を即返す
 *  - stdin を raw mode にし、data listener を登録する
 *  - query() を呼ぶたびに `\x1b[18t` を stdout に書く
 *  - 応答が返ってきたら onSize({cols, rows}) を呼ぶ
 *  - Ctrl+C (0x03) を受け取ったら onInterrupt を呼ぶ (raw mode では自動 SIGINT が飛ばないため)
 *  - stop() で raw mode を解除する (shutdown 時に必須)
 *
 * @param {{
 *   stdin?: NodeJS.ReadableStream & { setRawMode?: (v: boolean) => unknown, isTTY?: boolean },
 *   stdout?: NodeJS.WritableStream,
 *   onSize: (size: { cols: number, rows: number }) => void,
 *   onInterrupt?: () => void,
 * }} deps
 * @returns {{ supported: boolean, query: () => void, stop: () => void }}
 */
export function startSizeQuery(deps) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const onSize = deps.onSize;
  const onInterrupt = deps.onInterrupt;

  const unsupported = { supported: false, query: () => {}, stop: () => {} };
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return unsupported;
  }

  try {
    stdin.setRawMode(true);
  } catch {
    return unsupported;
  }
  stdin.setEncoding?.('utf8');
  stdin.resume?.();

  let buf = '';
  const onData = (chunk) => {
    buf += chunk;
    // Ctrl+C (ETX 0x03) 検出: raw mode だと自動 SIGINT 化しないので自前で拾う
    if (onInterrupt && buf.indexOf('\x03') >= 0) {
      try { onInterrupt(); } catch { /* shutdown path なので握り潰す */ }
      return; // これ以上 parse しても無駄
    }
    // 複数応答が溜まっていたら最後の 1 件だけ採用し、バッファから消費分を落とす
    let parsed = parseSizeResponse(buf);
    let lastSize = null;
    while (parsed) {
      lastSize = { cols: parsed.cols, rows: parsed.rows };
      buf = buf.slice(parsed.consumedEnd);
      parsed = parseSizeResponse(buf);
    }
    if (lastSize) {
      try { onSize(lastSize); } catch { /* 描画例外は呼び出し元で処理 */ }
    }
    // バッファが暴走しないよう頭を切る (応答は通常 12 バイト程度)
    if (buf.length > 256) buf = buf.slice(-64);
  };
  stdin.on('data', onData);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { stdin.off?.('data', onData); } catch { /* noop */ }
    try { stdin.setRawMode(false); } catch { /* noop */ }
    try { stdin.pause?.(); } catch { /* noop */ }
  };

  const query = () => {
    if (stopped) return;
    try { stdout.write(CSI_QUERY_WINDOW_SIZE); } catch { /* closed stdout の可能性 */ }
  };

  return { supported: true, query, stop };
}
