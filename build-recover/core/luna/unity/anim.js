'use strict';
// Animation clips (.anim) and Animator controllers (.controller).
// Luna keeps one float curve per animated component ("m_LocalPosition.x", "localEulerAnglesRaw.y", "m_Color.a"…) with
// 7-float keys (time, value, inTangent, outTangent, tangentMode, leftMode, rightMode) in data.blob.
const { flow } = require('./yaml');
const ids = require('./ids');
const { UnityProject, HEADER } = require('./project');
const { floats } = require('./mesh');

// component type → Unity classID (for curve bindings)
const CLASS_ID = {
  'UnityEngine.GameObject': 1, 'UnityEngine.Transform': 4, 'UnityEngine.RectTransform': 224, 'UnityEngine.Camera': 20, 'UnityEngine.Light': 108,
  'UnityEngine.MeshRenderer': 23, 'UnityEngine.SkinnedMeshRenderer': 137, 'UnityEngine.SpriteRenderer': 212, 'UnityEngine.Animator': 95,
  'UnityEngine.AudioSource': 82, 'UnityEngine.Canvas': 223, 'UnityEngine.CanvasGroup': 225, 'UnityEngine.BoxCollider2D': 61,
  'UnityEngine.CircleCollider2D': 58, 'UnityEngine.Rigidbody2D': 50, 'UnityEngine.BoxCollider': 65, 'UnityEngine.SphereCollider': 135,
  'UnityEngine.ParticleSystem': 198, 'UnityEngine.ParticleSystemRenderer': 199, 'UnityEngine.LineRenderer': 120, 'UnityEngine.SpriteMask': 331,
  'UnityEngine.TrailRenderer': 96, 'UnityEngine.Rigidbody': 54, 'UnityEngine.MeshFilter': 33,
};
const GROUPS = [['m_LocalPosition', 'position'], ['localEulerAnglesRaw', 'euler'], ['m_LocalEulerAnglesHint', 'euler'], ['m_LocalRotation', 'rotation'], ['m_LocalScale', 'scale']];

function keysOf(p, a, c) {
  const blob = p.m.blob(a.bundle);
  const k = c.keys;
  if (!Array.isArray(k) || k.length !== 2 || !blob) return [];
  const f = floats(blob, k[0], k[1], !!a.dto.halfPrecision);
  const out = [];
  for (let i = 0; i + 6 < f.length + 0.5 && i + 7 <= f.length; i += 7) out.push({ time: f[i], value: f[i + 1], inSlope: f[i + 2], outSlope: f[i + 3], tangentMode: f[i + 4] | 0 });
  return out;
}

const T = 1 / 3;
const floatKey = (k) => ({ serializedVersion: 3, time: k.time, value: k.value, inSlope: k.inSlope, outSlope: k.outSlope, tangentMode: k.tangentMode, weightedMode: 0, inWeight: T, outWeight: T });
const curve = (keys) => ({ serializedVersion: 2, m_Curve: keys, m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4 });

// Hermite evaluation, for merging x/y/z curves whose keys are at different times into one vector curve
function evalCurve(keys, t) {
  if (!keys.length) return { v: 0, d: 0 };
  if (t <= keys[0].time) return { v: keys[0].value, d: keys[0].inSlope };
  const last = keys[keys.length - 1];
  if (t >= last.time) return { v: last.value, d: last.outSlope };
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].time < t) i++;
  const a = keys[i], b = keys[i + 1], dt = b.time - a.time;
  if (!(dt > 0)) return { v: b.value, d: b.inSlope };
  if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) return { v: a.value, d: Infinity };
  const s = (t - a.time) / dt, s2 = s * s, s3 = s2 * s;
  const m0 = a.outSlope * dt, m1 = b.inSlope * dt;
  const v = (2 * s3 - 3 * s2 + 1) * a.value + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * b.value + (s3 - s2) * m1;
  const dv = ((6 * s2 - 6 * s) * a.value + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * b.value + (3 * s2 - 2 * s) * m1) / dt;
  return { v, d: dv };
}

