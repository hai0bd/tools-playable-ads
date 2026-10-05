#!/usr/bin/env node
'use strict';
/* GUID của script / shader / asset trong các package Unity hay gặp ở playable (UGUI, TextMeshPro, Spine,
 * Cinemachine, URP, Timeline…) — lấy từ các project Unity có trên máy, ghi ra core/luna/unity/known-guids.json.
 *
 * Project Unity dựng lại từ Luna phải tham chiếu ĐÚNG GUID của package thì component UGUI/TMP/Spine mới
 * không thành "Missing Script". Unity giữ GUID của script trong package ổn định qua các phiên bản nên một
 * bản chụp dùng được cho mọi build. Script nằm trong DLL (DOTween, DOTween Pro…) được tham chiếu bằng
 * GUID của DLL + fileID tính từ tên class: đọc bảng TypeDef của DLL rồi băm MD4 như Unity (dllScripts).
 *
 *   node scripts/unity-knowledge.js [thư mục gốc chứa project Unity …]   (mặc định D:/Unity)
 * Có sẵn known-guids.json đã commit — chỉ chạy lại khi muốn thêm package.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'core', 'luna', 'unity', 'known-guids.json');
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['D:/Unity'];

// thư mục nguồn trong mỗi project: package cache + vài plugin hay nằm thẳng trong Assets
const PACKAGE_RE = /^(com\.unity\.(ugui|textmeshpro|cinemachine|render-pipelines\.universal|timeline|2d\.sprite|2d\.tilemap)|com\.esotericsoftware\.spine\.spine-unity|com\.coffee\.softmask-for-ugui)@/;
const ASSET_DIRS = ['Spine', 'TextMesh Pro', 'Plugins/Demigiant'];

const out = { scripts: {}, dllScripts: {}, packages: {}, shaders: {}, assets: {}, sources: [] };
const dllTypes = new Map();   // full name → { base, guid } của mọi class trong các DLL plugin
let scanned = 0;

// Gói trả phí / Asset Store: thiếu thì component báo Missing Script → nêu tên trong "Cần import"
const PACKAGE_LABELS = [[/Plugins\/Demigiant\/DOTweenPro\b/, 'DOTween Pro'], [/Plugins\/Demigiant\/DOTween\b/, 'DOTween']];

// ---- script nằm trong DLL: Unity tham chiếu {fileID: MD4("s\0\0\0" + namespace + tên)[0..3], guid: <guid DLL>}
function md4(bytes) {
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const len = bytes.length, nblk = ((len + 8) >> 6) + 1, w = new Uint32Array(nblk * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i & 3) * 8);
  w[len >> 2] |= 0x80 << ((len & 3) * 8);
  w[nblk * 16 - 2] = len * 8;
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const F = (x, y, z) => (x & y) | (~x & z), G = (x, y, z) => (x & y) | (x & z) | (y & z), H = (x, y, z) => x ^ y ^ z;
  for (let o = 0; o < w.length; o += 16) {
    const X = w.subarray(o, o + 16), aa = a, bb = b, cc = c, dd = d;
    for (const i of [0, 4, 8, 12]) { a = rotl((a + F(b, c, d) + X[i]) | 0, 3); d = rotl((d + F(a, b, c) + X[i + 1]) | 0, 7); c = rotl((c + F(d, a, b) + X[i + 2]) | 0, 11); b = rotl((b + F(c, d, a) + X[i + 3]) | 0, 19); }
    for (const i of [0, 1, 2, 3]) { a = rotl((a + G(b, c, d) + X[i] + 0x5a827999) | 0, 3); d = rotl((d + G(a, b, c) + X[i + 4] + 0x5a827999) | 0, 5); c = rotl((c + G(d, a, b) + X[i + 8] + 0x5a827999) | 0, 9); b = rotl((b + G(c, d, a) + X[i + 12] + 0x5a827999) | 0, 13); }
    for (const i of [0, 2, 1, 3]) { a = rotl((a + H(b, c, d) + X[i] + 0x6ed9eba1) | 0, 3); d = rotl((d + H(a, b, c) + X[i + 8] + 0x6ed9eba1) | 0, 9); c = rotl((c + H(d, a, b) + X[i + 4] + 0x6ed9eba1) | 0, 11); b = rotl((b + H(c, d, a) + X[i + 12] + 0x6ed9eba1) | 0, 15); }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  return a;   // 4 byte đầu của digest, đọc little-endian = int32
}
const dllFileId = (ns, name) => md4(Buffer.from('s\0\0\0' + ns + name, 'utf8'));

// Bảng TypeDef của metadata .NET (ECMA-335 §II.24): tên, namespace và lớp cha của từng class trong DLL
function dotnetTypes(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) return [];
  const nSec = buf.readUInt16LE(pe + 6), optSize = buf.readUInt16LE(pe + 20), opt = pe + 24;
  const cliRva = buf.readUInt32LE(opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96) + 14 * 8);
  const secs = [];
  for (let i = 0; i < nSec; i++) { const s = opt + optSize + i * 40; secs.push({ va: buf.readUInt32LE(s + 12), size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)), raw: buf.readUInt32LE(s + 20) }); }
  const off = (rva) => { const s = secs.find((x) => rva >= x.va && rva < x.va + x.size); return s ? rva - s.va + s.raw : -1; };
  if (!cliRva || off(cliRva) < 0) return [];        // DLL native, không phải managed
  const root = off(buf.readUInt32LE(off(cliRva) + 8));
  if (buf.readUInt32LE(root) !== 0x424a5342) return [];   // 'BSJB'
  const verEnd = root + 16 + buf.readUInt32LE(root + 12);     // chuỗi version đã đệm tới bội của 4
  const streams = {};
  let h = verEnd + 4;                                          // sau Flags (2) + số stream (2)
  for (let i = 0, n = buf.readUInt16LE(verEnd + 2); i < n; i++) {
    let e = h + 8; while (buf[e]) e++;
    streams[buf.toString('latin1', h + 8, e)] = [root + buf.readUInt32LE(h), buf.readUInt32LE(h + 4)];
    h += 8 + ((e - (h + 8) + 1 + 3) & ~3);                     // tên kèm NUL, đệm tới bội của 4
  }
  const tbl = streams['#~'] || streams['#-'], strs = streams['#Strings'];
  if (!tbl || !strs) return [];
  const str = (i) => { let e = strs[0] + i; while (buf[e]) e++; return buf.toString('utf8', strs[0] + i, e); };
  let t = tbl[0];
  const heap = buf[t + 6], valid = buf.readBigUInt64LE(t + 8);
  const rows = new Array(64).fill(0);
  let q = t + 24;
  for (let i = 0; i < 64; i++) if ((valid >> BigInt(i)) & 1n) { rows[i] = buf.readUInt32LE(q); q += 4; }
  const si = heap & 1 ? 4 : 2, gi = heap & 2 ? 4 : 2;
  const coded = (tables, bits) => (Math.max(...tables.map((x) => rows[x])) < 1 << (16 - bits) ? 2 : 4);
  const idx = (x) => (rows[x] < 65536 ? 2 : 4);
  const rd = (at, n) => (n === 2 ? buf.readUInt16LE(at) : buf.readUInt32LE(at));
  const moduleRow = 2 + si + 3 * gi;
  const scope = coded([0x00, 0x1a, 0x23, 0x01], 2), typeDefOrRef = coded([0x02, 0x01, 0x1b], 2);
  const typeRefRow = scope + 2 * si;
  const typeDefRow = 4 + 2 * si + typeDefOrRef + idx(0x04) + idx(0x06);
  const refBase = q + rows[0] * moduleRow, defBase = refBase + rows[1] * typeRefRow;
  const refName = (r) => { const at = refBase + (r - 1) * typeRefRow + scope; const ns = str(rd(at + si, si)); return (ns ? ns + '.' : '') + str(rd(at, si)); };
  const defs = [];
  for (let r = 0; r < rows[2]; r++) {
    const at = defBase + r * typeDefRow;
    defs.push({ name: str(rd(at + 4, si)), ns: str(rd(at + 4 + si, si)), ext: rd(at + 4 + 2 * si, typeDefOrRef) });
  }
  return defs.map((d) => {
    const tag = d.ext & 3, row = d.ext >> 2;
    const base = !row ? null : tag === 1 ? refName(row) : tag === 0 ? (defs[row - 1].ns ? defs[row - 1].ns + '.' : '') + defs[row - 1].name : null;
    return { ns: d.ns, name: d.name, base };
  });
}

function scanDll(file, guid) {
  let types;
  try { types = dotnetTypes(fs.readFileSync(file)); } catch { return; }
  for (const t of types) {
    if (!t.name || /[<`]/.test(t.name)) continue;   // <Module>, class sinh tự động, generic
    const full = (t.ns ? t.ns + '.' : '') + t.name;
    if (!dllTypes.has(full)) dllTypes.set(full, { base: t.base, guid, fileID: dllFileId(t.ns, t.name) });
  }
}

function guidOf(metaFile) {
  try { return (fs.readFileSync(metaFile, 'utf8').match(/^guid:\s*([0-9a-f]{32})/m) || [])[1] || null; } catch { return null; }
}

function scanCs(file, guid, origin) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const base = path.basename(file, '.cs');
  // namespace của class trùng tên file (quy ước bắt buộc của Unity cho MonoBehaviour/ScriptableObject)
  const nsList = [];
  const nsRe = /\bnamespace\s+([\w.]+)\s*[{;]/g;
  let m;
  while ((m = nsRe.exec(src))) nsList.push({ at: m.index, ns: m[1] });
  const clsRe = new RegExp('\\b(?:class|struct)\\s+' + base + '\\b');
  const c = clsRe.exec(src);
  if (!c) return;
  const ns = nsList.filter((n) => n.at < c.index).map((n) => n.ns).pop() || '';
  const full = ns ? ns + '.' + base : base;
  if (!out.scripts[full]) out.scripts[full] = guid;
}

function scanShader(file, guid, origin) {
  const m = fs.readFileSync(file, 'utf8').match(/^\s*Shader\s+"([^"]+)"/m);
  if (m && !/^Hidden\//.test(m[1]) && !out.shaders[m[1]]) out.shaders[m[1]] = guid;
}

function walk(dir, origin, relBase) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    // script Editor không bao giờ nằm trong scene/prefab → bỏ, bảng nhẹ đi nhiều
    if (e.isDirectory()) { if (!/^(Editor|Tests?|Samples~|Documentation~|\.)/.test(e.name)) walk(p, origin, relBase); continue; }
    if (e.name.endsWith('.meta')) continue;
    const guid = guidOf(p + '.meta');
    if (!guid) continue;
    scanned++;
    const rel = relBase ? path.relative(relBase, p).split(path.sep).join('/') : '';
    if (e.name.endsWith('.cs')) scanCs(p, guid, origin);
    else if (e.name.endsWith('.shader')) scanShader(p, guid, origin);
    else if (e.name.endsWith('.dll')) scanDll(p, guid);
    const label = PACKAGE_LABELS.find(([re]) => re.test(rel));
    if (label && /\.(cs|dll)$/.test(e.name)) out.packages[guid] = label[1];
    // asset cố định của TMP Essential Resources (font SDF, TMP Settings…): project gốc tham chiếu đúng các GUID này
    if (/^TextMesh Pro\//.test(rel) && /\.(asset|mat|png|ttf|otf|shader|txt|json)$/.test(e.name) && !out.assets[rel]) out.assets[rel] = guid;
  }
}

for (const root of roots) {
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const pc = path.join(root, proj, 'Library', 'PackageCache');
    if (fs.existsSync(pc)) {
      for (const pkg of fs.readdirSync(pc)) {
        if (!PACKAGE_RE.test(pkg)) continue;
        out.sources.push(pkg);
        walk(path.join(pc, pkg), pkg.split('@')[0], null);
      }
    }
    for (const d of ASSET_DIRS) {
      const dir = path.join(root, proj, 'Assets', d);
      if (fs.existsSync(dir)) { out.sources.push(proj + '/Assets/' + d); walk(dir, 'Assets/' + d, path.join(root, proj, 'Assets')); }
    }
  }
}

// class trong DLL mà Unity coi là script: chuỗi lớp cha (có thể qua DLL khác) chạm tới MonoBehaviour/ScriptableObject
const UNITY_BASES = new Set(['UnityEngine.MonoBehaviour', 'UnityEngine.ScriptableObject', 'UnityEngine.StateMachineBehaviour']);
const isScript = (full, depth = 0) => {
  const t = dllTypes.get(full);
  return !!t && !!t.base && depth < 20 && (UNITY_BASES.has(t.base) || isScript(t.base, depth + 1));
};
for (const [full, t] of dllTypes) if (isScript(full)) out.dllScripts[full] = [t.guid, t.fileID];

out.sources = [...new Set(out.sources)].sort();
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
// giữ các khoá do công cụ khác ghi (builtin: scripts/unity-builtins/DumpBuiltins.cs)
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
fs.writeFileSync(OUT, JSON.stringify({
  ...prev, scripts: sorted(out.scripts), dllScripts: sorted(out.dllScripts), packages: sorted(out.packages),
  shaders: sorted(out.shaders), assets: sorted(out.assets), sources: out.sources,
}, null, 1) + '\n');
console.log(`${scanned} file có .meta → ${Object.keys(out.scripts).length} script, ${Object.keys(out.dllScripts).length} script trong DLL, ${Object.keys(out.shaders).length} shader, ${Object.keys(out.assets).length} asset`);
console.log('nguồn: ' + out.sources.join(', '));
