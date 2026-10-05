'use strict';
// Luna bundles → one in-memory model with every record deserialized through the build's own Deserializers.
//   assets:  id → { id, bundle, category, path, name, dto, record }
//   scenes:  [{ id, name, path, dto, renderSettings, roots: [node] }]
//   prefabs: [{ id, path, root: node }]
//   node:    { id, name, layer, tag, active, isStatic, components: [comp], children: [node], parent }
//   comp:    { id, typeName, className, dto, enabled, value }
const { Schema, plain } = require('./schema');

const DTO = {
  textures: 'Luna.Unity.DTO.UnityEngine.Textures.Texture2D',
  sprites: 'Luna.Unity.DTO.UnityEngine.Textures.Sprite',
  materials: 'Luna.Unity.DTO.UnityEngine.Assets.Material',
  meshes: 'Luna.Unity.DTO.UnityEngine.Assets.Mesh',
  'animation-clips': 'Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationClip',
  'animator-controllers': 'Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorController',
  fonts: 'Luna.Unity.DTO.UnityEngine.Assets.Font',
  'text-assets': 'Luna.Unity.DTO.UnityEngine.Assets.TextAsset',
  shaders: 'Luna.Unity.DTO.UnityEngine.Assets.Shader',
  'physics-materials-2d': 'Luna.Unity.DTO.UnityEngine.Assets.PhysicsMaterial2D',
  'physics-materials': 'Luna.Unity.DTO.UnityEngine.Assets.PhysicMaterial',
  sounds: 'Luna.Unity.DTO.UnityEngine.Assets.AudioClip',
  cubemaps: 'Luna.Unity.DTO.UnityEngine.Textures.Cubemap',
  'render-textures': 'Luna.Unity.DTO.UnityEngine.Textures.RenderTexture',
  avatars: 'Luna.Unity.DTO.UnityEngine.Animation.Mecanim.Avatar',
  'urp-assets': 'Luna.Unity.DTO.UnityEngine.Assets.UniversalRenderPipelineAsset',
  'project-settings': 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings',
  resources: 'Luna.Unity.DTO.UnityEngine.Assets.Resources',
};
const GAMEOBJECT = 'Luna.Unity.DTO.UnityEngine.Scene.GameObject';

class LunaModel {
  constructor(extracted) {
    this.x = extracted;
    this.schema = new Schema(extracted.code);
    this.info = this.schema.info();
    this.assets = new Map();
    this.byCategory = new Map();
    this.scenes = [];
    this.prefabs = [];
    this.nodes = new Map();        // node id → node
    this.components = new Map();   // component id → { comp, node }
    this.errors = [];
    this.load();
  }

  blob(bundle) { return this.x.blobs[`assets/bundles/${bundle}/data.blob`] || null; }

  add(category, rec, bundle) {
    let dto = null;
    const name = rec.class != null && category === 'scriptable-objects' ? this.schema.types[rec.class] : DTO[category];
    if (name && rec.data !== undefined) {
      try { dto = this.schema.deserialize(name, rec.data); } catch (e) { this.errors.push(`${category} ${rec.id}: ${e.message}`); }
    }
    const a = {
      id: rec.id, bundle, category, path: rec.path || '', record: rec, dto, className: category === 'scriptable-objects' ? name : null,
      name: rec.name || (dto && typeof dto.name === 'string' && dto.name) || (Array.isArray(rec.data) && typeof rec.data[0] === 'string' ? rec.data[0] : '') || '',
    };
    if (!this.assets.has(rec.id)) this.assets.set(rec.id, a);
    if (!this.byCategory.has(category)) this.byCategory.set(category, []);
    this.byCategory.get(category).push(a);
    return a;
  }

  node(rec, parent) {
    let go = {};
    try { go = this.schema.deserialize(GAMEOBJECT, rec.data) || {}; } catch (e) { this.errors.push(`GameObject ${rec.id}: ${e.message}`); }
    const n = {
      id: rec.id, name: go.name != null ? go.name : rec.path || '', tagId: go.tagId || 0, active: go.enabled !== false,
      isStatic: !!go.isStatic, layer: go.layer || 0, sourcePath: rec.path || '', parent, components: [], children: [],
    };
    this.nodes.set(n.id, n);
    for (const c of rec.components || []) {
      let comp;
      try { comp = this.schema.component(c); } catch (e) { this.errors.push(`Component ${c.id} (${this.schema.types[c.type]}): ${e.message}`); continue; }
      n.components.push(comp);
      this.components.set(comp.id, { comp, node: n });
    }
    for (const ch of rec.children || []) n.children.push(this.node(ch, n));
    return n;
  }

