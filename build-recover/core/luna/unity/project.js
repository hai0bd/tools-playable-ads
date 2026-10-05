'use strict';
// Luna model → Unity project on disk. Shared plumbing: output files, GUID planning, reference resolution and the
// generic DTO → YAML value conversion. The per-asset writers live in the sibling modules.
const fs = require('fs');
const path = require('path');
const { flow, unityFile, yamlDoc } = require('./yaml');
const ids = require('./ids');
const S = require('../schema');

const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/g;
const THIRD_PARTY = /^(UnityEngine|UnityEditor|Unity|TMPro|Spine|DG\.Tweening|Cinemachine|System)\./;

class Out {
  constructor(root) { this.root = root; this.claimed = new Set(); this.count = 0; this.bytes = 0; }
  /** Reserve a project-relative path; a taken name (case-insensitive, like Windows) gets " 2", " 3"… */
  claim(rel) {
    rel = rel.replace(/\\/g, '/').split('/').map((s) => s.replace(BAD_CHARS, '_').replace(/[. ]+$/, '') || '_').join('/');
    const ext = path.posix.extname(rel), base = rel.slice(0, rel.length - ext.length);
    let r = rel;
    for (let k = 2; this.claimed.has(r.toLowerCase()); k++) r = `${base} ${k}${ext}`;
    this.claimed.add(r.toLowerCase());
    return r;
  }
  has(rel) { return this.claimed.has(rel.toLowerCase()); }
  write(rel, data) {
    const abs = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    this.count++;
    this.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  }
  meta(rel, guid, importer) { this.write(rel + '.meta', yamlDoc({ fileFormatVersion: 2, guid, ...importer })); }
}

const IMPORTER_TAIL = { userData: '', assetBundleName: '', assetBundleVariant: '' };
const importers = {
  native: (mainObjectFileID) => ({ NativeFormatImporter: { externalObjects: {}, mainObjectFileID, ...IMPORTER_TAIL } }),
  text: () => ({ TextScriptImporter: { externalObjects: {}, ...IMPORTER_TAIL } }),
  default: () => ({ DefaultImporter: { externalObjects: {}, ...IMPORTER_TAIL } }),
  prefab: () => ({ PrefabImporter: { externalObjects: {}, ...IMPORTER_TAIL } }),
  shader: () => ({ ShaderImporter: { externalObjects: {}, defaultTextures: [], nonModifiableTextures: [], ...IMPORTER_TAIL } }),
  mono: () => ({ MonoImporter: { externalObjects: {}, serializedVersion: 2, defaultReferences: [], executionOrder: 0, icon: flow({ instanceID: 0 }), ...IMPORTER_TAIL } }),
  audio: () => ({
    AudioImporter: {
      externalObjects: {}, serializedVersion: 6,
      defaultSettings: { loadType: 0, sampleRateSetting: 0, sampleRateOverride: 44100, compressionFormat: 1, quality: 1, conversionMode: 0 },
      platformSettingOverrides: {}, forceToMono: 0, normalize: 1, preloadAudioData: 1, loadInBackground: 0, ambisonic: 0, '3D': 1, ...IMPORTER_TAIL,
    },
  }),
};

const HEADER = () => ({ m_ObjectHideFlags: 0, m_CorrespondingSourceObject: flow({ fileID: 0 }), m_PrefabInstance: flow({ fileID: 0 }), m_PrefabAsset: flow({ fileID: 0 }) });

class UnityProject {
  constructor(model, root, report, opts = {}) {
    this.m = model;
    this.out = new Out(root);
    this.report = report;
    this.opts = opts;
    this.assets = new Map();      // luna asset id → { kind, rel, guid, ref }
    this.homes = new Map();       // scene/prefab object or component id → { file, fileID }
    this.fileIds = new Map();     // file key → ids of its objects and components
    this.files = new Map();       // file key → { kind: 'scene'|'prefab', guid, rel }
    this.scripts = new Map();     // class name → { guid, fileID, user: bool, pkg, rel }
    this.packagesUsed = new Set(); // Asset Store packages components come from ("DOTween Pro"…)
    this.stats = {};
    this.unresolved = new Set();
    this.refFieldCache = new Map();
    this.missingFonts = new Set();
    this.subMaterials = [];         // materials stored inside another asset (TMP font asset, Spine atlas asset)
    this.looseMaterials = [];
    this.scriptSamples = new Map(); // user class → deserialized instances (types of references for the C#)
    this.scriptKinds = new Map();   // user class → 'mono' | 'scriptable'
    this.intCache = new Map();
  }

