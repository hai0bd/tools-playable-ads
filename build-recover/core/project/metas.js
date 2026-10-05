'use strict';
// Importer versions + meta builders for Cocos Creator 3.8.x asset metas.
// Defaults were collected from real 3.8.7 projects; refreshVersionsFromEditor() overrides them with the
// versions found in the target editor's builtin assets when available.
const fs = require('fs');
const path = require('path');

const VERSIONS = {
  image: '1.0.27', texture: '1.0.22', 'sprite-frame': '1.0.12', 'audio-clip': '1.0.0', 'ttf-font': '1.0.1',
  'bitmap-font': '1.0.6', 'label-atlas': '1.0.1', typescript: '4.0.24', javascript: '4.0.24', scene: '1.1.50',
  prefab: '1.1.50', 'animation-clip': '2.0.4', 'spine-data': '1.2.7', text: '1.0.1', json: '2.0.1', buffer: '1.0.3',
  directory: '1.2.0', material: '1.0.21', effect: '1.7.1', 'effect-header': '1.0.7', particle: '1.0.2',
  'physics-material': '1.0.1', 'render-texture': '1.2.1', 'rt-sprite-frame': '1.0.0', 'auto-atlas': '1.0.8',
  'video-clip': '1.0.0', dragonbones: '1.0.2', 'dragonbones-atlas': '1.0.2', 'sprite-atlas': '1.0.8',
  'tiled-map': '1.0.2', '*': '1.0.0',
  'texture-cube': '1.0.4', 'erp-texture-cube': '1.0.10', 'texture-cube-face': '1.0.0',
  gltf: '2.3.14', fbx: '2.3.14', 'gltf-mesh': '1.1.1', 'gltf-material': '1.0.14', 'gltf-scene': '1.0.14',
  'gltf-embeded-image': '1.0.3', 'gltf-skeleton': '1.0.1', 'gltf-animation': '1.0.18',
};

// uuids of the editor's builtin assets (db://internal): they exist in every project, never export them
const BUILTIN_UUIDS = new Set();
// builtin uuid -> asset type, for the __expectedType__ of references to builtin assets
const BUILTIN_TYPES = new Map();
const IMPORTER_TYPES = {
  effect: 'cc.EffectAsset', image: 'cc.ImageAsset', texture: 'cc.Texture2D', 'sprite-frame': 'cc.SpriteFrame', material: 'cc.Material',
  'gltf-mesh': 'cc.Mesh', 'gltf-material': 'cc.Material', 'gltf-scene': 'cc.Prefab', 'gltf-skeleton': 'cc.Skeleton', 'gltf-animation': 'cc.AnimationClip',
  'texture-cube': 'cc.TextureCube', 'erp-texture-cube': 'cc.TextureCube', 'render-pipeline': 'cc.RenderPipeline', 'physics-material': 'cc.PhysicsMaterial',
  prefab: 'cc.Prefab', scene: 'cc.SceneAsset', 'ttf-font': 'cc.TTFFont', 'render-texture': 'cc.RenderTexture',
};

function refreshVersionsFromEditor(engineDir) {
  const root = path.join(engineDir, 'editor', 'assets');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.meta')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        const take = (x) => {
          if (!x) return;
          if (x.importer && x.ver) { VERSIONS[x.importer] = x.ver; n++; }
          if (x.uuid) BUILTIN_UUIDS.add(x.uuid);
          if (x.uuid && IMPORTER_TYPES[x.importer]) BUILTIN_TYPES.set(x.uuid, IMPORTER_TYPES[x.importer]);
          Object.values(x.subMetas || {}).forEach(take);
        };
        take(m);
      } catch { /* ignore */ }
    }
  })(root);
  return n;
}

function meta(importer, uuid, { files = [], userData = {}, subMetas = {} } = {}) {
  return { ver: VERSIONS[importer] || '1.0.0', importer, imported: true, uuid, files, subMetas, userData };
}

function subMeta(importer, uuid, id, name, displayName, userData, files = ['.json']) {
  return { ver: VERSIONS[importer] || '1.0.0', importer, uuid, imported: true, files, subMetas: {}, userData, displayName, id, name };
}

module.exports = { VERSIONS, BUILTIN_UUIDS, BUILTIN_TYPES, refreshVersionsFromEditor, meta, subMeta };
