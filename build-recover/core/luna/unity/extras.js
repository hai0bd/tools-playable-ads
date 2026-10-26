'use strict';
// What a recovered project needs besides its own scripts before the game's code can compile once uncommented:
//   - a stub of the Luna SDK API the game calls (Luna.Unity.Playable.InstallFullGame(), Analytics.LogEvent…) — the SDK
//     is a Luna plugin, not in the build;
//   - DOTween, copied from a copy the user already has (a Unity project or an unzipped DOTween download). DOTween is not
//     on any package registry and its license does not let this tool redistribute it, so it never ships with the tool.
const fs = require('fs');
const path = require('path');
const { importers } = require('./project');
const ids = require('./ids');

// ---------------------------------------------------------------- Luna SDK stub
/** Luna.Unity.* members the game's code uses → { Cls: { methods:Set, enums:Map(name→Set), events:Set, values:Set } } */
function lunaUsage(model) {
  const api = {};
  const cls = (n) => (api[n] = api[n] || { methods: new Set(), enums: new Map(), events: new Set(), values: new Set() });
  for (const t of model.types.values()) {
    const src = [...Object.values(t.methods), ...Object.values(t.statics.methods), ...Object.values(t.props), t.init, t.statics.init].join('\n');
    for (const m of src.matchAll(/Luna\.Unity\.([A-Za-z_]\w*)((?:\.[A-Za-z_][\w$]*)+)(\s*\(|\s*[+-]=)?/g)) {
      const parts = m[2].slice(1).split('.').map((s) => s.replace(/\$\d+$/, ''));
      const c = cls(m[1]);
      const tail = (m[3] || '').trim();
      if (parts.length === 1) {
        if (tail === '(') c.methods.add(parts[0]);
        else if (/[+-]=/.test(tail)) c.events.add(parts[0]);
        else c.values.add(parts[0]);
      } else if (parts.length === 2 && tail !== '(') {
        if (!c.enums.has(parts[0])) c.enums.set(parts[0], new Set());
        c.enums.get(parts[0]).add(parts[1]);
      }
    }
  }
  return api;
}

function lunaStubSource(api) {
  const L = [
    '// Stub của Luna SDK do Build Recover tạo: chỉ gồm các API mà code game gọi, để script compile được khi bỏ comment.',
    '// Gọi hàm chỉ ghi log. Xoá file này khi import plugin Luna thật (trùng namespace Luna.Unity).',
    'using UnityEngine;', '', 'namespace Luna.Unity', '{',
  ];
  for (const [name, c] of Object.entries(api).sort()) {
    L.push(`    public static class ${name}`, '    {');
    for (const [en, members] of c.enums) L.push(`        public enum ${en}`, '        {', ...[...members].sort().map((x) => `            ${x},`), '        }', '');
    for (const e of [...c.events].sort()) L.push(`        public static System.Action ${e};`);
    for (const v of [...c.values].sort()) if (!c.enums.has(v) && !c.methods.has(v)) L.push(`        public static object ${v};`);
    for (const mth of [...c.methods].sort()) {
      L.push(`        public static void ${mth}(params object[] args)`, '        {', `            Debug.Log("[Luna stub] ${name}.${mth}(" + string.Join(", ", args) + ")");`, '        }', '');
    }
    while (L[L.length - 1] === '') L.pop();
    L.push('    }', '');
  }
  while (L[L.length - 1] === '') L.pop();
  L.push('}');
  return L.join('\n') + '\n';
}

function writeLunaStub(p) {
  const api = lunaUsage(p.typeModel);
  if (!Object.keys(api).length) return null;
  const rel = p.claim('Assets/_Recovered/Scripts/LunaStub.cs');
  p.out.write(rel, lunaStubSource(api));
  p.out.meta(rel, ids.guidOf(rel), importers.mono());
  p.count('scripts');
  return rel;
}

// ---------------------------------------------------------------- DOTween
const SKIP_DIRS = /^(Library|Temp|Logs|obj|node_modules|\.git|PackageCache)$/;

/** Folder holding DOTween.dll under `root` (itself, Assets/Plugins/Demigiant/DOTween…, or a search a few levels down). */
function findDOTween(root) {
  if (!root || !fs.existsSync(root)) return null;
  const direct = ['', 'DOTween', 'Demigiant/DOTween', 'Plugins/Demigiant/DOTween', 'Assets/Plugins/Demigiant/DOTween', 'Assets/Demigiant/DOTween'];
  for (const d of direct) if (fs.existsSync(path.join(root, d, 'DOTween.dll'))) return path.join(root, d);
  let found = null;
  (function search(dir, depth) {
    if (found || depth > 6) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (list.some((e) => !e.isDirectory() && e.name === 'DOTween.dll')) { found = dir; return; }
    for (const e of list) if (e.isDirectory() && !SKIP_DIRS.test(e.name)) search(path.join(dir, e.name), depth + 1);
  })(root, 0);
  return found;
}

/**
 * Copies DOTween (with its .meta files, so GUIDs stay the official ones) into Assets/Plugins/Demigiant.
 * The whole Demigiant folder goes when DOTween sits in one (DOTween Pro, DemiLib come along).
 * → { from, pro } or null
 */
function copyDOTween(p, root) {
  const dir = findDOTween(root);
  if (!dir) return null;
  const parent = path.dirname(dir);
  const src = path.basename(parent) === 'Demigiant' ? parent : dir;
  const destBase = path.basename(parent) === 'Demigiant' ? 'Assets/Plugins/Demigiant' : 'Assets/Plugins/Demigiant/DOTween';
  let pro = false;
  const copyDir = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), rel = to + '/' + e.name;
      if (e.isDirectory()) {
        if (/Examples?$/i.test(e.name)) continue;   // DOTweenPro Examples: demo scenes the game does not need
        if (/^DOTweenPro$/.test(e.name)) pro = true;
        copyDir(a, rel);
        continue;
      }
      if (/Examples?\.meta$/i.test(e.name)) continue;
      p.out.write(rel, fs.readFileSync(a));
      // a file the source keeps without .meta still needs one (folders: Unity makes their .meta itself)
      if (!/\.meta$/.test(e.name) && !fs.existsSync(a + '.meta')) p.out.meta(rel, ids.guidOf(rel), importers.default());
      p.count('dotweenFiles');
    }
  };
  copyDir(src, destBase);
  return { from: dir, pro };
}

module.exports = { lunaUsage, lunaStubSource, writeLunaStub, findDOTween, copyDOTween };
