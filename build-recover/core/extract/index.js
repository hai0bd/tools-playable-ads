'use strict';
// Turn any supported build input into a virtual file tree: Map<relativePath, Buffer>
//   - super-html single-file playable (.html with window.__zip / window.__res)
//   - .zip containing a web-mobile build or a playable .html
//   - web-mobile build folder (index.html + src/settings*.json + assets/)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readZip } = require('../util/zip');

const DATA_URL_RE = /^data:[^,]*;base64,/;

function decodeDataUrl(buf) {
  const head = buf.subarray(0, 96).toString('latin1');
  if (!DATA_URL_RE.test(head)) return buf;
  const s = buf.toString('latin1');
  const payload = s.slice(s.indexOf(',') + 1);
  const out = decodeBase64Segments(payload);
  // header and body glued without padding: magic comes out as "CC.." but not "CCON"
  const looksLikeBadMagic = out.length >= 16 && out[0] === 0x43 && out[1] === 0x43 && !isCCONMagic(out);
  return isBrokenCCON(out) || looksLikeBadMagic ? repairCCON(payload) || out : out;
}

// CCON header: "CCON", version u32, total byte length u32, json length u32
const isCCONMagic = (b) => b.length >= 16 && b.readUInt32LE(0) === 0x4e4f4343;
const isBrokenCCON = (b) => isCCONMagic(b) && b.readUInt32LE(8) !== b.length;

/**
 * Old packers wrote the CCON header and body as two base64 strings glued together without padding.
 * Find the split point for which the header's length fields agree with the decoded size.
 */
function repairCCON(payload) {
  payload = payload.replace(/\s+/g, '');
  let fallback = null;
  for (let k = 4; k < Math.min(80, payload.length); k++) {
    const buf = Buffer.concat([Buffer.from(payload.slice(0, k), 'base64'), Buffer.from(payload.slice(k), 'base64')]);
    if (!isCCONMagic(buf) || buf.readUInt32LE(8) !== buf.length) continue;
    const jsonLen = buf.readUInt32LE(12);
    if (16 + jsonLen > buf.length) continue;
    const version = buf.readUInt32LE(4);
    if (version === 1 || version === 2) return buf;
    if (!fallback) fallback = buf;
  }
  if (fallback) { fallback.writeUInt32LE(1, 4); return fallback; }   // version byte damaged, body verified by the length fields
  // other packers insert one stray character in the header ("Q0NPT3gEAAAD..." instead of "Q0NPTgEAAAD...")
  for (let k = 0; k < Math.min(32, payload.length); k++) {
    const buf = Buffer.from(payload.slice(0, k) + payload.slice(k + 1), 'base64');
    if (isCCONMagic(buf) && buf.readUInt32LE(8) === buf.length && 16 + buf.readUInt32LE(12) <= buf.length) return buf;
  }
  return null;
}

/** Some packers concatenate several base64 strings ("Q0NPTgE=" + "..."): decode each padded segment separately. */
function decodeBase64Segments(b64) {
  b64 = b64.replace(/\s+/g, '');
  const firstPad = b64.indexOf('=');
  if (firstPad < 0 || /^=*$/.test(b64.slice(firstPad))) return Buffer.from(b64, 'base64');
  const parts = b64.split(/(?<==)(?=[^=])/);
  return Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')));
}

/** Strip the 5-hex md5 suffix Cocos adds when md5Cache is on: "config.1a2b3.json" -> "config.json" */
function stripMd5(p) {
  return p.replace(/^(.*\/)?([^/]+)\.([0-9a-f]{5})(\.[^./]+)$/i, (m, dir = '', name, md5, ext) => `${dir}${name}${ext}`);
}

