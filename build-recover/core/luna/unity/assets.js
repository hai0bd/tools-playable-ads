'use strict';
// Audio, text assets, fonts, materials (+ stand-in shaders), physics materials and ScriptableObject assets.
const { flow, unityFile } = require('./yaml');
const ids = require('./ids');
const { UnityProject, importers, HEADER } = require('./project');

const withExt = (p, ext) => p.replace(/\.[^./]+$/, '') + ext;
const TEXT_EXT = /\.(txt|json|bytes|html?|xml|csv|ya?ml|fnt|md|atlas)$/i;

// ---------------------------------------------------------------- audio
function planAudio(p) {
  for (const a of p.m.list('sounds')) {
    const bytes = p.m.x.sounds[`assets/bundles/${a.bundle}/${a.id}.mp3`] || Object.entries(p.m.x.sounds).find(([k]) => new RegExp(`/${a.id}\\.\\w+$`).test(k))?.[1];
    const ap = UnityProject.assetPath(a.path);
    if (!bytes) { p.register(a.id, { kind: 'audio', ref: null, builtin: false }); p.report.warn(`Âm thanh ${a.path || a.id}: không có dữ liệu trong build.`); continue; }
    // Luna re-encodes every clip to mp3; keep the name, change the extension
    const rel = p.claim(ap ? withExt(ap, '.mp3') : `Assets/_Recovered/Audio/${a.name || a.id}.mp3`);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'audio', rel, guid, ref: ids.assetRef(8300000, guid, 3), bytes });
  }
}
function writeAudio(p) {
  for (const a of p.m.list('sounds')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    p.out.write(info.rel, info.bytes);
    p.out.meta(info.rel, info.guid, importers.audio());
    p.count('audio');
  }
}

// ---------------------------------------------------------------- text assets
function planText(p) {
  for (const a of p.m.list('text-assets')) {
    const ap = UnityProject.assetPath(a.path);
    if (ap && ids.knownAssetGuid(ap)) { p.register(a.id, { kind: 'text', ref: ids.assetRef(4900000, ids.knownAssetGuid(ap), 3), essential: ap }); continue; }
    const rel = p.claim(ap ? (TEXT_EXT.test(ap) ? ap : ap + '.txt') : `Assets/_Recovered/Text/${a.name || a.id}.txt`);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'text', rel, guid, ref: ids.assetRef(4900000, guid, 3) });
  }
}
function writeText(p) {
  for (const a of p.m.list('text-assets')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    const d = a.dto || {};
    // text in "data", binary TextAssets (.bytes) as base64 in "bytes64"
    let body = d.bytes64 ? Buffer.from(d.bytes64, 'base64') : d.data != null ? d.data : '';
    if (Array.isArray(body)) body = Buffer.from(body);
    p.out.write(info.rel, body == null ? '' : body);
    p.out.meta(info.rel, info.guid, importers.text());
    p.count('textAssets');
  }
}

// ---------------------------------------------------------------- fonts
// The .ttf/.otf bytes are not in a Luna build (only a pre-rendered glyph atlas), so legacy UI.Text falls back to
// Unity's builtin font; TextMesh Pro font assets are recovered separately as ScriptableObjects.
function planFonts(p) {
  for (const a of p.m.list('fonts')) {
    const ap = UnityProject.assetPath(a.path);
    if (ap && ids.knownAssetGuid(ap)) { p.register(a.id, { kind: 'font', ref: ids.assetRef(12800000, ids.knownAssetGuid(ap), 3), essential: ap }); continue; }
    p.register(a.id, { kind: 'font', ref: ids.fontFallback(), builtin: true, missingFont: ap || a.name });
    if (ap) p.missingFonts.add(ap);
  }
}

