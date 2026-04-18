import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseSizeResponse, startSizeQuery } from './terminal-size.mjs';

// --- parseSizeResponse ---

test('parseSizeResponse: 正常な CSI 8 応答をパースする', () => {
  const r = parseSizeResponse('\x1b[8;24;80t');
  assert.deepEqual(r && { rows: r.rows, cols: r.cols }, { rows: 24, cols: 80 });
});

test('parseSizeResponse: 先頭にノイズがあっても応答を見つける', () => {
  const r = parseSizeResponse('garbage\x1b[8;40;120tmore');
  assert.ok(r);
  assert.equal(r.rows, 40);
  assert.equal(r.cols, 120);
  assert.equal(r.consumedEnd, 'garbage\x1b[8;40;120t'.length);
});

test('parseSizeResponse: 応答が無ければ null', () => {
  assert.equal(parseSizeResponse(''), null);
  assert.equal(parseSizeResponse('\x1b[8;24t'), null); // 不完全
  assert.equal(parseSizeResponse('not ansi at all'), null);
});

test('parseSizeResponse: 数値でない応答は null', () => {
  // 実際は RE が \d+ のみマッチするので to null になる
  assert.equal(parseSizeResponse('\x1b[8;abc;defgt'), null);
});

// --- startSizeQuery ---

function makeFakeStdin({ isTTY = true } = {}) {
  const ee = new EventEmitter();
  ee.isTTY = isTTY;
  ee.setRawMode = (v) => { ee.rawMode = v; };
  ee.setEncoding = () => {};
  ee.resume = () => {};
  ee.pause = () => {};
  ee.off = (ev, fn) => ee.removeListener(ev, fn);
  ee.rawMode = false;
  return ee;
}

function makeFakeStdout() {
  const writes = [];
  return {
    writes,
    write(data) { writes.push(data); return true; },
  };
}

test('startSizeQuery: stdin が TTY でなければ supported=false', () => {
  const stdin = makeFakeStdin({ isTTY: false });
  const stdout = makeFakeStdout();
  const onSize = () => {};
  const q = startSizeQuery({ stdin, stdout, onSize });
  assert.equal(q.supported, false);
});

test('startSizeQuery: TTY なら supported=true で raw mode を立てる', () => {
  const stdin = makeFakeStdin({ isTTY: true });
  const stdout = makeFakeStdout();
  const q = startSizeQuery({ stdin, stdout, onSize: () => {} });
  assert.equal(q.supported, true);
  assert.equal(stdin.rawMode, true);
  q.stop();
  assert.equal(stdin.rawMode, false);
});

test('startSizeQuery: query() で \\x1b[18t が stdout に書かれる', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const q = startSizeQuery({ stdin, stdout, onSize: () => {} });
  q.query();
  assert.deepEqual(stdout.writes, ['\x1b[18t']);
  q.stop();
});

test('startSizeQuery: stdin に応答が流れると onSize が呼ばれる', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const sizes = [];
  const q = startSizeQuery({ stdin, stdout, onSize: (s) => sizes.push(s) });
  stdin.emit('data', '\x1b[8;24;80t');
  assert.deepEqual(sizes, [{ rows: 24, cols: 80 }]);
  q.stop();
});

test('startSizeQuery: 複数応答が一度に来たら最後のサイズだけ採用する', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const sizes = [];
  const q = startSizeQuery({ stdin, stdout, onSize: (s) => sizes.push(s) });
  // resize スパムで連続応答が来るケースを想定
  stdin.emit('data', '\x1b[8;24;80t\x1b[8;30;100t\x1b[8;40;120t');
  assert.deepEqual(sizes, [{ rows: 40, cols: 120 }]);
  q.stop();
});

test('startSizeQuery: 応答が分割到着しても連結してパースする', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const sizes = [];
  const q = startSizeQuery({ stdin, stdout, onSize: (s) => sizes.push(s) });
  stdin.emit('data', '\x1b[8;24');
  stdin.emit('data', ';80t');
  assert.deepEqual(sizes, [{ rows: 24, cols: 80 }]);
  q.stop();
});

test('startSizeQuery: Ctrl+C (0x03) が来たら onInterrupt を呼ぶ', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  let interrupted = false;
  const q = startSizeQuery({
    stdin,
    stdout,
    onSize: () => {},
    onInterrupt: () => { interrupted = true; },
  });
  stdin.emit('data', '\x03');
  assert.equal(interrupted, true);
  q.stop();
});

test('startSizeQuery: stop() 後は query() しても書き込まない', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const q = startSizeQuery({ stdin, stdout, onSize: () => {} });
  q.stop();
  q.query();
  assert.deepEqual(stdout.writes, []);
});

test('startSizeQuery: stop() を 2 度呼んでも安全 (冪等)', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const q = startSizeQuery({ stdin, stdout, onSize: () => {} });
  q.stop();
  q.stop();
  assert.equal(stdin.rawMode, false);
});

test('startSizeQuery: バッファが 256 バイト超えたら前方を捨てる', () => {
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();
  const sizes = [];
  const q = startSizeQuery({ stdin, stdout, onSize: (s) => sizes.push(s) });
  // 応答が来ない状況でゴミが 300 バイト溜まる → 次の正常応答が認識される
  stdin.emit('data', 'x'.repeat(300));
  stdin.emit('data', '\x1b[8;10;20t');
  assert.deepEqual(sizes, [{ rows: 10, cols: 20 }]);
  q.stop();
});

test('startSizeQuery: setRawMode で throw する stdin は supported=false', () => {
  const stdin = makeFakeStdin();
  stdin.setRawMode = () => { throw new Error('no raw'); };
  const stdout = makeFakeStdout();
  const q = startSizeQuery({ stdin, stdout, onSize: () => {} });
  assert.equal(q.supported, false);
});
