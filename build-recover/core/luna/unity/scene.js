'use strict';
// Scenes (.unity) and prefabs (.prefab): GameObjects, the builtin components Luna has DTOs for, and MonoBehaviours
// (UI, TextMesh Pro, Spine, user scripts) serialized generically — Luna keeps their real serialized field names.
const { flow, unityFile } = require('./yaml');
const ids = require('./ids');
const { UnityProject, importers, HEADER } = require('./project');
const { fieldsOf } = require('./assets');
const S = require('../schema');

const CLASS = {
  'UnityEngine.Transform': [4, 'Transform'], 'UnityEngine.RectTransform': [224, 'RectTransform'], 'UnityEngine.Camera': [20, 'Camera'],
  'UnityEngine.Light': [108, 'Light'], 'UnityEngine.MeshFilter': [33, 'MeshFilter'], 'UnityEngine.MeshRenderer': [23, 'MeshRenderer'],
  'UnityEngine.SkinnedMeshRenderer': [137, 'SkinnedMeshRenderer'], 'UnityEngine.SpriteRenderer': [212, 'SpriteRenderer'],
  'UnityEngine.Animator': [95, 'Animator'], 'UnityEngine.Animation': [111, 'Animation'], 'UnityEngine.AudioSource': [82, 'AudioSource'],
  'UnityEngine.AudioListener': [81, 'AudioListener'], 'UnityEngine.Canvas': [223, 'Canvas'], 'UnityEngine.CanvasRenderer': [222, 'CanvasRenderer'],
  'UnityEngine.CanvasGroup': [225, 'CanvasGroup'], 'UnityEngine.Rigidbody2D': [50, 'Rigidbody2D'], 'UnityEngine.BoxCollider2D': [61, 'BoxCollider2D'],
  'UnityEngine.CircleCollider2D': [58, 'CircleCollider2D'], 'UnityEngine.Rigidbody': [54, 'Rigidbody'], 'UnityEngine.BoxCollider': [65, 'BoxCollider'],
  'UnityEngine.SphereCollider': [135, 'SphereCollider'], 'UnityEngine.CapsuleCollider': [136, 'CapsuleCollider'], 'UnityEngine.MeshCollider': [64, 'MeshCollider'],
  'UnityEngine.CharacterJoint': [144, 'CharacterJoint'], 'UnityEngine.SpriteMask': [331, 'SpriteMask'], 'UnityEngine.LineRenderer': [120, 'LineRenderer'],
  'UnityEngine.ParticleSystem': [198, 'ParticleSystem'], 'UnityEngine.ParticleSystemRenderer': [199, 'ParticleSystemRenderer'],
};
const TRANSFORMS = new Set(['UnityEngine.Transform', 'UnityEngine.RectTransform']);
const v3 = (v, d = { x: 0, y: 0, z: 0 }) => flow(v ? { x: v.x, y: v.y, z: v.z } : d);
const v2 = (v, d = { x: 0, y: 0 }) => flow(v ? { x: v.x, y: v.y } : d);
const col = (c, d = { r: 1, g: 1, b: 1, a: 1 }) => flow(c ? { r: c.r, g: c.g, b: c.b, a: c.a } : d);
const q = (r) => flow(r ? { x: r.x, y: r.y, z: r.z, w: r.w } : { x: 0, y: 0, z: 0, w: 1 });
const b = (x, d = 0) => (x == null ? d : x ? 1 : 0);
const n = (x, d = 0) => (x == null || Number.isNaN(x) ? d : x);
const mask = (bits) => ({ serializedVersion: 2, m_Bits: (bits == null ? -1 : bits) >>> 0 });

function walk(node, fn) { fn(node); for (const c of node.children) walk(c, fn); }

// ---------------------------------------------------------------- planning
function planScenesAndPrefabs(p) {
  const claimHomes = (root, key) => {
    if (!p.fileIds.has(key)) p.fileIds.set(key, new Set());
    const own = p.fileIds.get(key);
    walk(root, (node) => {
      own.add(node.id);
      // first claimer keeps the global entry: real prefab assets are planned before scenes, so cross-file
      // references resolve to the prefab asset
      if (!p.homes.has(node.id)) p.homes.set(node.id, { file: key, fileID: node.id });
      for (const c of node.components) {
        own.add(c.id);
        if (!p.homes.has(c.id)) p.homes.set(c.id, { file: key, fileID: c.id });
      }
    });
  };
  for (const pf of p.m.prefabs) {
    const ap = UnityProject.assetPath(pf.path);
    const rel = p.claim(ap && /\.prefab$/i.test(ap) ? ap : `Assets/_Recovered/Prefabs/${pf.root.name || pf.id}.prefab`);
    const key = 'prefab:' + pf.id;
    p.files.set(key, { kind: 'prefab', rel, guid: ids.guidOf(rel), roots: [pf.root] });
    claimHomes(pf.root, key);
  }
  for (const sc of p.m.scenes) {
    const ap = UnityProject.assetPath(sc.path);
    const rel = p.claim(ap && /\.unity$/i.test(ap) ? ap : `Assets/Scenes/${sc.name || 'Scene'}.unity`);
    const key = 'scene:' + sc.id;
    p.files.set(key, { kind: 'scene', rel, guid: ids.guidOf(rel), roots: sc.roots, scene: sc });
    for (const r of sc.roots) claimHomes(r, key);
  }
}