// ---------------------------------------------------------------- physics materials
function planPhysics(p) {
  for (const [cat, ext, fid] of [['physics-materials-2d', '.physicsMaterial2D', 6200000], ['physics-materials', '.physicMaterial', 13400000]]) {
    for (const a of p.m.list(cat)) {
      const ap = UnityProject.assetPath(a.path);
      const rel = p.claim(ap || `Assets/_Recovered/Physics/${a.name || a.id}${ext}`);
      const guid = ids.guidOf(rel);
      p.register(a.id, { kind: cat, rel, guid, ref: ids.assetRef(fid, guid, 2), fid });
    }
  }
}
function writePhysics(p) {
  for (const a of p.m.list('physics-materials-2d')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    const d = a.dto || {};
    p.writeYamlAsset(info.rel, info.guid, [{ classId: 62, fileId: 6200000, type: 'PhysicsMaterial2D', body: { ...HEADER(), m_Name: d.name || a.name, friction: d.friction != null ? d.friction : 0.4, bounciness: d.bounciness || 0 } }], 6200000);
    p.count('physicsMaterials');
  }
  for (const a of p.m.list('physics-materials')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    const d = a.dto || {};
    p.writeYamlAsset(info.rel, info.guid, [{
      classId: 134, fileId: 13400000, type: 'PhysicMaterial', body: {
        ...HEADER(), m_Name: d.name || a.name, dynamicFriction: d.dynamicFriction != null ? d.dynamicFriction : 0.6, staticFriction: d.staticFriction != null ? d.staticFriction : 0.6,
        bounciness: d.bounciness || 0, frictionCombine: d.frictionCombine || 0, bounceCombine: d.bounceCombine || 0,
      },
    }], 13400000);
    p.count('physicsMaterials');
  }
}

// ---------------------------------------------------------------- shaders + materials
function shaderInfo(p, ref) {
  const a = ref && p.m.asset(ref.id);
  return a && a.dto ? a.dto : null;
}

function planMaterials(p) {
  p.shaderStandIns = new Map();   // shader name → { rel, guid, props }
  for (const a of p.m.list('materials')) {
    if (ids.isBuiltinPath(a.path)) { p.register(a.id, { kind: 'material', ref: ids.builtinRef(a.path, 'UnityEngine.Material'), builtin: true }); continue; }
    const ap = UnityProject.assetPath(a.path);
    if (!ap) { p.register(a.id, { kind: 'material', ref: ids.NULL_REF, builtin: true }); continue; }   // "Default UI Material" & co: runtime defaults
    if (ids.knownAssetGuid(ap)) { p.register(a.id, { kind: 'material', ref: null, essential: ap }); continue; }
    if (!/\.mat$/i.test(ap)) { p.subMaterials.push(a); continue; }   // material inside another asset (TMP font asset, Spine atlas…)
    const rel = p.claim(ap);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'material', rel, guid, ref: ids.assetRef(2100000, guid, 2) });
  }
}

/** Unity Material YAML body for a Luna material DTO. */
function materialBody(p, d, file) {
  const sh = shaderInfo(p, d.shader);
  const shaderName = sh ? sh.name : 'Standard';
  let shader = ids.shaderRef(shaderName);
  if (!shader) shader = { ref: standInShader(p, shaderName, d, sh), source: 'stand-in' };
  const texEnvs = [], floats = [], colors = [];
  for (const t of d.textureParameters || []) {
    const st = (d.vectorParameters || []).find((v) => v.name === t.name + '_ST');
    const s = st && st.value ? st.value : { x: 1, y: 1, z: 0, w: 0 };
    texEnvs.push({ [t.name]: { m_Texture: t.value ? p.ref(t.value, file) : ids.NULL_REF, m_Scale: flow({ x: s.x, y: s.y }), m_Offset: flow({ x: s.z, y: s.w }) } });
  }
  for (const f of d.floatParameters || []) floats.push({ [f.name]: f.value });
  for (const c of d.colorParameters || []) if (c.value) colors.push({ [c.name]: flow({ r: c.value.r, g: c.value.g, b: c.value.b, a: c.value.a }) });
  for (const v of d.vectorParameters || []) if (v.value && !/_ST$/.test(v.name) && !/_TexelSize$/.test(v.name)) colors.push({ [v.name]: flow({ r: v.value.x, g: v.value.y, b: v.value.z, a: v.value.w }) });
  const keywords = (d.materialFlags || []).filter((f) => f && f.value !== 0 && f.name).map((f) => f.name);
  return {
    body: {
      serializedVersion: 6, ...HEADER(), m_Name: d.name || 'Material', m_Shader: shader.ref, m_ShaderKeywords: keywords.join(' '),
      m_LightmapFlags: 4, m_EnableInstancingVariants: d.enableInstancing ? 1 : 0, m_DoubleSidedGI: 0,
      m_CustomRenderQueue: d.renderQueue != null ? d.renderQueue : -1, stringTagMap: {}, disabledShaderPasses: [],
      m_SavedProperties: { serializedVersion: 3, m_TexEnvs: texEnvs, m_Floats: floats, m_Colors: colors },
      m_BuildTextureStacks: [],
    },
    shader,
  };
}

