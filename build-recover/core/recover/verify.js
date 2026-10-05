'use strict';
// Self-checks on the recovered project.
const fs = require('fs');
const path = require('path');

/** Compare a decoded build graph with the generated editor JSON (ids resolved). Returns { compared, diffs[] } */
function roundTrip(original, editorJson) {
  const objs = editorJson.map((o) => ({ ...o }));
  const res = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(res);
    if ('__id__' in v) return objs[v.__id__];
    if (v.__uuid__) return { __uuid__: v.__uuid__ };
    const o = {}; for (const k of Object.keys(v)) o[k] = res(v[k]); return o;
  };
  for (const o of objs) for (const k of Object.keys(o)) o[k] = res(o[k]);
  const ADDED = new Set(['_id', '__editorExtras__', '_objFlags', '_native', '__prefab', '_prefab', 'autoReleaseAssets', 'optimizationPolicy', 'persistent', '_name', '_enabled', '_parent', '_children', '_active', '_components', '_mobility', '_layer', '_lpos', '_lrot', '_lscale', '_euler']);
  let compared = 0;
  const diffs = [];
  const seen = new Set();
  (function cmp(a, g, p) {
    if (a === g) return;
    if (typeof a !== 'object' || a === null || typeof g !== 'object' || g === null) {
      if (!(a === undefined && g === null)) diffs.push(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(g)}`);
      return;
    }
    if (Array.isArray(a)) {
      if (!Array.isArray(g) || a.length !== g.length) { diffs.push(`${p}: độ dài mảng khác`); return; }
      a.forEach((x, i) => cmp(x, g[i], `${p}[${i}]`));
      return;
    }
    if (a.__uuid__) { if (a.__uuid__ !== g.__uuid__) diffs.push(`${p}: uuid khác`); return; }
    if (a.__custom__ !== undefined) { if (JSON.stringify(a.__custom__) !== JSON.stringify(g.content)) diffs.push(`${p}: nội dung custom khác`); return; }
    if (seen.has(a)) return;
    seen.add(a);
    compared++;
    if (a.__type__ !== g.__type__) diffs.push(`${p}: kiểu ${a.__type__} != ${g.__type__}`);
    for (const k of Object.keys(a)) {
      if (k === '_prefab' || k === '__prefab') continue; // intentionally rewritten
      if (!(k in g)) { diffs.push(`${p}.${k}: thiếu`); continue; }
      cmp(a[k], g[k], `${p}.${k}`);
    }
    for (const k of Object.keys(g)) if (!(k in a) && !ADDED.has(k) && k !== '__type__' && k !== 'content') diffs.push(`${p}.${k}: khóa thừa`);
  })(original, objs[0], 'root');
  return { compared, diffs };
}

/** Every {__uuid__} in the JSON must have a meta in the project (or be a builtin asset). */
function unresolvedRefs(json, knownUuids, isInternal) {
  const missing = new Set();
  (function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.__uuid__ && !knownUuids.has(v.__uuid__) && !isInternal(v.__uuid__)) missing.add(v.__uuid__);
    for (const k of Object.keys(v)) walk(v[k]);
  })(json);
  return [...missing];
}

const BASE_KEYS = new Set(['__type__', '_name', '_objFlags', '__editorExtras__', 'node', '_enabled', '__prefab', '_id']);

/** Serialized properties of custom components must exist as @property fields in the decompiled classes. */
function scriptPropertyCheck(docs, scripts) {
  const byCid = new Map();
  const byCcName = new Map();
  for (const s of scripts) {
    for (const c of s.classes || []) {
      if (s.cid && c === s.classes.find((x) => x.ccclass === s.rfName || x.name === s.rfName)) byCid.set(s.cid, { ...c, file: s.fileName });
      if (c.ccclass) byCcName.set(c.ccclass, { ...c, file: s.fileName });
    }
    if (s.cid && !byCid.has(s.cid) && s.classes && s.classes.length === 1) byCid.set(s.cid, { ...s.classes[0], file: s.fileName });
  }
  const problems = [];
  const missingClasses = new Set();
  for (const json of docs) {
    for (const o of json) {
      if (!o || !o.__type__ || /^(cc|sp|dragonBones)\./.test(o.__type__) || ENGINE_CLASSES.has(o.__type__)) continue;
      const cls = byCid.get(o.__type__) || byCcName.get(o.__type__);
      if (!cls) { missingClasses.add(o.__type__); continue; }
      for (const k of Object.keys(o)) {
        if (BASE_KEYS.has(k)) continue;
        if (!cls.fields.includes(k)) problems.push(`${cls.name} (${cls.file}): thuộc tính "${k}" có trong scene nhưng không thấy @property trong script`);
      }
    }
  }
  return { problems: [...new Set(problems)], missingClasses: [...missingClasses] };
}

// engine classes registered without the "cc." prefix
const ENGINE_CLASSES = new Set(['CCPropertyOverrideInfo', 'CCClass', 'TypedArrayRef']);

module.exports = { roundTrip, unresolvedRefs, scriptPropertyCheck };
