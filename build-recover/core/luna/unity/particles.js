'use strict';
// ParticleSystem: Luna keeps the Shuriken modules as PlayCanvas-side objects (main, emission, shape, *OverLifetime…).
// Modules we do not map are left out and come back with Unity's defaults (all disabled except Emission/Shape).
const { flow } = require('./yaml');
const ids = require('./ids');

const T = 0.33333334;
function curveKeys(c) {
  // pc.AnimationCurve({ keys: [t, v, t, v…] } | { keys_flow: [...] }) — Luna passes the Unity keys through args[0]
  const a = c && c.args && c.args[0];
  const raw = a && (a.keys || a.keys_flow || a.keysFlow);
  const out = [];
  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object') for (const k of raw) out.push({ time: k.time || 0, value: k.value || 0, inSlope: k.inTangent || 0, outSlope: k.outTangent || 0, tangentMode: 0 });
    // flat keys, 7 numbers each like animation keys: time, value, inTangent, outTangent, tangentMode, left, right
    else if (raw.length % 7 === 0) for (let i = 0; i + 6 < raw.length; i += 7) out.push({ time: raw[i], value: raw[i + 1], inSlope: raw[i + 2], outSlope: raw[i + 3], tangentMode: raw[i + 4] | 0 });
    else for (let i = 0; i + 1 < raw.length; i += 2) out.push({ time: raw[i], value: raw[i + 1], inSlope: 0, outSlope: 0, tangentMode: 0 });
  }
  return out;
}
function animCurve(c, def = 1) {
  let keys = curveKeys(c);
  if (!keys.length) keys = [{ time: 0, value: def, inSlope: 0, outSlope: 0 }];
  return {
    serializedVersion: 2,
    m_Curve: keys.map((k) => ({ serializedVersion: 3, time: k.time, value: k.value, inSlope: k.inSlope, outSlope: k.outSlope, tangentMode: k.tangentMode || 0, weightedMode: 0, inWeight: T, outWeight: T })),
    m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4,
  };
}
function mmc(c, def = 0) {
  if (!c) return { serializedVersion: 2, minMaxState: 0, scalar: def, minScalar: def, maxCurve: animCurve(null), minCurve: animCurve(null) };
  const mode = c.mode || 0;
  const curveMode = mode === 1 || mode === 2;
  return {
    serializedVersion: 2, minMaxState: mode, scalar: curveMode ? (c.curveMultiplier != null ? c.curveMultiplier : 1) : (c.constantMax != null ? c.constantMax : def),
    minScalar: c.constantMin != null ? c.constantMin : def, maxCurve: animCurve(c.curveMax), minCurve: animCurve(c.curveMin),
  };
}
function gradient(g) {
  const out = { serializedVersion: 2 };
  const ck = (g && g.colorKeys) || [], ak = (g && g.alphaKeys) || [];
  const cks = ck.length ? ck : [{ color: { r: 1, g: 1, b: 1 }, time: 0 }, { color: { r: 1, g: 1, b: 1 }, time: 1 }];
  const aks = ak.length ? ak : [{ alpha: 1, time: 0 }, { alpha: 1, time: 1 }];
  for (let i = 0; i < 8; i++) {
    const c = cks[i] && (cks[i].color || cks[i]);
    const a = aks[i];
    out['key' + i] = flow({ r: c ? c.r : 0, g: c ? c.g : 0, b: c ? c.b : 0, a: a ? (a.alpha != null ? a.alpha : a.a) : 0 });
  }
  for (let i = 0; i < 8; i++) out['ctime' + i] = cks[i] ? Math.round((cks[i].time || 0) * 65535) : 0;
  for (let i = 0; i < 8; i++) out['atime' + i] = aks[i] ? Math.round((aks[i].time || 0) * 65535) : 0;
  return Object.assign(out, { m_Mode: (g && g.mode) || 0, m_ColorSpace: -1, m_NumColorKeys: Math.min(8, cks.length), m_NumAlphaKeys: Math.min(8, aks.length) });
}
function mmg(c) {
  const col = (x, d) => flow(x ? { r: x.r, g: x.g, b: x.b, a: x.a } : d);
  return {
    serializedVersion: 2, minMaxState: c ? c.mode || 0 : 0, minColor: col(c && c.colorMin, { r: 1, g: 1, b: 1, a: 1 }), maxColor: col(c && c.colorMax, { r: 1, g: 1, b: 1, a: 1 }),
    maxGradient: gradient(c && c.gradientMax), minGradient: gradient(c && c.gradientMin),
  };
}
const on = (m) => (m && m.enabled ? 1 : 0);

