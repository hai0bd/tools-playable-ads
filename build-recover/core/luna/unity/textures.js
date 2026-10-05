'use strict';
// Textures + sprites. Luna ships each texture as an inline PNG/JPG/WebP (often downscaled) and each sprite as a
// normalized rect on it; sizes in world units come from the sprite bounds, so pixelsPerUnit is recomputed for
// the recovered (smaller) image and every sprite keeps its on-screen size.
const path = require('path');
const { flow } = require('./yaml');
const ids = require('./ids');
const { IMPORTER_TAIL } = require('./project');
const { UnityProject } = require('./project');
const { isPNG, decodePNG, encodePNG } = require('../../util/png');
const { isWebP, decodeWebP } = require('../../util/webp');

const IMAGE_EXT = /\.(png|jpe?g|tga|psd|tiff?|bmp|gif|exr|hdr|webp|iff|pict)$/i;
const withExt = (p, ext) => p.replace(/\.[^./]+$/, '') + ext;
const hex32 = (seed) => ids.guidOf('spriteid:' + seed);

function mediaIndex(media) {
  const byId = new Map();
  for (const [key, v] of Object.entries(media)) {
    const m = key.match(/^assets\/bundles\/(-?\d+)\/(-?\d+)\.(\w+)$/);
    if (m && !byId.has(+m[2])) byId.set(+m[2], v);
  }
  return byId;
}