// ---------------------------------------------------------------- component bodies
function rendererBase(p, d, file, sorting) {
  const layer = sorting(d.sortingLayerID || 0);
  return {
    m_Enabled: b(d.enabled, 1), m_CastShadows: n(d.shadowCastingMode), m_ReceiveShadows: b(d.receiveShadows, 1), m_DynamicOccludee: 1,
    m_StaticShadowCaster: 0, m_MotionVectors: 1, m_LightProbeUsage: n(d.lightProbeUsage, 1), m_ReflectionProbeUsage: n(d.reflectionProbeUsage, 1),
    m_RayTracingMode: 2, m_RayTraceProcedural: 0, m_RenderingLayerMask: 1, m_RendererPriority: 0,
    m_Materials: (d.sharedMaterials && d.sharedMaterials.length ? d.sharedMaterials : d.sharedMaterial ? [d.sharedMaterial] : []).map((m) => p.ref(m, file)),
    m_StaticBatchInfo: { firstSubMesh: 0, subMeshCount: 0 }, m_StaticBatchRoot: ids.NULL_REF, m_ProbeAnchor: ids.NULL_REF,
    m_LightProbeVolumeOverride: ids.NULL_REF, m_ScaleInLightmap: 1, m_ReceiveGI: 1, m_PreserveUVs: 0, m_IgnoreNormalsForChartDetection: 0,
    m_ImportantGI: 0, m_StitchLightmapSeams: 1, m_SelectedEditorRenderState: 3, m_MinimumChartSize: 4, m_AutoUVMaxDistance: 0.5,
    m_AutoUVMaxAngle: 89, m_LightmapParameters: ids.NULL_REF, m_SortingLayerID: layer.id, m_SortingLayer: layer.value, m_SortingOrder: n(d.sortingOrder),
  };
}

const curve1 = (value = 1) => ({ serializedVersion: 2, m_Curve: [{ serializedVersion: 3, time: 0, value, inSlope: 0, outSlope: 0, tangentMode: 0, weightedMode: 0, inWeight: 0.33333334, outWeight: 0.33333334 }], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4 });

