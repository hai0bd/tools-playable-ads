'use strict';
// Asset bundle loader for Cocos Creator 3.x builds (assets/<bundle>/config.json + import/ + native/)
const { decompressUuid } = require('../util/uuid');
const { readZip } = require('../util/zip');
const { unpackJSONs, isCompiled } = require('./deserialize');
const { isCCON, decodeCCON } = require('./ccon');

function parseJSON(buf, what) {
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error(`JSON hỏng (${what}): ${e.message}`); }
}

/** Find bundle roots: "assets/<name>/" or "remote/<name>/" (or subpackages) that contain a config.json */
function discoverBundles(files) {
  const roots = new Map();
  for (const k of files.keys()) {
    const m = k.match(/^((?:assets|remote|subpackages)\/([^/]+)\/)config\.json$/);
    if (m) roots.set(m[2], m[1]);
  }
  return roots;
}

class Bundle {
  constructor(name, prefix, files) {
    this.name = name;
    this.prefix = prefix;
    this.files = files;
    // bundles compressed as zip: "<prefix>res.zip" holds import/ + native/
    const zipKey = prefix + 'res.zip';
    if (files.has(zipKey)) {
      for (const [k, v] of readZip(files.get(zipKey))) files.set(prefix + k, v);
    }
    this.cfg = parseJSON(files.get(prefix + 'config.json'), prefix + 'config.json');
    const cfg = this.cfg;
    this.uuids = cfg.uuids.map((u) => decompressUuid(u));
    this.types = cfg.types || [];
    this.paths = new Map();   // uuid -> { path, type, isSub }
    for (const [idx, v] of Object.entries(cfg.paths || {})) {
      this.paths.set(this.uuids[+idx], { path: v[0], type: this.types[v[1]] || null, isSub: !!v[2] });
    }
    this.scenes = new Map();  // uuid -> db url
    for (const [url, idx] of Object.entries(cfg.scenes || {})) this.scenes.set(this.uuids[idx], url);
    this.redirect = new Set();
    for (let i = 0; i < (cfg.redirect || []).length; i += 2) this.redirect.add(this.uuids[cfg.redirect[i]]);
    this.extOf = new Map();   // uuid -> import file extension (".cconb" ...)
    for (const [ext, list] of Object.entries(cfg.extensionMap || {})) for (const idx of list) this.extOf.set(this.uuids[idx], ext);
    this.importBase = prefix + (cfg.importBase || 'import') + '/';
    this.nativeBase = prefix + (cfg.nativeBase || 'native') + '/';
    this._import = null;
    this._natives = null;
  }

  /** Map<uuid, {kind, data, file}>  kind: compiled | dynamic | ccon | texture-pack | image-pack */
  get importData() {
    if (this._import) return this._import;
    const out = new Map();
    const packed = new Set();
    for (const [packId, idxs] of Object.entries(this.cfg.packs || {})) {
      const key = `${this.importBase}${packId.slice(0, 2)}/${packId}.json`;
      if (!this.files.has(key)) continue;
      const json = parseJSON(this.files.get(key), key);
      if (Array.isArray(json)) {
        const secs = unpackJSONs(json);
        idxs.forEach((ui, k) => { out.set(this.uuids[ui], { kind: 'compiled', data: secs[k], file: key }); packed.add(ui); });
      } else if (json.type === 'cc.Texture2D') {
        idxs.forEach((ui, k) => { out.set(this.uuids[ui], { kind: 'texture-pack', data: { base: json.data[k][0], mipmaps: json.data[k][1] }, file: key }); packed.add(ui); });
      } else if (json.type === 'cc.ImageAsset') {
        idxs.forEach((ui, k) => { out.set(this.uuids[ui], { kind: 'image-pack', data: json.data[k], file: key }); packed.add(ui); });
      }
    }
    const packIds = new Set(Object.keys(this.cfg.packs || {}));
    this.uuids.forEach((uuid, i) => {
      if (packed.has(i) || out.has(uuid) || packIds.has(uuid)) return;
      const ext = this.extOf.get(uuid) || '.json';
      const key = `${this.importBase}${uuid.slice(0, 2)}/${uuid}${ext}`;
      const buf = this.files.get(key);
      if (!buf) return;
      if (ext === '.cconb' || isCCON(buf)) { out.set(uuid, { kind: 'ccon', data: decodeCCON(buf), file: key }); return; }
      const json = parseJSON(buf, key);
      out.set(uuid, { kind: isCompiled(json) ? 'compiled' : 'dynamic', data: json, file: key });
    });
    this._import = out;
    return out;
  }

  /** Map<uuid, [{ key, ext, name }]> native files (an asset can have several, e.g. compressed texture variants) */
  get natives() {
    if (this._natives) return this._natives;
    const out = new Map();
    for (const k of this.files.keys()) {
      if (!k.startsWith(this.nativeBase)) continue;
      const rest = k.slice(this.nativeBase.length).split('/'); // [xx, file] or [xx, uuid, filename]
      if (rest.length === 2) {
        const f = rest[1];
        // uuid (36 chars, or a short id such as the auto-atlas texture '18fc8c6b9') + optional @sub, then the extension
        const m = f.match(/^([0-9a-z-]{8,36}(?:@[^.]+)?)(\..+)$/i);
        if (!m) continue;
        (out.get(m[1]) || out.set(m[1], []).get(m[1])).push({ key: k, ext: m[2].toLowerCase(), name: null });
      } else if (rest.length === 3) {
        // native/xx/<uuid>[.md5]/<original file name>  (fonts, ...)
        const uuid = rest[1].replace(/\.[0-9a-f]{5}$/i, '');
        const ext = (rest[2].match(/\.[^.]+$/) || [''])[0].toLowerCase();
        (out.get(uuid) || out.set(uuid, []).get(uuid)).push({ key: k, ext, name: rest[2] });
      }
    }
    this._natives = out;
    return out;
  }

  native(uuid) {
    const list = this.natives.get(uuid);
    return list && list.length ? list[0] : null;
  }
}

function loadBundles(files) {
  const bundles = new Map();
  for (const [name, prefix] of discoverBundles(files)) bundles.set(name, new Bundle(name, prefix, files));
  return bundles;
}

/** Parse src/settings.json (3.x). Returns null if missing. */
function loadSettings(files) {
  const buf = files.get('src/settings.json');
  if (!buf) return null;
  return parseJSON(buf, 'src/settings.json');
}

module.exports = { Bundle, loadBundles, loadSettings, discoverBundles };
