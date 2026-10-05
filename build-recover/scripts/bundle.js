#!/usr/bin/env node
'use strict';
/* Đóng gói lõi (core/, CommonJS cho Node) thành dist/recover-core.js cho trình duyệt.
 *
 *   node scripts/bundle.js            (cần esbuild: npm i --no-save esbuild, hoặc ESBUILD_PATH=<thư mục esbuild>)
 *
 * dist/ được commit: người dùng tool không cần Node hay esbuild, chỉ người sửa core/ mới phải chạy lại.
 *
 * Kết quả là MỘT hàm `RecoverCoreFactory` chứ không phải IIFE: trang chính lấy mã nguồn của hàm
 * (Function.prototype.toString) ghép với worker.js thành Blob để tạo Web Worker. Nhờ vậy worker chạy
 * được cả khi mở index.html bằng file:// — lúc đó Chrome cấm new Worker('file.js') lẫn importScripts.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'recover-core.js');
const SNAPSHOT = path.join(ROOT, 'browser', 'editor-snapshot.json');
const shim = (f) => path.join(ROOT, 'shims', f);

function loadEsbuild() {
  for (const p of [process.env.ESBUILD_PATH, 'esbuild', path.join(ROOT, 'node_modules', 'esbuild')]) {
    if (!p) continue;
    try { return require(p); } catch { /* thử chỗ khác */ }
  }
  console.error('Không tìm thấy esbuild. Cài tạm: npm i --no-save esbuild — hoặc đặt ESBUILD_PATH trỏ tới thư mục esbuild có sẵn.');
  process.exit(1);
}

/* Phiên bản importer + uuid asset builtin của Cocos Creator cài trên máy. Không có editor thì dùng
   snapshot đã commit — bản trình duyệt vẫn chạy như cũ. */
function editorSnapshot() {
  const { findEditors, pickEditor } = require('../core/project/editors');
  const metas = require('../core/project/metas');
  const editor = pickEditor(process.env.COCOS_VERSION || '3.8.7', findEditors());
  if (editor && editor.engine && metas.refreshVersionsFromEditor(editor.engine)) {
    const snap = {
      editor: editor.version,
      versions: metas.VERSIONS,
      builtinUuids: [...metas.BUILTIN_UUIDS].sort(),
      builtinTypes: [...metas.BUILTIN_TYPES].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 1) + '\n');
    console.log(`snapshot editor ${editor.version}: ${snap.builtinUuids.length} uuid builtin`);
    return snap;
  }
  if (!fs.existsSync(SNAPSHOT)) { console.error('Không có Cocos Creator trên máy và cũng chưa có browser/editor-snapshot.json.'); process.exit(1); }
  console.log('Không thấy Cocos Creator — dùng browser/editor-snapshot.json có sẵn.');
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

function templatesModule() {
  const dir = path.join(ROOT, 'core', 'project', 'templates');
  const all = {};
  for (const f of fs.readdirSync(dir).sort()) all[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return `const T = ${JSON.stringify(all)};
module.exports = { readTemplate(name) { if (!(name in T)) throw new Error('Thiếu template ' + name); return T[name]; } };`;
}

async function main() {
  const esbuild = loadEsbuild();
  const snap = editorSnapshot();
  const virtualPlugin = {
    name: 'virtual',
    setup(build) {
      build.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path, namespace: 'virtual' }));
      build.onLoad({ filter: /.*/, namespace: 'virtual' }, (a) => {
        if (a.path === 'virtual:editor-snapshot') return { contents: 'module.exports = ' + JSON.stringify(snap), loader: 'js' };
        return null;
      });
      // core/project/templates.js đọc đĩa → thay bằng bản nhúng sẵn
      build.onLoad({ filter: /[\\/]core[\\/]project[\\/]templates\.js$/ }, () => ({ contents: templatesModule(), loader: 'js' }));
    },
  };
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'browser', 'entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'RecoverCore',
    platform: 'browser',
    target: ['chrome100', 'edge100'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    alias: {
      fs: shim('fs.js'), path: shim('path.js'), zlib: shim('zlib.js'), crypto: shim('crypto.js'), vm: shim('vm.js'),
      os: shim('os.js'), buffer: shim('buffer.js'), process: shim('process.js'),
      child_process: shim('empty.js'), worker_threads: shim('empty.js'), util: shim('empty.js'), tty: shim('empty.js'),
    },
    inject: [shim('inject.mjs')],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [virtualPlugin],
    logLevel: 'warning',
  });
  const code = result.outputFiles[0].text;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const header = `/* recover-core.js — sinh bởi scripts/bundle.js từ core/ (v${pkg.version}, Cocos Creator ${snap.editor}). ĐỪNG SỬA TAY. */\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${header}function RecoverCoreFactory() {\n${code}\nreturn RecoverCore;\n}\n`);
  console.log(`dist/recover-core.js: ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