function writeMaterials(p) {
  for (const a of p.m.list('materials')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    const { body } = materialBody(p, a.dto || {}, null);
    p.writeYamlAsset(info.rel, info.guid, [{ classId: 21, fileId: 2100000, type: 'Material', body }], 2100000);
    p.count('materials');
  }
  for (const [name, s] of p.shaderStandIns) {
    p.out.write(s.rel, standInSource(name, s));
    p.out.meta(s.rel, s.guid, importers.shader());
    p.count('standInShaders');
  }
}

// A shader whose source is not in the build (custom / Asset Store): write an unlit stand-in with the same name and
// property names so materials keep their values and still render; replace it with the original when available.
function standInShader(p, name, d, sh) {
  let s = p.shaderStandIns.get(name);
  if (!s) {
    const rel = p.claim(`Assets/_Recovered/Shaders/${name.replace(/[\\/:*?"<>|]+/g, '_')}.shader`);
    s = { rel, guid: ids.guidOf(rel), props: new Map(), transparent: false, cutout: false };
    p.shaderStandIns.set(name, s);
  }
  for (const t of d.textureParameters || []) s.props.set(t.name, '2D');
  for (const f of d.floatParameters || []) if (!s.props.has(f.name)) s.props.set(f.name, 'Float');
  for (const c of d.colorParameters || []) s.props.set(c.name, 'Color');
  for (const v of d.vectorParameters || []) if (!/_ST$|_TexelSize$/.test(v.name) && !s.props.has(v.name)) s.props.set(v.name, 'Vector');
  if ((d.renderQueue || 0) >= 2900) s.transparent = true;
  else if ((d.renderQueue || 0) >= 2400) s.cutout = true;
  return ids.assetRef(4800000, s.guid, 3);
}

function standInSource(name, s) {
  const props = [...s.props].map(([k, t]) => {
    if (t === '2D') return `        ${k} ("${k}", 2D) = "white" {}`;
    if (t === 'Color') return `        ${k} ("${k}", Color) = (1,1,1,1)`;
    if (t === 'Vector') return `        ${k} ("${k}", Vector) = (0,0,0,0)`;
    return `        ${k} ("${k}", Float) = ${k === '_Cutoff' ? 0.5 : 0}`;
  });
  const mainTex = s.props.get('_MainTex') === '2D' ? '_MainTex' : [...s.props].find(([, t]) => t === '2D')?.[0];
  const color = s.props.get('_Color') === 'Color' ? '_Color' : s.props.get('_TintColor') === 'Color' ? '_TintColor' : null;
  const tags = s.transparent ? '"Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True"' : s.cutout ? '"Queue"="AlphaTest" "RenderType"="TransparentCutout"' : '"RenderType"="Opaque"';
  return `// Stand-in do Build Recover tạo: shader gốc "${name}" không có mã nguồn trong bản build Luna (chỉ có GLSL đã biên dịch).
// Giữ đúng tên và tên thuộc tính để material giữ nguyên giá trị; thay bằng shader gốc nếu còn giữ được.
Shader "${name}"
{
    Properties
    {
${props.join('\n')}
    }
    SubShader
    {
        Tags { ${tags} }
        LOD 100
${s.transparent ? '        Blend SrcAlpha OneMinusSrcAlpha\n        ZWrite Off\n' : ''}        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
${mainTex ? `            sampler2D ${mainTex};\n            float4 ${mainTex}_ST;\n` : ''}${color ? `            fixed4 ${color};\n` : ''}${s.cutout && s.props.has('_Cutoff') ? '            fixed _Cutoff;\n' : ''}
            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; fixed4 color : COLOR; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; fixed4 color : COLOR; };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = ${mainTex ? `TRANSFORM_TEX(v.uv, ${mainTex})` : 'v.uv'};
                o.color = v.color;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                fixed4 c = ${mainTex ? `tex2D(${mainTex}, i.uv)` : 'fixed4(1,1,1,1)'} * i.color${color ? ` * ${color}` : ''};
${s.cutout && s.props.has('_Cutoff') ? '                clip(c.a - _Cutoff);\n' : ''}                return c;
            }
            ENDCG
        }
    }
}
`;
}

