'use strict';
// ProjectSettings (version, tags/layers/sorting layers, physics, time, build scenes) and Packages/manifest.json.
const { flow, unityFile } = require('./yaml');
const ids = require('./ids');

const BUILTIN_TAGS = ['Untagged', 'Respawn', 'Finish', 'EditorOnly', 'MainCamera', 'Player', 'GameController'];

function sortingTable(ps) {
  const layers = (ps && ps.sortingLayers) || [];
  const byId = new Map(layers.map((l) => [l.id, { id: l.id, value: l.value != null ? l.value : 0, name: l.name }]));
  return (id) => byId.get(id) || { id: 0, value: 0 };
}

function tagTable(ps) {
  const all = (ps && ps.allTags) || BUILTIN_TAGS;
  return (tagId) => all[tagId] || 'Untagged';
}

// com.unity.* packages Luna reports; plus modules every project has
function manifest(info, extras) {
  const deps = {
    'com.unity.ugui': '1.0.0',
    'com.unity.modules.ai': '1.0.0', 'com.unity.modules.animation': '1.0.0', 'com.unity.modules.audio': '1.0.0',
    'com.unity.modules.imgui': '1.0.0', 'com.unity.modules.jsonserialize': '1.0.0', 'com.unity.modules.particlesystem': '1.0.0',
    'com.unity.modules.physics': '1.0.0', 'com.unity.modules.physics2d': '1.0.0', 'com.unity.modules.ui': '1.0.0',
    'com.unity.modules.uielements': '1.0.0', 'com.unity.modules.unitywebrequest': '1.0.0', 'com.unity.modules.video': '1.0.0',
  };
  for (const line of String(info.packagesInfo || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z0-9.\-]+)\s*:\s*([^\s]+)\s*$/i);
    if (m && m[1] !== 'com.unity.modules.ui') deps[m[1]] = m[2];
  }
  Object.assign(deps, extras || {});
  const sorted = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
  return JSON.stringify({ dependencies: sorted }, null, 2) + '\n';
}

function writeSettings(p, sceneRels) {
  const ps = p.m.projectSettings() || {};
  const info = p.m.info;
  const version = info.unityVersion || '2021.3.0f1';
  p.out.write('ProjectSettings/ProjectVersion.txt', `m_EditorVersion: ${version}\n`);
  const extras = {};
  // spine-unity from git needs its spine-csharp dependency from the same branch (UPM cannot find it in a registry);
  // only 4.x branches ship UPM package manifests — 3.x is installed from the .unitypackage (see the report)
  if (p.needSpine && /^[4-9]\./.test(p.spineBranch || '4.1')) {
    const branch = p.spineBranch || '4.1';
    extras['com.esotericsoftware.spine.spine-csharp'] = 'https://github.com/EsotericSoftware/spine-runtimes.git?path=spine-csharp/src#' + branch;
    extras['com.esotericsoftware.spine.spine-unity'] = 'https://github.com/EsotericSoftware/spine-runtimes.git?path=spine-unity/Assets/Spine#' + branch;
  }
  p.out.write('Packages/manifest.json', manifest(info, extras));

  // tags & layers
  const tags = ((ps.allTags || []).filter((t) => !BUILTIN_TAGS.includes(t)));
  const layers = new Array(32).fill('');
  ['Default', 'TransparentFX', 'Ignore Raycast', '', 'Water', 'UI'].forEach((l, i) => { layers[i] = l; });
  for (const l of ps.cullingLayers || []) if (l.id >= 0 && l.id < 32) layers[l.id] = l.name;
  const sorting = (ps.sortingLayers && ps.sortingLayers.length ? ps.sortingLayers : [{ id: 0, name: 'Default', value: 0 }])
    .slice().sort((a, b) => (a.value || 0) - (b.value || 0)).map((l) => ({ name: l.name, uniqueID: l.id >>> 0, locked: 0 }));
  p.out.write('ProjectSettings/TagManager.asset', unityFile([{ classId: 78, fileId: 1, type: 'TagManager', body: { serializedVersion: 2, tags, layers, m_SortingLayers: sorting } }]));

  // time + physics
  const t = ps.timeSettings || {};
  p.out.write('ProjectSettings/TimeManager.asset', unityFile([{ classId: 5, fileId: 1, type: 'TimeManager', body: { m_ObjectHideFlags: 0, 'Fixed Timestep': t.fixedDeltaTime || 0.02, 'Maximum Allowed Timestep': t.maximumDeltaTime || 0.33333334, m_TimeScale: t.timeScale != null ? t.timeScale : 1, 'Maximum Particle Timestep': t.maximumParticleTimestep || 0.03 } }]));
  const g2 = ps.physics2DSettings && ps.physics2DSettings.gravity;
  if (g2) p.out.write('ProjectSettings/Physics2DSettings.asset', unityFile([{ classId: 19, fileId: 1, type: 'Physics2DSettings', body: { m_ObjectHideFlags: 0, serializedVersion: 5, m_Gravity: flow({ x: g2.x, y: g2.y }) } }]));
  const g3 = ps.physicsSettings && ps.physicsSettings.gravity;
  if (g3) p.out.write('ProjectSettings/DynamicsManager.asset', unityFile([{ classId: 55, fileId: 1, type: 'PhysicsManager', body: { m_ObjectHideFlags: 0, serializedVersion: 13, m_Gravity: flow({ x: g3.x, y: g3.y, z: g3.z }), m_DefaultSolverIterations: ps.physicsSettings.defaultSolverIterations || 6 } }]));

  // scenes in build: the startup scene first
  p.out.write('ProjectSettings/EditorBuildSettings.asset', unityFile([{
    classId: 1045, fileId: 1, type: 'EditorBuildSettings', body: {
      m_ObjectHideFlags: 0, serializedVersion: 2, m_Scenes: sceneRels.map((s) => ({ enabled: 1, path: s.rel, guid: s.guid })), m_configObjects: {},
    },
  }]));
  // script execution order lives in the .cs.meta files (MonoImporter.executionOrder), handled by the script writer
  p.executionOrder = new Map((ps.scriptsExecutionOrder || []).map((e) => [e.name, e.value]));
  writeRenderPipeline(p, info);
  return { sorting: sortingTable(ps), tag: tagTable(ps) };
}

