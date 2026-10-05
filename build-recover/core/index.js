'use strict';
// cocos-build-recover: rebuild a Cocos Creator 3.x project from a build (web-mobile folder / zip / super-html playable).
const fs = require('fs');
const path = require('path');
const { loadBuild, UnsupportedBuildError } = require('./extract');
const { loadBundles, loadSettings } = require('./decode/bundle');
const { AssetDB } = require('./recover/assetdb');
const { Planner } = require('./recover/plan');
const { Exporter } = require('./recover/export');
const { walkNodes } = require('./recover/editorjson');
const verify = require('./recover/verify');
const { ProjectWriter, sanitizeName } = require('./project/writer');
const { findEditors, pickEditor } = require('./project/editors');
const { refreshVersionsFromEditor, meta } = require('./project/metas');
const { detectModules, buildEngineJson } = require('./project/modules');
const { writeSkeleton } = require('./project/skeleton');
const { decompileBundles } = require('./scripts/decompile');
const { deobfuscate, cleanup } = require('./scripts/deobfuscate');
const { Report, renderReport } = require('./report');
const { stableUuid } = require('./util/uuid');
const { claimOutDir } = require('./util/outdir');

function projectNameFrom(build) {
  const m = (build.title || '').match(/Cocos Creator\s*\|\s*(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  return path.basename(build.source).replace(/\.(html?|zip|js)$/i, '');
}

/** uuid -> { tsFile, metaFile } for every script in the reference folders */
function scanReferenceScripts(dirs) {
  const map = new Map();
  for (const dir of dirs || []) {
    if (!dir || !fs.existsSync(dir)) continue;
    (function walk(d, depth) {
      if (depth > 12) return;
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!/^(node_modules|library|temp|build|\.git)$/.test(e.name)) walk(p, depth + 1); continue; }
        if (!e.name.endsWith('.ts.meta')) continue;
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8'));
          const ts = p.slice(0, -5);
          if (m.uuid && fs.existsSync(ts) && !map.has(m.uuid)) map.set(m.uuid, { tsFile: ts, metaFile: p });
        } catch { /* ignore broken metas */ }
      }
    })(dir, 0);
  }
  return map;
}

