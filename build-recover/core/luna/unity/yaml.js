'use strict';
// Unity's YAML flavour: "--- !u!<classID> &<fileID>" documents of block mappings; sequences put "- " at the
// parent key's indentation; references and small structs (vectors, colours) are flow mappings on one line.

class Flow { constructor(obj) { this.obj = obj; } }
class Raw { constructor(text) { this.text = text; } }
/** {a: 1, b: 2} on one line */
const flow = (obj) => new Flow(obj);
/** emitted verbatim (hex blobs, keyword lists) */
const raw = (text) => new Raw(text);

/** Shortest decimal that reads back as the same float32 — how Unity itself prints floats. */
function num(n) {
  if (typeof n !== 'number') n = Number(n);
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(n)) return String(n);
  const f = Math.fround(n);
  if (f !== n && Math.abs(f - n) > Math.abs(n) * 1e-7) return String(n);   // a real double: keep it
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return String(s);
  }
  return String(f);
}

const PLAIN = /^[A-Za-z0-9_$][^:#\n\r\t{}\[\],&*!|>'"%@`]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d[\d.eE+-]*)$/i;
function str(s) {
  s = String(s);
  if (s === '') return '';
  if (PLAIN.test(s) && !/\s$/.test(s) && !RESERVED.test(s) && !/: |\s#/.test(s)) return s;
  return JSON.stringify(s);   // YAML double-quoted strings accept JSON escapes
}

function scalar(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Flow) return '{' + Object.entries(v.obj).filter(([, x]) => x !== undefined).map(([k, x]) => k + ': ' + scalar(x)).join(', ') + '}';
  if (v instanceof Raw) return v.text;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return typeof v === 'bigint' ? String(v) : num(v);
  return str(v);
}
const isScalar = (v) => v === null || v === undefined || typeof v !== 'object' || v instanceof Flow || v instanceof Raw;

function mapping(obj, indent, out) {
  const pad = ' '.repeat(indent);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (isScalar(v)) { const s = scalar(v); out.push(s === '' ? pad + k + ':' + (v === '' || v === null ? ' ' : '') : pad + k + ': ' + s); continue; }
    if (Array.isArray(v)) {
      if (!v.length) { out.push(pad + k + ': []'); continue; }
      out.push(pad + k + ':');
      sequence(v, indent, out);
      continue;
    }
    if (!Object.keys(v).length) { out.push(pad + k + ': {}'); continue; }
    out.push(pad + k + ':');
    mapping(v, indent + 2, out);
  }
}

function sequence(arr, indent, out) {
  const pad = ' '.repeat(indent);
  for (const item of arr) {
    if (isScalar(item)) { out.push(pad + '- ' + scalar(item)); continue; }
    if (Array.isArray(item)) {
      if (!item.length) { out.push(pad + '- []'); continue; }
      out.push(pad + '-');
      sequence(item, indent + 2, out);
      continue;
    }
    const lines = [];
    mapping(item, indent + 2, lines);
    if (!lines.length) { out.push(pad + '- {}'); continue; }
    lines[0] = pad + '- ' + lines[0].slice(indent + 2);
    out.push(...lines);
  }
}

/** docs: [{ classId, fileId, type, body, stripped }] → a Unity serialized file (scene, prefab, .mat, .asset…) */
function unityFile(docs) {
  const out = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];
  for (const d of docs) {
    out.push(`--- !u!${d.classId} &${d.fileId}${d.stripped ? ' stripped' : ''}`);
    out.push(d.type + ':');
    mapping(d.body, 2, out);
  }
  return out.join('\n') + '\n';
}

/** plain YAML (asset .meta files) */
function yamlDoc(obj) {
  const out = [];
  mapping(obj, 0, out);
  return out.join('\n') + '\n';
}

module.exports = { flow, raw, num, str, unityFile, yamlDoc, Flow, Raw };