// ---------------------------------------------------------------- ScriptableObjects (Spine data, TMP font assets, settings…)
function planScriptables(p) {
  for (const a of p.m.list('scriptable-objects')) {
    const ap = UnityProject.assetPath(a.path);
    if (ap && ids.knownAssetGuid(ap)) { p.register(a.id, { kind: 'scriptable', ref: ids.assetRef(11400000, ids.knownAssetGuid(ap), 2), essential: ap }); continue; }
    // DOTween's settings asset is created by its own setup panel; a copy with a guessed script would clash
    if (/^DG\.Tweening\./.test(a.className || '')) { p.register(a.id, { kind: 'scriptable', ref: ids.NULL_REF, builtin: true }); p.usesDOTween = true; continue; }
    const rel = p.claim(ap || `Assets/_Recovered/Data/${a.name || a.className || a.id}.asset`);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'scriptable', rel, guid, ref: ids.assetRef(11400000, guid, 2) });
  }
  // materials living inside a .asset (TMP font asset material, Spine atlas materials): sub-objects of that file
  for (const mat of p.subMaterials) {
    const owner = [...p.assets.values()].find((x) => x.rel && x.rel === UnityProject.assetPath(mat.path));
    if (owner) {
      const fid = ids.fileIdOf('submat:' + mat.id);
      p.register(mat.id, { kind: 'material', ref: ids.assetRef(fid, owner.guid, 2), sub: { owner, fid } });
      (owner.subs = owner.subs || []).push({ mat, fid });
    } else {
      // e.g. a Spine atlas asset material stored next to the atlas: write it as its own .mat
      const rel = p.claim(`${mat.path.replace(/\.[^./]+$/, '')}_${mat.name || mat.id}.mat`.replace(/^(?!Assets\/)/, 'Assets/_Recovered/Materials/'));
      const guid = ids.guidOf(rel);
      p.register(mat.id, { kind: 'material', rel, guid, ref: ids.assetRef(2100000, guid, 2) });
      p.looseMaterials.push(mat);
    }
  }
}

function writeScriptables(p) {
  for (const mat of p.looseMaterials) {
    const info = p.assets.get(mat.id);
    const { body } = materialBody(p, mat.dto || {}, null);
    p.writeYamlAsset(info.rel, info.guid, [{ classId: 21, fileId: 2100000, type: 'Material', body }], 2100000);
    p.count('materials');
  }
  for (const a of p.m.list('scriptable-objects')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    if (!p.scriptKinds.has(a.className)) p.scriptKinds.set(a.className, 'scriptable');
    p.noteScriptUse(a.className, a.dto);
    const docs = [{
      classId: 114, fileId: 11400000, type: 'MonoBehaviour',
      body: {
        ...HEADER(), m_GameObject: flow({ fileID: 0 }), m_Enabled: 1, m_EditorHideFlags: 0, m_Script: p.scriptRef(a.className),
        m_Name: a.name || (a.dto && a.dto.name) || 'Asset', m_EditorClassIdentifier: '', ...fieldsOf(p, a.dto, null, a.className),
      },
    }];
    for (const s of info.subs || []) docs.push({ classId: 21, fileId: s.fid, type: 'Material', body: materialBody(p, s.mat.dto || {}, null).body });
    p.writeYamlAsset(info.rel, info.guid, docs, 11400000);
    p.count('scriptableObjects');
  }
}

/** Serialized fields of a MonoBehaviour/ScriptableObject DTO (everything but the Luna bookkeeping). */
function fieldsOf(p, dto, file, typeName) {
  const o = {};
  if (!dto) return o;
  for (const k of Object.keys(dto)) {
    if (k[0] === '$' || k === 'enabled' || k === 'name' && typeName && !/^m_/.test(k)) continue;
    const v = p.value(dto[k], file, dto.$type || typeName, k);
    if (v !== undefined) o[k] = v;
  }
  return o;
}

module.exports = {
  planAudio, writeAudio, planText, writeText, planFonts, planPhysics, writePhysics, planMaterials, writeMaterials,
  planScriptables, writeScriptables, materialBody, fieldsOf,
};
