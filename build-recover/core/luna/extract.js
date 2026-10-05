'use strict';
// Read everything a Luna (Unity → Luna Playground) playable html embeds.
//
//   1. images:  <img id="assets/bundles/<bundle>/<id>.png" src="data:…;base64,…">, or data-src122="…"
//               (standard base122, html-escaped), or data-b122/data-b122m after the spy/network tools
//   2. everything else: decompressString / decompressArrayBuffer("<payload>", isBase122)
//               .then(function (x) { window.jsons|blobs|sounds["<key>"] = … })   — Brotli payloads
//   3. game code (Bridge.NET + Luna runtime): decompressString("…").then(function (code) { window.eval(code) })
// Same format knowledge as playable-converter/luna-core.js, rewritten for Node Buffers.
const zlib = require('zlib');

const LUNA_RE = /LunaCompilerV|Luna\.Unity\.(?:Playable|LifeCycle|Analytics)|LunaUnity\.Objects|window\._compressedAssets/;
const isLuna = (html) => LUNA_RE.test(html);

function readStringLiteral(html, quoteAt) {
  const quote = html[quoteAt];
  for (let j = quoteAt + 1; j < html.length; j++) {
    const c = html[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j;
    if (c === '\n') return -1;
  }
  return -1;
}

// payloads written back by tools may escape "</" or "<!--" to keep the <script> open
function unescapeJs(raw) {
  if (raw.indexOf('\\') < 0) return raw;
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] || e;
  });
}

const unescapeHtml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#39|#x27);/g, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'", '#x27': "'" })[e]);

/** Base122 decoder. Luna uses the standard 6-entry table; `short` lets callers pass the 7-entry variant. */
function base122(str, short = [0, 10, 13, 34, 38, 92]) {
  const out = Buffer.alloc(Math.ceil(str.length * 1.75) + 2);
  let n = 0, cur = 0, bits = 0;
  const push = (v) => {
    v = (v & 0x7f) << 1;
    cur |= v >>> bits;
    bits += 7;
    if (bits >= 8) { out[n++] = cur & 0xff; bits -= 8; cur = (v << (7 - bits)) & 0xff; }
  };
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) {
      const k = (c >>> 8) & 7;
      if (k !== 7) push(short[k]);
      push(c & 0x7f);
    } else push(c);
  }
  return out.subarray(0, n);
}

