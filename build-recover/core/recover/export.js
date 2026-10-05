'use strict';
// Export every recovered asset into the project: files + .meta with the original uuids.
const path = require('path');
const { meta, subMeta } = require('../project/metas');
const { isPNG, decodePNG, encodePNG, alphaBBox, extractSprite } = require('../util/png');
const { toEditorJSON, preparePrefab, unlinkScenePrefabs, convertDynamicDoc, normalizeMaterialJSON } = require('./editorjson');
const { decompressUuid } = require('../util/uuid');
const { ModelExporter } = require('./model');

const FILTER = { 0: 'none', 1: 'nearest', 2: 'linear' };
const WRAP = { 0: 'repeat', 1: 'mirrored-repeat', 2: 'clamp-to-edge', 3: 'clamp-to-border' };
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
const eqRect = (a, c) => a.x === c.x && a.y === c.y && a.width === c.width && a.height === c.height;
// fixed sub-asset ids of the 6 faces of a cube map
const CUBE_FACES = { front: 'e9a6d', back: '40c10', top: 'bb97f', bottom: '7d38f', right: '74afd', left: '8fd34' };

/**
 * Rebuild an equirectangular panorama (4s x 2s) from cube faces, inverse of the Cocos ERP importer:
 *   dir(u, v) = (-cos(2pi u) cos(lat), sin(lat), -sin(2pi u) cos(lat)),  lat = (0.5 - v) pi
 *   front (s,-t,1)  back (-s,-t,-1)  right (1,-t,-s)  left (-1,-t,s)  top (s,1,t)  bottom (s,-1,-t)
 * RGBE data is sampled with nearest filtering (encoded values cannot be interpolated).
 */