function relImport(fromRel, toRel) {
  let r = path.posix.relative(path.posix.dirname(fromRel), toRel.replace(/\.ts$/, ''));
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

function recoverScripts(build, bundles, writer, report, opts) {
  const results = [];
  const refs = scanReferenceScripts(opts.reference);
  let total = 0, fromRef = 0;
  // every bundle in one pass: scripts of a bundle may import scripts of main / other bundles
  const sources = [];
  for (const [bname, bundle] of bundles) {
    if (bname === 'internal') continue;
    const key = bundle.prefix + 'index.js';
    if (build.files.has(key)) sources.push({ code: build.files.get(key).toString('utf8'), tag: bname });
  }
  const dirOf = (tag) => (!tag || tag === 'main' ? 'assets/Scripts' : `assets/${tag}/Scripts`);
  const fileOf = new Map();
  const helpersRel = 'assets/Scripts/_babelHelpers.ts';
  let needHelpers = false;
  const inlineHelpers = new Map();   // helper name -> { local, src } (builds that inline the Babel helpers)
  const r = sources.length ? decompileBundles(sources, {
    warn: (w) => report.warn(w),
    onUnmerge: (um) => {
      for (const [k, v] of um.helperSources || []) if (!inlineHelpers.has(k)) inlineHelpers.set(k, v);
      report.note(`Build gộp toàn bộ script vào một module: đã tách lại thành từng file theo _RF (${um.merged} module gộp).`);
    },
    planPaths: (entries) => { for (const e of entries) fileOf.set(e.id, writer.claim(dirOf(e.tag), e.fileName.replace(/\.(ts|js)$/, ''), '.ts')); },
    pathOf: (from, to) => relImport(fileOf.get(from.id), fileOf.get(to.id)),
    helpersImport: (e) => { needHelpers = true; return relImport(fileOf.get(e.id), helpersRel); },
  }) : { modules: [], deobfuscated: 0 };
  for (const m of r.modules) {
    const rel = fileOf.get(m.id) || writer.claim(dirOf(m.tag), m.fileName.replace(/\.(ts|js)$/, ''), '.ts');
    const ref = m.uuid && refs.get(m.uuid);
    if (ref) {
      writer.write(rel, fs.readFileSync(ref.tsFile));
      writer.writeMeta(rel, JSON.parse(fs.readFileSync(ref.metaFile, 'utf8')));
      fromRef++;
      report.note(`Script ${path.posix.basename(rel)}: dùng bản gốc từ ${ref.tsFile} (cùng uuid).`);
    } else {
      writer.write(rel, m.error ? `// Dịch ngược thất bại: ${m.error}\n` : m.code);
      writer.writeMeta(rel, meta('typescript', m.uuid || stableUuid('script:' + m.id)));
      for (const w of m.warnings || []) report.note(`${path.posix.basename(rel)}: ${w}`);
    }
    total++;
    results.push({ ...m, rel, cid: m.rf && m.rf.cid, rfName: m.rf && m.rf.name, fromReference: !!ref });
  }
  if (needHelpers) writeHelpersModule(build, writer, helpersRel, report, [...new Set(r.modules.flatMap((m) => m.needsHelpers || []))], inlineHelpers);
  report.set('scripts', { total, fromReference: fromRef, deobfuscated: r.deobfuscated });
  return results;
}

/** Babel helpers still referenced by decompiled code: extract them from src/chunks/bundle.js */
function writeHelpersModule(build, writer, rel, report, names, inlineHelpers) {
  const key = [...build.files.keys()].find((k) => /^src\/chunks\/bundle\.js$/.test(k));
  if (!key && inlineHelpers && inlineHelpers.size) {
    // merged builds: the helpers were inlined in the script module; the functions call each other by local name
    const fns = [...inlineHelpers.values()].map((h) => h.src).join('\n\n');
    const exportsCode = names.filter((n) => inlineHelpers.has(n)).map((n) => `export { ${inlineHelpers.get(n).local} as ${n} };`).join('\n');
    const missing = names.filter((n) => !inlineHelpers.has(n));
    writer.write(rel, `// @ts-nocheck\n// Helper Babel trích từ bản build (được nội tuyến trong module script). Có thể xoá khi các script không còn import file này.\n${fns}\n\n${exportsCode}\n`);
    writer.writeMeta(rel, meta('typescript', stableUuid('babel-helpers:' + rel)));
    report.warn(`Một số script còn dùng helper Babel — tạm import từ ${rel}.${missing.length ? ' Thiếu helper: ' + missing.join(', ') + '.' : ''}`);
    return;
  }
  if (!key) { report.warn('Script cần helper Babel nhưng không tìm thấy src/chunks/bundle.js.'); return; }
  const code = cleanup(deobfuscate(build.files.get(key).toString('utf8')).code);
  let helperCall = '';
  try {
    const parser = require('@babel/parser');
    const traverse = require('@babel/traverse').default;
    const generate = require('@babel/generator').default;
    traverse(parser.parse(code, { sourceType: 'script', errorRecovery: true }), {
      CallExpression(p) {
        const a = p.node.arguments[0];
        if (a && a.type === 'StringLiteral' && /rollupPluginModLoBabelHelpers/.test(a.value)) { helperCall = generate(p.node).code + ';'; p.stop(); }
      },
    });
  } catch { /* leave empty */ }
  if (!helperCall) { report.warn('Không trích được helper Babel từ src/chunks/bundle.js.'); return; }
  // reserved words (e.g. "extends") cannot be binding names: export them through an alias
  const exportsCode = names.map((n) => `const __h_${n.replace(/\W/g, '_')} = __helpers[${JSON.stringify(n)}];\nexport { __h_${n.replace(/\W/g, '_')} as ${n} };`).join('\n');
  const body = `// @ts-nocheck\n// Helper Babel trích từ bản build (src/chunks/bundle.js). Có thể xoá khi các script không còn import file này.\nconst __helpers: any = {};\nconst System = { register(_id: string, _deps: string[], factory: any) { const mod = factory((name: any, value: any) => { if (typeof name === 'object') Object.assign(__helpers, name); else __helpers[name] = value; }); mod.execute(); } };\n${helperCall}\n${exportsCode}\n`;
  writer.write(rel, body);
  writer.writeMeta(rel, meta('typescript', stableUuid('babel-helpers:' + rel)));
  report.warn(`Một số script còn dùng helper Babel (vd. async/await, for...of) — tạm import từ ${rel}. Có thể viết lại thành cú pháp TS gốc rồi xoá file này.`);
}

function usedComponentTypes(db) {
  const types = new Set();
  const add = (root) => walkNodes(root, (n) => (n._components || []).forEach((c) => types.add(c.__type__)));
  for (const r of db.ofType('cc.SceneAsset')) if (r.root && r.root.scene) add(r.root.scene);
  for (const r of db.ofType('cc.Prefab')) if (r.root && r.root.data) add(r.root.data);
  for (const t of db.records.values()) if (t.type) types.add(t.type);
  return types;
}

function spineVersionOf(db) {
  for (const r of db.ofType('sp.SkeletonData')) {
    const v = r.root && r.root._skeletonJson && r.root._skeletonJson.skeleton && r.root._skeletonJson.skeleton.spine;
    if (v) return String(v);
  }
  return '3.8';
}

function isEmptyDir(d) {
  return !fs.existsSync(d) || fs.readdirSync(d).length === 0;
}

/** A Luna (Unity) playable? Only the head and tail of the file are read — builds are several MB. */
function isLunaFile(input) {
  if (!/\.html?$/i.test(input)) return false;
  const buf = fs.readFileSync(input);
  const probe = buf.length > 262144 ? Buffer.concat([buf.subarray(0, 131072), buf.subarray(buf.length - 131072)]) : buf;
  return require('./luna/extract').isLuna(probe.toString('latin1')) || require('./luna/extract').isLuna(buf.toString('latin1'));
}

/**
 * @param {string} input path to .html / .zip / build folder
 * @param {object} opts { out, force, name, creator, reference: [dirs], log }
 */
function recover(input, opts = {}) {
  // Luna playables are Unity projects: separate pipeline, Unity project out
  if (!fs.statSync(input).isDirectory() && isLunaFile(input)) return require('./luna').recoverLuna(input, opts);
  const log0 = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const log = (msg, pct) => { log0(msg); if (pct !== undefined) onProgress(pct, msg); };
  const report = new Report();
  log('Đọc bản build...', 2);
  const build = loadBuild(input);
  const settings = loadSettings(build.files);
  const engineVersion = settings && settings.CocosEngine;
  const bundles = loadBundles(build.files);
  if (!bundles.has('main')) throw new UnsupportedBuildError('Không tìm thấy bundle "main" trong bản build.');
  const name = sanitizeName(opts.name || projectNameFrom(build));
  const outDir = opts.out ? path.resolve(opts.out) : opts.outRoot ? claimOutDir(path.resolve(opts.outRoot), name) : path.resolve(path.join(process.cwd(), 'recovered', name));
  if (!isEmptyDir(path.join(outDir, 'assets')) && !opts.force) {
    throw new Error(`Thư mục đích đã có assets: ${outDir}\nDùng --force để ghi đè, hoặc chọn --out khác.`);
  }
  report.set('projectName', name);
  report.set('source', opts.sourceLabel || build.source);   // browser: the user's file name, not the virtual path
  report.set('kind', build.kind);
  report.set('engineVersion', engineVersion);
  report.set('channel', build.channel);
  report.set('bundles', [...bundles.keys()]);
  if (settings && settings.launch) report.set('launchScene', settings.launch.launchScene);
  if (settings && settings.screen && settings.screen.designResolution) {
    const d = settings.screen.designResolution;
    report.set('designResolution', `${d.width}x${d.height} (policy ${d.policy})`);
  }

  // opts.editors: the browser build has no disk to search and passes the editor its snapshot came from
  const editors = opts.editors || findEditors(opts.editorRoots || []);
  const editor = opts.creator ? editors.find((e) => e.version === opts.creator) || { version: opts.creator } : pickEditor(engineVersion, editors);
  if (editor && editor.engine) refreshVersionsFromEditor(editor.engine);
  const creatorVersion = (editor && editor.version) || engineVersion || '3.8.7';
  report.set('creatorVersion', creatorVersion);

  log('Giải mã asset...', 12);
  const db = new AssetDB(bundles, report);
  const writer = new ProjectWriter(outDir);
  const planner = new Planner(db, writer, report);
  planner.analyzeUsage();
  log('Xuất asset...', 25);
  const exporter = new Exporter({ db, writer, planner, report, options: { ...opts, onStep: (i, n, step) => onProgress(25 + Math.round((i / n) * 45), `Xuất asset: ${step}`) } });
  const stats = exporter.run();

  log('Dịch ngược script...', 72);
  const scripts = opts.noScripts ? [] : recoverScripts(build, bundles, writer, report, opts);
  stats.scripts = scripts.length;

  log('Tạo cấu hình project...', 88);
  const det = detectModules(build.files, usedComponentTypes(db), spineVersionOf(db));
  writeSkeleton(writer, { name, creatorVersion, settings, engineJson: buildEngineJson(det), superHtml: /super-html/.test(build.kind) });
  const special = {};
  for (const bname of bundles.keys()) {
    if (bname === 'main' || bname === 'internal') continue;
    special[`assets/${bname}`] = { isBundle: true, bundleConfigID: 'default', bundleName: bname, priority: bname === 'resources' ? 8 : 1 };
  }
  writer.writeFolderMetas(special);
  const logo = settings && settings.splashScreen && settings.splashScreen.logo;
  if (logo && logo.type === 'custom' && logo.base64) {
    writer.write('_recovered/splash_logo.png', Buffer.from(logo.base64.slice(logo.base64.indexOf(',') + 1), 'base64'));
    report.note('Logo splash tùy biến của bản build được lưu ở _recovered/splash_logo.png (chọn lại trong Build panel → Splash Screen nếu cần).');
  }

  log('Tự kiểm tra...', 92);
  const checks = [];
  const known = new Set(writer.uuids);
  const docs = [];
  for (const rec of [...db.ofType('cc.SceneAsset'), ...db.ofType('cc.Prefab')]) {
    const rel = rec.plannedPath;
    if (!rel) continue;
    const json = JSON.parse(fs.readFileSync(writer.abs(rel), 'utf8'));
    docs.push(json);
    const rt = verify.roundTrip(rec.root, json);
    checks.push(`${rel}: so khớp ${rt.compared} object với dữ liệu build — ${rt.diffs.length ? rt.diffs.length + ' khác biệt' : 'khớp hoàn toàn'}`);
    rt.diffs.slice(0, 5).forEach((d) => report.warn(`${rel}: ${d}`));
    const miss = verify.unresolvedRefs(json, known, (u) => db.isInternal(u));
    if (miss.length) report.warn(`${rel}: ${miss.length} tham chiếu asset không có trong project (${miss.slice(0, 3).join(', ')}${miss.length > 3 ? ', ...' : ''})`);
  }
  if (scripts.length) {
    const sc = verify.scriptPropertyCheck(docs, scripts);
    checks.push(`Script: ${sc.problems.length ? sc.problems.length + ' thuộc tính lệch' : 'mọi thuộc tính dùng trong scene/prefab đều có @property tương ứng'}`);
    sc.problems.slice(0, 20).forEach((p) => report.warn(p));
    sc.missingClasses.forEach((c) => report.warn(`Scene/prefab dùng class "${c}" nhưng không tìm thấy script tương ứng trong build.`));
  }
  report.set('verification', checks);
  report.set('stats', stats);
  const next = [`Mở thư mục ${outDir} bằng Cocos Creator ${creatorVersion} (Dashboard → Add project).`];
  if (settings && settings.launch) next.push(`Mở scene ${settings.launch.launchScene.replace('db://', '')} rồi bấm Save (Ctrl+S) để editor chuẩn hoá lại file scene.`);
  if (/super-html/.test(build.kind)) next.push('Bản build là playable super-html: cài extension super-html vào thư mục extensions/ và chọn "Native Code Bundle Mode = AsmJS" khi build.');
  report.set('nextSteps', next);
  writer.write('RECOVERY_REPORT.md', renderReport(report));
  onProgress(100, 'Xong');
  return { outDir, report, stats, name, creatorVersion };
}

module.exports = { recover, UnsupportedBuildError, claimOutDir };