function particleBody(p, d, file) {
  const main = d.main || {}, em = d.emission || {}, sh = d.shape || {};
  const rad = main.startRotationZ || main.startRotation;
  return {
    serializedVersion: 8, lengthInSec: main.duration != null ? main.duration : 5, simulationSpeed: main.simulationSpeed != null ? main.simulationSpeed : 1,
    stopAction: main.stopAction || 0, cullingMode: 0, ringBufferMode: 0, ringBufferLoopRange: flow({ x: 0, y: 1 }), emitterVelocityMode: 1,
    looping: main.loop ? 1 : 0, prewarm: main.prewarm ? 1 : 0, playOnAwake: main.playOnAwake === false ? 0 : 1, useUnscaledTime: 0,
    autoRandomSeed: d.useAutoRandomSeed === false ? 0 : 1, startDelay: mmc(main.startDelay, 0),
    moveWithTransform: main.simulationSpace === 1 ? 0 : 1, moveWithCustomTransform: ids.NULL_REF, scalingMode: main.scalingMode != null ? main.scalingMode : 1, randomSeed: d.randomSeed || 0,
    InitialModule: {
      serializedVersion: 3, enabled: 1, startLifetime: mmc(main.startLifetime, 5), startSpeed: mmc(main.startSpeed, 5), startColor: mmg(main.startColor),
      startSize: mmc(main.startSizeX || main.startSize, 1), startSizeY: mmc(main.startSizeY, 1), startSizeZ: mmc(main.startSizeZ, 1),
      startRotationX: mmc(main.startRotationX, 0), startRotationY: mmc(main.startRotationY, 0), startRotation: mmc(rad, 0),
      randomizeRotationDirection: main.flipRotation || 0, gravitySource: 0, maxNumParticles: main.maxParticles || 1000,
      customEmitterVelocity: flow({ x: 0, y: 0, z: 0 }), size3D: main.startSize3D ? 1 : 0, rotation3D: main.startRotation3D ? 1 : 0, gravityModifier: mmc(main.gravityModifier, 0),
    },
    ShapeModule: {
      serializedVersion: 6, enabled: sh.enabled === false ? 0 : 1, type: sh.shapeType != null ? sh.shapeType : 4, angle: sh.angle != null ? sh.angle : 25,
      length: sh.length != null ? sh.length : 5, boxThickness: flow(sh.boxThickness ? { x: sh.boxThickness.x, y: sh.boxThickness.y, z: sh.boxThickness.z } : { x: 0, y: 0, z: 0 }),
      radiusThickness: sh.radiusThickness != null ? sh.radiusThickness : 1, donutRadius: sh.donutRadius != null ? sh.donutRadius : 0.2,
      m_Position: flow(sh.position ? { x: sh.position.x, y: sh.position.y, z: sh.position.z } : { x: 0, y: 0, z: 0 }),
      m_Rotation: flow(sh.rotation ? { x: sh.rotation.x, y: sh.rotation.y, z: sh.rotation.z } : { x: 0, y: 0, z: 0 }),
      m_Scale: flow(sh.scale ? { x: sh.scale.x, y: sh.scale.y, z: sh.scale.z } : { x: 1, y: 1, z: 1 }),
      placementMode: sh.meshShapeType || 0, m_MeshMaterialIndex: 0, m_MeshNormalOffset: 0, m_Mesh: sh.mesh ? p.ref(sh.mesh, file) : ids.NULL_REF,
      m_MeshRenderer: sh.meshRenderer ? p.ref(sh.meshRenderer, file) : ids.NULL_REF, m_SkinnedMeshRenderer: sh.skinnedMeshRenderer ? p.ref(sh.skinnedMeshRenderer, file) : ids.NULL_REF,
      m_Sprite: ids.NULL_REF, m_SpriteRenderer: ids.NULL_REF, m_UseMeshMaterialIndex: sh.useMeshMaterialIndex ? 1 : 0, m_UseMeshColors: 1,
      alignToDirection: sh.alignToDirection ? 1 : 0, randomDirectionAmount: sh.randomDirectionAmount || 0, sphericalDirectionAmount: sh.sphericalDirectionAmount || 0,
      randomPositionAmount: sh.randomPositionAmount || 0,
      radius: { value: sh.radius != null ? sh.radius : 1, mode: sh.radiusMode || 0, spread: sh.radiusSpread || 0, speed: mmc(sh.radiusSpeed, 1) },
      arc: { value: sh.arc != null ? sh.arc : 360, mode: sh.arcMode || 0, spread: sh.arcSpread || 0, speed: mmc(sh.arcSpeed, 1) },
    },
    EmissionModule: {
      enabled: em.enabled === false ? 0 : 1, serializedVersion: 4, rateOverTime: mmc(em.rateOverTime, 10), rateOverDistance: mmc(em.rateOverDistance, 0),
      m_BurstCount: (em.bursts || []).length,
      m_Bursts: (em.bursts || []).map((bu) => ({ serializedVersion: 2, time: bu.time || 0, countCurve: mmc(bu.count, 30), cycleCount: bu.cycleCount != null ? bu.cycleCount : 1, repeatInterval: bu.repeatInterval != null ? bu.repeatInterval : 0.01, probability: bu.probability != null ? bu.probability : 1 })),
    },
    SizeModule: d.sizeOverLifetime ? { enabled: on(d.sizeOverLifetime), curve: mmc(d.sizeOverLifetime.x || d.sizeOverLifetime.size, 1), y: mmc(d.sizeOverLifetime.y, 1), z: mmc(d.sizeOverLifetime.z, 1), separateAxes: d.sizeOverLifetime.separateAxes ? 1 : 0 } : undefined,
    RotationModule: d.rotationOverLifetime ? { enabled: on(d.rotationOverLifetime), x: mmc(d.rotationOverLifetime.x, 0), y: mmc(d.rotationOverLifetime.y, 0), curve: mmc(d.rotationOverLifetime.z, 0.7853982), separateAxes: d.rotationOverLifetime.separateAxes ? 1 : 0 } : undefined,
    ColorModule: d.colorOverLifetime ? { enabled: on(d.colorOverLifetime), gradient: mmg(d.colorOverLifetime.color) } : undefined,
    UVModule: d.textureSheetAnimation ? (() => {
      const u = d.textureSheetAnimation;
      return {
        serializedVersion: 2, enabled: on(u), mode: u.mode || 0, timeMode: 0, fps: 30, frameOverTime: mmc(u.frameOverTime, 0.9999), startFrame: mmc(u.startFrame, 0),
        speedRange: flow({ x: 0, y: 1 }), tilesX: u.numTilesX || 1, tilesY: u.numTilesY || 1, animationType: u.animation || 0, rowIndex: u.rowIndex || 0,
        cycles: u.cycleCount || 1, uvChannelMask: -1, rowMode: u.useRandomRow ? 1 : 0, sprites: [{ sprite: ids.NULL_REF }], flipU: u.flipU || 0, flipV: u.flipV || 0,
      };
    })() : undefined,
    VelocityModule: d.velocityOverLifetime ? { enabled: on(d.velocityOverLifetime), x: mmc(d.velocityOverLifetime.x, 0), y: mmc(d.velocityOverLifetime.y, 0), z: mmc(d.velocityOverLifetime.z, 0), inWorldSpace: d.velocityOverLifetime.space === 1 ? 1 : 0 } : undefined,
    ForceModule: d.forceOverLifetime ? { enabled: on(d.forceOverLifetime), x: mmc(d.forceOverLifetime.x, 0), y: mmc(d.forceOverLifetime.y, 0), z: mmc(d.forceOverLifetime.z, 0), inWorldSpace: d.forceOverLifetime.space === 1 ? 1 : 0, randomizePerFrame: 0 } : undefined,
    ClampVelocityModule: d.limitVelocityOverLifetime ? { enabled: on(d.limitVelocityOverLifetime), x: mmc(d.limitVelocityOverLifetime.limitX, 1), y: mmc(d.limitVelocityOverLifetime.limitY, 1), z: mmc(d.limitVelocityOverLifetime.limitZ, 1), magnitude: mmc(d.limitVelocityOverLifetime.limit, 1), separateAxis: d.limitVelocityOverLifetime.separateAxes ? 1 : 0, inWorldSpace: 0, multiplyDragByParticleSize: 1, multiplyDragByParticleVelocity: 1, dampen: d.limitVelocityOverLifetime.dampen != null ? d.limitVelocityOverLifetime.dampen : 0, drag: mmc(null, 0) } : undefined,
    InheritVelocityModule: d.inheritVelocity ? { enabled: on(d.inheritVelocity), m_Mode: d.inheritVelocity.mode || 0, m_Curve: mmc(d.inheritVelocity.curve, 0) } : undefined,
  };
}

module.exports = { particleBody };
