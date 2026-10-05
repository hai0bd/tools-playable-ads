#!/usr/bin/env node
'use strict';
// CLI: cocos-recover <build.html|build.zip|build-folder|folder-of-builds> [options]
const fs = require('fs');
const path = require('path');
const { recover, UnsupportedBuildError } = require('../core');

const HELP = `
Cocos Build Recover — khôi phục project Cocos Creator 3.x từ file build

Cách dùng:
  cocos-recover <đầu vào> [tuỳ chọn]

Đầu vào:
  file .html   playable super-html (applovin.html, google.html, ...)
  file .zip    build web-mobile nén hoặc zip chứa playable
  thư mục      build web-mobile (có index.html + src/settings.json)
  thư mục chứa nhiều build  (dùng kèm --batch)

Tuỳ chọn:
  -o, --out <thư mục>       nơi tạo project (mặc định: ./recovered/<tên project>)
  -r, --reference <thư mục> project có sẵn để lấy lại script gốc trùng uuid (có thể lặp lại)
      --creator <x.y.z>     phiên bản Cocos Creator đích (mặc định: tự chọn theo bản build)
      --name <tên>          đặt tên project
      --force               cho phép ghi vào thư mục đã có assets
      --batch               khôi phục mọi build tìm thấy trong thư mục (mỗi thư mục con lấy 1 bản)
      --no-scripts          bỏ qua bước dịch ngược script
  -h, --help                hiện hướng dẫn này
`;

function parseArgs(argv) {
  const o = { reference: [], inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`Thiếu giá trị cho ${a}`); return v; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-o' || a === '--out') o.out = val();
    else if (a === '-r' || a === '--reference') o.reference.push(val());
    else if (a === '--creator') o.creator = val();
    else if (a === '--name') o.name = val();
    else if (a === '--force') o.force = true;
    else if (a === '--batch') o.batch = true;
    else if (a === '--no-scripts') o.noScripts = true;
    else if (a.startsWith('-')) throw new Error('Tuỳ chọn không hợp lệ: ' + a);
    else o.inputs.push(a);
  }
  return o;
}

// one build per directory (channel variants share the same payload)
const { findBuilds } = require('../core/scan');

function runOne(input, opts) {
  const t0 = Date.now();
  const r = recover(input, { ...opts, log: (m) => process.stdout.write(`  ${m}\n`) });
  const s = r.stats;
  console.log(`\n✔ Đã tạo project "${r.name}" tại ${r.outDir} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  ${Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  if (r.report.warnings.length) console.log(`  ⚠ ${r.report.warnings.length} cảnh báo — xem RECOVERY_REPORT.md`);
  console.log(r.engine === 'unity' ? `  Mở bằng Unity ${r.engineVersion || ''} (Unity Hub → Add project from disk).` : `  Mở bằng Cocos Creator ${r.creatorVersion}.`);
  return r;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help || !opts.inputs.length) { console.log(HELP); process.exit(opts.help ? 0 : 1); }
  let failed = 0;
  for (const input of opts.inputs) {
    if (!fs.existsSync(input)) { console.error(`Không tìm thấy: ${input}`); failed++; continue; }
    const isDir = fs.statSync(input).isDirectory();
    const builds = opts.batch && isDir ? findBuilds(input) : [input];
    if (opts.batch) console.log(`Tìm thấy ${builds.length} bản build trong ${input}`);
    for (const b of builds) {
      console.log(`\n▶ ${b}`);
      try {
        const o = { ...opts };
        if (opts.batch) o.out = opts.out ? path.join(opts.out, path.basename(path.dirname(b)) + '_' + path.basename(b).replace(/\.[^.]+$/, '')) : undefined;
        runOne(b, o);
      } catch (e) {
        failed++;
        if (e instanceof UnsupportedBuildError) console.error(`  ✖ ${e.message}`);
        else console.error(`  ✖ Lỗi: ${e.stack || e.message}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