function builtinBody(p, cls, d, comp, file, ctx) {
  const ref = (r) => p.ref(r, file);
  const en = comp.enabled != null ? b(comp.enabled) : b(d.enabled, 1);
  switch (cls) {
    case 'UnityEngine.Camera': {
      const rc = Array.isArray(d.rect) ? d.rect : [0, 0, 1, 1];
      return {
        m_Enabled: en, serializedVersion: 2, m_ClearFlags: n(d.clearFlags, 1), m_BackGroundColor: col(d.backgroundColor, { r: 0.19, g: 0.3, b: 0.47, a: 0 }),
        m_projectionMatrixMode: 1, m_GateFitMode: n(d.gateFit, 2), m_FOVAxisMode: 0, m_SensorSize: v2(d.sensorSize, { x: 36, y: 24 }), m_LensShift: v2(d.lensShift),
        m_FocalLength: n(d.focalLength, 50), m_NormalizedViewPortRect: { serializedVersion: 2, x: rc[0], y: rc[1], width: rc[2], height: rc[3] },
        'near clip plane': n(d.nearClipPlane, 0.3), 'far clip plane': n(d.farClipPlane, 1000), 'field of view': n(d.fieldOfView, 60),
        orthographic: b(d.orthographic), 'orthographic size': n(d.orthographicSize, 5), m_Depth: n(d.depth, -1), m_CullingMask: mask(d.cullingMask),
        m_RenderingPath: -1, m_TargetTexture: ref(d.targetTexture), m_TargetDisplay: 0, m_TargetEye: 3, m_HDR: 1, m_AllowMSAA: 1,
        m_AllowDynamicResolution: 0, m_ForceIntoRT: 0, m_OcclusionCulling: 1, m_StereoConvergence: 10, m_StereoSeparation: 0.022,
      };
    }
    case 'UnityEngine.Light':
      return {
        m_Enabled: en, serializedVersion: 10, m_Type: n(d.type, 1), m_Shape: 0, m_Color: col(d.color), m_Intensity: n(d.intensity, 1), m_Range: n(d.range, 10),
        m_SpotAngle: n(d.spotAngle, 30), m_InnerSpotAngle: 21.80208, m_CookieSize: n(d.cookieSize, 10),
        m_Shadows: {
          m_Type: n(d.shadows), m_Resolution: n(d.shadowResolution, -1), m_CustomResolution: -1, m_Strength: n(d.shadowStrength, 1),
          m_Bias: n(d.shadowBias, 0.05), m_NormalBias: n(d.shadowNormalBias, 0.4), m_NearPlane: 0.2, m_CullingMatrixOverride: identity(), m_UseCullingMatrixOverride: 0,
        },
        m_Cookie: ref(d.cookie), m_DrawHalo: 0, m_Flare: ids.NULL_REF, m_RenderMode: n(d.renderMode), m_CullingMask: mask(d.cullingMask),
        m_RenderingLayerMask: 1, m_Lightmapping: n(d.lightmapBakeType, 4), m_LightShadowCasterMode: 0, m_AreaSize: flow({ x: 1, y: 1 }),
        m_BounceIntensity: 1, m_ColorTemperature: 6570, m_UseColorTemperature: 0, m_BoundingSphereOverride: flow({ x: 0, y: 0, z: 0, w: 0 }),
        m_UseBoundingSphereOverride: 0, m_UseViewFrustumForShadowCasterCull: 1, m_ShadowRadius: 0, m_ShadowAngle: 0,
      };
    case 'UnityEngine.MeshFilter': return { m_Mesh: ref(d.sharedMesh) };
    case 'UnityEngine.MeshRenderer': return { ...rendererBase(p, d, file, ctx.sorting), m_AdditionalVertexStreams: ref(d.additionalVertexStreams) };
    case 'UnityEngine.SkinnedMeshRenderer': {
      const lb = d.localBounds || d.bounds;
      return {
        ...rendererBase(p, d, file, ctx.sorting), serializedVersion: 2, m_Quality: n(d.quality), m_UpdateWhenOffscreen: b(d.updateWhenOffscreen),
        m_SkinnedMotionVectors: 1, m_Mesh: ref(d.sharedMesh), m_Bones: (d.bones || []).map((x) => ref(x)),
        m_BlendShapeWeights: d.blendShapeWeights || [], m_RootBone: ref(d.rootBone),
        m_AABB: { m_Center: v3(lb && lb.center), m_Extent: v3(lb && (lb.extents || lb.extends), { x: 1, y: 1, z: 1 }) }, m_DirtyAABB: lb ? 0 : 1,
      };
    }
    case 'UnityEngine.SpriteRenderer':
      return {
        ...rendererBase(p, d, file, ctx.sorting), m_Sprite: ref(d.sprite), m_Color: col(d.color), m_FlipX: b(d.flipX), m_FlipY: b(d.flipY),
        m_DrawMode: n(d.drawMode), m_Size: v2(d.size, { x: 1, y: 1 }), m_AdaptiveModeThreshold: n(d.adaptiveModeThreshold, 0.5),
        m_SpriteTileMode: n(d.tileMode), m_WasSpriteAssigned: 1, m_MaskInteraction: n(d.maskInteraction), m_SpriteSortPoint: n(d.spriteSortPoint),
      };
    case 'UnityEngine.SpriteMask': {
      const front = ctx.sorting(d.frontSortingLayerID || 0), back = ctx.sorting(d.backSortingLayerID || 0);
      return {
        ...rendererBase(p, d, file, ctx.sorting), m_Sprite: ref(d.sprite), m_MaskAlphaCutoff: n(d.alphaCutoff, 0.2),
        m_FrontSortingLayerID: front.id, m_BackSortingLayerID: back.id, m_FrontSortingLayer: front.value, m_BackSortingLayer: back.value,
        m_FrontSortingOrder: n(d.frontSortingOrder), m_BackSortingOrder: n(d.backSortingOrder), m_IsCustomRangeActive: b(d.isCustomRangeActive),
        m_SpriteSortPoint: n(d.spriteSortPoint),
      };
    }
    case 'UnityEngine.Animator':
      return {
        serializedVersion: 5, m_Enabled: en, m_Avatar: ids.NULL_REF, m_Controller: ref(d.animatorController || d.runtimeAnimatorController),
        m_CullingMode: n(d.cullingMode), m_UpdateMode: n(d.updateMode), m_ApplyRootMotion: b(d.applyRootMotion), m_LinearVelocityBlending: 0,
        m_StabilizeFeet: 0, m_WarningMessage: '', m_HasTransformHierarchy: b(d.hasTransformHierarchy, 1), m_AllowConstantClipSamplingOptimization: 1,
        m_KeepAnimatorStateOnDisable: 0, m_WriteDefaultValuesOnDisable: 0,
      };
    case 'UnityEngine.Animation':
      return {
        m_Enabled: en, serializedVersion: 3, m_Animation: ref(d.clip), m_Animations: (d.clips || []).map((x) => ref(x)), m_WrapMode: n(d.wrapMode),
        m_PlayAutomatically: b(d.playAutomatically, 1), m_AnimatePhysics: 0, m_CullingType: 0,
      };
    case 'UnityEngine.AudioSource':
      return {
        m_Enabled: en, serializedVersion: 4, OutputAudioMixerGroup: ref(d.outputAudioMixerGroup), m_audioClip: ref(d.clip), m_PlayOnAwake: b(d.playOnAwake, 1),
        m_Volume: n(d.volume, 1), m_Pitch: n(d.pitch, 1), Loop: b(d.loop), Mute: b(d.mute), Spatialize: 0, SpatializePostEffects: 0, Priority: 128,
        DopplerLevel: 1, MinDistance: 1, MaxDistance: 500, Pan2D: 0, rolloffMode: 0, BypassEffects: 0, BypassListenerEffects: 0, BypassReverbZones: 0,
        rolloffCustomCurve: curve1(1), panLevelCustomCurve: curve1(n(d.spatialBlend, 0)), spreadCustomCurve: curve1(0), reverbZoneMixCustomCurve: curve1(1),
      };
    case 'UnityEngine.AudioListener': return { m_Enabled: en };
    case 'UnityEngine.Canvas': {
      const layer = ctx.sorting(d.sortingLayerID || 0);
      return {
        m_Enabled: b(d.enabled, en), serializedVersion: 3, m_RenderMode: n(d.renderMode), m_Camera: ref(d.worldCamera), m_PlaneDistance: n(d.planeDistance, 100),
        m_PixelPerfect: b(d.pixelPerfect), m_ReceivesEvents: 1, m_OverrideSorting: b(d.overrideSorting), m_OverridePixelPerfect: b(d.overridePixelPerfect),
        m_SortingBucketNormalizedSize: 0, m_VertexColorAlwaysGammaSpace: 0, m_AdditionalShaderChannelsFlag: 25, m_UpdateRectTransformForStandalone: 0,
        m_SortingLayerID: layer.id, m_SortingOrder: n(d.sortingOrder), m_TargetDisplay: n(d.targetDisplay),
      };
    }
    case 'UnityEngine.CanvasRenderer': return { m_CullTransparentMesh: b(d.cullTransparentMesh, 1) };
    case 'UnityEngine.CanvasGroup':
      return { m_Enabled: en, m_Alpha: n(d.alpha, 1), m_Interactable: b(d.interactable, 1), m_BlocksRaycasts: b(d.blocksRaycasts, 1), m_IgnoreParentGroups: b(d.ignoreParentGroups) };
    case 'UnityEngine.Rigidbody2D':
      return {
        m_BodyType: n(d.bodyType), m_Simulated: b(d.simulated, 1), m_UseFullKinematicContacts: b(d.useFullKinematicContacts), m_UseAutoMass: b(d.useAutoMass),
        m_Mass: n(d.mass, 1), m_LinearDrag: n(d.drag), m_AngularDrag: n(d.angularDrag, 0.05), m_GravityScale: n(d.gravityScale, 1), m_Material: ref(d.material),
        m_Interpolate: n(d.interpolation), m_SleepingMode: n(d.sleepMode, 1), m_CollisionDetection: n(d.collisionDetectionMode), m_Constraints: n(d.constraints),
      };
    case 'UnityEngine.BoxCollider2D':
      return {
        m_Enabled: b(d.enabled, en), m_Density: n(d.density, 1), m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_UsedByEffector: b(d.usedByEffector),
        m_UsedByComposite: b(d.usedByComposite), m_Offset: v2(d.offset), m_SpriteTilingProperty: { border: flow({ x: 0, y: 0, z: 0, w: 0 }), pivot: flow({ x: 0.5, y: 0.5 }), oldSize: flow({ x: 1, y: 1 }), newSize: flow({ x: 1, y: 1 }), adaptiveTilingThreshold: 0.5, drawMode: 0, adaptiveTiling: 0 },
        m_AutoTiling: b(d.autoTiling), serializedVersion: 2, m_Size: v2(d.size, { x: 1, y: 1 }), m_EdgeRadius: n(d.edgeRadius),
      };
    case 'UnityEngine.CircleCollider2D':
      return {
        m_Enabled: b(d.enabled, en), m_Density: n(d.density, 1), m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_UsedByEffector: b(d.usedByEffector),
        m_UsedByComposite: 0, m_Offset: v2(d.offset), serializedVersion: 2, m_Radius: n(d.radius, 0.5),
      };
    case 'UnityEngine.Rigidbody':
      return {
        serializedVersion: 2, m_Mass: n(d.mass, 1), m_Drag: n(d.drag), m_AngularDrag: n(d.angularDrag, 0.05), m_UseGravity: b(d.useGravity, 1),
        m_IsKinematic: b(d.isKinematic), m_Interpolate: n(d.interpolation), m_Constraints: n(d.constraints), m_CollisionDetection: n(d.collisionDetectionMode),
      };
    case 'UnityEngine.BoxCollider':
      return { m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_Enabled: b(d.enabled, en), serializedVersion: 2, m_Size: v3(d.size, { x: 1, y: 1, z: 1 }), m_Center: v3(d.center) };
    case 'UnityEngine.SphereCollider':
      return { m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_Enabled: b(d.enabled, en), serializedVersion: 2, m_Radius: n(d.radius, 0.5), m_Center: v3(d.center) };
    case 'UnityEngine.CapsuleCollider':
      return { m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_Enabled: b(d.enabled, en), m_Radius: n(d.radius, 0.5), m_Height: n(d.height, 2), m_Direction: n(d.direction, 1), m_Center: v3(d.center) };
    case 'UnityEngine.MeshCollider':
      return { m_Material: ref(d.material), m_IsTrigger: b(d.isTrigger), m_Enabled: b(d.enabled, en), serializedVersion: 4, m_Convex: b(d.convex), m_CookingOptions: 30, m_Mesh: ref(d.sharedMesh) };
    case 'UnityEngine.CharacterJoint': {
      const lim = (l) => ({ limit: n(l && l.m_Limit), bounciness: n(l && l.m_Bounciness), contactDistance: n(l && l.m_ContactDistance) });
      const spr = (s) => ({ spring: n(s && s.m_Spring), damper: n(s && s.m_Damper) });
      return {
        m_ConnectedBody: ref(d.connectedBody), m_ConnectedArticulationBody: ids.NULL_REF, m_Anchor: v3(d.anchor), m_Axis: v3(d.axis, { x: 1, y: 0, z: 0 }),
        m_AutoConfigureConnectedAnchor: b(d.autoConfigureConnectedAnchor, 1), m_ConnectedAnchor: v3(d.connectedAnchor), serializedVersion: 2,
        m_SwingAxis: v3(d.swingAxis, { x: 0, y: 1, z: 0 }), m_TwistLimitSpring: spr(d.twistLimitSpring), m_LowTwistLimit: lim(d.lowTwistLimit),
        m_HighTwistLimit: lim(d.highTwistLimit), m_SwingLimitSpring: spr(d.swingLimitSpring), m_Swing1Limit: lim(d.swing1Limit), m_Swing2Limit: lim(d.swing2Limit),
        m_EnableProjection: b(d.enableProjection), m_ProjectionDistance: n(d.projectionDistance, 0.1), m_ProjectionAngle: n(d.projectionAngle, 180),
        m_BreakForce: d.breakForce != null && Number.isFinite(d.breakForce) ? d.breakForce : Infinity, m_BreakTorque: d.breakTorque != null && Number.isFinite(d.breakTorque) ? d.breakTorque : Infinity,
        m_EnableCollision: b(d.enableCollision), m_EnablePreprocessing: b(d.enablePreprocessing, 1), m_MassScale: n(d.massScale, 1), m_ConnectedMassScale: n(d.connectedMassScale, 1),
      };
    }
    case 'UnityEngine.LineRenderer':
      return {
        ...rendererBase(p, d, file, ctx.sorting), m_Positions: (d.positions || []).map((x) => v3(x)), m_Parameters: {
          serializedVersion: 3, widthMultiplier: n(d.widthMultiplier, 1), widthCurve: curve1(1), colorGradient: gradient(), numCornerVertices: n(d.numCornerVertices),
          numCapVertices: n(d.numCapVertices), alignment: n(d.alignment), textureMode: n(d.textureMode), shadowBias: 0.5, generateLightingData: 0,
        }, m_UseWorldSpace: b(d.useWorldSpace, 1), m_Loop: b(d.loop), m_ApplyActiveColorSpace: 0,
      };
    case 'UnityEngine.ParticleSystemRenderer':
      return {
        ...rendererBase(p, d, file, ctx.sorting), m_RenderMode: n(d.renderMode), m_MeshDistribution: 0, m_SortMode: n(d.sortMode), m_MinParticleSize: n(d.minParticleSize),
        m_MaxParticleSize: n(d.maxParticleSize, 0.5), m_CameraVelocityScale: n(d.cameraVelocityScale), m_VelocityScale: n(d.velocityScale), m_LengthScale: n(d.lengthScale, 2),
        m_SortingFudge: n(d.sortingFudge), m_NormalDirection: n(d.normalDirection, 1), m_ShadowBias: 0, m_RenderAlignment: n(d.alignment), m_Pivot: v3(d.pivot),
        m_Flip: flow({ x: 0, y: 0, z: 0 }), m_EnableGPUInstancing: 1, m_ApplyActiveColorSpace: 1, m_AllowRoll: 1, m_FreeformStretching: 0, m_RotateWithStretchDirection: 1,
        m_UseCustomVertexStreams: 0, m_VertexStreams: '00010304', m_UseCustomTrailVertexStreams: 0, m_TrailVertexStreams: '00010304', m_Mesh: ref(d.mesh),
        m_Mesh1: ids.NULL_REF, m_Mesh2: ids.NULL_REF, m_Mesh3: ids.NULL_REF, m_MeshWeighting: 1, m_MeshWeighting1: 1, m_MeshWeighting2: 1, m_MeshWeighting3: 1, m_MaskInteraction: 0,
      };
    case 'UnityEngine.ParticleSystem': return require('./particles').particleBody(p, d, file);
    default: return null;
  }
}

