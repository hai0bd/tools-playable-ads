'use strict';
// Meshes → Unity Mesh assets (.asset YAML with the vertex/index buffers as hex), exact data including skin weights,
// bind poses and blend shapes. Luna stores Unity's own (left-handed) mesh data, so nothing is flipped.
const { flow } = require('./yaml');
const ids = require('./ids');
const { UnityProject, HEADER } = require('./project');

// Luna's vertex stream order, read from the runtime when possible (it has changed between Luna versions)
const DEFAULT_STREAMS = [['POSITION', 3], ['NORMAL', 3], ['TANGENT', 4], ['BLENDWEIGHT', 4], ['BLENDINDICES', 4], ['COLOR', 4], ['TEXCOORD0', 2], ['TEXCOORD1', 2], ['TEXCOORD2', 2], ['TEXCOORD3', 2]];
function streamOrder(code) {
  const arrays = code.match(/\[\s*\{\s*semantic\s*:\s*[\w.$]*SEMANTIC_POSITION\s*,\s*components\s*:\s*3[^\]]*\]/g) || [];
  for (const a of arrays) {
    if (!/SEMANTIC_BLENDWEIGHT/.test(a) || !/SEMANTIC_TANGENT/.test(a)) continue;
    const list = [], re = /SEMANTIC_(\w+)\s*,\s*components\s*:\s*(\d+)/g;
    let m;
    while ((m = re.exec(a))) list.push([m[1], +m[2]]);
    if (list.length >= 6) return list;
  }
  return DEFAULT_STREAMS;
}

let HALF = null;
function halfToFloat(h) {
  if (!HALF) {
    HALF = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 31, f = i & 1023;
      HALF[i] = e === 0 ? s * f * Math.pow(2, -24) : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * Math.pow(2, e - 15);
    }
  }
  return HALF[h];
}
function floats(blob, offset, length, half) {
  const dv = new DataView(blob.buffer, blob.byteOffset + offset, length);
  const n = half ? length >> 1 : length >> 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = half ? halfToFloat(dv.getUint16(i * 2, true)) : dv.getFloat32(i * 4, true);
  return out;
}

// Unity channel slots (VertexAttribute order) and the Luna semantic feeding each
const UNITY_CHANNELS = ['POSITION', 'NORMAL', 'TANGENT', 'COLOR', 'TEXCOORD0', 'TEXCOORD1', 'TEXCOORD2', 'TEXCOORD3', 'TEXCOORD4', 'TEXCOORD5', 'TEXCOORD6', 'TEXCOORD7', 'BLENDWEIGHT', 'BLENDINDICES'];

const hex = (buf) => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('hex');

function planMeshes(p) {
  p.meshStreams = streamOrder(p.m.x.code);
  const byFile = new Map();
  for (const a of p.m.list('meshes')) {
    if (ids.isBuiltinPath(a.path)) { p.register(a.id, { kind: 'mesh', ref: ids.builtinRef(a.path, 'UnityEngine.Mesh'), builtin: true }); continue; }
    const ap = UnityProject.assetPath(a.path);
    // meshes came out of model files (.fbx/.obj/.blend): one folder per model, one .asset per mesh
    const dir = ap ? ap.replace(/\.[^./]+$/, '') : 'Assets/_Recovered/Meshes';
    const name = (a.dto && a.dto.name) || a.name || 'Mesh_' + a.id;
    const rel = p.claim(`${dir}/${name.replace(/[\\/]/g, '_')}.asset`);
    const guid = ids.guidOf(rel);
    p.register(a.id, { kind: 'mesh', rel, guid, ref: ids.assetRef(4300000, guid, 2) });
    if (!byFile.has(dir)) byFile.set(dir, 0);
  }
}