function stitchPanorama(faces, size, nearest) {
  const W = size * 4, H = size * 2;
  const out = Buffer.alloc(W * H * 4);
  const ch = (img) => img.data.length / (img.width * img.height);
  const sample = (img, fx, fy, o) => {
    const c = ch(img), w = img.width, h = img.height;
    const cl = (v, m) => (v < 0 ? 0 : v > m ? m : v);
    if (nearest) {
      const x = cl(Math.round(fx), w - 1), y = cl(Math.round(fy), h - 1), i = (y * w + x) * c;
      for (let k = 0; k < 4; k++) out[o + k] = k < c ? img.data[i + k] : 255;
      return;
    }
    const x0 = cl(Math.floor(fx), w - 1), y0 = cl(Math.floor(fy), h - 1), x1 = cl(x0 + 1, w - 1), y1 = cl(y0 + 1, h - 1);
    const ax = cl(fx - x0, 1), ay = cl(fy - y0, 1);
    for (let k = 0; k < 4; k++) {
      if (k >= c) { out[o + k] = 255; continue; }
      const p = (x, y) => img.data[(y * w + x) * c + k];
      const v = (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
      out[o + k] = Math.round(v);
    }
  };
  for (let py = 0; py < H; py++) {
    const lat = (0.5 - (py + 0.5) / H) * Math.PI;
    for (let px = 0; px < W; px++) {
      const th = 2 * Math.PI * ((px + 0.5) / W);
      const dx = -Math.cos(th) * Math.cos(lat), dy = Math.sin(lat), dz = -Math.sin(th) * Math.cos(lat);
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
      let f, s, t;
      if (ax >= ay && ax >= az) { const m = 1 / ax; if (dx > 0) { f = 'right'; t = -dy * m; s = -dz * m; } else { f = 'left'; t = -dy * m; s = dz * m; } }
      else if (ay >= az) { const m = 1 / ay; if (dy > 0) { f = 'top'; s = dx * m; t = dz * m; } else { f = 'bottom'; s = dx * m; t = -dz * m; } }
      else { const m = 1 / az; if (dz > 0) { f = 'front'; s = dx * m; t = -dy * m; } else { f = 'back'; s = -dx * m; t = -dy * m; } }
      const img = faces[f];
      sample(img, (s + 1) / 2 * img.width - 0.5, (t + 1) / 2 * img.height - 0.5, (py * W + px) * 4);
    }
  }
  return { width: W, height: H, data: out };
}

class Exporter {
  constructor({ db, writer, planner, report, options }) {
    this.db = db;
    this.writer = writer;
    this.planner = planner;
    this.report = report;
    this.options = options || {};
    this.fixedImagePlace = new Map();   // image uuid -> { dir, fileName } forced by spine/fonts/particles
    this.done = new Set();
    this.typeOf = (u) => this.db.typeOf(u);
    this.stats = {};
  }

  count(k, n = 1) { this.stats[k] = (this.stats[k] || 0) + n; }

  // ------------------------------------------------------------ helpers
  nativeOf(rec, preferExts) {
    const list = rec.bundle.natives.get(rec.baseUuid) || rec.bundle.natives.get(rec.uuid) || [];
    if (preferExts) for (const ext of preferExts) { const n = list.find((x) => x.ext === ext); if (n) return n; }
    return list[0] || null;
  }
  nativeBuf(n) { return n ? this.writer && this.db.bundles && n.key && this.anyBundleFile(n.key) : null; }
  anyBundleFile(key) {
    for (const b of this.db.bundles.values()) if (b.files.has(key)) return b.files.get(key);
    return null;
  }
  imageUuidOfTexture(texUuid) { return texUuid ? texUuid.split('@')[0] : null; }

  /** Force an image to be written in a given folder with a given file name (spine/dragonbones/fonts need it). */
  pinImage(imageUuid, dir, fileName) {
    if (!imageUuid || this.fixedImagePlace.has(imageUuid)) return;
    this.fixedImagePlace.set(imageUuid, { dir, fileName });
  }

  // ------------------------------------------------------------ run
  run() {
    const steps = [
      ['model 3D', () => this.exportModels()], ['cube map', () => this.exportTextureCubes()], ['ảnh', () => { this.prePlanSpecialImages(); this.exportImages(); this.exportMissingPanoramas(); }],
      ['atlas', () => this.exportSpriteAtlases()], ['âm thanh, video', () => this.exportSimpleNatives()], ['font', () => this.exportFonts()],
      ['Spine', () => this.exportSpine()], ['DragonBones', () => this.exportDragonBones()], ['dữ liệu', () => this.exportDataAssets()],
      ['particle', () => this.exportParticles()], ['tiled map', () => this.exportTiledMaps()], ['animation', () => this.exportAnimations()],
      ['material', () => this.exportGenericAssets()], ['prefab', () => this.exportPrefabs()], ['scene', () => this.exportScenes()], ['còn lại', () => this.exportLeftovers()],
    ];
    const onStep = this.options.onStep || (() => {});
    steps.forEach(([name, fn], i) => { onStep(i, steps.length, name); fn(); });
    return this.stats;
  }

  // ------------------------------------------------------------ 3D models (.glb rebuilt from mesh/skeleton/material/... sub-assets)
  exportModels() {
    return new ModelExporter(this).run();
  }

  // ------------------------------------------------------------ cube maps (skybox / environment)
  //  - standalone .cubemap assets (importer texture-cube): the meta lists the 6 face images
  //  - cubes generated from a panorama image (X@b47c0, importer erp-texture-cube): the image X is written with
  //    type "texture cube"; when the build lost X, it is stitched back from the 6 faces
  exportTextureCubes() {
    this.erpCubes = new Map();
    for (const rec of this.db.ofType('cc.TextureCube')) {
      if (this.isInternalPath(rec)) continue;
      const c = (rec.root && rec.root.__custom__) || {};
      const mip = (c.mipmaps || [])[0] || {};
      const face = {};
      for (const k of Object.keys(CUBE_FACES)) { let u = mip[k]; if (u && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(u)) u = decompressUuid(u); if (u) face[k] = u; }
      const tb = String(c.base || '2,2,0,0,0,0').split(',').map(Number);
      const sampler = { wrapModeS: WRAP[tb[2]] || 'repeat', wrapModeT: WRAP[tb[3]] || 'repeat', minfilter: FILTER[tb[0]] || 'linear', magfilter: FILTER[tb[1]] || 'linear', mipfilter: FILTER[tb[4]] || 'none', anisotropy: tb[5] || 0 };
      if (rec.subId) {
        this.erpCubes.set(rec.baseUuid, { rec, face, sampler, isRGBE: !!c.rgbe });
        for (const u of Object.values(face)) this.done.add(u);
        this.done.add(rec.uuid);
        continue;
      }
      const name = (rec.root && rec.root._name) || 'Skybox';
      const rel = this.planner.place(rec, name, '.cubemap', 'Textures', { useOwner: true, subFolder: name });
      const dir = path.posix.dirname(rel);
      for (const [k, u] of Object.entries(face)) this.pinImage(u, dir, k);
      this.writer.write(rel, '');
      this.writer.writeMeta(rel, meta('texture-cube', rec.uuid, { files: ['.json'], userData: { ...sampler, isRGBE: !!c.rgbe, ...face } }));
      this.done.add(rec.uuid);
      this.count('textureCubes');
    }
  }

  /** Panorama images lost by the build: rebuild them from their 6 cube faces (Cocos ERP convention). */
  exportMissingPanoramas() {
    for (const [base, cube] of this.erpCubes || []) {
      if (this.done.has(base)) continue;
      const faces = {};
      let size = 0, ok = true;
      for (const [k, u] of Object.entries(cube.face)) {
        const r = this.db.get(u) || { uuid: u, baseUuid: u.split('@')[0], bundle: cube.rec.bundle };
        const list = cube.rec.bundle.natives.get(u) || [];
        const nat = list.find((n) => n.ext === '.png');
        const buf = nat && this.anyBundleFile(nat.key);
        const img = buf && isPNG(buf) ? safe(() => decodePNG(buf)) : null;
        if (!img) { ok = false; break; }
        faces[k] = img; size = img.width;
        void r;
      }
      if (!ok || !size) { this.report.warn(`Cube map ${base}@b47c0: không còn ảnh panorama gốc và các mặt không phải PNG — chưa dựng lại được.`); continue; }
      const pano = stitchPanorama(faces, size, cube.isRGBE);
      const fakeImg = { uuid: base, baseUuid: base, bundle: cube.rec.bundle, type: 'cc.ImageAsset', pathInfo: cube.rec.pathInfo };
      this.writeImage(fakeImg, null, pano, 'skybox');
      this.report.note(`Cube map ${base}@b47c0: ảnh panorama gốc không có trong build — đã ghép lại từ 6 mặt (${size * 4}x${size * 2}).`);
    }
  }

  // ------------------------------------------------------------ images that must sit next to their owner
  prePlanSpecialImages() {
    for (const rec of this.db.ofType('sp.SkeletonData')) {
      const sd = rec.root; if (!sd) continue;
      const dir = this.planner.place(rec, sd._name || 'skeleton', '', 'Spine', { subFolder: sd._name || 'skeleton' }).replace(/\/[^/]*$/, '');
      rec.__dir = dir;
      (sd.textures || []).forEach((t, i) => t && t.__uuid__ && this.pinImage(this.imageUuidOfTexture(t.__uuid__), dir, (sd.textureNames || [])[i]));
    }
    for (const rec of this.db.ofType('dragonBones.DragonBonesAtlasAsset')) {
      const a = rec.root; if (!a) continue;
      let atlas = {}; try { atlas = JSON.parse(a._atlasJson || '{}'); } catch { /* ignore */ }
      const name = (atlas.name || a._name || 'dragonbones').replace(/_tex$/, '');
      const dir = this.planner.place(rec, name, '', 'DragonBones', { subFolder: name }).replace(/\/[^/]*$/, '');
      rec.__dir = dir; rec.__name = name;
      if (a._texture && a._texture.__uuid__) this.pinImage(this.imageUuidOfTexture(a._texture.__uuid__), dir, atlas.imagePath || name + '_tex.png');
    }
    for (const rec of this.db.ofType('cc.BitmapFont')) {
      const f = rec.root; if (!f) continue;
      const cfg = f.fntConfig || f._fntConfig || {};
      const dir = this.planner.place(rec, f._name || 'font', '', 'Fonts', { subFolder: f._name || 'font' }).replace(/\/[^/]*$/, '');
      rec.__dir = dir;
      const sf = f.spriteFrame && f.spriteFrame.__uuid__;
      if (sf) this.pinImage(sf.split('@')[0], dir, cfg.atlasName || (f._name || 'font') + '.png');
    }
  }

  // ------------------------------------------------------------ images, textures, sprite frames
  exportImages() {
    const atlasTextures = new Map();   // image uuid used as texture by sprite frames of OTHER assets
    for (const sf of this.db.ofType('cc.SpriteFrame')) {
      const tex = sf.root && sf.root._textureSource && sf.root._textureSource.__uuid__;
      const img = this.imageUuidOfTexture(tex);
      if (img && img !== sf.baseUuid) (atlasTextures.get(img) || atlasTextures.set(img, []).get(img)).push(sf);
    }
    const plistFrames = new Set();
    for (const a of this.db.ofType('cc.SpriteAtlas')) for (const v of Object.values((a.root && a.root.spriteFrames) || {})) if (v && v.__uuid__) plistFrames.add(v.__uuid__);

    for (const img of this.db.ofType('cc.ImageAsset')) {
      if (this.done.has(img.uuid)) continue;
      const sfRec = this.db.get(img.uuid + '@f9941');
      const usedAsAtlas = atlasTextures.get(img.uuid) || [];
      const atlasOnly = usedAsAtlas.length && !sfRec && usedAsAtlas.every((sf) => !plistFrames.has(sf.uuid));
      if (atlasOnly && !this.fixedImagePlace.has(img.uuid)) {
        this.unpackAutoAtlas(img, usedAsAtlas);
        continue;
      }
      this.writeImage(img, sfRec);
    }
  }

  writeImage(img, sfRec, overridePixels, nameHint) {
    const nat = this.nativeOf(img, IMAGE_EXTS);
    if (!nat && !overridePixels) { this.report.warn(`Ảnh ${img.uuid} không có file gốc (có thể chỉ có texture nén) — bỏ qua.`); return; }
    const ext = overridePixels ? '.png' : nat.ext === '.jpeg' ? '.jpg' : nat.ext;
    const sf = sfRec && sfRec.root && sfRec.root.__custom__;
    const name = sf ? sf.name : (this.fixedImagePlace.get(img.uuid) || {}).fileName || nameHint || img.uuid.slice(0, 8);
    let rel;
    const fixed = this.fixedImagePlace.get(img.uuid);
    // sprite frame names have no extension ("Podium 2.1"): only strip real image extensions
    const stripImgExt = (n) => String(n).replace(/\.(png|jpe?g|webp|bmp)$/i, '');
    if (fixed) rel = this.writer.claimExact(`${fixed.dir}/${stripImgExt(fixed.fileName)}${ext}`);
    else rel = this.planner.place(img, stripImgExt(name), ext, 'Textures', { useOwner: true });
    const buf = overridePixels ? encodePNG(overridePixels.width, overridePixels.height, overridePixels.data) : this.anyBundleFile(nat.key);
    this.writer.write(rel, buf);
    const decoded = isPNG(buf) ? safe(() => decodePNG(buf)) : null;
    const displayName = path.posix.basename(rel, ext);
    const texRec = this.db.get(img.uuid + '@6c48a');
    const texBase = (texRec && texRec.root && texRec.root.__custom__ && texRec.root.__custom__.base) || '2,2,2,2,0,0';
    const t = String(texBase).split(',').map(Number);
    const subMetas = {
      '6c48a': subMeta('texture', img.uuid + '@6c48a', '6c48a', 'texture', displayName, {
        wrapModeS: WRAP[t[2]] || 'clamp-to-edge', wrapModeT: WRAP[t[3]] || 'clamp-to-edge', minfilter: FILTER[t[0]] || 'linear',
        magfilter: FILTER[t[1]] || 'linear', mipfilter: FILTER[t[4]] || 'none', premultiplyAlpha: false, anisotropy: t[5] || 0,
        isUuid: true, imageUuidOrDatabaseUri: img.uuid, visible: false,
      }),
    };
    if (sf) subMetas.f9941 = subMeta('sprite-frame', img.uuid + '@f9941', 'f9941', 'spriteFrame', displayName, this.spriteFrameUserData(img.uuid, sf, decoded, overridePixels ? 'none' : null));
    const erp = this.erpCubes && this.erpCubes.get(img.uuid);
    if (erp) {
      // panorama used as a cube map: the importer regenerates X@b47c0 and its 6 faces
      const faceSubs = {};
      for (const [k, id] of Object.entries(CUBE_FACES)) faceSubs[id] = subMeta('texture-cube-face', `${img.uuid}@b47c0@${id}`, id, k, '', {}, ['.json', '.png']);
      const cube = subMeta('erp-texture-cube', img.uuid + '@b47c0', 'b47c0', 'textureCube', displayName, { ...erp.sampler, isRGBE: erp.isRGBE, imageDatabaseUri: img.uuid });
      cube.subMetas = faceSubs;
      this.writer.writeMeta(rel, meta('image', img.uuid, {
        files: ['.json', ext], subMetas: { b47c0: cube },
        userData: { hasAlpha: false, type: 'texture cube', redirect: img.uuid + '@b47c0', fixAlphaTransparencyArtifacts: false },
      }));
      img.plannedPath = rel;
      this.done.add(img.uuid); this.done.add(img.uuid + '@b47c0');
      this.count('cubeMaps');
      return;
    }
    this.writer.writeMeta(rel, meta('image', img.uuid, {
      files: ['.json', ext], subMetas,
      userData: { type: sf ? 'sprite-frame' : 'texture', hasAlpha: decoded ? decoded.hasAlpha : ext === '.png', fixAlphaTransparencyArtifacts: false, redirect: img.uuid + '@6c48a' },
    }));
    img.plannedPath = rel;
    this.done.add(img.uuid); this.done.add(img.uuid + '@6c48a'); if (sf) this.done.add(img.uuid + '@f9941');
    this.count('images');
  }

  spriteFrameUserData(imageUuid, sf, img, forceTrim) {
    let r = sf.rect, o = sf.originalSize, off = sf.offset || { x: 0, y: 0 }, vertices = sf.vertices, trimType;
    if (forceTrim) trimType = forceTrim;
    else if (img && (img.width !== o.width || img.height !== o.height)) {
      // the image file was replaced by a different size after import: use it as-is
      trimType = 'none'; o = { width: img.width, height: img.height }; r = { x: 0, y: 0, width: img.width, height: img.height }; off = { x: 0, y: 0 }; vertices = null;
      this.report.note(`SpriteFrame "${sf.name}": kích thước ảnh (${img.width}x${img.height}) khác dữ liệu build (${sf.originalSize.width}x${sf.originalSize.height}) — dùng ảnh thực tế, trim = none.`);
    } else {
      const full = r.x === 0 && r.y === 0 && r.width === o.width && r.height === o.height;
      if (!img) trimType = full ? 'auto' : 'custom';
      else if (eqRect(alphaBBox(img, 1), r)) trimType = 'auto';
      else trimType = full ? 'none' : 'custom';
    }
    if (!vertices) {
      const w = r.width, h = r.height;
      vertices = { rawPosition: [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, -w / 2, h / 2, 0, w / 2, h / 2, 0], indexes: [0, 1, 2, 2, 1, 3], uv: [r.x, o.height - r.y, r.x + w, o.height - r.y, r.x, o.height - r.y - h, r.x + w, o.height - r.y - h], nuv: [0, 0, 1, 0, 0, 1, 1, 1], minPos: { x: -w / 2, y: -h / 2, z: 0 }, maxPos: { x: w / 2, y: h / 2, z: 0 } };
    }
    const ci = sf.capInsets || [0, 0, 0, 0];   // [left, top, right, bottom]
    return {
      trimType, trimThreshold: 1, rotated: false, offsetX: off.x, offsetY: off.y, trimX: r.x, trimY: r.y,
      width: r.width, height: r.height, rawWidth: o.width, rawHeight: o.height,
      borderTop: ci[1], borderBottom: ci[3], borderLeft: ci[0], borderRight: ci[2],
      packable: sf.packable !== false, pixelsToUnit: sf.pixelsToUnit ?? 100,
      pivotX: sf.pivot ? sf.pivot.x : 0.5, pivotY: sf.pivot ? sf.pivot.y : 0.5, meshType: sf.meshType || 0,
      vertices: {
        rawPosition: vertices.rawPosition, indexes: vertices.indexes, uv: vertices.uv, nuv: vertices.nuv,
        minPos: [vertices.minPos.x, vertices.minPos.y, vertices.minPos.z], maxPos: [vertices.maxPos.x, vertices.maxPos.y, vertices.maxPos.z],
      },
      isUuid: true, imageUuidOrDatabaseUri: imageUuid + '@6c48a', atlasUuid: '',
    };
  }

  /** Sprite frames packed into an auto-atlas texture: cut each one back out as its own image (original uuid). */
  unpackAutoAtlas(atlasImg, frames) {
    const nat = this.nativeOf(atlasImg, IMAGE_EXTS);
    const buf = nat && this.anyBundleFile(nat.key);
    if (!buf || !isPNG(buf)) {
      this.report.warn(`Auto-atlas ${atlasImg.uuid} không phải PNG — chưa tách được ${frames.length} sprite frame (${frames.map((f) => f.root.__custom__.name).join(', ')}).`);
      return;
    }
    const atlas = decodePNG(buf);
    for (const sfRec of frames) {
      const sf = sfRec.root.__custom__;
      const pixels = extractSprite(atlas, sf.rect, !!sf.rotated, sf.originalSize, sf.offset || { x: 0, y: 0 });
      // the frame now lives in its own image: rect relative to the untrimmed image
      const trimX = Math.round((sf.originalSize.width - sf.rect.width) / 2 + (sf.offset || { x: 0 }).x);
      const trimY = Math.round((sf.originalSize.height - sf.rect.height) / 2 - (sf.offset || { y: 0 }).y);
      const localSf = { ...sf, rect: { x: trimX, y: trimY, width: sf.rect.width, height: sf.rect.height }, rotated: false, vertices: null };
      const fakeImg = { uuid: sfRec.baseUuid, baseUuid: sfRec.baseUuid, bundle: sfRec.bundle, type: 'cc.ImageAsset', pathInfo: sfRec.pathInfo };
      this.writeImage(fakeImg, { root: { __custom__: localSf } }, pixels);
    }
    this.report.note(`Tách ${frames.length} sprite frame khỏi auto-atlas ${atlasImg.uuid.slice(0, 8)} thành ảnh riêng (giữ uuid gốc). Nếu project gốc dùng Auto Atlas (.pac), hãy tạo lại file .pac trong thư mục ảnh đó.`);
    this.done.add(atlasImg.uuid); this.done.add(atlasImg.uuid + '@6c48a');
    this.count('autoAtlasFrames', frames.length);
  }

  // ------------------------------------------------------------ TexturePacker .plist atlases
  exportSpriteAtlases() {
    for (const rec of this.db.ofType('cc.SpriteAtlas')) {
      const a = rec.root; if (!a) continue;
      const frames = Object.entries(a.spriteFrames || {}).map(([name, ref]) => ({ name, uuid: ref && ref.__uuid__, rec: ref && this.db.get(ref.__uuid__) })).filter((f) => f.rec);
      if (!frames.length) continue;
      const texUuid = frames[0].rec.root._textureSource && frames[0].rec.root._textureSource.__uuid__;
      const imgUuid = this.imageUuidOfTexture(texUuid);
      const imgRec = this.db.get(imgUuid);
      const rel = this.planner.place(rec, a._name || 'atlas', '.plist', 'Textures', { useOwner: true });
      const pngName = path.posix.basename(rel, '.plist') + '.png';
      if (imgRec && !this.done.has(imgUuid)) { this.pinImage(imgUuid, path.posix.dirname(rel), pngName); this.writeImage(imgRec, null); }
      const tex = imgRec ? this.nativeOf(imgRec, IMAGE_EXTS) : null;
      let texSize = { w: 0, h: 0 };
      if (tex) { const b = this.anyBundleFile(tex.key); if (isPNG(b)) { texSize = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; } }
      this.writer.write(rel, buildPlist(frames.map((f) => ({ name: f.name, sf: f.rec.root.__custom__ })), pngName, texSize));
      const subMetas = {};
      for (const f of frames) {
        const id = f.uuid.split('@')[1];
        const sf = f.rec.root.__custom__;
        const ud = this.spriteFrameUserData(imgUuid, sf, null, 'custom');
        ud.rotated = !!sf.rotated; ud.atlasUuid = rec.uuid; ud.imageUuidOrDatabaseUri = imgUuid + '@6c48a';
        subMetas[id] = subMeta('sprite-frame', f.uuid, id, f.name.replace(/\.[^.]+$/, ''), f.name.replace(/\.[^.]+$/, ''), ud);
        this.done.add(f.uuid);
      }
      this.writer.writeMeta(rel, meta('sprite-atlas', rec.uuid, { files: ['.json'], subMetas, userData: { atlasTextureName: pngName, textureUuid: imgUuid + '@6c48a', format: 3, uuid: rec.uuid } }));
      this.done.add(rec.uuid);
      this.count('spriteAtlases');
    }
  }

  // ------------------------------------------------------------ audio / video / buffer (plain native files)
  exportSimpleNatives() {
    const kinds = [
      ['cc.AudioClip', 'audio-clip', 'Audio', { downloadMode: 0 }],
      ['cc.VideoClip', 'video-clip', 'Videos', {}],
      ['cc.BufferAsset', 'buffer', 'Data', {}],
      ['cc.Asset', '*', 'Data', {}],        // generic file asset (e.g. spine .atlas in 3.7)
    ];
    for (const [type, importer, folder, userData] of kinds) {
      for (const rec of this.db.ofType(type)) {
        const r = rec.root || {};
        const nat = this.nativeOf(rec);
        if (!nat) { this.report.warn(`${type} ${r._name || rec.uuid} không có file gốc.`); continue; }
        const ext = (r._native && r._native.startsWith('.') ? r._native : nat.ext) || nat.ext;
        // spine atlases sit next to their skeleton
        let sub = null;
        if (type === 'cc.Asset' && ext === '.atlas') {
          const sd = this.db.ofType('sp.SkeletonData').find((s) => s.root && s.root._name === r._name && s.__dir);
          if (sd) sub = sd.__dir;
        }
        const rel = sub ? this.writer.claimExact(`${sub}/${r._name}${ext}`) : this.planner.place(rec, r._name || rec.uuid.slice(0, 8), ext, folder);
        this.writer.write(rel, this.anyBundleFile(nat.key));
        this.writer.writeMeta(rel, meta(importer, rec.uuid, { files: importer === '*' ? [ext, '.json'] : ['.json', ext], userData }));
        this.done.add(rec.uuid);
        this.count(importer);
      }
    }
  }

  // ------------------------------------------------------------ fonts
  exportFonts() {
    for (const rec of this.db.ofType('cc.TTFFont')) {
      const r = rec.root || {};
      const nat = this.nativeOf(rec);
      if (!nat) { this.report.warn(`Font ${r._name} không có file gốc.`); continue; }
      const fileName = nat.name || (r._native && !r._native.startsWith('.') ? r._native : (r._name || 'font') + '.ttf');
      const ext = path.extname(fileName) || '.ttf';
      const rel = this.planner.place(rec, path.basename(fileName, ext), ext, 'Fonts');
      this.writer.write(rel, this.anyBundleFile(nat.key));
      this.writer.writeMeta(rel, meta('ttf-font', rec.uuid, { files: ['.json', path.posix.basename(rel)] }));
      this.done.add(rec.uuid);
      this.count('ttfFonts');
    }
    for (const rec of this.db.ofType('cc.BitmapFont')) {
      const f = rec.root || {};
      const cfg = f.fntConfig || f._fntConfig;
      if (!cfg) { this.report.warn(`Bitmap font ${f._name}: thiếu fntConfig.`); continue; }
      const rel = this.writer.claimExact(`${rec.__dir}/${f._name || 'font'}.fnt`);
      const imgUuid = f.spriteFrame && f.spriteFrame.__uuid__ && f.spriteFrame.__uuid__.split('@')[0];
      this.writer.write(rel, buildFnt(cfg, f));
      this.writer.writeMeta(rel, meta('bitmap-font', rec.uuid, { files: ['.json'], userData: { _fntConfig: cfg, fontSize: f.fontSize || cfg.fontSize, textureUuid: imgUuid || '' } }));
      this.done.add(rec.uuid);
      this.count('bitmapFonts');
    }
  }

  // ------------------------------------------------------------ spine
  exportSpine() {
    for (const rec of this.db.ofType('sp.SkeletonData')) {
      const sd = rec.root || {};
      const name = sd._name || 'skeleton';
      const dir = rec.__dir;
      let dataRel;
      if (sd._skeletonJson) {
        dataRel = this.writer.claimExact(`${dir}/${name}.json`);
        this.writer.write(dataRel, JSON.stringify(sd._skeletonJson, null, 2));
      } else {
        const nat = this.nativeOf(rec);
        if (!nat) { this.report.warn(`Spine ${name}: không có dữ liệu skeleton (.json/.skel).`); continue; }
        dataRel = this.writer.claimExact(`${dir}/${name}${nat.ext || '.skel'}`);
        this.writer.write(dataRel, this.anyBundleFile(nat.key));
      }
      const atlasUuid = require('../util/uuid').stableUuid('spine-atlas:' + rec.uuid);
      const atlasRel = this.writer.claimExact(`${dir}/${name}.atlas.txt`);
      this.writer.write(atlasRel, sd._atlasText || '');
      this.writer.writeMeta(atlasRel, meta('text', atlasUuid, { files: ['.json'] }));
      this.writer.writeMeta(dataRel, meta('spine-data', rec.uuid, { files: ['.json'], userData: { atlasUuid } }));
      this.done.add(rec.uuid);
      this.count('spine');
    }
  }

  // ------------------------------------------------------------ dragonbones
  exportDragonBones() {
    for (const rec of this.db.ofType('dragonBones.DragonBonesAtlasAsset')) {
      const a = rec.root || {};
      const rel = this.writer.claimExact(`${rec.__dir}/${rec.__name}_tex.json`);
      this.writer.write(rel, prettyJsonString(a._atlasJson || '{}'));
      this.writer.writeMeta(rel, meta('dragonbones-atlas', rec.uuid, { files: ['.json'] }));
      this.done.add(rec.uuid);
      this.count('dragonbonesAtlas');
    }
    for (const rec of this.db.ofType('dragonBones.DragonBonesAsset')) {
      const d = rec.root || {};
      let json = null; try { json = d._dragonBonesJson ? JSON.parse(d._dragonBonesJson) : null; } catch { /* ignore */ }
      const name = (json && json.name) || d._name || 'dragonbones';
      const atlasRec = this.db.ofType('dragonBones.DragonBonesAtlasAsset').find((x) => x.__name === name.replace(/_ske$/, '')) || null;
      const dir = atlasRec ? atlasRec.__dir : this.planner.place(rec, name, '', 'DragonBones', { subFolder: name }).replace(/\/[^/]*$/, '');
      let rel;
      if (d._dragonBonesJson) { rel = this.writer.claimExact(`${dir}/${name.replace(/_ske$/, '')}_ske.json`); this.writer.write(rel, prettyJsonString(d._dragonBonesJson)); }
      else {
        const nat = this.nativeOf(rec);
        if (!nat) { this.report.warn(`DragonBones ${name}: không có dữ liệu.`); continue; }
        rel = this.writer.claimExact(`${dir}/${name.replace(/_ske$/, '')}_ske${nat.ext}`);
        this.writer.write(rel, this.anyBundleFile(nat.key));
      }
      this.writer.writeMeta(rel, meta('dragonbones', rec.uuid, { files: ['.json'] }));
      this.done.add(rec.uuid);
      this.count('dragonbones');
    }
  }

  // ------------------------------------------------------------ json / text
  exportDataAssets() {
    for (const rec of this.db.ofType('cc.JsonAsset')) {
      const r = rec.root || {};
      const rel = this.planner.place(rec, r._name || rec.uuid.slice(0, 8), '.json', 'Data');
      this.writer.write(rel, JSON.stringify(r.json !== undefined ? r.json : null, null, 2));
      this.writer.writeMeta(rel, meta('json', rec.uuid, { files: ['.json'] }));
      this.done.add(rec.uuid); this.count('json');
    }
    for (const rec of this.db.ofType('cc.TextAsset')) {
      if (this.done.has(rec.uuid)) continue;
      const r = rec.root || {};
      const n = r._name || rec.uuid.slice(0, 8);
      const ext = /\.[a-z0-9]{1,5}$/i.test(n) ? '' : '.txt';
      const rel = this.planner.place(rec, n, ext, 'Data');
      this.writer.write(rel, r.text || '');
      this.writer.writeMeta(rel, meta('text', rec.uuid, { files: ['.json'] }));
      this.done.add(rec.uuid); this.count('text');
    }
  }

  // ------------------------------------------------------------ particles (.plist)
  exportParticles() {
    for (const rec of this.db.ofType('cc.ParticleAsset')) {
      const r = rec.root || {};
      const nat = this.nativeOf(rec, ['.plist']);
      if (!nat) { this.report.warn(`Particle ${r._name}: không có file .plist.`); continue; }
      const rel = this.planner.place(rec, r._name || 'particle', '.plist', 'Particles');
      const buf = this.anyBundleFile(nat.key);
      this.writer.write(rel, buf);
      const sfUuid = r.spriteFrame && r.spriteFrame.__uuid__;
      if (sfUuid) {
        const tf = (buf.toString('utf8').match(/<key>textureFileName<\/key>\s*<string>([^<]*)<\/string>/) || [])[1];
        if (tf && !this.done.has(sfUuid.split('@')[0])) this.pinImage(sfUuid.split('@')[0], path.posix.dirname(rel), path.basename(tf));
      }
      this.writer.writeMeta(rel, meta('particle', rec.uuid, { files: ['.plist', '.json'] }));
      this.done.add(rec.uuid); this.count('particles');
    }
  }

  // ------------------------------------------------------------ tiled maps
  exportTiledMaps() {
    for (const rec of this.db.ofType('cc.TiledMapAsset')) {
      const r = rec.root || {};
      const name = r._name || 'map';
      const rel = this.planner.place(rec, name, '.tmx', 'TiledMaps', { subFolder: name });
      const dir = path.posix.dirname(rel);
      this.writer.write(rel, r.tmxXmlStr || '');
      (r.tsxFiles || []).forEach((t, i) => {
        const trec = t && t.__uuid__ && this.db.get(t.__uuid__);
        const fname = (r.tsxFileNames || [])[i] || `tileset${i}.tsx`;
        if (trec && trec.root) { const trel = this.writer.claimExact(`${dir}/${fname}`); this.writer.write(trel, trec.root.text || ''); this.writer.writeMeta(trel, meta('text', trec.uuid, { files: ['.json'] })); this.done.add(trec.uuid); }
      });
      (r.spriteFrames || []).forEach((s, i) => { if (s && s.__uuid__) this.pinImage(s.__uuid__.split('@')[0], dir, (r.spriteFrameNames || [])[i] || `tile${i}.png`); });
      (r.imageLayerSpriteFrame || []).forEach((s, i) => { if (s && s.__uuid__) this.pinImage(s.__uuid__.split('@')[0], dir, (r.imageLayerSpriteFrameNames || [])[i] || `layer${i}.png`); });
      this.writer.writeMeta(rel, meta('tiled-map', rec.uuid, { files: ['.json'] }));
      this.done.add(rec.uuid); this.count('tiledMaps');
    }
    // images pinned by tiled maps/particles after the image pass
    for (const [uuid] of this.fixedImagePlace) {
      if (this.done.has(uuid)) continue;
      const img = this.db.get(uuid);
      if (img && img.type === 'cc.ImageAsset') this.writeImage(img, this.db.get(uuid + '@f9941'));
    }
  }

  // ------------------------------------------------------------ animation clips
  exportAnimations() {
    for (const rec of this.db.ofType('cc.AnimationClip')) {
      if (this.done.has(rec.uuid)) continue;
      let json, name;
      if (rec.dynamic) {
        const r = convertDynamicDoc(rec.dynamic.doc, rec.dynamic.chunks, { typeOf: this.typeOf });
        r.problems.forEach((p) => this.report.warn(`Animation ${rec.uuid}: ${p}`));
        json = r.json; name = (Array.isArray(json) ? json[0] : json)._name;
      } else {
        json = toEditorJSON(rec.root, { kind: 'asset', typeOf: this.typeOf });
        name = rec.root._name;
      }
      const rel = this.planner.place(rec, name || rec.uuid.slice(0, 8), '.anim', 'Animations');
      this.writer.writeJSON(rel, json);
      this.writer.writeMeta(rel, meta('animation-clip', rec.uuid, { files: ['.bin'], userData: { name: name || '' } }));
      this.done.add(rec.uuid); this.count('animations');
    }
  }

  // ------------------------------------------------------------ materials / physics materials / effects / render textures
  exportGenericAssets() {
    const kinds = [
      ['cc.Material', 'material', 'Materials', '.mtl'],
      ['cc.PhysicsMaterial', 'physics-material', 'Physics', '.pmtl'],
      ['cc.RenderTexture', 'render-texture', 'RenderTextures', '.rt'],
    ];
    for (const [type, importer, folder, ext] of kinds) {
      for (const rec of this.db.ofType(type)) {
        if (this.isInternalPath(rec) || this.done.has(rec.uuid)) continue;
        const json = rec.dynamic ? convertDynamicDoc(rec.dynamic.doc, rec.dynamic.chunks, { typeOf: this.typeOf }).json : toEditorJSON(rec.root, { kind: 'asset', typeOf: this.typeOf });
        const first = Array.isArray(json) ? json[0] : json;
        normalizeMaterialJSON(first);
        const rel = this.planner.place(rec, (first && first._name) || rec.uuid.slice(0, 8), ext, folder);
        this.writer.writeJSON(rel, Array.isArray(json) && json.length === 1 ? json[0] : json);
        const userData = type === 'cc.RenderTexture' ? { width: first._width || 512, height: first._height || 512 } : {};
        this.writer.writeMeta(rel, meta(importer, rec.uuid, { files: ['.json'], userData }));
        this.done.add(rec.uuid); this.count(importer);
      }
    }
    for (const rec of this.db.ofType('cc.EffectAsset')) {
      if (this.isInternalPath(rec)) continue;
      const r = rec.root || {};
      const base = `_recovered/effects/${(r._name || rec.uuid).replace(/[\\/:*?"<>|]/g, '_')}`;
      this.writer.writeJSON(base + '.json', r);
      (r.shaders || []).forEach((s, i) => {
        const g = s.glsl3 || s.glsl1 || s.glsl4;
        if (g) { this.writer.write(`${base}.${i}.vert.glsl`, g.vert || ''); this.writer.write(`${base}.${i}.frag.glsl`, g.frag || ''); }
      });
      this.report.warn(`Shader tùy biến "${r._name}" (${rec.uuid}) chỉ còn dạng đã biên dịch — đã lưu GLSL vào ${base}.* để viết lại file .effect thủ công (giữ uuid ${rec.uuid} trong .meta để material nhận lại).`);
      this.done.add(rec.uuid); this.count('customEffects');
    }
  }

  isInternalPath(rec) {
    const p = rec.pathInfo && rec.pathInfo.path;
    return (p && p.startsWith('db:/internal')) || this.db.isInternal(rec.uuid);
  }

  // ------------------------------------------------------------ prefabs & scenes
  exportPrefabs() {
    for (const rec of this.db.ofType('cc.Prefab')) {
      if (this.done.has(rec.uuid)) continue;
      if (!rec.root || !rec.root.data) { this.report.warn(`Prefab ${rec.uuid} không có dữ liệu node.`); continue; }
      preparePrefab(rec.root, rec.uuid);
      const name = rec.root._name || rec.root.data._name || rec.uuid.slice(0, 8);
      const json = toEditorJSON(rec.root, { kind: 'prefab', typeOf: this.typeOf });
      const rel = this.planner.place(rec, name, '.prefab', 'Prefabs');
      this.writer.writeJSON(rel, json);
      this.writer.writeMeta(rel, meta('prefab', rec.uuid, { files: ['.json'], userData: { syncNodeName: rec.root.data._name || name } }));
      rec.plannedPath = rel;
      this.done.add(rec.uuid); this.count('prefabs');
    }
  }

  exportScenes() {
    for (const rec of this.db.ofType('cc.SceneAsset')) {
      if (!rec.root || !rec.root.scene) { this.report.warn(`Scene ${rec.uuid} không có dữ liệu.`); continue; }
      const unlinked = unlinkScenePrefabs(rec.root.scene);
      if (unlinked) this.report.note(`Scene "${rec.root._name}": ${unlinked} node là instance của prefab — đã chuyển thành node thường (bản build không còn liên kết prefab).`);
      const json = toEditorJSON(rec.root, { kind: 'scene', typeOf: this.typeOf, sceneUuid: rec.uuid });
      const rel = this.planner.place(rec, rec.root._name || 'scene', '.scene', 'Scenes');
      this.writer.writeJSON(rel, json);
      this.writer.writeMeta(rel, meta('scene', rec.uuid, { files: ['.json'] }));
      rec.plannedPath = rel;
      rec.editorJson = json;
      this.done.add(rec.uuid); this.count('scenes');
    }
  }

  // ------------------------------------------------------------ everything else
  exportLeftovers() {
    const skipTypes = new Set(['cc.Texture2D', 'cc.SpriteFrame', 'cc.ImageAsset', 'cc.RenderPipeline', 'ForwardPipeline', 'DeferredPipeline', 'native-only', 'error']);
    const byType = {};
    for (const rec of this.db.records.values()) {
      if (this.done.has(rec.uuid) || skipTypes.has(rec.type) || this.isInternalPath(rec)) continue;
      (byType[rec.type] = byType[rec.type] || []).push(rec);
    }
    for (const [type, list] of Object.entries(byType)) {
      for (const rec of list) {
        const data = rec.root || (rec.dynamic && rec.dynamic.doc);
        this.writer.writeJSON(`_recovered/raw/${String(type).replace(/[^\w.-]/g, '_')}/${rec.uuid}.json`, safeJson(data));
      }
      this.report.warn(`Chưa hỗ trợ loại asset "${type}" (${list.length} asset) — dữ liệu thô lưu ở _recovered/raw/.`);
    }
    // sprite frames / textures that were never attached to an image
    const orphans = [...this.db.records.values()].filter((r) => (r.type === 'cc.SpriteFrame' || r.type === 'cc.Texture2D') && !this.done.has(r.uuid) && !this.isInternalPath(r));
    if (orphans.length) this.report.warn(`${orphans.length} SpriteFrame/Texture không gắn được với ảnh nào (ví dụ ${orphans.slice(0, 3).map((o) => o.uuid).join(', ')}).`);
  }
}

// ------------------------------------------------------------ file format writers
function buildFnt(cfg, font) {
  const lines = [];
  const defs = cfg.fontDefDictionary || {};
  lines.push(`info face="${font._name || 'font'}" size=${cfg.fontSize || font.fontSize || 0} bold=0 italic=0 charset="" unicode=0 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=0,0`);
  lines.push(`common lineHeight=${cfg.commonHeight || 0} base=${cfg.commonHeight || 0} scaleW=0 scaleH=0 pages=1 packed=0`);
  lines.push(`page id=0 file="${cfg.atlasName || (font._name || 'font') + '.png'}"`);
  const ids = Object.keys(defs);
  lines.push(`chars count=${ids.length}`);
  for (const id of ids) {
    const d = defs[id];
    lines.push(`char id=${id} x=${d.rect.x} y=${d.rect.y} width=${d.rect.width} height=${d.rect.height} xoffset=${d.xOffset} yoffset=${d.yOffset} xadvance=${d.xAdvance} page=0 chnl=0`);
  }
  const kern = cfg.kerningDict || {};
  const kk = Object.keys(kern);
  if (kk.length) {
    lines.push(`kernings count=${kk.length}`);
    for (const k of kk) { const key = +k; lines.push(`kerning first=${key >> 16} second=${key & 0xffff} amount=${kern[k]}`); }
  }
  return lines.join('\n') + '\n';
}

function buildPlist(frames, textureName, texSize) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const f = frames.map(({ name, sf }) => {
    const r = sf.rect, o = sf.originalSize, off = sf.offset || { x: 0, y: 0 };
    const w = sf.rotated ? r.height : r.width, h = sf.rotated ? r.width : r.height;
    return `            <key>${esc(name)}</key>
            <dict>
                <key>spriteOffset</key>
                <string>{${off.x},${off.y}}</string>
                <key>spriteSize</key>
                <string>{${r.width},${r.height}}</string>
                <key>spriteSourceSize</key>
                <string>{${o.width},${o.height}}</string>
                <key>textureRect</key>
                <string>{{${r.x},${r.y}},{${sf.rotated ? r.height : r.width},${sf.rotated ? r.width : r.height}}}</string>
                <key>textureRotated</key>
                <${sf.rotated ? 'true' : 'false'}/>
            </dict>`.replace(/\{\{(\d+),(\d+)\},\{(\d+),(\d+)\}\}/, `{{${r.x},${r.y}},{${r.width},${r.height}}}`) + (w && h ? '' : '');
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>frames</key>
        <dict>
${f}
        </dict>
        <key>metadata</key>
        <dict>
            <key>format</key>
            <integer>3</integer>
            <key>pixelFormat</key>
            <string>RGBA8888</string>
            <key>premultiplyAlpha</key>
            <false/>
            <key>realTextureFileName</key>
            <string>${esc(textureName)}</string>
            <key>size</key>
            <string>{${texSize.w},${texSize.h}}</string>
            <key>textureFileName</key>
            <string>${esc(textureName)}</string>
        </dict>
    </dict>
</plist>
`;
}

function prettyJsonString(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
function safe(fn) { try { return fn(); } catch { return null; } }
function safeJson(v) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(v, (k, x) => {
    if (x && typeof x === 'object') { if (seen.has(x)) return '[circular]'; seen.add(x); }
    if (x && x.type === 'Buffer' && Array.isArray(x.data)) return `[binary ${x.data.length} bytes]`;
    return x;
  }));
}

module.exports = { Exporter, buildFnt, buildPlist, stitchPanorama };