// ---------------------------------------------------------------- URP
// A URP game renders magenta until a pipeline asset is assigned in Graphics settings: rebuild the asset + renderer
// from Luna's UniversalRenderPipelineAsset DTO (Luna names → Unity serialized names); URP's editor fills the
// renderer's shader/post-process references itself.
const URP_ASSET = 'UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset';
const URP_RENDERER = 'UnityEngine.Rendering.Universal.UniversalRendererData';
const ALWAYS_INCLUDED = [7, 15104, 15105, 15106, 10753, 10770, 10783];

function writeRenderPipeline(p, info) {
  const d = (p.m.list('urp-assets')[0] || {}).dto;
  const urpPackage = /render-pipelines\.universal/.test(info.packagesInfo || '');
  let pipelineRef = null;
  if (d || urpPackage) {
    const rendRel = p.claim('Assets/Settings/UniversalRP_Renderer.asset'), assetRel = p.claim('Assets/Settings/UniversalRP.asset');
    const rendGuid = ids.guidOf(rendRel), assetGuid = ids.guidOf(assetRel);
    const rd = (d && d.scriptableRendererData) || {};
    const mask = (m) => ({ serializedVersion: 2, m_Bits: (m == null ? -1 : m) >>> 0 });
    const mono = (script, name, body) => [{
      classId: 114, fileId: 11400000, type: 'MonoBehaviour',
      body: { m_ObjectHideFlags: 0, m_CorrespondingSourceObject: ids.NULL_REF, m_PrefabInstance: ids.NULL_REF, m_PrefabAsset: ids.NULL_REF, m_GameObject: ids.NULL_REF, m_Enabled: 1, m_EditorHideFlags: 0, m_Script: ids.assetRef(11500000, ids.packageScriptGuid(script), 3), m_Name: name, m_EditorClassIdentifier: '', ...body },
    }];
    p.writeYamlAsset(rendRel, rendGuid, mono(URP_RENDERER, 'UniversalRP_Renderer', {
      debugShaders: {}, m_RendererFeatures: [], m_RendererFeatureMap: '', m_UseNativeRenderPass: 0, xrSystemData: ids.NULL_REF,
      m_AssetVersion: 2, m_OpaqueLayerMask: mask(rd.opaqueLayerMask), m_TransparentLayerMask: mask(rd.transparentLayerMask),
      m_DefaultStencilState: { overrideStencilState: 0, stencilReference: 0, stencilCompareFunction: 8, passOperation: 2, failOperation: 0, zFailOperation: 0 },
      m_ShadowTransparentReceive: 1, m_RenderingMode: 0, m_DepthPrimingMode: 0, m_CopyDepthMode: 1, m_AccurateGbufferNormals: 0, m_IntermediateTextureMode: 1,
    }), 11400000);
    const v = (x, dflt) => (x == null ? dflt : typeof x === 'boolean' ? (x ? 1 : 0) : x);
    const s3 = d && d.Cascade3Split, s4 = d && d.Cascade4Split;
    p.writeYamlAsset(assetRel, assetGuid, mono(URP_ASSET, 'UniversalRP', {
      k_AssetVersion: 11, k_AssetPreviousVersion: 11, m_RendererType: 1, m_RendererData: ids.NULL_REF,
      m_RendererDataList: [ids.assetRef(11400000, rendGuid, 2)], m_DefaultRendererIndex: 0,
      m_RequireDepthTexture: v(d && d.RequireDepthTexture, 0), m_RequireOpaqueTexture: v(d && d.RequireOpaqueTexture, 0), m_OpaqueDownsampling: 1,
      m_SupportsTerrainHoles: 1, m_SupportsHDR: 1, m_HDRColorBufferPrecision: 0, m_MSAA: 1, m_RenderScale: 1, m_UpscalingFilter: 0,
      m_FsrOverrideSharpness: 0, m_FsrSharpness: 0.92, m_EnableLODCrossFade: 1, m_LODCrossFadeDitheringType: 1, m_ShEvalMode: 0,
      m_MainLightRenderingMode: v(d && d.MainLightRenderingModeValue, 1), m_MainLightShadowsSupported: v(d && d.SupportsMainLightShadows, 1),
      m_MainLightShadowmapResolution: v(d && d.MainLightShadowmapResolutionValue, 2048), m_AdditionalLightsRenderingMode: v(d && d.AdditionalLightsRenderingMode, 1),
      m_AdditionalLightsPerObjectLimit: 4, m_AdditionalLightShadowsSupported: 0, m_AdditionalLightsShadowmapResolution: 2048,
      m_ShadowDistance: v(d && d.ShadowDistance, 50), m_ShadowCascadeCount: v(d && d.ShadowCascadeCount, 1), m_Cascade2Split: v(d && d.Cascade2Split, 0.25),
      m_Cascade3Split: flow(s3 ? { x: s3.x, y: s3.y } : { x: 0.1, y: 0.3 }), m_Cascade4Split: flow(s4 ? { x: s4.x, y: s4.y, z: s4.z } : { x: 0.067, y: 0.2, z: 0.467 }),
      m_CascadeBorder: v(d && d.CascadeBorder, 0.2), m_ShadowDepthBias: v(d && d.ShadowDepthBias, 1), m_ShadowNormalBias: v(d && d.ShadowNormalBias, 1),
      m_SoftShadowsSupported: v(d && d.SupportsSoftShadows, 0), m_MixedLightingSupported: v(d && d.MixedLightingSupported, 1),
    }), 11400000);
    pipelineRef = ids.assetRef(11400000, assetGuid, 2);
    p.report.note('Dựng lại URP Asset (Assets/Settings/UniversalRP.asset) và gán trong Graphics settings.');
  }
  p.out.write('ProjectSettings/GraphicsSettings.asset', unityFile([{
    classId: 30, fileId: 1, type: 'GraphicsSettings', body: {
      m_ObjectHideFlags: 0, serializedVersion: 15,
      m_AlwaysIncludedShaders: ALWAYS_INCLUDED.map((f) => ids.assetRef(f, ids.EXTRA, 0)),
      m_PreloadedShaders: [], m_PreloadShadersBatchTimeLimit: -1, m_CustomRenderPipeline: pipelineRef || ids.NULL_REF,
      m_TransparencySortMode: 0, m_TransparencySortAxis: flow({ x: 0, y: 0, z: 1 }), m_DefaultRenderingPath: 1, m_DefaultMobileRenderingPath: 1,
      m_TierSettings: [], m_LightmapStripping: 0, m_FogStripping: 0, m_InstancingStripping: 0, m_LightmapKeepPlain: 1, m_LightmapKeepDirCombined: 1,
      m_LightmapKeepDynamicPlain: 1, m_LightmapKeepDynamicDirCombined: 1, m_LightmapKeepShadowMask: 1, m_LightmapKeepSubtractive: 1,
      m_FogKeepLinear: 1, m_FogKeepExp: 1, m_FogKeepExp2: 1, m_AlbedoSwatchInfos: [], m_LightsUseLinearIntensity: 0, m_LightsUseColorTemperature: 0,
      m_LogWhenShaderIsCompiled: 0, m_SRPDefaultSettings: {}, m_CameraRelativeLightCulling: 0, m_CameraRelativeShadowCulling: 0,
    },
  }]));
}

module.exports = { writeSettings, sortingTable, tagTable };
