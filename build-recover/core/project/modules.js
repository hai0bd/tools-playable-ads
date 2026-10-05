'use strict';
// Reconstruct settings/v2/packages/engine.json (feature modules) from what the build contains.
// Start from the Creator 3.8 2D template and switch modules on/off based on evidence:
//   * class signatures present in cocos-js/cc.js (the build ships exactly the enabled modules)
//   * component/asset types actually used by recovered scenes/prefabs
const { readTemplate } = require('./templates');

// module key -> cc.js signature. Only signatures verified to be absent from a default 2D build are used
// for switching modules ON; 2D-template modules are switched OFF when their signature is missing.
const SIGNATURES = {
  'spine': '"sp.Skeleton"',
  'dragon-bones': '"dragonBones.ArmatureDisplay"',
  'tiled-map': '"cc.TiledMap"',
  'video': '"cc.VideoPlayer"',
  'webview': '"cc.WebView"',
  'particle-2d': '"cc.ParticleSystem2D"',
  'rich-text': '"cc.RichText"',
  'graphics': '"cc.Graphics"',
  'mask': '"cc.Mask"',
  'physics-2d': '"cc.RigidBody2D"',
  '3d': '"cc.DirectionalLight"',
  'skeletal-animation': '"cc.SkeletalAnimation"',
  'physics': '"cc.RigidBody"',
  'terrain': '"cc.Terrain"',
  'light-probe': '"cc.LightProbeGroup"',
  'marionette': '"cc.animation.AnimationController"',
  'ui-skew': '"cc.UISkew"',
  'sorting-2d': '"cc.Sorting2D"',
};

// component types (as they appear in scenes) -> module
const COMPONENT_MODULES = {
  'sp.Skeleton': 'spine', 'dragonBones.ArmatureDisplay': 'dragon-bones', 'cc.TiledMap': 'tiled-map',
  'cc.VideoPlayer': 'video', 'cc.WebView': 'webview', 'cc.ParticleSystem2D': 'particle-2d', 'cc.ParticleSystem': 'particle',
  'cc.RichText': 'rich-text', 'cc.Graphics': 'graphics', 'cc.Mask': 'mask', 'cc.RigidBody2D': 'physics-2d',
  'cc.BoxCollider2D': 'physics-2d', 'cc.CircleCollider2D': 'physics-2d', 'cc.PolygonCollider2D': 'physics-2d',
  'cc.MeshRenderer': '3d', 'cc.SkinnedMeshRenderer': 'skeletal-animation', 'cc.SkeletalAnimation': 'skeletal-animation',
  'cc.DirectionalLight': '3d', 'cc.SphereLight': '3d', 'cc.SpotLight': '3d', 'cc.RigidBody': 'physics',
  'cc.BoxCollider': 'physics', 'cc.SphereCollider': 'physics', 'cc.MeshCollider': 'physics', 'cc.Terrain': 'terrain',
  'cc.animation.AnimationController': 'marionette',
};

function detectModules(files, usedTypes = new Set(), spineVersion = '3.8') {
  const ccKey = [...files.keys()].find((k) => /^cocos-js\/cc(\.[0-9a-f]{5})?\.js$/.test(k));
  const cc = ccKey ? files.get(ccKey).toString('latin1') : null;
  const cocosJsNames = [...files.keys()].filter((k) => k.startsWith('cocos-js/')).join('\n');
  const on = new Set(), off = new Set(), evidence = {};

  if (cc) {
    for (const [mod, sig] of Object.entries(SIGNATURES)) {
      if (cc.includes(sig)) { on.add(mod); evidence[mod] = 'cc.js'; }
      else off.add(mod);
    }
  }
  for (const t of usedTypes) {
    const mod = COMPONENT_MODULES[t];
    if (mod) { on.add(mod); off.delete(mod); evidence[mod] = (evidence[mod] ? evidence[mod] + ' + ' : '') + t; }
  }

  // backends
  let physics2d = null, physics3d = null;
  if (on.has('physics-2d')) physics2d = cc && /b2World|box2d/i.test(cc) ? (/box2d\.wasm|box2d.*wasm/i.test(cocosJsNames) ? 'physics-2d-box2d-wasm' : 'physics-2d-box2d') : 'physics-2d-builtin';
  if (on.has('physics')) {
    if (/bullet|ammo/i.test(cocosJsNames) || (cc && /\bAmmo\b|bullet\./.test(cc))) physics3d = 'physics-ammo';
    else if (cc && /CANNON/.test(cc)) physics3d = 'physics-cannon';
    else if (cc && /PhysX/.test(cc)) physics3d = 'physics-physx';
    else physics3d = 'physics-builtin';
  }
  const spineKey = /^4/.test(spineVersion) ? 'spine-4.2' : 'spine-3.8';
  return { on, off, evidence, physics2d, physics3d, spineKey, hadCC: !!cc };
}

function buildEngineJson(det) {
  const tpl = JSON.parse(readTemplate('engine.json'));
  const cfg = tpl.modules.configs.defaultConfig;
  const cache = cfg.cache;
  const include = new Set(cfg.includeModules);
  const set = (key, value) => { if (cache[key]) cache[key]._value = value; };

  const toggle = (mod, value) => {
    set(mod, value);
    if (!value) include.delete(mod);
  };

  for (const mod of det.off) {
    if (['physics-2d', 'physics', 'spine'].includes(mod)) continue; // handled below
    toggle(mod, false);
  }
  for (const mod of det.on) {
    if (['physics-2d', 'physics', 'spine'].includes(mod)) continue;
    set(mod, true);
    include.add(mod);
  }
  // spine
  include.delete('spine-3.8'); include.delete('spine-4.2');
  if (det.on.has('spine') || !det.hadCC) {
    set('spine', true); cache.spine._option = det.spineKey; set('spine-3.8', det.spineKey === 'spine-3.8'); set('spine-4.2', det.spineKey === 'spine-4.2');
    include.add(det.spineKey);
  } else { set('spine', false); set('spine-3.8', false); set('spine-4.2', false); }
  // physics 2d
  for (const k of ['physics-2d-box2d', 'physics-2d-box2d-wasm', 'physics-2d-builtin', 'physics-2d-box2d-jsb']) include.delete(k);
  if (det.physics2d || !det.hadCC) {
    const be = det.physics2d || 'physics-2d-box2d';
    set('physics-2d', true); cache['physics-2d']._option = be;
    include.add(be);
  } else set('physics-2d', false);
  // physics 3d
  for (const k of ['physics-ammo', 'physics-cannon', 'physics-physx', 'physics-builtin']) include.delete(k);
  if (det.physics3d) { set('physics', true); cache.physics._option = det.physics3d; include.add(det.physics3d); }
  // 3D rendering needs these
  if (det.on.has('3d')) { include.add('3d'); set('3d', true); }
  if (det.on.has('skeletal-animation')) { include.add('skeletal-animation'); set('skeletal-animation', true); include.add('3d'); set('3d', true); }
  if (det.on.has('particle')) { include.add('particle'); set('particle', true); }

  cfg.includeModules = [...include].sort();
  return tpl;
}

module.exports = { detectModules, buildEngineJson, COMPONENT_MODULES };
