'use strict';
// Shim trình duyệt phải cư xử như module Node thật ở mọi chỗ lõi dùng tới.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const Z = require('../shims/zlib');
const { Buffer: B } = require('../shims/buffer');
const C = require('../shims/crypto');
const P = require('../shims/path');
const vm = require('../shims/vm');
const fs = require('../shims/fs');

function rnd(n, seed = 7) {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
const SAMPLES = {
  empty: Buffer.alloc(0),
  byte: Buffer.from([42]),
  text: Buffer.from('Cocos Creator build recover — tiếng Việt có dấu. '.repeat(500)),
  noise: rnd(200000),
  zeros: Buffer.alloc(300000),
  mixed: Buffer.concat([rnd(3000), Buffer.alloc(70000, 9), Buffer.from('abcabc'.repeat(20000))]),
};

test('zlib: deflate của shim → inflate của Node, và ngược lại', () => {
  for (const [name, data] of Object.entries(SAMPLES)) {
    for (const level of [1, 6, 9]) {
      assert.ok(zlib.inflateSync(Z.deflateSync(data, { level })).equals(data), `${name} L${level}: shim → node`);
      assert.ok(Buffer.from(Z.inflateSync(zlib.deflateSync(data, { level }))).equals(data), `${name} L${level}: node → shim`);
      assert.ok(Buffer.from(Z.inflateRawSync(zlib.deflateRawSync(data, { level }))).equals(data), `${name} L${level}: raw`);
      assert.ok(zlib.inflateRawSync(Z.deflateRawSync(data, { level })).equals(data), `${name} L${level}: raw shim → node`);
    }
  }
});

test('zlib: nén được thật (không chỉ block stored)', () => {
  const data = SAMPLES.text;
  assert.ok(Z.deflateSync(data, { level: 9 }).length < data.length / 10);
});

test('zlib: dữ liệu cụt thì báo lỗi, không trả rác', () => {
  const z = zlib.deflateSync(SAMPLES.mixed);
  assert.throws(() => Z.inflateSync(z.subarray(0, z.length >> 1)));
});

test('zlib: brotli', () => {
  // brotli-core chưa có static dictionary (payload Luna không dùng tới) → thử với dữ liệu không trùng từ điển
  const data = SAMPLES.mixed;
  assert.ok(Buffer.from(Z.brotliDecompressSync(zlib.brotliCompressSync(data))).equals(data));
});

test('Buffer: bảng mã giống Node', () => {
  const bytes = Buffer.from(rnd(1000));
  const b = B.from(bytes);
  for (const enc of ['base64', 'hex', 'latin1', 'utf8']) assert.strictEqual(b.toString(enc), bytes.toString(enc), enc);
  const s = 'Xin chào 🌏 — \u0000ÿ';
  for (const enc of ['utf8', 'latin1', 'base64', 'hex']) {
    const src = enc === 'base64' || enc === 'hex' ? Buffer.from(s).toString(enc) : s;
    assert.ok(Buffer.from(B.from(src, enc)).equals(Buffer.from(src, enc)), enc);
    assert.strictEqual(B.byteLength(src, enc), Buffer.byteLength(src, enc), 'byteLength ' + enc);
  }
  assert.strictEqual(B.from([0x80, 0x9f]).toString('latin1'), '\u0080\u009f', 'latin1 không phải windows-1252');
});

test('Buffer: slice là view, đọc/ghi số nguyên', () => {
  const b = B.alloc(16);
  const s = b.slice(4, 8);
  s[0] = 7;
  assert.strictEqual(b[4], 7, 'slice phải chung bộ nhớ');
  b.writeUInt32LE(0xdeadbeef, 0); b.writeUInt32BE(0x01020304, 8); b.writeUInt16LE(0xabcd, 12);
  const n = Buffer.from(b);
  assert.strictEqual(b.readUInt32LE(0), n.readUInt32LE(0));
  assert.strictEqual(b.readUInt32BE(8), n.readUInt32BE(8));
  assert.strictEqual(b.readInt32LE(0), n.readInt32LE(0));
  assert.strictEqual(b.readUInt16LE(12), 0xabcd);
  assert.strictEqual(b.readBigUInt64LE(0), n.readBigUInt64LE(0));
  assert.strictEqual(B.concat([B.from('ab'), B.from('cd')]).toString(), 'abcd');
  assert.strictEqual(B.from('hello world').indexOf('world'), 6);
  assert.ok(B.isBuffer(b.subarray(1)));
});

test('crypto: md5 giống Node', () => {
  for (const s of ['', 'a', 'diamond.mesh', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000), 'tiếng Việt']) {
    assert.strictEqual(C.createHash('md5').update(s).digest('hex'), crypto.createHash('md5').update(s).digest('hex'), JSON.stringify(s));
  }
});

test('path: posix giống Node', () => {
  const cases = [['join', ['/a/b', '../c', './d']], ['join', ['a', '', 'b/']], ['dirname', ['/a/b/c.txt']], ['dirname', ['a']],
    ['basename', ['/a/b/c.txt', '.txt']], ['extname', ['x.tar.gz']], ['extname', ['.gitignore']], ['relative', ['/a/b/c', '/a/d']],
    ['resolve', ['/x', 'y', '../z']], ['normalize', ['/a//b/../c/.']]];
  for (const [fn, args] of cases) assert.strictEqual(P[fn](...args), path.posix[fn](...args), `${fn}(${args.join(', ')})`);
});

test('vm: object literal và khai báo hàm trong sandbox', () => {
  const ctx = {};
  vm.runInNewContext('__o = {"a": [1, 2], b: "x"}', ctx);
  assert.deepStrictEqual(ctx.__o, { a: [1, 2], b: 'x' });
  const sb = vm.createContext({});
  vm.runInContext('function arr(){ var a = ["p","q"]; arr = function(){ return a; }; return arr(); }\nfunction dec(i){ return arr()[i]; }\nthis.__decoders = { dec: dec };', sb);
  assert.strictEqual(sb.__decoders.dec(1), 'q');
});

test('fs ảo: mkdir nguyên tử, đọc/ghi, liệt kê', () => {
  fs.__vfs.reset();
  fs.mkdirSync('/out', { recursive: true });
  fs.mkdirSync('/out/p');
  assert.throws(() => fs.mkdirSync('/out/p'), (e) => e.code === 'EEXIST');
  fs.writeFileSync('/out/p/a/b.txt', 'xin chào');
  assert.strictEqual(fs.readFileSync('/out/p/a/b.txt', 'utf8'), 'xin chào');
  assert.deepStrictEqual(fs.readdirSync('/out/p'), ['a']);
  assert.ok(fs.readdirSync('/out/p', { withFileTypes: true })[0].isDirectory());
  assert.deepStrictEqual(fs.__vfs.list('/out').map((x) => x[0]), ['p/a/b.txt']);
  fs.__vfs.reset();
  assert.ok(!fs.existsSync('/out'));
});