function vectorCurve(comps, dims, def) {
  const times = [...new Set(dims.flatMap((d) => (comps[d] || []).map((k) => k.time)))].sort((x, y) => x - y);
  const keys = times.map((t) => {
    const val = {}, inS = {}, outS = {};
    for (const d of dims) {
      const ks = comps[d];
      if (!ks || !ks.length) { val[d] = def[d]; inS[d] = 0; outS[d] = 0; continue; }
      const exact = ks.find((k) => Math.abs(k.time - t) < 1e-6);
      if (exact) { val[d] = exact.value; inS[d] = exact.inSlope; outS[d] = exact.outSlope; continue; }
      const e = evalCurve(ks, t);
      val[d] = e.v; inS[d] = e.d; outS[d] = e.d;
    }
    const w = Object.fromEntries(dims.map((d) => [d, T]));
    return { serializedVersion: 3, time: t, value: flow(val), inSlope: flow(inS), outSlope: flow(outS), tangentMode: 0, weightedMode: 0, inWeight: flow(w), outWeight: flow({ ...w }) };
  });
  return keys;
}

function planClips(p) {
  for (const a of p.m.list('animation-clips')) {
    const ap = UnityProject.assetPath(a.path);
    const name = (a.dto && a.dto.name) || a.name || 'Clip_' + a.id;
    let rel;
    if (ap && /\.anim$/i.test(ap)) rel = ap;
    else if (ap) rel = `${ap.replace(/\.[^./]+$/, '')}/${name.replace(/[\\/|]/g, '_')}.anim`;   // clip inside an FBX / controller
    else rel = `Assets/_Recovered/Animations/${name}.anim`;
    rel = p.claim(rel);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'clip', rel, guid, ref: ids.assetRef(7400000, guid, 2) });
  }
}