function identity() { const o = {}; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[`e${r}${c}`] = r === c ? 1 : 0; return o; }
function gradient() {
  return {
    serializedVersion: 2, key0: flow({ r: 1, g: 1, b: 1, a: 1 }), key1: flow({ r: 1, g: 1, b: 1, a: 1 }), key2: flow({ r: 0, g: 0, b: 0, a: 0 }), key3: flow({ r: 0, g: 0, b: 0, a: 0 }),
    key4: flow({ r: 0, g: 0, b: 0, a: 0 }), key5: flow({ r: 0, g: 0, b: 0, a: 0 }), key6: flow({ r: 0, g: 0, b: 0, a: 0 }), key7: flow({ r: 0, g: 0, b: 0, a: 0 }),
    ctime0: 0, ctime1: 65535, ctime2: 0, ctime3: 0, ctime4: 0, ctime5: 0, ctime6: 0, ctime7: 0, atime0: 0, atime1: 65535, atime2: 0, atime3: 0, atime4: 0, atime5: 0, atime6: 0, atime7: 0,
    m_Mode: 0, m_ColorSpace: -1, m_NumColorKeys: 2, m_NumAlphaKeys: 2,
  };
}

// ---------------------------------------------------------------- files
function objectDocs(p, roots, file, ctx) {
  const docs = [];
  const tr = (node) => node.components.find((c) => TRANSFORMS.has(c.className));
  const trId = (node) => { const t = tr(node); return t ? t.id : ids.fileIdOf('tr:' + node.id); };
  roots.forEach((root, rootIndex) => walk(root, (node) => {
    const parent = node.parent;
    const index = parent ? parent.children.indexOf(node) : rootIndex;
    const compRefs = [];
    let hasTransform = false;
    for (const c of node.components) {
      const d = c.value || {};
      let classId, type, body;
      if (TRANSFORMS.has(c.className)) {
        hasTransform = true;
        const rect = c.className === 'UnityEngine.RectTransform';
        [classId, type] = CLASS[c.className];
        const pos = rect ? d.anchoredPosition3D : d.position;
        body = {
          ...HEADER(), m_GameObject: ids.localRef(node.id), m_LocalRotation: q(d.rotation), m_LocalPosition: rect ? flow({ x: 0, y: 0, z: pos ? pos.z : 0 }) : v3(pos),
          m_LocalScale: v3(d.scale, { x: 1, y: 1, z: 1 }), m_ConstrainProportionsScale: 0,
          m_Children: node.children.map((ch) => ids.localRef(trId(ch))), m_Father: parent ? ids.localRef(trId(parent)) : ids.NULL_REF, m_RootOrder: index,
          m_LocalEulerAnglesHint: flow({ x: 0, y: 0, z: 0 }),
        };
        if (rect) Object.assign(body, { m_AnchorMin: v2(d.anchorMin), m_AnchorMax: v2(d.anchorMax), m_AnchoredPosition: v2(pos), m_SizeDelta: v2(d.sizeDelta), m_Pivot: v2(d.pivot, { x: 0.5, y: 0.5 }) });
      } else if (CLASS[c.className]) {
        [classId, type] = CLASS[c.className];
        const bb = builtinBody(p, c.className, d, c, file, ctx);
        body = { ...HEADER(), m_GameObject: ids.localRef(node.id), ...bb };
      } else if (/^UnityEngine\.(Transform|GameObject|Component|Behaviour|Renderer|Collider2?D?)$/.test(c.className)) {
        continue;
      } else {
        classId = 114; type = 'MonoBehaviour';
        body = {
          ...HEADER(), m_GameObject: ids.localRef(node.id), m_Enabled: comp_enabled(c), m_EditorHideFlags: 0, m_Script: p.scriptRef(c.className),
          m_Name: '', m_EditorClassIdentifier: '', ...fieldsOf(p, d, file, c.className),
        };
        p.noteScriptUse(c.className, c.value);
      }
      compRefs.push({ component: ids.localRef(c.id) });
      docs.push({ classId, fileId: c.id, type, body });
      p.count(type === 'MonoBehaviour' ? 'monoBehaviours' : 'components');
    }
    if (!hasTransform) {
      const f = trId(node);
      compRefs.unshift({ component: ids.localRef(f) });
      docs.push({
        classId: 4, fileId: f, type: 'Transform', body: {
          ...HEADER(), m_GameObject: ids.localRef(node.id), m_LocalRotation: q(null), m_LocalPosition: v3(null), m_LocalScale: v3(null, { x: 1, y: 1, z: 1 }),
          m_ConstrainProportionsScale: 0, m_Children: node.children.map((ch) => ids.localRef(trId(ch))), m_Father: parent ? ids.localRef(trId(parent)) : ids.NULL_REF,
          m_RootOrder: index, m_LocalEulerAnglesHint: flow({ x: 0, y: 0, z: 0 }),
        },
      });
    }
    docs.push({
      classId: 1, fileId: node.id, type: 'GameObject', body: {
        ...HEADER(), serializedVersion: 6, m_Component: compRefs, m_Layer: node.layer || 0, m_Name: node.name || 'GameObject', m_TagString: ctx.tag(node.tagId),
        m_Icon: ids.NULL_REF, m_NavMeshLayer: 0, m_StaticEditorFlags: node.isStatic ? 4294967295 : 0, m_IsActive: node.active ? 1 : 0,
      },
    });
    p.count('gameObjects');
  }));
  return docs;
}
const comp_enabled = (c) => (c.enabled == null ? 1 : c.enabled ? 1 : 0);