function normalizeTree(files) {
  const out = new Map();
  for (const [k, v] of files) {
    let key = k.replace(/\\/g, '/').replace(/^\.\//, '');
    out.set(key, decodeDataUrl(v));
  }
  // md5 cache: add canonical aliases (keep originals too)
  for (const k of [...out.keys()]) {
    const c = stripMd5(k);
    if (c !== k && !out.has(c)) out.set(c, out.get(k));
  }
  return out;
}

/** Find the root prefix of a web-mobile build inside a tree (the dir that holds src/settings.json or assets/main). */
function findBuildRoot(files) {
  const candidates = [];
  for (const k of files.keys()) {
    let m = k.match(/^(.*?)(?:^|\/)src\/settings(?:\.[0-9a-f]{5})?\.json$/);
    if (m) candidates.push(m[1] ? m[1] + '/' : '');
    m = k.match(/^(.*?)(?:^|\/)assets\/main\/config(?:\.[0-9a-f]{5})?\.json$/);
    if (m) candidates.push(m[1] ? m[1] + '/' : '');
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

function rebase(files, prefix) {
  if (!prefix) return files;
  const out = new Map();
  for (const [k, v] of files) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  return out;
}

// ---------------------------------------------------------------- super-html
function extractJsStringAssignment(html, name) {
  // window.NAME = "...."  /  var NAME = "...."  (can be several MB; plain base64 so no escapes)
  const re = new RegExp(`(?:window\\.|\\bvar\\s+|\\blet\\s+|\\bconst\\s+)${name}\\s*=\\s*(["'])`, 'g');
  const m = re.exec(html);
  if (!m) return null;
  const quote = m[1];
  const start = m.index + m[0].length;
  const end = html.indexOf(quote, start);
  return end > start ? html.slice(start, end) : null;
}

function extractJsObjectAssignment(html, name) {
  const idx = html.indexOf(`window.${name}`);
  if (idx < 0) return null;
  const eq = html.indexOf('=', idx);
  const open = html.indexOf('{', eq);
  if (open < 0) return null;
  // scan to the matching brace, respecting string literals
  let depth = 0, i = open, inStr = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const src = html.slice(open, i + 1);
  const ctx = {};
  vm.runInNewContext('__o = ' + src, ctx, { timeout: 20000 });
  return ctx.__o;
}

function parseSuperHtml(html) {
  const files = new Map();
  const zipB64 = extractJsStringAssignment(html, '__zip');
  if (zipB64) {
    for (const [k, v] of readZip(Buffer.from(zipB64, 'base64'))) {
      if (k === '__res') {
        // newer super-html: the zip carries the resource map as a JSON entry
        const inner = JSON.parse(v.toString('utf8'));
        for (const [ik, iv] of Object.entries(inner)) if (typeof iv === 'string') files.set(ik, Buffer.from(iv, 'utf8'));
        continue;
      }
      // "@src/..." entries are boot scripts evaluated first; keep them under their real path
      files.set(k.startsWith('@') ? k.slice(1) : k, v);
    }
  }
  const res = extractJsObjectAssignment(html, '__res');
  if (res) {
    for (const [k, v] of Object.entries(res)) {
      if (typeof v === 'string') files.set(k, Buffer.from(v, 'utf8'));
    }
  }
  // anti-extraction: newer super-html inserts one extra character at index window.oasjidx of every data URL,
  // its loader (getRes) removes it again at runtime
  const findIdx = (s) => { const m = s.match(/oasjidx\s*=\s*(\d+)/); return m ? +m[1] : 0; };
  let junkIndex = findIdx(html.replace(/[A-Za-z0-9+/=]{300,}/g, ''));
  if (!junkIndex) for (const [k, v] of files) { if (/\.js$/.test(k) && v.length < 5e6) { junkIndex = findIdx(v.toString('latin1')); if (junkIndex) break; } }
  if (junkIndex) {
    for (const [k, v] of files) {
      if (v.length > junkIndex && v.subarray(0, 5).toString('latin1') === 'data:') {
        const s = v.toString('latin1');
        files.set(k, Buffer.from(s.slice(0, junkIndex) + s.slice(junkIndex + 1), 'latin1'));
      }
    }
  }
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const channel = (html.match(/super_html_channel\s*=\s*["']([^"']+)["']/) || [])[1] || '';
  return { files, title: title.trim(), channel, junkIndex };
}

function looksLikeSuperHtml(html) {
  return /(?:window\.|\bvar\s+|\blet\s+|\bconst\s+)__(zip|res)\s*=/.test(html);
}

// ---------------------------------------------------------------- public
function readDirTree(dir) {
  const files = new Map();
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else files.set(r, fs.readFileSync(p));
    }
  })(dir, '');
  return files;
}