function clipBody(p, a, legacy) {
  const d = a.dto;
  const groups = new Map(), floatsCurves = [], pptr = [], editor = [], euler = [];
  for (const c of d.curves || []) {
    const keys = keysOf(p, a, c);
    const prop = String(c.property || '');
    const type = c.componentType || 'UnityEngine.Transform';
    const classID = CLASS_ID[type] || 114;
    const g = type === 'UnityEngine.Transform' || type === 'UnityEngine.RectTransform' ? GROUPS.find(([pre]) => prop.startsWith(pre + '.')) : null;
    if (c.objectReferenceKeys && c.objectReferenceKeys.length) {
      pptr.push({
        curve: c.objectReferenceKeys.map((k) => ({ time: k.time, value: p.ref(k.value, null) })),
        attribute: prop, path: c.path || '', classID, script: classID === 114 ? p.scriptRef(type) : ids.NULL_REF,
      });
      continue;
    }
    if (prop === 'dummy' || !keys.length) continue;
    const fk = keys.map(floatKey);
    const entry = { curve: curve(fk), attribute: prop, path: c.path || '', classID, script: classID === 114 ? p.scriptRef(type) : ids.NULL_REF };
    if (g) {
      const key = g[1] + '|' + (c.path || '');
      if (!groups.has(key)) groups.set(key, { kind: g[1], path: c.path || '', comps: {} });
      groups.get(key).comps[prop.slice(g[0].length + 1)] = keys;
      (g[1] === 'euler' ? euler : editor).push(entry);
    } else { floatsCurves.push(entry); editor.push(entry); }
  }
  const out = { m_RotationCurves: [], m_CompressedRotationCurves: [], m_EulerCurves: [], m_PositionCurves: [], m_ScaleCurves: [] };
  for (const g of groups.values()) {
    if (g.kind === 'rotation') out.m_RotationCurves.push({ curve: curve(vectorCurve(g.comps, ['x', 'y', 'z', 'w'], { x: 0, y: 0, z: 0, w: 1 })), path: g.path });
    else if (g.kind === 'euler') out.m_EulerCurves.push({ curve: curve(vectorCurve(g.comps, ['x', 'y', 'z'], { x: 0, y: 0, z: 0 })), path: g.path });
    else if (g.kind === 'position') out.m_PositionCurves.push({ curve: curve(vectorCurve(g.comps, ['x', 'y', 'z'], { x: 0, y: 0, z: 0 })), path: g.path });
    else out.m_ScaleCurves.push({ curve: curve(vectorCurve(g.comps, ['x', 'y', 'z'], { x: 1, y: 1, z: 1 })), path: g.path });
  }
  const length = d.length || 0;
  const b = d.localBounds || {};
  return {
    ...HEADER(), m_Name: d.name || a.name, serializedVersion: 7, m_Legacy: legacy ? 1 : 0, m_Compressed: 0, m_UseHighQualityCurve: 1,
    ...out, m_FloatCurves: floatsCurves, m_PPtrCurves: pptr, m_SampleRate: d._frameRate || 60, m_WrapMode: d.wrapMode || 0,
    m_Bounds: { m_Center: flow(b.center ? { x: b.center.x, y: b.center.y, z: b.center.z } : { x: 0, y: 0, z: 0 }), m_Extent: flow(b.extends ? { x: b.extends.x, y: b.extends.y, z: b.extends.z } : { x: 0, y: 0, z: 0 }) },   // (sic) Luna's field name
    m_ClipBindingConstant: { genericBindings: [], pptrCurveMapping: [] },
    m_AnimationClipSettings: {
      serializedVersion: 2, m_AdditiveReferencePoseClip: ids.NULL_REF, m_AdditiveReferencePoseTime: 0, m_StartTime: 0, m_StopTime: length,
      m_OrientationOffsetY: 0, m_Level: 0, m_CycleOffset: 0, m_HasAdditiveReferencePose: 0, m_LoopTime: d.isLooping ? 1 : 0, m_LoopBlend: 0,
      m_LoopBlendOrientation: 0, m_LoopBlendPositionY: 0, m_LoopBlendPositionXZ: 0, m_KeepOriginalOrientation: 0, m_KeepOriginalPositionY: 1,
      m_KeepOriginalPositionXZ: 0, m_HeightFromFeet: 0, m_Mirror: 0,
    },
    m_EditorCurves: editor, m_EulerEditorCurves: euler, m_HasGenericRootTransform: 0, m_HasMotionFloatCurves: 0,
    m_Events: (d.events || []).map((e) => ({
      time: e.time || 0, functionName: e.functionName || '', data: e.stringParameter || '', objectReferenceParameter: ids.NULL_REF,
      floatParameter: e.floatParameter || 0, intParameter: e.intParameter || 0, messageOptions: 0,
    })),
  };
}

function writeClips(p) {
  // clips played by a legacy Animation component must be marked legacy
  const legacy = new Set();
  for (const { comp } of p.m.components.values()) {
    if (comp.className !== 'UnityEngine.Animation') continue;
    const v = comp.value || {};
    for (const r of [v.clip, ...(v.clips || [])]) if (r && r.id != null) legacy.add(r.id);
  }
  for (const a of p.m.list('animation-clips')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel || !a.dto) continue;
    p.writeYamlAsset(info.rel, info.guid, [{ classId: 74, fileId: 7400000, type: 'AnimationClip', body: clipBody(p, a, legacy.has(a.id)) }], 7400000);
    p.count('animationClips');
  }
}

// ---------------------------------------------------------------- Animator controllers
function planControllers(p) {
  for (const a of p.m.list('animator-controllers')) {
    const ap = UnityProject.assetPath(a.path);
    const rel = p.claim(ap && /\.controller$/i.test(ap) ? ap : `Assets/_Recovered/Animations/${a.name || a.id}.controller`);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'controller', rel, guid, ref: ids.assetRef(9100000, guid, 2) });
  }
}

const PARAM_TYPE = { 1: 1, 3: 3, 4: 4, 9: 9 };   // Float, Int, Bool, Trigger — same numbers in Unity
const motionRef = (p, id) => (id != null && p.assets.get(id) ? p.assets.get(id).ref || ids.NULL_REF : ids.NULL_REF);