  load() {
    const bundles = Object.keys(this.x.jsons).map((k) => k.match(/^assets\/bundles\/(-?\d+)\/bundle\.json$/)).filter(Boolean).map((m) => m[1]);
    // builtin (-2) first: bundle -1 ids win when both exist
    bundles.sort((a, b) => +a - +b);
    for (const b of bundles) {
      const json = this.x.jsons[`assets/bundles/${b}/bundle.json`];
      for (const [category, list] of Object.entries(json)) {
        if (!Array.isArray(list) || category === 'scenes' || category === 'prefabs') continue;
        for (const rec of list) if (rec && rec.id != null) this.add(category, rec, +b);
      }
    }
    for (const b of bundles) {
      const json = this.x.jsons[`assets/bundles/${b}/bundle.json`];
      for (const rec of json.prefabs || []) {
        const root = this.node(rec, null);
        this.prefabs.push({ id: rec.id, path: rec.path || '', root, bundle: +b });
      }
      for (const rec of json.scenes || []) {
        let dto = {};
        try { dto = this.schema.deserialize('Luna.Unity.DTO.UnityEngine.Scene.Scene', rec.data) || {}; } catch (e) { this.errors.push(`Scene ${rec.id}: ${e.message}`); }
        let rs = null;
        if (rec.render_settings && rec.render_settings.data) {
          try { rs = this.schema.deserialize('Luna.Unity.DTO.UnityEngine.Assets.RenderSettings', rec.render_settings.data); } catch (e) { this.errors.push(`RenderSettings: ${e.message}`); }
        }
        const roots = (rec.objects || []).map((o) => this.node(o, null));
        if (rec.transform_ids) this.sceneTransforms(rec, roots, +b);
        this.scenes.push({ id: rec.id, name: rec.name || dto.name || 'Scene', path: rec.path || '', dto, renderSettings: rs, roots, bundle: +b });
      }
    }
  }

  /**
   * Luna 7 keeps scene Transforms out of the objects: transform_ids + local_positions/rotations/scales (or the same
   * data in data.blob behind transforms.marker), one entry per object WITHOUT a Transform component (RectTransforms
   * stay in the component list), holding LOCAL position/rotation/scale.
   *
   * The order is POST-ORDER — children before their parent — because that is when Luna's own loader claims an entry:
   *
   *   _loadObject(scene, parent, json) {
   *     for (const ch of json.children) this._loadObject(scene, entity, ch);   // children first
   *     for (const c of json.components) this._loadComponent(...);             // sets TransformDirty for (Rect)Transform
   *     if (0 == (entity.flags & TransformDirty)) { json.transformId = ids[entities.length]; entities.push(entity); }
   *   }
   *
   * and _installTransforms() then applies transformData[i] to entities[i]. Walking pre-order instead gives the same
   * 442-vs-442 count on this build, so nothing below catches it — every object just gets another object's transform.
   */
  sceneTransforms(rec, roots, bundle) {
    const S = require('./schema');
    let ids = rec.transform_ids, pos = rec.local_positions, rot = rec.local_rotations, scl = rec.local_scales;
    const blob = this.blob(bundle);
    if ((!pos || !rot || !scl) && rec.transforms && rec.transforms.marker && blob) {
      const [off, len] = rec.transforms.marker;
      const f = new Float32Array(blob.buffer.slice(blob.byteOffset + off, blob.byteOffset + off + len));
      const o = rec.transforms.offsets || {};
      const n = rec.transforms.count || ids.length;
      pos = f.subarray(o.positions || 0, (o.positions || 0) + n * 3);
      rot = f.subarray(o.rotations != null ? o.rotations : n * 3, (o.rotations != null ? o.rotations : n * 3) + n * 4);
      scl = f.subarray(o.scales != null ? o.scales : n * 7, (o.scales != null ? o.scales : n * 7) + n * 3);
    }
    const order = [];
    (function walk(list) { for (const nd of list) { walk(nd.children); order.push(nd); } })(roots);
    const without = order.filter((nd) => !nd.components.some((c) => c.className === 'UnityEngine.Transform' || c.className === 'UnityEngine.RectTransform'));
    if (without.length !== ids.length) this.errors.push(`Scene ${rec.name}: ${ids.length} transform tách riêng nhưng ${without.length} object thiếu Transform — vị trí có thể lệch.`);
    without.forEach((nd, i) => {
      if (i >= ids.length) return;
      const value = {
        $type: 'Luna.Unity.DTO.UnityEngine.Components.Transform',
        position: pos ? new S.Vec3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) : new S.Vec3(),
        rotation: rot ? new S.Quat(rot[i * 4], rot[i * 4 + 1], rot[i * 4 + 2], rot[i * 4 + 3]) : new S.Quat(),
        scale: scl ? new S.Vec3(scl[i * 3], scl[i * 3 + 1], scl[i * 3 + 2]) : new S.Vec3(1, 1, 1),
      };
      const comp = { typeName: 'UnityEngine.Transform', className: 'UnityEngine.Transform', dto: value.$type, id: ids[i], enabled: null, value };
      nd.components.unshift(comp);
      this.components.set(comp.id, { comp, node: nd });
    });
  }

  asset(id) { return this.assets.get(id) || null; }
  list(category) { return this.byCategory.get(category) || []; }
  projectSettings() { const a = this.list('project-settings')[0]; return a ? a.dto : null; }
}

module.exports = { LunaModel, DTO, plain };