/**
 * Load a build from a path. Returns { files: Map, title, channel, kind, source }.
 * Throws with a readable message when the input is not a supported Cocos Creator 3.x build.
 */
function loadBuild(input) {
  const stat = fs.statSync(input);
  let files, title = '', channel = '', kind;

  if (stat.isDirectory()) {
    files = readDirTree(input);
    kind = 'web-mobile-folder';
  } else if (/\.(html?|js)$/i.test(input)) {
    let html = fs.readFileSync(input, 'utf8');
    html = unwrapPreviewJs(html);
    if (!looksLikeSuperHtml(html)) throw new UnsupportedBuildError(describeUnknownHtml(html));
    ({ files, title, channel } = parseSuperHtml(html));
    kind = 'super-html';
  } else if (/\.zip$/i.test(input)) {
    const zipFiles = readZip(fs.readFileSync(input));
    const root = findBuildRoot(normalizeTree(zipFiles));
    if (root !== null) { files = zipFiles; kind = 'zip-web-mobile'; }
    else {
      // zip that contains a single playable html
      const htmlName = [...zipFiles.keys()].find(k => /\.html?$/i.test(k) && looksLikeSuperHtml(zipFiles.get(k).toString('utf8')));
      if (!htmlName) throw new UnsupportedBuildError('File zip không chứa build web-mobile hay playable super-html.');
      ({ files, title, channel } = parseSuperHtml(zipFiles.get(htmlName).toString('utf8')));
      kind = 'zip-super-html';
    }
  } else {
    throw new UnsupportedBuildError('Định dạng đầu vào chưa hỗ trợ: ' + path.basename(input));
  }

  files = normalizeTree(files);
  const root = findBuildRoot(files);
  if (root === null) {
    if ([...files.keys()].some(k => /cocos2d-js|src\/settings\.js$|_CCSettings/.test(k))) {
      throw new UnsupportedBuildError('Đây là build Cocos Creator 2.x — tool hiện chỉ hỗ trợ Cocos Creator 3.x.');
    }
    throw new UnsupportedBuildError('Không tìm thấy src/settings.json hoặc assets/main/config.json — có thể không phải build Cocos Creator 3.x.');
  }
  files = rebase(files, root);
  if (!title && files.has('index.html')) title = ((files.get('index.html').toString('utf8').match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
  return { files, title, channel, kind, source: path.resolve(input) };
}

/** AppLovin preview files wrap the whole page: al_renderHtml({"html": "<!DOCTYPE html>..."}) */
function unwrapPreviewJs(text) {
  const m = text.match(/^\s*al_renderHtml\s*\(/);
  if (!m) return text;
  const start = text.indexOf('(') + 1;
  const end = text.lastIndexOf(')');
  try {
    const obj = JSON.parse(text.slice(start, end));
    return typeof obj.html === 'string' ? obj.html : text;
  } catch { return text; }
}

function describeUnknownHtml(html) {
  const t = html.replace(/[A-Za-z0-9+/=]{300,}/g, '');
  if (/_CCSettings|cocos2d-js/.test(t)) return 'Đây là build Cocos Creator 2.x — tool hiện chỉ hỗ trợ Cocos Creator 3.x.';
  if (/Laya\.(init|stage)|laya\.core/i.test(t)) return 'Đây là build LayaAir, không phải Cocos Creator.';
  if (/new\s+Phaser\.Game|Phaser\.AUTO/.test(t)) return 'Đây là build Phaser, không phải Cocos Creator.';
  if (/PIXI\.Application/.test(t)) return 'Đây là build PixiJS, không phải Cocos Creator.';
  if (/createUnityInstance|UnityLoader/.test(t)) return 'Đây là build Unity, không phải Cocos Creator.';
  return 'File HTML này không phải playable super-html (không có window.__zip / window.__res).';
}

class UnsupportedBuildError extends Error {}

module.exports = { loadBuild, normalizeTree, stripMd5, findBuildRoot, parseSuperHtml, looksLikeSuperHtml, UnsupportedBuildError };