function controllerDocs(p, a) {
  const d = a.dto, docs = [];
  const fid = (seed) => ids.fileIdOf(`${a.id}:${seed}`);
  const stateIds = new Map();                       // Luna state id → fileID
  const smIds = new Map();
  const transitions = [];
  const transition = (t, kind) => {
    const f = fid('t' + transitions.length);
    transitions.push({ t, f, kind });
    return ids.localRef(f);
  };
  const walkMachine = (sm) => {
    smIds.set(sm.id, fid('sm' + sm.id));
    for (const st of sm.states || []) stateIds.set(st.id, fid('s' + st.id));
    for (const sub of sm.machines || []) walkMachine(sub.stateMachine || sub);
  };
  const layers = [];
  for (const layer of d.layers || []) if (layer.stateMachine) walkMachine(layer.stateMachine);

  const emitMachine = (sm, depth) => {
    const children = (sm.states || []).map((st, i) => {
      const f = stateIds.get(st.id);
      docs.push({
        classId: 1102, fileId: f, type: 'AnimatorState', body: {
          serializedVersion: 6, ...HEADER(), m_ObjectHideFlags: 1, m_Name: st.name, m_Speed: st.speed != null ? st.speed : 1,
          m_CycleOffset: st.cycleOffset || 0, m_Transitions: (st.transitions || []).map((t) => transition(t, 'state')), m_StateMachineBehaviours: [],
          m_Position: flow({ x: 300 + (i % 3) * 250, y: 60 + Math.floor(i / 3) * 80 + depth * 20, z: 0 }), m_IKOnFeet: 0,
          m_WriteDefaultValues: st.writeDefaultValues === false ? 0 : 1, m_Mirror: st.mirror ? 1 : 0,
          m_SpeedParameterActive: st.speedParameterActive ? 1 : 0, m_MirrorParameterActive: st.mirrorParameterActive ? 1 : 0,
          m_CycleOffsetParameterActive: st.cycleOffsetParameterActive ? 1 : 0, m_TimeParameterActive: 0, m_Motion: motionRef(p, st.motionId),
          m_Tag: st.tag || '', m_SpeedParameter: st.speedParameter || '', m_MirrorParameter: st.mirrorParameter || '',
          m_CycleOffsetParameter: st.cycleOffsetParameter || '', m_TimeParameter: '',
        },
      });
      return { serializedVersion: 1, m_State: ids.localRef(f), m_Position: flow({ x: 300 + (i % 3) * 250, y: 60 + Math.floor(i / 3) * 80, z: 0 }) };
    });
    const subs = (sm.machines || []).map((sub, i) => {
      const inner = sub.stateMachine || sub;
      emitMachine(inner, depth + 1);
      return { serializedVersion: 1, m_StateMachine: ids.localRef(smIds.get(inner.id)), m_Position: flow({ x: 300 + i * 250, y: 400, z: 0 }) };
    });
    const def = sm.defaultStateId != null ? sm.defaultStateId : sm.defaultState;
    docs.push({
      classId: 1107, fileId: smIds.get(sm.id), type: 'AnimatorStateMachine', body: {
        serializedVersion: 6, ...HEADER(), m_ObjectHideFlags: 1, m_Name: sm.name || 'Base Layer', m_ChildStates: children, m_ChildStateMachines: subs,
        m_AnyStateTransitions: (sm.anyStateTransitions || []).map((t) => transition(t, 'any')),
        m_EntryTransitions: (sm.entryStateTransitions || []).map((t) => transition(t, 'entry')),
        m_StateMachineTransitions: {}, m_StateMachineBehaviours: [],
        m_AnyStatePosition: flow({ x: 50, y: 20, z: 0 }), m_EntryPosition: flow({ x: 50, y: 120, z: 0 }), m_ExitPosition: flow({ x: 800, y: 120, z: 0 }),
        m_ParentStateMachinePosition: flow({ x: 800, y: 20, z: 0 }),
        m_DefaultState: stateIds.has(def) ? ids.localRef(stateIds.get(def)) : (sm.states && sm.states[0] ? ids.localRef(stateIds.get(sm.states[0].id)) : ids.NULL_REF),
      },
    });
  };
  for (const layer of d.layers || []) {
    if (!layer.stateMachine) continue;
    emitMachine(layer.stateMachine, 0);
    layers.push({
      serializedVersion: 5, m_Name: layer.name, m_StateMachine: ids.localRef(smIds.get(layer.stateMachine.id)), m_Mask: ids.NULL_REF,
      m_Motions: [], m_Behaviours: [], m_BlendingMode: layer.blendingMode || 0, m_SyncedLayerIndex: layer.syncedLayerIndex != null ? layer.syncedLayerIndex : -1,
      m_DefaultWeight: layers.length ? (layer.defaultWeight || 0) : 0, m_IKPass: 0, m_SyncedLayerAffectsTiming: layer.syncedLayerAffectsTiming ? 1 : 0,
      m_Controller: ids.localRef(9100000),
    });
  }
  for (const { t, f, kind } of transitions) {
    const conds = (t.conditions || []).map((c) => ({ m_ConditionMode: c.mode, m_ConditionEvent: c.parameter, m_EventTreshold: c.threshold || 0 }));
    const dst = t.destinationStateId != null && stateIds.has(t.destinationStateId) ? ids.localRef(stateIds.get(t.destinationStateId)) : ids.NULL_REF;
    if (kind === 'entry') {
      docs.push({ classId: 1109, fileId: f, type: 'AnimatorTransition', body: { ...HEADER(), m_ObjectHideFlags: 1, m_Name: '', m_Conditions: conds, m_DstStateMachine: ids.NULL_REF, m_DstState: dst, m_Solo: 0, m_Mute: 0, m_IsExit: 0, serializedVersion: 1 } });
      continue;
    }
    docs.push({
      classId: 1101, fileId: f, type: 'AnimatorStateTransition', body: {
        ...HEADER(), m_ObjectHideFlags: 1, m_Name: '', m_Conditions: conds, m_DstStateMachine: ids.NULL_REF, m_DstState: dst,
        m_Solo: t.solo ? 1 : 0, m_Mute: t.mute ? 1 : 0, m_IsExit: t.isExit ? 1 : 0, serializedVersion: 3,
        m_TransitionDuration: t.duration != null ? t.duration : 0.25, m_TransitionOffset: t.offset || 0, m_ExitTime: t.exitTime != null ? t.exitTime : 0.75,
        m_HasExitTime: t.hasExitTime ? 1 : 0, m_HasFixedDuration: t.hasFixedDuration === false ? 0 : 1, m_InterruptionSource: t.interruptionSource || 0,
        m_OrderedInterruption: t.orderedInterruption === false ? 0 : 1, m_CanTransitionToSelf: t.canTransitionToSelf === false ? 0 : 1,
      },
    });
  }
  docs.unshift({
    classId: 91, fileId: 9100000, type: 'AnimatorController', body: {
      ...HEADER(), m_Name: d.name || a.name, serializedVersion: 5,
      m_AnimatorParameters: (d.parameters || []).map((pr) => ({
        m_Name: pr.name, m_Type: PARAM_TYPE[pr.type] || pr.type, m_DefaultFloat: pr.defaultFloat || 0, m_DefaultInt: pr.defaultInt || 0,
        m_DefaultBool: pr.defaultBool ? 1 : 0, m_Controller: ids.localRef(9100000),
      })),
      m_AnimatorLayers: layers,
    },
  });
  return docs;
}

function writeControllers(p) {
  for (const a of p.m.list('animator-controllers')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel || !a.dto) continue;
    try {
      p.writeYamlAsset(info.rel, info.guid, controllerDocs(p, a), 9100000);
      p.count('animatorControllers');
    } catch (e) { p.report.warn(`Animator ${a.path}: ${e.message}`); }
  }
}

module.exports = { planClips, writeClips, planControllers, writeControllers, CLASS_ID };