function sceneSettingsDocs(p, sc, file) {
  const rs = sc.renderSettings || {};
  const skybox = rs.skybox ? p.ref(rs.skybox, file) : ids.NULL_REF;
  const sun = rs.sunLightObjectId && p.homes.get(rs.sunLightObjectId) && p.homes.get(rs.sunLightObjectId).file === file ? ids.localRef(rs.sunLightObjectId) : ids.NULL_REF;
  return [
    { classId: 29, fileId: 1, type: 'OcclusionCullingSettings', body: { m_ObjectHideFlags: 0, serializedVersion: 2, m_OcclusionBakeSettings: { smallestOccluder: 5, smallestHole: 0.25, backfaceThreshold: 100 }, m_SceneGUID: '00000000000000000000000000000000', m_OcclusionCullingData: ids.NULL_REF } },
    {
      classId: 104, fileId: 2, type: 'RenderSettings', body: {
        m_ObjectHideFlags: 0, serializedVersion: 9, m_Fog: b(rs.fog), m_FogColor: col(rs.fogColor, { r: 0.5, g: 0.5, b: 0.5, a: 1 }), m_FogMode: n(rs.fogMode, 3),
        m_FogDensity: n(rs.fogDensity, 0.01), m_LinearFogStart: n(rs.fogStartDistance, 0), m_LinearFogEnd: n(rs.fogEndDistance, 300),
        m_AmbientSkyColor: col(rs.ambientSkyColor, { r: 0.212, g: 0.227, b: 0.259, a: 1 }), m_AmbientEquatorColor: col(rs.ambientEquatorColor, { r: 0.114, g: 0.125, b: 0.133, a: 1 }),
        m_AmbientGroundColor: col(rs.ambientGroundColor, { r: 0.047, g: 0.043, b: 0.035, a: 1 }), m_AmbientIntensity: n(rs.ambientIntensity, 1), m_AmbientMode: n(rs.ambientMode),
        m_SubtractiveShadowColor: flow({ r: 0.42, g: 0.478, b: 0.627, a: 1 }), m_SkyboxMaterial: skybox, m_HaloStrength: 0.5, m_FlareStrength: 1, m_FlareFadeSpeed: 3,
        m_HaloTexture: ids.NULL_REF, m_SpotCookie: flow({ fileID: 10001, guid: '0000000000000000e000000000000000', type: 0 }), m_DefaultReflectionMode: n(rs.defaultReflectionMode),
        m_DefaultReflectionResolution: n(rs.defaultReflectionResolution, 128), m_ReflectionBounces: 1, m_ReflectionIntensity: n(rs.reflectionIntensity, 1),
        m_CustomReflection: ids.NULL_REF, m_Sun: sun, m_IndirectSpecularColor: flow({ r: 0, g: 0, b: 0, a: 1 }), m_UseRadianceAmbientProbe: 0,
      },
    },
    {
      classId: 157, fileId: 3, type: 'LightmapSettings', body: {
        m_ObjectHideFlags: 0, serializedVersion: 12, m_GIWorkflowMode: 1, m_GISettings: { serializedVersion: 2, m_BounceScale: 1, m_IndirectOutputScale: 1, m_AlbedoBoost: 1, m_EnvironmentLightingMode: 0, m_EnableBakedLightmaps: 0, m_EnableRealtimeLightmaps: 0 },
        m_LightmapEditorSettings: { serializedVersion: 12, m_Resolution: 2, m_BakeResolution: 40, m_AtlasSize: 1024, m_AO: 0, m_AOMaxDistance: 1, m_CompAOExponent: 1, m_CompAOExponentDirect: 0, m_ExtractAmbientOcclusion: 0, m_Padding: 2, m_LightmapParameters: ids.NULL_REF, m_LightmapsBakeMode: 1, m_TextureCompression: 1, m_FinalGather: 0, m_FinalGatherFiltering: 1, m_FinalGatherRayCount: 256, m_ReflectionCompression: 2, m_MixedBakeMode: 2, m_BakeBackend: 1, m_PVRSampling: 1, m_PVRDirectSampleCount: 32, m_PVRSampleCount: 512, m_PVRBounces: 2, m_PVREnvironmentSampleCount: 256, m_PVREnvironmentReferencePointCount: 2048, m_PVRFilteringMode: 1, m_PVRDenoiserTypeDirect: 1, m_PVRDenoiserTypeIndirect: 1, m_PVRDenoiserTypeAO: 1, m_PVRFilterTypeDirect: 0, m_PVRFilterTypeIndirect: 0, m_PVRFilterTypeAO: 0, m_PVREnvironmentMIS: 1, m_PVRCulling: 1, m_PVRFilteringGaussRadiusDirect: 1, m_PVRFilteringGaussRadiusIndirect: 5, m_PVRFilteringGaussRadiusAO: 2, m_PVRFilteringAtrousPositionSigmaDirect: 0.5, m_PVRFilteringAtrousPositionSigmaIndirect: 2, m_PVRFilteringAtrousPositionSigmaAO: 1, m_ExportTrainingData: 0, m_TrainingDataDestination: 'TrainingData', m_LightProbeSampleCountMultiplier: 4 },
        m_LightingDataAsset: ids.NULL_REF, m_LightingSettings: ids.NULL_REF,
      },
    },
    { classId: 196, fileId: 4, type: 'NavMeshSettings', body: { serializedVersion: 2, m_ObjectHideFlags: 0, m_BuildSettings: { serializedVersion: 3, agentTypeID: 0, agentRadius: 0.5, agentHeight: 2, agentSlope: 45, agentClimb: 0.4, ledgeDropHeight: 0, maxJumpAcrossDistance: 0, minRegionArea: 2, manualCellSize: 0, cellSize: 0.16666667, manualTileSize: 0, tileSize: 256, buildHeightMesh: 0, maxJobWorkers: 0, preserveTilesOutsideBounds: 0, debug: { m_Flags: 0 } }, m_NavMeshData: ids.NULL_REF } },
  ];
}

function writeScenesAndPrefabs(p, ctx) {
  for (const [key, f] of p.files) {
    let docs;
    try {
      docs = objectDocs(p, f.roots, key, ctx);
      if (f.kind === 'scene') docs = [...sceneSettingsDocs(p, f.scene, key), ...docs];
    } catch (e) {
      p.report.warn(`${f.rel}: ${e.message}`);
      continue;
    }
    p.out.write(f.rel, unityFile(docs));
    p.out.meta(f.rel, f.guid, f.kind === 'scene' ? importers.default() : importers.prefab());
    p.count(f.kind === 'scene' ? 'scenes' : 'prefabs');
  }
}

module.exports = { planScenesAndPrefabs, writeScenesAndPrefabs, CLASS };
