'use strict';
// Index of every asset found in the build's bundles (except the builtin "internal" bundle).
const { decodeCompiled } = require('../decode/deserialize');
const { decompressUuid } = require('../util/uuid');

class AssetRecord {
  constructor(uuid, bundle, entry) {
    this.uuid = uuid;
    this.bundle = bundle;
    this.entry = entry;           // import data entry from Bundle.importData (may be undefined for native-only)
    this.type = null;
    this.root = null;             // decoded root object (compiled/custom) or dynamic doc
    this.decoded = null;          // full decodeCompiled result
    this.dynamic = null;          // { doc, chunks } for CCON / dynamic json
    this.baseUuid = uuid.split('@')[0];
    this.subId = uuid.includes('@') ? uuid.split('@')[1] : null;
    this.pathInfo = bundle.paths.get(uuid) || null;   // { path, type, isSub } when the bundle records paths
    this.plannedPath = null;      // project relative path assigned by the planner
    this.exported = false;
  }
}

class AssetDB {
  constructor(bundles, report) {
    this.bundles = bundles;
    this.report = report;
    this.records = new Map();
    this.internal = new Set();
    for (const [name, bundle] of bundles) {
      if (name === 'internal') { bundle.uuids.forEach((u) => this.internal.add(u)); continue; }
      for (const uuid of bundle.uuids) {
        if (bundle.redirect.has(uuid)) continue;
        if (this.isInternal(uuid)) { this.internal.add(uuid); continue; }   // builtin asset copied into this bundle
        const entry = bundle.importData.get(uuid);
        if (!entry) {
          // a uuid in "uuids" without import data: usually a pack id or an asset stored only in another bundle
          if (!bundle.cfg.packs || !bundle.cfg.packs[uuid]) {
            const nat = bundle.native(uuid);
            if (nat) this.records.set(uuid, Object.assign(new AssetRecord(uuid, bundle, null), { type: 'native-only' }));
          }
          continue;
        }
        const rec = new AssetRecord(uuid, bundle, entry);
        try { this.decode(rec); } catch (e) { rec.type = 'error'; rec.error = e.message; report.warn(`Không giải mã được asset ${uuid}: ${e.message}`); }
        this.records.set(uuid, rec);
      }
    }
  }

  decode(rec) {
    const e = rec.entry;
    if (e.kind === 'compiled') {
      rec.decoded = decodeCompiled(e.data);
      rec.root = rec.decoded.root;
      rec.type = rec.root && rec.root.__type__;
    } else if (e.kind === 'texture-pack') {
      rec.type = 'cc.Texture2D';
      rec.root = { __type__: 'cc.Texture2D', __custom__: { base: e.data.base, mipmaps: (e.data.mipmaps || []).map(decompressUuid) } };
    } else if (e.kind === 'image-pack') {
      rec.type = 'cc.ImageAsset';
      rec.root = { __type__: 'cc.ImageAsset', __custom__: e.data };
    } else if (e.kind === 'ccon') {
      rec.dynamic = { doc: e.data.doc, chunks: e.data.chunks };
      const first = Array.isArray(e.data.doc) ? e.data.doc[0] : e.data.doc;
      rec.type = first && first.__type__;
    } else if (e.kind === 'dynamic') {
      rec.dynamic = { doc: e.data, chunks: [] };
      const first = Array.isArray(e.data) ? e.data[0] : e.data;
      rec.type = first && first.__type__;
    }
  }

  get(uuid) { return this.records.get(uuid); }
  has(uuid) { return this.records.has(uuid); }
  isInternal(uuid) {
    const { BUILTIN_UUIDS } = require('../project/metas');
    const base = uuid.split('@')[0];
    return this.internal.has(uuid) || this.internal.has(base) || BUILTIN_UUIDS.has(uuid) || BUILTIN_UUIDS.has(base);
  }

  typeOf(uuid) {
    const r = this.records.get(uuid);
    if (r && r.type) return r.type;
    if (uuid.endsWith('@f9941')) return 'cc.SpriteFrame';
    if (uuid.endsWith('@6c48a')) return 'cc.Texture2D';
    const builtin = require('../project/metas').BUILTIN_TYPES.get(uuid);
    if (builtin) return builtin;
    return 'cc.Asset';
  }

  ofType(...types) {
    const set = new Set(types);
    return [...this.records.values()].filter((r) => set.has(r.type));
  }

  /** Sub-assets of an asset (e.g. uuid@6c48a, uuid@f9941 of an image). */
  subsOf(baseUuid) {
    return [...this.records.values()].filter((r) => r.baseUuid === baseUuid && r.subId);
  }
}

module.exports = { AssetDB, AssetRecord };