  /** Will this type compile in the recovered project (Unity, generated scripts, packages the manifest pulls in)? */
  typeAvailable(t) {
    if (!t) return false;
    if (/^UnityEngine\./.test(t) && !/^UnityEngine\.(Rendering\.Universal|InputSystem|Timeline|Playables\.)/.test(t)) return true;
    if (/^TMPro\./.test(t)) return true;
    if (/^Spine\./.test(t)) return !!(this.needSpine && /^[4-9]\./.test(this.spineBranch || '4.1'));
    const s = this.scripts.get(t);
    if (s) return !!s.user || (!!s.guid && !THIRD_PARTY.test(t));
    return !THIRD_PARTY.test(t) && !/^(DG|RootMotion|Luna|Sirenix|Cinemachine)\./.test(t) && this.m.schema.types.includes(t);
  }

  /** Methods scenes bind through UnityEvents (Button.onClick…): class → method → C# parameter list. */
  collectEventMethods() {
    this.eventMethods = new Map();
    const PARAM = { 1: '', 2: 'UnityEngine.Object value', 3: 'int value', 4: 'float value', 5: 'string value', 6: 'bool value' };
    const walk = (v) => {
      if (!v || typeof v !== 'object') return;
      if (v instanceof S.List) return v.items.forEach(walk);
      if (Array.isArray(v)) return v.forEach(walk);
      if (v.$type === 'UnityEngine.Events.PersistentCall' && v.m_MethodName) {
        let cls = null;
        const t = v.m_Target && this.m.components.get(v.m_Target.id);
        if (t) cls = t.comp.className;
        else if (v.m_TargetAssemblyTypeName) cls = String(v.m_TargetAssemblyTypeName).split(',')[0].trim();
        if (cls) {
          if (!this.eventMethods.has(cls)) this.eventMethods.set(cls, new Map());
          let param = PARAM[v.m_Mode] != null ? PARAM[v.m_Mode] : '';
          const objType = v.m_Arguments && v.m_Arguments.m_ObjectArgumentAssemblyTypeName;
          if (v.m_Mode === 2 && objType) param = String(objType).split(',')[0].trim() + ' value';
          this.eventMethods.get(cls).set(v.m_MethodName, param);
        }
        return;
      }
      for (const k of Object.keys(v)) if (k[0] !== '$') walk(v[k]);
    };
    for (const { comp } of this.m.components.values()) walk(comp.value);
  }

  noteScriptUse(className, value) {
    if (!this.scriptSamples.has(className)) this.scriptSamples.set(className, []);
    const list = this.scriptSamples.get(className);
    if (list.length < 50) list.push(value);
  }

  /** Bridge.NET keeps C# int arithmetic as "x | 0": a field ever written that way is an int. */
  intHint(className, field) {
    const key = className + '.' + field;
    if (this.intCache.has(key)) return this.intCache.get(key);
    const def = require('./csharp').bridgeDefine(this.m.x.code, className) || '';
    const re = new RegExp(`this\\.${field.replace(/\W/g, '')}\\s*=[^;,]*\\|\\s*0\\b|this\\.${field.replace(/\W/g, '')}\\s*\\|\\s*0\\b`);
    const v = re.test(def);
    this.intCache.set(key, v);
    return v;
  }

  count(k, n = 1) { this.stats[k] = (this.stats[k] || 0) + n; }

  // ---------------------------------------------------------------- paths
  /** Luna asset path → project path ("Assets/..."). Paths outside Assets/ (builtins, "Default UI Material") → null. */
  static assetPath(p) {
    p = String(p || '').replace(/\\/g, '/');
    return /^Assets\//.test(p) ? p : null;
  }
  claim(rel) { return this.out.claim(rel); }
  claimUnder(dir, name, ext) { return this.out.claim(`${dir}/${String(name || 'Asset').replace(/[\\/]/g, '_')}${ext}`); }

  // ---------------------------------------------------------------- asset registry
  register(id, info) { if (!this.assets.has(id)) this.assets.set(id, info); return info; }
  assetRef(id) { const a = this.assets.get(id); return a ? a.ref : null; }

  /** Luna reference {type, id} → Unity reference (flow) as seen from `file` (scene/prefab key, or null for assets). */
  ref(r, file) {
    if (r == null) return ids.NULL_REF;
    if (!(r instanceof S.Ref)) return ids.NULL_REF;
    // the same id can live in a scene AND in a runtime "prefab" Luna cut out of it (DontDestroyOnLoad roots…):
    // an object of the referencing file always wins
    const own = file && this.fileIds.get(file);
    if (own && own.has(r.id)) return ids.localRef(r.id);
    const home = this.homes.get(r.id);
    if (home) {
      if (home.file === file) return ids.localRef(home.fileID);
      const f = this.files.get(home.file);
      if (f && f.kind === 'prefab') return ids.assetRef(home.fileID, f.guid, 3);
      this.unresolved.add(`${r.type}#${r.id} (ở ${f ? f.rel : home.file}, tham chiếu từ ${file ? (this.files.get(file) || {}).rel || file : 'asset'})`);
      return ids.NULL_REF;
    }
    const a = this.assets.get(r.id);
    if (a && a.ref) {
      // a sprite asked for as Texture2D (or the other way round) — resolve to the requested kind when possible
      if (r.type === 'UnityEngine.Texture2D' && a.textureRef) return a.textureRef;
      return a.ref;
    }
    if (a && a.builtin === false) return ids.NULL_REF;
    this.unresolved.add(`${r.type}#${r.id}`);
    return ids.NULL_REF;
  }

