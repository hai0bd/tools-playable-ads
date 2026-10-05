'use strict';
// Luna playable (Unity → Luna Playground html) → Unity project.
const fs = require('fs');
const path = require('path');
const { extractLuna } = require('./extract');
const { LunaModel } = require('./model');
const { UnityProject } = require('./unity/project');
const tex = require('./unity/textures');
const assets = require('./unity/assets');
const mesh = require('./unity/mesh');
const anim = require('./unity/anim');
const scene = require('./unity/scene');
const settings = require('./unity/settings');
const cs = require('./unity/csharp');
const { Report } = require('../report');
const { sanitizeName } = require('../project/writer');
const { claimOutDir } = require('../util/outdir');

const STAT_NAMES = {
  textures: 'Texture', sprites: 'Sprite', spriteSheets: 'Texture nhiều sprite', audio: 'Âm thanh', textAssets: 'Text asset', materials: 'Material',
  standInShaders: 'Shader thay thế', meshes: 'Mesh', animationClips: 'Animation clip', animatorControllers: 'Animator controller',
  scriptableObjects: 'ScriptableObject', physicsMaterials: 'Physics material', prefabs: 'Prefab', scenes: 'Scene', gameObjects: 'GameObject',
  components: 'Component', monoBehaviours: 'MonoBehaviour', scripts: 'Script C#',
};

function renderReport(r, extra) {
  const f = r.facts, L = [];
  L.push(`# Báo cáo khôi phục project Unity — ${f.projectName}`, '');
  L.push(`Tạo bởi Build Recover lúc ${new Date().toISOString().replace('T', ' ').slice(0, 19)} từ \`${f.source}\` (playable Luna).`, '');
  L.push('## Thông tin bản build', '');
  L.push('| Mục | Giá trị |', '|---|---|');
  L.push(`| Unity | ${f.unityVersion || '?'} |`, `| Luna | ${f.lunaVersion || '?'} |`, `| Product name | ${f.productName || '-'} |`, `| Creative | ${f.creativeName || '-'} |`);
  L.push(`| Package | ${(f.packages || []).join(', ') || '-'} |`, '');
  L.push('## Đã khôi phục', '', '| Loại | Số lượng |', '|---|---|');
  for (const [k, v] of Object.entries(f.stats || {})) L.push(`| ${STAT_NAMES[k] || k} | ${v} |`);
  L.push('');
  L.push('## Cần làm khi mở project', '');
  (f.nextSteps || []).forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push('## Giới hạn (không có trong bản build Luna)', '');
  L.push('- **Script C#**: tên class, field serialize và kiểu dữ liệu là thật (dữ liệu trong scene/prefab gắn đúng). Thân hàm được dịch tự động từ JavaScript Bridge.NET về C# và để **trong comment** (biến cục bộ là `var`, tham số chưa có kiểu, tên biến là tên đã minify) — kiểm tra rồi bỏ comment từng hàm. Nhờ vậy project luôn compile được ngay khi mở.');
  L.push('- **Texture** ở độ phân giải Luna đã nén (thường nhỏ hơn bản gốc); PPU và border của sprite đã tính lại để kích thước trên màn hình giữ nguyên.');
  L.push('- **Shader tuỳ biến** chỉ có GLSL đã biên dịch: tool tạo shader thay thế cùng tên, cùng thuộc tính (unlit) trong `Assets/_Recovered/Shaders`.');
  L.push('- **Font** .ttf/.otf không có trong bản build (Luna chỉ giữ atlas chữ): Text dùng tạm font mặc định của Unity.');
  L.push('- **Model 3D** (.fbx) được tách thành từng Mesh asset (dữ liệu đỉnh chính xác, kể cả skin); prefab gốc của model, Avatar humanoid và cấu hình import không còn.');
  L.push('- Instance prefab trong scene đã bị Luna "unpack": scene chứa bản sao đầy đủ, không còn link về prefab.');
  L.push('- Lightmap, reflection probe, occlusion: Unity bake lại khi cần.');
  L.push('');
  if (r.warnings.length) { L.push('## Cảnh báo', ''); r.warnings.forEach((w) => L.push(`- ${w}`)); L.push(''); }
  if (r.notes.length) { L.push('## Ghi chú', ''); r.notes.forEach((w) => L.push(`- ${w}`)); L.push(''); }
  if (extra) L.push(extra);
  return L.join('\n') + '\n';
}

