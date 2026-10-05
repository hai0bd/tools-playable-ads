'use strict';
// Decide where every recovered asset goes inside assets/.
//  1. exact paths when the build still knows them (bundle "paths", scene urls)
//  2. otherwise a type folder + "owner" (the scene screen / prefab that uses the asset; "Common" if shared)
const { walkNodes } = require('./editorjson');
const { sanitizeName } = require('../project/writer');

const TYPE_FOLDERS = {
  'cc.SceneAsset': ['Scenes', '.scene'],
  'cc.Prefab': ['Prefabs', '.prefab'],
  'cc.AnimationClip': ['Animations', '.anim'],
  'cc.AudioClip': ['Audio', null],
  'cc.TTFFont': ['Fonts', '.ttf'],
  'cc.BitmapFont': ['Fonts', '.fnt'],
  'cc.LabelAtlas': ['Fonts', '.labelatlas'],
  'cc.Material': ['Materials', '.mtl'],
  'cc.EffectAsset': ['Effects', '.effect'],
  'cc.PhysicsMaterial': ['Physics', '.pmtl'],
  'cc.JsonAsset': ['Data', '.json'],
  'cc.TextAsset': ['Data', '.txt'],
  'cc.BufferAsset': ['Data', '.bin'],
  'cc.ParticleAsset': ['Particles', '.plist'],
  'cc.TiledMapAsset': ['TiledMaps', '.tmx'],
  'cc.VideoClip': ['Videos', null],
  'cc.RenderTexture': ['RenderTextures', '.rt'],
  'cc.SpriteAtlas': ['Textures', '.plist'],
  'sp.SkeletonData': ['Spine', null],
  'dragonBones.DragonBonesAsset': ['DragonBones', null],
  'dragonBones.DragonBonesAtlasAsset': ['DragonBones', null],
};

const isNodeObj = (o) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const isCompObj = (o) => o && o.node && isNodeObj(o.node) && !isNodeObj(o);

/**
 * Collect asset uuids referenced from a decoded graph.
 * With stopAtNodes, references to other nodes/components are not followed (so a component only
 * reports the assets it uses itself, not the whole scene reachable through node links).
 */
function collectRefs(graph, { stopAtNodes = false } = {}) {
  const refs = [];
  const seen = new Set();
  (function rec(v, depth) {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x) => rec(x, depth + 1)); return; }
    if (v.__uuid__) { refs.push(v.__uuid__); return; }
    if (stopAtNodes && depth > 0 && (isNodeObj(v) || isCompObj(v))) return;
    for (const k of Object.keys(v)) rec(v[k], depth + 1);
  })(graph, 0);
  return refs;
}

class Planner {
  constructor(db, writer, report) {
    this.db = db;
    this.writer = writer;
    this.report = report;
    this.owners = new Map();   // uuid -> Set(owner)
    this.nameOf = new Map();   // uuid -> display name hint
  }

  addOwner(uuid, owner) {
    const base = uuid.split('@')[0];
    for (const u of [uuid, base]) (this.owners.get(u) || this.owners.set(u, new Set()).get(u)).add(owner);
  }

  /** Follow indirect references (anim -> sprite frames, spine -> textures, font -> sprite frame ...) */
  propagate(uuid, owner, depth = 0) {
    if (depth > 6) return;
    const base = uuid.split('@')[0];
    const already = this.owners.get(base);
    this.addOwner(uuid, owner);
    if (already && already.has(owner) && depth > 0) return;
    const rec = this.db.get(uuid) || this.db.get(base);
    if (!rec) return;
    let refs = [];
    if (rec.root) refs = collectRefs(rec.root);
    else if (rec.dynamic) refs = collectRefs(rec.dynamic.doc).map((u) => require('../util/uuid').decompressUuid(u));
    // sub-assets of the same image (texture / spriteFrame)
    for (const s of [base + '@f9941', base + '@6c48a']) if (this.db.has(s) && s !== uuid) refs.push(s);
    for (const r of refs) if (r.split('@')[0] !== base) this.propagate(r, owner, depth + 1);
  }

  analyzeUsage() {
    const scenes = this.db.ofType('cc.SceneAsset');
    const multiScene = scenes.length > 1;
    for (const rec of scenes) {
      const scene = rec.root && rec.root.scene;
      if (!scene) continue;
      const sceneName = rec.root._name || 'Scene';
      const canvas = (scene._children || []).find((n) => (n._components || []).some((c) => c.__type__ === 'cc.Canvas'));
      const screens = canvas ? canvas._children || [] : [];
      const ownerOfNode = new Map();
      for (const s of screens) walkNodes(s, (n) => ownerOfNode.set(n, (multiScene ? sceneName + '/' : '') + s._name));
      walkNodes(scene, (n) => {
        const owner = ownerOfNode.get(n) || sceneName;
        for (const c of n._components || []) for (const u of collectRefs(c, { stopAtNodes: true })) this.propagate(u, owner);
      });
    }
    for (const rec of this.db.ofType('cc.Prefab')) {
      const owner = 'Prefab_' + (rec.root._name || (rec.root.data && rec.root.data._name) || rec.uuid.slice(0, 8));
      for (const u of collectRefs(rec.root)) if (u.split('@')[0] !== rec.uuid) this.propagate(u, owner);
    }
  }

  ownerFolder(uuid) {
    const set = this.owners.get(uuid) || this.owners.get(uuid.split('@')[0]);
    if (!set || set.size === 0) return 'Unused';
    if (set.size === 1) return [...set][0].replace(/^Prefab_/, '');
    // shared by several prefabs only -> Prefabs common; otherwise Common
    return 'Common';
  }

  /** Bundle root folder for records that come from a named bundle (resources / custom bundles). */
  bundleRoot(rec) {
    if (rec.bundle.name === 'main') return 'assets';
    return `assets/${rec.bundle.name}`;
  }

  /** exact path (without extension) recorded by the bundle, or null */
  exactPath(rec) {
    const info = rec.pathInfo || (this.db.get(rec.baseUuid + '@f9941') || {}).pathInfo || (this.db.get(rec.baseUuid + '@6c48a') || {}).pathInfo;
    if (!info || !info.path || info.path.startsWith('db:/')) return null;
    let p = info.path;
    p = p.replace(/\/(spriteFrame|texture)$/, '');
    return `${this.bundleRoot(rec)}/${p}`;
  }

  /** Returns project-relative path for an asset file, reserving it in the writer. */
  place(rec, name, ext, typeFolder, { useOwner = false, subFolder = null } = {}) {
    const scene = rec.type === 'cc.SceneAsset' && rec.bundle.scenes.get(rec.uuid);
    if (scene) {
      const rel = scene.replace(/^db:\/\//, '');
      return this.writer.claimExact(rel);
    }
    const exact = this.exactPath(rec);
    if (exact) return this.writer.claimExact(exact + ext);
    let dir = `${this.bundleRoot(rec)}/${typeFolder}`;
    if (useOwner) dir += '/' + this.ownerFolder(rec.uuid).split('/').map(sanitizeName).join('/');
    if (subFolder) dir += '/' + subFolder.split('/').map(sanitizeName).join('/');
    return this.writer.claim(dir.replace(/\/+/g, '/'), name, ext);
  }
}

module.exports = { Planner, TYPE_FOLDERS, collectRefs };