  // ---------------------------------------------------------------- generic values
  /** Fields a deserializer fills through e.r(…, 0, obj, "name") — null there means a null reference, not an empty value. */
  refFields(typeName) {
    if (this.refFieldCache.has(typeName)) return this.refFieldCache.get(typeName);
    const set = new Set();
    const fn = this.m.schema.D[typeName];
    if (typeof fn === 'function') {
      const src = fn.toString();
      const re = /\.r\([^()]*?,\s*[0-2]\s*,\s*\w+\s*,\s*"([^"]+)"\s*\)/g;
      let mm;
      while ((mm = re.exec(src))) set.add(mm[1]);
      // arrays / lists of references: `...,2,s,"")` then `i.field=s`
      const re2 = /\.r\([^()]*?,\s*[12]\s*,\s*(\w+)\s*,\s*""\s*\)[^]*?\.(\w+)\s*=\s*\1\b/g;
      while ((mm = re2.exec(src))) set.add(mm[2]);
    }
    this.refFieldCache.set(typeName, set);
    return set;
  }

  /** Deserialized value → YAML value. `owner` = DTO type name of the object holding the field (null-ref detection). */
  value(v, file, owner, field) {
    if (v === undefined) return undefined;
    if (v === null) return owner && this.refFields(owner).has(field) ? ids.NULL_REF : '';
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'object') return v;
    if (v instanceof S.Ref) return this.ref(v, file);
    if (v instanceof S.Vec2) return flow({ x: v.x, y: v.y });
    if (v instanceof S.Vec3) return flow({ x: v.x, y: v.y, z: v.z });
    if (v instanceof S.Vec4 || v instanceof S.Quat) return flow({ x: v.x, y: v.y, z: v.z, w: v.w });
    if (v instanceof S.Color) return flow({ r: v.r, g: v.g, b: v.b, a: v.a });
    if (v instanceof S.Color32) return { serializedVersion: 2, rgba: ((v.a & 255) * 16777216 + ((v.b & 255) << 16 | (v.g & 255) << 8 | (v.r & 255))) >>> 0 };
    if (v instanceof S.Rect) return { serializedVersion: 2, x: v.x, y: v.y, width: v.width, height: v.height };
    if (v instanceof S.LayerMask) return { serializedVersion: 2, m_Bits: v.m_Bits };
    if (v instanceof S.Mat4) { const o = {}; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[`e${r}${c}`] = v.data[c * 4 + r]; return o; }
    if (v instanceof S.List) return v.items.map((x) => (x === null ? ids.NULL_REF : this.value(x, file)));
    if (Array.isArray(v)) {
      const hasRef = v.some((x) => x instanceof S.Ref);
      return v.map((x) => (x === null && hasRef ? ids.NULL_REF : this.value(x, file)));
    }
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (v.$unknown) return undefined;
    const typeName = v.$type || owner;
    const o = {};
    for (const k of Object.keys(v)) {
      if (k[0] === '$') continue;
      const x = this.value(v[k], file, typeName, k);
      if (x !== undefined) o[k] = x;
    }
    return o;
  }

  // ---------------------------------------------------------------- scripts
  /** m_Script reference for a MonoBehaviour / ScriptableObject class. */
  scriptRef(className) {
    let s = this.scripts.get(className);
    if (!s) {
      const pkg = ids.packageScript(className);
      if (pkg) s = { guid: pkg.guid, fileID: pkg.fileID, user: false, pkg: ids.packageLabel(pkg.guid) };
      // third-party code we have no GUID for (unknown Spine/Unity classes, plugin DLLs never seen on this machine):
      // never generate a clashing copy — the component keeps its data and binds once the package is imported
      else if (THIRD_PARTY.test(className)) s = { guid: null, user: false, missing: true };
      else s = { guid: ids.guidOf('script:' + className), user: true };
      this.scripts.set(className, s);
    }
    if (s.pkg) this.packagesUsed.add(s.pkg);
    return s.guid ? ids.assetRef(s.fileID || 11500000, s.guid, 3) : ids.NULL_REF;
  }

  // ---------------------------------------------------------------- serialized YAML files
  writeYamlAsset(rel, guid, docs, mainFileID) {
    this.out.write(rel, unityFile(docs));
    this.out.meta(rel, guid, importers.native(mainFileID));
  }
}

module.exports = { UnityProject, Out, importers, HEADER, IMPORTER_TAIL };