/**
 * @param {string} input Luna playable .html
 * @param {object} opts  { out, outRoot, name, sourceLabel, onProgress, log }
 */
function recoverLuna(input, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const report = new Report();
  onProgress(3, 'Đọc playable Luna...');
  const html = fs.readFileSync(input, 'utf8');
  const x = extractLuna(html);
  x.warnings.forEach((w) => report.warn(w));
  if (!x.code) throw new Error('Không tìm thấy code game Luna trong file (định dạng Luna quá cũ hoặc đã bị chỉnh sửa).');
  onProgress(15, 'Giải mã dữ liệu Unity...');
  const model = new LunaModel(x);
  model.errors.slice(0, 20).forEach((e) => report.warn('Giải mã: ' + e));
  const info = model.info;
  const name = sanitizeName(opts.name || info.creativeName || info.productName || x.title || path.basename(input).replace(/\.html?$/i, ''));
  const outDir = opts.out ? path.resolve(opts.out) : opts.outRoot ? claimOutDir(path.resolve(opts.outRoot), name) : path.resolve(path.join(process.cwd(), 'recovered', name));

  const p = new UnityProject(model, outDir, report, opts);
  onProgress(25, 'Lập kế hoạch asset...');
  tex.planTextures(p);
  assets.planAudio(p);
  assets.planText(p);
  assets.planFonts(p);
  assets.planPhysics(p);
  assets.planMaterials(p);
  mesh.planMeshes(p);
  anim.planClips(p);
  anim.planControllers(p);
  assets.planScriptables(p);
  scene.planScenesAndPrefabs(p);
  // Spine runtime (git package) when the game uses it, matching the skeleton version
  const spineUsed = [...model.components.values()].some(({ comp }) => /^Spine\./.test(comp.className)) || model.list('scriptable-objects').some((a) => /^Spine\./.test(a.className || ''));
  if (spineUsed) {
    p.needSpine = true;
    const js = model.list('text-assets').map((a) => (a.dto && a.dto.data) || '').find((t) => /"spine"\s*:\s*"\d/.test(t));
    const v = js && (js.match(/"spine"\s*:\s*"(\d+)\.(\d+)/) || []);
    if (v && v[1]) p.spineBranch = `${v[1]}.${v[2]}`;
  }

  const sceneFiles = [...p.files.values()].filter((f) => f.kind === 'scene');
  sceneFiles.sort((a, b) => (b.scene.dto && b.scene.dto.startup ? 1 : 0) - (a.scene.dto && a.scene.dto.startup ? 1 : 0) || (a.scene.dto.index || 0) - (b.scene.dto.index || 0));
  const ctx = settings.writeSettings(p, sceneFiles);

  onProgress(35, 'Ghi texture...');
  tex.writeTextures(p);
  onProgress(50, 'Ghi âm thanh, text, material...');
  assets.writeAudio(p);
  assets.writeText(p);
  assets.writePhysics(p);
  assets.writeMaterials(p);
  onProgress(58, 'Ghi mesh...');
  mesh.writeMeshes(p);
  onProgress(66, 'Ghi animation...');
  anim.writeClips(p);
  anim.writeControllers(p);
  assets.writeScriptables(p);
  onProgress(74, 'Ghi scene và prefab...');
  scene.writeScenesAndPrefabs(p, ctx);
  onProgress(88, 'Dựng script C#...');
  p.collectEventMethods();
  cs.writeScripts(p);

  // report
  const pkgs = String(info.packagesInfo || '').split(/\r?\n/).filter(Boolean);
  report.set('projectName', name);
  report.set('source', opts.sourceLabel || path.basename(input));
  report.set('unityVersion', info.unityVersion);
  report.set('lunaVersion', info.lunaVersion);
  report.set('productName', info.productName);
  report.set('creativeName', info.creativeName);
  report.set('packages', pkgs);
  report.set('stats', p.stats);
  if (p.unresolved.size) report.warn(`${p.unresolved.size} tham chiếu không tìm thấy trong bản build (để trống): ${[...p.unresolved].slice(0, 8).join(', ')}${p.unresolved.size > 8 ? ', …' : ''}`);
  if (p.missingFonts.size) report.warn(`Font không có trong bản build, dùng tạm font mặc định: ${[...p.missingFonts].join(', ')} — chép file font gốc vào đúng đường dẫn rồi gán lại cho Text.`);
  if (p.shaderStandIns && p.shaderStandIns.size) report.note(`Shader thay thế (unlit) cho: ${[...p.shaderStandIns.keys()].join(', ')}.`);
  if (p.webpDecoded) report.note(`${p.webpDecoded} texture Luna đã nén sang WebP (Unity không import được .webp): đã giải mã và ghi lại thành PNG — ảnh gốc là .jpg thì file giờ là .png.`);
  const next = [
    `Mở thư mục bằng Unity Hub (Add project from disk) với Unity ${info.unityVersion || '(phiên bản trong ProjectSettings/ProjectVersion.txt)'} — bản mới hơn cũng mở được, Unity tự nâng cấp.`,
  ];
  const requires = [];                                 // what has to be imported by hand (shown on the job card)
  if (pkgs.some((x) => /textmeshpro/.test(x)) || [...p.scripts.keys()].some((c) => /^TMPro\./.test(c))) {
    next.push('Window → TextMeshPro → Import TMP Essential Resources (font LiberationSans SDF, TMP Settings… mà scene tham chiếu).');
    requires.push('TMP Essentials');
  }
  if (p.needSpine && /^[4-9]\./.test(p.spineBranch || '4.1')) next.push(`Spine: Packages/manifest.json đã trỏ tới spine-unity ${p.spineBranch || ''} trên GitHub (cần mạng khi mở lần đầu); hoặc xoá dòng đó và import file .unitypackage spine-unity đúng phiên bản.`);
  const dotweenPro = p.packagesUsed.has('DOTween Pro');
  if (dotweenPro) {
    next.push('DOTween Pro (Asset Store, trả phí): import rồi chạy Tools → Demigiant → DOTween Utility Panel → Setup. Trước khi import, các component DOTween Pro (DOTweenAnimation, DOTweenPath, DOTweenVisualManager…) báo "Missing Script"; GUID đã khớp bản chính thức nên import xong tự nối lại.');
    requires.push('DOTween Pro');
  } else if (p.usesDOTween || p.packagesUsed.has('DOTween') || /\bDG\.Tweening\.DOTween\b/.test(x.code)) {
    next.push('DOTween: import DOTween (Asset Store, miễn phí) rồi chạy Tools → Demigiant → DOTween Utility Panel → Setup.');
    requires.push('DOTween');
  }
  if (p.needSpine && !/^[4-9]\./.test(p.spineBranch || '')) {
    next.push(`Spine ${p.spineBranch || '3.x'}: import file spine-unity ${p.spineBranch || ''} .unitypackage (esotericsoftware.com/spine-unity-download) — bản 3.x không cài được qua Package Manager. Trước khi import, mọi SkeletonAnimation/SkeletonGraphic và asset Spine báo "Missing Script"; GUID trong project đã khớp bản chính thức nên import xong tự nối lại.`);
    requires.push(`Spine ${p.spineBranch || '3.x'}`);
  }
  report.set('requires', requires);
  const missing = [...p.scripts].filter(([, s]) => s.missing).map(([c]) => c);
  if (missing.length) report.warn(`Component thuộc package chưa có GUID (để "Missing Script" cho tới khi import package gốc): ${missing.join(', ')}.`);
  next.push(`Mở scene ${sceneFiles[0] ? sceneFiles[0].rel : ''}. Script trong Assets/Scripts: bỏ comment phần C# đã dịch của từng hàm, sửa kiểu tham số/biến cho khớp rồi chạy thử.`);
  report.set('nextSteps', next);
  const reportText = renderReport(report);
  p.out.write('RECOVERY_REPORT.md', reportText);
  onProgress(100, 'Xong');
  return {
    outDir, report, stats: p.stats, name, engine: 'unity', engineVersion: info.unityVersion, creatorVersion: null,
    files: p.out.count, bytes: p.out.bytes, project: opts.returnProject ? p : undefined,
  };
}

module.exports = { recoverLuna };