function imageSize(bytes) {
  if (isPNG(bytes)) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  // JPEG: walk the segments up to a SOF marker
  for (let p = 2; p + 9 < bytes.length;) {
    if (bytes[p] !== 0xff) break;
    const mk = bytes[p + 1], len = bytes.readUInt16BE(p + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { width: bytes.readUInt16BE(p + 7), height: bytes.readUInt16BE(p + 5) };
    p += 2 + len;
  }
  return null;
}

// The real format, from the bytes: Luna's mime/extension can say "webp" for PNG data and vice versa.
function imageFormat(bytes) {
  if (isPNG(bytes)) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (isWebP(bytes)) return 'webp';
  return null;
}

// Luna can re-encode textures as WebP, which Unity does not import: decode those and store PNG instead.
function importableImage(img, t, p) {
  const fmt = imageFormat(img.bytes);
  if (fmt !== 'webp') return { bytes: img.bytes, ext: fmt ? '.' + fmt : img.ext || '.png' };
  try {
    const decoded = decodeWebP(img.bytes);
    p.webpDecoded = (p.webpDecoded || 0) + 1;
    return { bytes: encodePNG(decoded.width, decoded.height, decoded.data), ext: '.png', decoded };
  } catch (e) {
    p.report.warn(`Texture #${t.id} ${t.path || ''}: không giải mã được WebP (${e.message}) — giữ file .webp, Unity không đọc được.`);
    return { bytes: img.bytes, ext: '.webp' };
  }
}

const pot = (n) => { let p = 32; while (p < n) p *= 2; return p; };

function textureImporter(o) {
  const maxSize = Math.min(8192, Math.max(2048, pot(Math.max(o.width || 0, o.height || 0))));
  return {
    TextureImporter: {
      internalIDToNameTable: [], externalObjects: {}, serializedVersion: 12,
      mipmaps: {
        mipMapMode: 0, enableMipMap: o.mipmaps ? 1 : 0, sRGBTexture: o.sRGB === false ? 0 : 1, linearTexture: 0, fadeOut: 0, borderMipMap: 0,
        mipMapsPreserveCoverage: 0, alphaTestReferenceValue: 0.5, mipMapFadeDistanceStart: 1, mipMapFadeDistanceEnd: 3,
      },
      bumpmap: { convertToNormalMap: 0, externalNormalMap: 0, heightScale: 0.25, normalMapFilter: 0 },
      isReadable: 0, streamingMipmaps: 0, streamingMipmapsPriority: 0, vTOnly: 0, ignoreMasterTextureLimit: 0,
      grayScaleToAlpha: 0, generateCubemap: 6, cubemapConvolution: 0, seamlessCubemap: 0, textureFormat: 1, maxTextureSize: maxSize,
      textureSettings: { serializedVersion: 2, filterMode: o.filterMode, aniso: o.aniso, mipBias: 0, wrapU: o.wrap, wrapV: o.wrap, wrapW: o.wrap },
      nPOTScale: o.textureType === 8 ? 0 : 1, lightmap: 0, compressionQuality: 50,
      spriteMode: o.spriteMode, spriteExtrude: 1, spriteMeshType: 1, alignment: o.alignment || 0,
      spritePivot: flow(o.pivot || { x: 0.5, y: 0.5 }), spritePixelsToUnits: o.ppu || 100,
      spriteBorder: flow(o.border || { x: 0, y: 0, z: 0, w: 0 }), spriteGenerateFallbackPhysicsShape: 1, alphaUsage: 1,
      alphaIsTransparency: o.alphaIsTransparency ? 1 : 0, spriteTessellationDetail: -1, textureType: o.textureType, textureShape: 1,
      singleChannelComponent: 0, flipbookRows: 1, flipbookColumns: 1, maxTextureSizeSet: 0, compressionQualitySet: 0, textureFormatSet: 0,
      ignorePngGamma: 0, applyGammaDecoding: 0, swizzle: 50462976, cookieLightType: 0,
      platformSettings: [{
        serializedVersion: 3, buildTarget: 'DefaultTexturePlatform', maxTextureSize: maxSize, resizeAlgorithm: 0, textureFormat: -1,
        textureCompression: 1, compressionQuality: 50, crunchedCompression: 0, allowsAlphaSplitting: 0, overridden: 0,
        androidETC2FallbackOverride: 0, forceMaximumCompressionQuality_BC6H_BC7: 0,
      }],
      spriteSheet: {
        serializedVersion: 2, sprites: o.sheet || [], outline: [], physicsShape: [], bones: [], spriteID: o.spriteID || hex32('single'),
        internalID: 0, vertices: [], indices: '', edges: [], weights: [], secondaryTextures: [], nameFileIdTable: o.nameTable || {},
      },
      spritePackingTag: '', pSDRemoveMatte: 0, pSDShowRemoveMatteOption: 0, ...IMPORTER_TAIL,
    },
  };
}

/** Sprite geometry in the recovered image's pixels. */
function spriteGeometry(s, W, H) {
  const d = s.dto, tr = d.textureRect || { x: 0, y: 0, width: 1, height: 1 };
  const rect = { x: Math.round(tr.x * W), y: Math.round(tr.y * H), width: Math.max(1, Math.round(tr.width * W)), height: Math.max(1, Math.round(tr.height * H)) };
  const native = d.nativeSize && d.nativeSize.x ? d.nativeSize : { x: d.textureWidth || rect.width, y: d.textureHeight || rect.height };
  const scale = rect.width / (native.x || rect.width);
  const b = d.bounds || [];
  const boundsW = b.length >= 4 ? b[2] - b[0] : 0;
  const ppu = boundsW > 0 ? rect.width / boundsW : (d.pixelsPerUnit || 100) * scale;
  const pivot = d.pivot && native.x && native.y ? { x: d.pivot.x / native.x, y: d.pivot.y / native.y } : { x: 0.5, y: 0.5 };
  const bd = d.border || { x: 0, y: 0, z: 0, w: 0 };
  const border = { x: Math.round(bd.x * scale), y: Math.round(bd.y * scale), z: Math.round(bd.z * scale), w: Math.round(bd.w * scale) };
  const full = Math.abs(tr.x) < 1e-3 && Math.abs(tr.y) < 1e-3 && Math.abs(tr.width - 1) < 1e-3 && Math.abs(tr.height - 1) < 1e-3;
  const round = (v) => Math.round(v * 1e5) / 1e5;
  return { rect, ppu: round(ppu), pivot: { x: round(pivot.x), y: round(pivot.y) }, border, full };
}
const alignmentOf = (pivot) => (Math.abs(pivot.x - 0.5) < 1e-4 && Math.abs(pivot.y - 0.5) < 1e-4 ? 0 : 9);

function planTextures(p) {
  const m = p.m, media = mediaIndex(m.x.media);
  const spritesByTex = new Map();
  for (const s of m.list('sprites')) {
    if (ids.isBuiltinPath(s.path)) { p.register(s.id, { kind: 'sprite', ref: ids.builtinRef(s.path, 'UnityEngine.Sprite'), builtin: true }); continue; }
    const tid = s.dto && s.dto.texture && s.dto.texture.id;
    if (tid == null) continue;
    if (!spritesByTex.has(tid)) spritesByTex.set(tid, []);
    spritesByTex.get(tid).push(s);
  }
  const jobs = [];
  for (const t of m.list('textures')) {
    if (ids.isBuiltinPath(t.path)) { p.register(t.id, { kind: 'texture', ref: ids.builtinRef(t.path, 'UnityEngine.Texture2D'), builtin: true }); continue; }
    const tp = UnityProject.assetPath(t.path);
    // baked reflection probes / lightmaps: regenerated by Unity, not project assets
    if (tp && /\.unity\//.test(tp)) { p.register(t.id, { kind: 'texture', ref: null, builtin: false }); continue; }
    // RenderTexture assets (record type 3): no pixels, just the description — cameras rendering into one must keep
    // their target or they draw over the screen
    if (t.record.type === 3 || (tp && /\.renderTexture$/i.test(tp))) {
      const rel = p.claim(tp && /\.renderTexture$/i.test(tp) ? tp : `Assets/_Recovered/RenderTextures/${t.name || t.id}.renderTexture`);
      const guid = ids.guidOf(rel);
      p.register(t.id, { kind: 'renderTexture', rel, guid, ref: ids.assetRef(8400000, guid, 2) });
      (p.renderTextures = p.renderTextures || []).push({ t, rel, guid });
      continue;
    }
    const media0 = media.get(t.id);
    if (!media0) { p.register(t.id, { kind: 'texture', ref: null, builtin: false }); p.report.warn(`Texture #${t.id} ${t.path || ''}: không có ảnh trong build.`); continue; }
    // TMP Essential Resources atlases live inside the essentials font asset — referenced through its known GUID
    if (tp && ids.knownAssetGuid(tp)) { p.register(t.id, { kind: 'texture', ref: null, builtin: false, essential: tp }); continue; }
    const img = importableImage(media0, t, p);
    const ext = img.ext;
    const sprites = spritesByTex.get(t.id) || [];
    const spritePaths = [...new Set(sprites.map((s) => UnityProject.assetPath(s.path)).filter(Boolean))];
    let rel, atlas = false;
    if (tp && IMAGE_EXT.test(tp)) rel = withExt(tp, ext);
    else if (tp && /\.asset$/i.test(tp)) rel = tp.replace(/\.asset$/i, '') + ' Atlas' + ext;
    else if (spritePaths.length === 1) rel = withExt(spritePaths[0], ext);
    else if (spritePaths.length > 1) { atlas = true; rel = `Assets/_Recovered/Atlases/${t.name || (t.dto && t.dto.name) || 'Atlas_' + t.id}${ext}`; }
    else rel = `Assets/_Recovered/Textures/${t.name || (t.dto && t.dto.name) || 'Texture_' + t.id}${ext}`;
    rel = p.claim(rel);
    const guid = ids.guidOf(rel);
    const info = p.register(t.id, { kind: 'texture', rel, guid, ref: ids.assetRef(2800000, guid, 3) });
    jobs.push({ t, img, rel, guid, info, sprites, atlas, decoded: atlas ? img.decoded : null });   // pixels only for cut-outs
  }
  p.textureJobs = jobs;
  // sprites: sub-assets of their texture (or cut out of a Luna-made atlas into their own file)
  for (const j of jobs) {
    const size = imageSize(j.img.bytes) || { width: j.t.dto.width, height: j.t.dto.height };
    j.size = size;
    if (!j.sprites.length) continue;
    if (j.atlas) {
      // each original sprite texture is gone; cut it back out of the atlas (PNG only)
      j.cutouts = [];
      const groups = new Map();
      for (const s of j.sprites) {
        const sp = UnityProject.assetPath(s.path) || `Assets/_Recovered/Sprites/${s.dto.name}.png`;
        if (!groups.has(sp)) groups.set(sp, []);
        groups.get(sp).push(s);
      }
      for (const [sp, list] of groups) {
        if (list.length > 1 || !isPNG(j.img.bytes)) { list.forEach((s) => j.cutouts.push({ inAtlas: s })); continue; }
        const s = list[0];
        const rel = p.claim(withExt(sp, '.png'));
        const guid = ids.guidOf(rel);
        p.register(s.id, { kind: 'sprite', rel, guid, ref: ids.assetRef(21300000, guid, 3), textureRef: ids.assetRef(2800000, guid, 3) });
        j.cutouts.push({ sprite: s, rel, guid });
      }
      j.sheetSprites = j.cutouts.filter((c) => c.inAtlas).map((c) => c.inAtlas);
    } else j.sheetSprites = j.sprites;
    const sheet = j.sheetSprites || [];
    const g0 = sheet.length === 1 ? spriteGeometry(sheet[0], size.width, size.height) : null;
    j.single = sheet.length === 1 && g0.full;
    if (j.single) { p.register(sheet[0].id, { kind: 'sprite', ref: ids.assetRef(21300000, j.guid, 3), textureRef: j.info.ref }); continue; }
    const used = new Set();
    j.multi = sheet.map((s) => {
      let name = s.dto.name || 'Sprite', k = 1;
      while (used.has(name)) name = `${s.dto.name || 'Sprite'}_${k++}`;
      used.add(name);
      const internalID = ids.fileIdOf(`sprite:${j.rel}:${s.id}`);
      p.register(s.id, { kind: 'sprite', ref: ids.assetRef(internalID, j.guid, 3), textureRef: j.info.ref });
      return { s, name, internalID };
    });
  }
}

function writeRenderTextures(p) {
  for (const { t, rel, guid } of p.renderTextures || []) {
    const d = t.dto || {};
    const H = { m_ObjectHideFlags: 0, m_CorrespondingSourceObject: ids.NULL_REF, m_PrefabInstance: ids.NULL_REF, m_PrefabAsset: ids.NULL_REF };
    p.writeYamlAsset(rel, guid, [{
      classId: 84, fileId: 8400000, type: 'RenderTexture', body: {
        ...H, m_Name: d.name || t.name || 'RenderTexture', m_ImageContentsHash: { serializedVersion: 2, Hash: '00000000000000000000000000000000' },
        m_ForcedFallbackFormat: 4, m_DownscaleFallback: 0, m_IsAlphaChannelOptional: 0, serializedVersion: 5,
        m_Width: d.width || 256, m_Height: d.height || 256, m_AntiAliasing: 1, m_MipCount: -1, m_DepthStencilFormat: 94,
        m_ColorFormat: d.hdr ? 48 : 8, m_MipMap: 0, m_GenerateMips: 1, m_SRGB: 0, m_UseDynamicScale: 0, m_BindMS: 0, m_EnableCompatibleFormat: 1,
        m_TextureSettings: { serializedVersion: 2, m_FilterMode: d.filterMode != null ? d.filterMode : 1, m_Aniso: 0, m_MipBias: 0, m_WrapU: 1, m_WrapV: 1, m_WrapW: 1 },
        m_Dimension: 2, m_VolumeDepth: 1, m_ShadowSamplingMode: 2,
      },
    }], 8400000);
    p.count('renderTextures');
  }
}

function writeTextures(p) {
  writeRenderTextures(p);
  for (const j of p.textureJobs || []) {
    const d = j.t.dto || {};
    const common = {
      width: j.size.width, height: j.size.height, filterMode: d.filterMode != null ? d.filterMode : 1, aniso: d.anisoLevel || 1,
      wrap: d.wrapMode != null ? d.wrapMode : 1, mipmaps: (d.mipmapCount || 1) > 1, alphaIsTransparency: d.alphaIsTransparency !== false, sRGB: d.sRGBTexture !== false,
    };
    p.out.write(j.rel, j.img.bytes);
    let imp;
    if (j.single) {
      const g = spriteGeometry(j.sheetSprites[0], j.size.width, j.size.height);
      imp = textureImporter({ ...common, textureType: 8, spriteMode: 1, ppu: g.ppu, pivot: g.pivot, alignment: alignmentOf(g.pivot), border: g.border, alphaIsTransparency: true });
    } else if (j.multi && j.multi.length) {
      const sheet = [], nameTable = {};
      let ppu = 100;
      for (const { s, name, internalID } of j.multi) {
        const g = spriteGeometry(s, j.size.width, j.size.height);
        ppu = g.ppu;
        sheet.push({
          serializedVersion: 2, name, rect: { serializedVersion: 2, ...g.rect }, alignment: alignmentOf(g.pivot), pivot: flow(g.pivot),
          border: flow(g.border), outline: [], physicsShape: [], tessellationDetail: 0, bones: [], spriteID: hex32(j.rel + ':' + name),
          internalID, vertices: [], indices: '', edges: [], weights: [],
        });
        nameTable[name] = internalID;
      }
      imp = textureImporter({ ...common, textureType: 8, spriteMode: 2, ppu, sheet, nameTable, alphaIsTransparency: true });
      p.count('spriteSheets');
    } else imp = textureImporter({ ...common, textureType: 0, spriteMode: 0 });
    p.out.meta(j.rel, j.guid, imp);
    p.count('textures');
    for (const c of j.cutouts || []) {
      if (!c.sprite) continue;
      let atlasImg = j.decoded;
      if (!atlasImg) { try { atlasImg = j.decoded = decodePNG(j.img.bytes); } catch (e) { p.report.warn(`Không cắt được sprite từ atlas ${j.rel}: ${e.message}`); break; } }
      const g = spriteGeometry(c.sprite, atlasImg.width, atlasImg.height);
      const { x, width, height } = g.rect;
      const top = atlasImg.height - (g.rect.y + height);     // texture rects start at the bottom, PNG rows at the top
      const px = Buffer.alloc(width * height * 4);
      for (let yy = 0; yy < height; yy++) {
        const sy = top + yy;
        if (sy < 0 || sy >= atlasImg.height) continue;
        atlasImg.data.copy(px, yy * width * 4, (sy * atlasImg.width + x) * 4, (sy * atlasImg.width + x + width) * 4);
      }
      p.out.write(c.rel, encodePNG(width, height, px));
      p.out.meta(c.rel, c.guid, textureImporter({ ...common, width, height, textureType: 8, spriteMode: 1, ppu: g.ppu, pivot: g.pivot, alignment: alignmentOf(g.pivot), border: g.border, alphaIsTransparency: true }));
      p.count('sprites');
    }
    p.count('sprites', j.single ? 1 : (j.multi || []).length);
  }
}

module.exports = { planTextures, writeTextures, mediaIndex, imageSize };
