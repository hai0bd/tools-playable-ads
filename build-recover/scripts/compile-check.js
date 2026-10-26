#!/usr/bin/env node
'use strict';
/* Compile the C# of a recovered Unity project with the Roslyn compiler shipped inside a Unity editor — without
 * opening Unity. Checks the promise the script writer makes: the project compiles as soon as it opens.
 *
 *   node scripts/compile-check.js <project> [--unity <Editor/Data>] [--refs <dir with UnityEngine.UI.dll, …>]
 *
 * --unity  Editor/Data of a Unity install (default: newest 2022/2021 under Unity Hub's Editor folder, or UNITY_EDITOR_DATA)
 * --refs   folder(s) with the package assemblies the scripts use (UnityEngine.UI, Unity.TextMeshPro, spine-*) — the
 *          Library/ScriptAssemblies of any project that has those packages (or BUILD_RECOVER_UNITY_REFS, ';'-separated)
 * Exit code 0 = compiles; errors are printed as file(line,col): error CSxxxx.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function findUnityData() {
  if (process.env.UNITY_EDITOR_DATA && fs.existsSync(process.env.UNITY_EDITOR_DATA)) return process.env.UNITY_EDITOR_DATA;
  const roots = ['C:/Program Files/Unity/Hub/Editor', '/Applications/Unity/Hub/Editor', path.join(os.homedir(), 'Unity/Hub/Editor')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const versions = fs.readdirSync(r).filter((v) => /^20\d\d\./.test(v)).sort().reverse();
    for (const v of versions) {
      const d = [path.join(r, v, 'Editor', 'Data'), path.join(r, v, 'Unity.app', 'Contents')].find((x) => fs.existsSync(path.join(x, 'DotNetSdkRoslyn', 'csc.dll')));
      if (d) return d;
    }
  }
  return null;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(Editor)$/.test(e.name)) walk(p, out); } else if (/\.cs$/.test(e.name)) out.push(p);
  }
  return out;
}

/** → { ok, errors: [string], skipped?: reason } */
function compileCheck(project, opts = {}) {
  const data = opts.unity || findUnityData();
  if (!data) return { ok: false, skipped: 'không tìm thấy Unity (Roslyn) trên máy' };
  const dotnet = [path.join(data, 'NetCoreRuntime', 'dotnet.exe'), path.join(data, 'NetCoreRuntime', 'dotnet')].find((x) => fs.existsSync(x));
  const csc = path.join(data, 'DotNetSdkRoslyn', 'csc.dll');
  const refDirs = [...(opts.refs || []), ...(process.env.BUILD_RECOVER_UNITY_REFS || '').split(';').filter(Boolean)];
  const refs = [
    path.join(data, 'NetStandard', 'ref', '2.1.0', 'netstandard.dll'),
    path.join(data, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx', 'mscorlib.dll'),
    path.join(data, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx', 'System.Core.dll'),
    ...fs.readdirSync(path.join(data, 'Managed', 'UnityEngine')).filter((f) => /\.dll$/.test(f)).map((f) => path.join(data, 'Managed', 'UnityEngine', f)),
  ];
  for (const d of refDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/^(UnityEngine\.UI|Unity\.TextMeshPro|spine-csharp|spine-unity|DOTween)\.dll$/.test(f)) refs.push(path.join(d, f));
  }
  // plugins inside the project (DOTween, DOTweenPro, DemiLib…): their runtime dlls, not the Editor ones
  const dlls = [];
  (function findDll(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'Editor') findDll(p); } else if (/\.dll$/i.test(e.name) && !/Editor/i.test(e.name)) dlls.push(p);
    }
  })(path.join(project, 'Assets'));
  refs.push(...dlls);
  const sources = walk(path.join(project, 'Assets'));
  if (!sources.length) return { ok: true, errors: [] };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'br-csc-'));
  const rsp = path.join(out, 'build.rsp');
  const q = (s) => '"' + s.replace(/\\/g, '/') + '"';
  fs.writeFileSync(rsp, [
    '-target:library', '-nologo', '-langversion:9.0', '-nowarn:0168,0219,0414,0649,0169,0108,0114,0162,0429,0618,0067',
    '-define:UNITY_5_3_OR_NEWER;UNITY_2017_1_OR_NEWER;UNITY_2019_1_OR_NEWER;UNITY_2020_1_OR_NEWER;UNITY_2021_1_OR_NEWER;UNITY_2022_1_OR_NEWER',
    '-out:' + q(path.join(out, 'Check.dll')),
    ...[...new Set(refs)].filter((r) => fs.existsSync(r)).map((r) => '-r:' + q(r)),
    ...sources.map(q),
  ].join('\n'));
  const r = spawnSync(dotnet, [csc, '@' + rsp], { encoding: 'utf8', maxBuffer: 64 << 20 });
  fs.rmSync(out, { recursive: true, force: true });
  const text = (r.stdout || '') + (r.stderr || '');
  const errors = text.split(/\r?\n/).filter((l) => /error CS\d+/.test(l)).map((l) => l.replace(project.replace(/\//g, '\\'), '').replace(project, ''));
  return { ok: r.status === 0 && !errors.length, errors };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const o = { refs: [] };
  let project = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--unity') o.unity = args[++i];
    else if (args[i] === '--refs') o.refs.push(args[++i]);
    else project = args[i];
  }
  if (!project) { console.error('Cách dùng: node scripts/compile-check.js <project> [--unity <Editor/Data>] [--refs <dir>]'); process.exit(2); }
  const r = compileCheck(path.resolve(project), o);
  if (r.skipped) { console.log('Bỏ qua: ' + r.skipped); process.exit(0); }
  r.errors.slice(0, 80).forEach((e) => console.log(e));
  console.log(r.ok ? '✔ compile được' : `✘ ${r.errors.length} lỗi`);
  process.exit(r.ok ? 0 : 1);
}

module.exports = { compileCheck, findUnityData };