function meshBody(p, a) {
  const d = a.dto, blob = p.m.blob(a.bundle);
  if (!d || !blob) throw new Error('thiếu data.blob');
  const half = !!d.halfPrecision, vc = d.vertexCount || 0;
  const layout = {}, sizes = {};
  let stride = 0;
  p.meshStreams.forEach(([sem, n], i) => { sizes[sem] = n; layout[sem] = d.streams && d.streams[i] ? stride : -1; if (d.streams && d.streams[i]) stride += n; });
  const v = d.vertices || [0, 0];
  const src = floats(blob, v[0], v[1], half);
  if (src.length < vc * stride) throw new Error(`buffer đỉnh ngắn hơn ${vc}×${stride}`);

  // stream 0: everything but skinning, float32; stream 1: blend weights (float32×4) + indices (uint32×4)
  const used = UNITY_CHANNELS.filter((s) => layout[s] != null && layout[s] >= 0);
  const main = used.filter((s) => s !== 'BLENDWEIGHT' && s !== 'BLENDINDICES');
  const skinned = layout.BLENDWEIGHT >= 0 && layout.BLENDINDICES >= 0;
  const channels = [];
  let off0 = 0;
  const pos0 = {};
  for (const s of UNITY_CHANNELS) {
    if (main.includes(s)) { pos0[s] = off0; channels.push({ stream: 0, offset: off0, format: 0, dimension: sizes[s] }); off0 += sizes[s] * 4; }
    else if (skinned && s === 'BLENDWEIGHT') channels.push({ stream: 1, offset: 0, format: 0, dimension: 4 });
    else if (skinned && s === 'BLENDINDICES') channels.push({ stream: 1, offset: 16, format: 10, dimension: 4 });
    else channels.push({ stream: 0, offset: 0, format: 0, dimension: 0 });
  }
  const stride0 = off0, stride1 = skinned ? 32 : 0;
  const size0 = stride0 * vc, start1 = skinned ? Math.ceil(size0 / 16) * 16 : size0;
  const data = Buffer.alloc(start1 + stride1 * vc);
  for (let i = 0; i < vc; i++) {
    const b = i * stride;
    for (const s of main) {
      for (let c = 0; c < sizes[s]; c++) data.writeFloatLE(src[b + layout[s] + c], i * stride0 + pos0[s] + c * 4);
    }
    if (skinned) {
      for (let c = 0; c < 4; c++) {
        data.writeFloatLE(src[b + layout.BLENDWEIGHT + c], start1 + i * 32 + c * 4);
        data.writeUInt32LE(Math.max(0, Math.round(src[b + layout.BLENDINDICES + c])) >>> 0, start1 + i * 32 + 16 + c * 4);
      }
    }
  }

  // index buffer: submeshes concatenated
  const wide = !!d.useUInt32IndexFormat, isz = wide ? 4 : 2;
  const parts = [], subMeshes = [];
  let firstByte = 0;
  const aabbOf = (list) => {
    if (!list.length || layout.POSITION < 0) return { m_Center: flow({ x: 0, y: 0, z: 0 }), m_Extent: flow({ x: 0, y: 0, z: 0 }) };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const ix of list) for (let c = 0; c < 3; c++) { const x = src[ix * stride + layout.POSITION + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
    return { m_Center: flow({ x: (mn[0] + mx[0]) / 2, y: (mn[1] + mx[1]) / 2, z: (mn[2] + mx[2]) / 2 }), m_Extent: flow({ x: (mx[0] - mn[0]) / 2, y: (mx[1] - mn[1]) / 2, z: (mx[2] - mn[2]) / 2 }) };
  };
  for (const sm of d.subMeshes || []) {
    const t = sm.triangles || [0, 0];
    const raw = Buffer.from(blob.buffer, blob.byteOffset + t[0], t[1]);
    parts.push(raw);
    const count = Math.floor(t[1] / isz), list = [];
    let lo = Infinity, hi = -1;
    for (let k = 0; k < count; k++) { const ix = wide ? raw.readUInt32LE(k * 4) : raw.readUInt16LE(k * 2); list.push(ix); if (ix < lo) lo = ix; if (ix > hi) hi = ix; }
    subMeshes.push({
      serializedVersion: 2, firstByte, indexCount: count, topology: 0, baseVertex: 0,
      firstVertex: hi < 0 ? 0 : lo, vertexCount: hi < 0 ? 0 : hi - lo + 1, localAABB: aabbOf(list),
    });
    firstByte += raw.length;
  }
  const index = Buffer.concat(parts);
  const aabb = d.aabb || [0, 0, 0, 0, 0, 0];
  const bind = (d.bindposes || []).map((mt) => { const o = {}; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[`e${r}${c}`] = mt.data[c * 4 + r]; return o; });

  // blend shapes
  const shapes = { vertices: [], shapes: [], channels: [], fullWeights: [] };
  for (const bs of d.blendShapes || []) {
    const frames = bs.frames || [];
    const firstShape = shapes.shapes.length;
    for (const fr of frames) {
      const dp = fr.deltaPositions || fr.vertices;
      if (!Array.isArray(dp) && !(dp && dp.length)) continue;
      const pos = Array.isArray(dp) && dp.length === 2 && typeof dp[0] === 'number' ? floats(blob, dp[0], dp[1], half) : Float32Array.from(dp || []);
      const firstVertex = shapes.vertices.length;
      for (let i = 0; i < vc; i++) {
        const x = pos[i * 3] || 0, y = pos[i * 3 + 1] || 0, z = pos[i * 3 + 2] || 0;
        if (!x && !y && !z) continue;
        shapes.vertices.push({ vertex: flow({ x, y, z }), normal: flow({ x: 0, y: 0, z: 0 }), tangent: flow({ x: 0, y: 0, z: 0 }), index: i });
      }
      shapes.shapes.push({ firstVertex, vertexCount: shapes.vertices.length - firstVertex, hasNormals: 0, hasTangents: 0 });
      shapes.fullWeights.push(fr.weight != null ? fr.weight : 100);
    }
    if (shapes.shapes.length > firstShape) {
      shapes.channels.push({ name: bs.name, nameHash: crc32(bs.name || ''), frameIndex: firstShape, frameCount: shapes.shapes.length - firstShape });
    }
  }

  return {
    ...HEADER(), m_Name: d.name || a.name, serializedVersion: 10,
    m_SubMeshes: subMeshes, m_Shapes: shapes, m_BindPose: bind, m_BoneNameHashes: '', m_RootBoneNameHash: 0, m_BonesAABB: [],
    m_VariableBoneCountWeights: { m_Data: '' },
    m_MeshCompression: 0, m_IsReadable: 1, m_KeepVertices: 1, m_KeepIndices: 1, m_IndexFormat: wide ? 1 : 0,
    m_IndexBuffer: index.toString('hex'),
    m_VertexData: { serializedVersion: 3, m_VertexCount: vc, m_Channels: channels, m_DataSize: data.length, _typelessdata: data.toString('hex') },
    m_CompressedMesh: {
      m_Vertices: pv(), m_UV: pv(), m_Normals: pv(), m_Tangents: pv(), m_Weights: pi(), m_NormalSigns: pi(), m_TangentSigns: pi(),
      m_FloatColors: pv(), m_BoneIndices: pi(), m_Triangles: pi(), m_UVInfo: 0,
    },
    m_LocalAABB: { m_Center: flow({ x: aabb[0], y: aabb[1], z: aabb[2] }), m_Extent: flow({ x: aabb[3], y: aabb[4], z: aabb[5] }) },
    m_MeshUsageFlags: 0, m_BakedConvexCollisionMesh: '', m_BakedTriangleCollisionMesh: '',
    'm_MeshMetrics[0]': 1, 'm_MeshMetrics[1]': 1, m_MeshOptimized: 0,
    m_StreamData: { serializedVersion: 2, offset: 0, size: 0, path: '' },
  };
}
const pv = () => ({ m_NumItems: 0, m_Range: 0, m_Start: 0, m_Data: '', m_BitSize: 0 });
const pi = () => ({ m_NumItems: 0, m_Data: '', m_BitSize: 0 });

let CRC = null;
function crc32(s) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = ~0;
  for (const b of Buffer.from(s, 'utf8')) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function writeMeshes(p) {
  for (const a of p.m.list('meshes')) {
    const info = p.assets.get(a.id);
    if (!info || !info.rel) continue;
    let body;
    try { body = meshBody(p, a); } catch (e) { p.report.warn(`Mesh ${a.path} (${a.name}): ${e.message}`); continue; }
    p.writeYamlAsset(info.rel, info.guid, [{ classId: 43, fileId: 4300000, type: 'Mesh', body }], 4300000);
    p.count('meshes');
  }
}

module.exports = { planMeshes, writeMeshes, halfToFloat, floats, crc32 };
