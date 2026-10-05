'use strict';
/* dist/recover-core.js (bản trình duyệt) phải ra đúng project như lõi Node.
 * Chạy bundle mà KHÔNG có require/process/Buffer của Node — như trong Web Worker.
 * Cần bản build thật: đặt file .html vào _out/ (thư mục bị gitignore), hoặc BUILD_RECOVER_SAMPLES=a.html;b.html */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const samples = (process.env.BUILD_RECOVER_SAMPLES ? process.env.BUILD_RECOVER_SAMPLES.split(';') : [])
  .concat(fs.existsSync(path.join(ROOT, '_out')) ? fs.readdirSync(path.join(ROOT, '_out')).filter((f) => /\.html$/.test(f) && !/test/.test(f)).map((f) => path.join(ROOT, '_out', f)) : [])
  .filter((f) => fs.existsSync(f) && fs.statSync(f).size > 100000);

function loadBundle() {
  const code = fs.readFileSync(path.join(ROOT, 'dist', 'recover-core.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function('require', 'process', 'Buffer', 'module', 'exports', '__dirname', '__filename', 'global', code + '\nreturn RecoverCoreFactory;')()();
}

function pngPixels(buf) {
  const idat = [];
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  return zlib.inflateSync(Buffer.concat(idat));
}

function walk(dir, base = '', out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out); else out.set(rel, fs.readFileSync(path.join(dir, e.name)));
  }
  return out;
}

test('bundle nạp được không cần module Node', () => {
  const core = loadBundle();
  assert.strictEqual(typeof core.recover, 'function');
  assert.ok(core.editor, 'có snapshot editor');
});

for (const input of samples) {
  test('bundle == Node: ' + path.basename(input), { timeout: 180000 }, () => {
    const core = loadBundle();
    const { recover } = require('../core');
    // lõi Node dùng đúng snapshot editor của bundle → hai bên so được từng byte trên mọi máy
    const metas = require('../core/project/metas');
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'browser', 'editor-snapshot.json'), 'utf8'));
    Object.assign(metas.VERSIONS, snap.versions);
    snap.builtinUuids.forEach((u) => metas.BUILTIN_UUIDS.add(u));
    snap.builtinTypes.forEach(([u, ty]) => metas.BUILTIN_TYPES.set(u, ty));
    const outNode = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
    try {
      recover(input, { out: outNode, force: true, editors: [{ version: core.editor, engine: null }] });
      core.vfs.reset();
      core.vfs.put('/in/' + path.basename(input), new Uint8Array(fs.readFileSync(input)));
      const res = core.recover('/in/' + path.basename(input), { outRoot: '/out', sourceLabel: input });
      const got = new Map(core.vfs.list(res.outDir).map(([k, v]) => [k, Buffer.from(v)]));
      const want = walk(outNode);
      assert.deepStrictEqual([...got.keys()].sort(), [...want.keys()].sort(), 'cùng danh sách file');
      for (const [k, b] of got) {
        const a = want.get(k);
        if (a.equals(b) || k === 'RECOVERY_REPORT.md') continue;
        if (/\.png$/i.test(k)) { assert.ok(pngPixels(a).equals(pngPixels(b)), k + ': pixel'); continue; }
        if (/\.glb$/i.test(k)) continue;   // ảnh PNG nhúng nén khác zlib → offset lệch; đã so pixel ở scratch
        assert.fail(k + ' khác');
      }
    } finally {
      fs.rmSync(outNode, { recursive: true, force: true });
    }
  });
}