/** Every decompressString / decompressArrayBuffer call with a literal payload. */
function scanPayloads(html) {
  const out = [], re = /\b(decompressString|decompressArrayBuffer)\(\s*(["'])/g;
  let m;
  while ((m = re.exec(html))) {
    const quoteAt = m.index + m[0].length - 1;
    const close = readStringLiteral(html, quoteAt);
    if (close < 0) continue;
    const tail = html.slice(close + 1, close + 400);
    const flag = tail.match(/^\s*,\s*(true|false|!0|!1)\s*\)/);
    const base122Flag = !!flag && (flag[1] === 'true' || flag[1] === '!0');
    let store = 'unknown', key = '';
    const assign = tail.match(/^[^;]*?\.then\(\s*(?:function\s*)?\(?\s*\w*\s*\)?\s*(?:=>)?\s*\{?\s*window\.(\w+)\s*\[\s*["']([^"']+)["']\s*\]\s*=/);
    if (assign) { store = assign[1]; key = assign[2]; } else if (/^[^;]*?\.then\([^;]*?\beval\(/.test(tail)) { store = 'code'; key = 'code'; }
    out.push({ fn: m[1], base122: base122Flag, start: quoteAt + 1, end: close, store, key: key || 'payload@' + m.index });
    re.lastIndex = close + 1;
  }
  return out;
}

function decodePayload(html, e) {
  const raw = unescapeJs(html.slice(e.start, e.end));
  return zlib.brotliDecompressSync(e.base122 ? base122(raw) : Buffer.from(raw, 'base64'));
}

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'video/mp4': '.mp4' };

/** Attributes of the tag starting at `from` (just after the tag name). Quote-aware: base122 data holds raw '>'. */
function readAttributes(html, from) {
  const attrs = {};
  let i = from;
  const ws = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f';
  while (i < html.length) {
    while (ws(html[i])) i++;
    if (html[i] === '>' || (html[i] === '/' && html[i + 1] === '>')) break;
    const start = i;
    while (i < html.length && !ws(html[i]) && html[i] !== '=' && html[i] !== '>') i++;
    const name = html.slice(start, i).toLowerCase();
    if (!name) { i++; continue; }
    while (ws(html[i])) i++;
    if (html[i] !== '=') { attrs[name] = ''; continue; }
    i++;
    while (ws(html[i])) i++;
    const qc = html[i];
    if (qc === '"' || qc === "'") {
      const end = html.indexOf(qc, i + 1);
      if (end < 0) break;
      attrs[name] = html.slice(i + 1, end);
      i = end + 1;
    } else {
      const s = i;
      while (i < html.length && !ws(html[i]) && html[i] !== '>') i++;
      attrs[name] = html.slice(s, i);
    }
  }
  return { attrs, end: i };
}

/** <img|audio|video|source id="assets/…"> carrying data inline (data URI, data-src122, data-b122). */
function scanMedia(html) {
  const media = {};
  const re = /<(img|audio|video|source)\b/gi;
  let m;
  while ((m = re.exec(html))) {
    const { attrs, end } = readAttributes(html, m.index + m[0].length);
    re.lastIndex = Math.max(end, m.index + m[0].length);
    const id = attrs.id;
    if (!id) continue;
    let bytes = null, mime = '';
    const uri = (attrs.src || '').match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
    if (uri && uri[2] && uri[3]) { bytes = Buffer.from(uri[3], 'base64'); mime = uri[1]; }
    else if (attrs['data-src122'] != null || attrs['data-b122'] != null) {
      const spy = attrs['data-src122'] == null;
      // base122 never emits '&', so any entity in the attribute came from html escaping
      bytes = base122(unescapeHtml(spy ? attrs['data-b122'] : attrs['data-src122']));
      mime = (spy ? attrs['data-b122m'] : attrs['data-mime']) || (spy ? 'image/jpeg' : 'image/png');
    }
    if (!bytes || !bytes.length) continue;
    media[id] = { bytes, mime, ext: MIME_EXT[mime.toLowerCase()] || '' };
  }
  return media;
}

/**
 * → { jsons: {key: object}, blobs: {key: Buffer}, sounds: {key: Buffer}, other: {key: Buffer},
 *     media: {id: {bytes, mime, ext}}, code: string, title, warnings: [] }
 */
function extractLuna(html) {
  const res = { jsons: {}, blobs: {}, sounds: {}, other: {}, media: scanMedia(html), code: '', title: '', warnings: [] };
  res.title = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
  const code = [];
  for (const e of scanPayloads(html)) {
    let bytes;
    try { bytes = decodePayload(html, e); } catch (err) { res.warnings.push(`Không giải nén được payload ${e.key}: ${err.message}`); continue; }
    if (e.store === 'code') code.push(bytes.toString('utf8'));
    else if (e.store === 'jsons') {
      if (res.jsons[e.key]) continue;
      try { res.jsons[e.key] = JSON.parse(bytes.toString('utf8')); } catch (err) { res.warnings.push(`JSON ${e.key} hỏng: ${err.message}`); }
    } else if (e.store === 'blobs') res.blobs[e.key] = bytes;
    else if (e.store === 'sounds') res.sounds[e.key] = bytes;
    else res.other[e.key] = bytes;
  }
  // the runtime + game code: one or several chunks evaluated in order
  res.code = code.join('\n;\n');
  return res;
}

module.exports = { isLuna, extractLuna, scanPayloads, scanMedia, base122 };
