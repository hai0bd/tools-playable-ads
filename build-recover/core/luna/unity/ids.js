'use strict';
// GUIDs, fileIDs and the Unity builtin assets Luna references by name.
const crypto = require('crypto');
const { flow } = require('./yaml');
const KNOWN = require('./known-guids.json');

/** Stable 32-hex GUID for a generated asset (same build → same GUIDs, so re-running keeps references). */
const guidOf = (seed) => crypto.createHash('md5').update('luna-unity:' + seed).digest('hex');

/** Stable non-zero fileID for objects we synthesize: a positive 62-bit BigInt (Unity reads fileIDs as int64;
 *  a JS number would lose digits, and a string would be written quoted). */
function fileIdOf(seed) {
  const h = crypto.createHash('md5').update('luna-fid:' + seed).digest();
  return (BigInt(h.readUInt32LE(0)) | (BigInt(h.readUInt32LE(4) & 0x3fffffff) << 32n)) || 1n;
}

const NULL_REF = flow({ fileID: 0 });
const localRef = (fileID) => flow({ fileID });
const assetRef = (fileID, guid, type) => flow({ fileID, guid, type });

// main object fileID of each generated asset kind, and the "type" field of references to it
// (2 = serialized YAML asset, 3 = imported asset)
const MAIN = {
  texture: [2800000, 3], sprite: [21300000, 3], audio: [8300000, 3], text: [4900000, 3], font: [12800000, 3],
  material: [2100000, 2], mesh: [4300000, 2], clip: [7400000, 2], controller: [9100000, 2], scriptable: [11400000, 2],
  physics2d: [6200000, 2], physics3d: [13400000, 2], shader: [4800000, 3], script: [11500000, 3], prefab: [null, 3],
};

// ---------------------------------------------------------------- Unity builtins
// fileIDs dumped from Unity 2022.3 itself (scripts/unity-builtins/DumpBuiltins.cs) — stable across versions
const EXTRA = '0000000000000000f000000000000000';     // Resources/unity_builtin_extra
const DEFAULT = '0000000000000000e000000000000000';   // Library/unity default resources
const B = KNOWN.builtin;
const ALIAS = { Arial: 'LegacyRuntime' };   // 2022+ renamed the builtin font, same fileID
const builtinOf = (table, name) => {
  name = String(name).replace(/\.(fbx|mat|psd|ttf|png)$/i, '');
  const hit = table[name] || table[ALIAS[name]];
  return hit ? assetRef(hit[0], hit[1] === 'e' ? DEFAULT : EXTRA, 0) : null;
};
const BUILTIN_BY_TYPE = {
  'UnityEngine.Material': B.materials, 'UnityEngine.Mesh': B.meshes, 'UnityEngine.Sprite': B.sprites,
  'UnityEngine.Font': B.fonts, 'UnityEngine.Texture2D': B.textures, 'UnityEngine.Shader': B.shaders,
};

/** "Resources/unity_builtin_extra\Sprites-Default" | "Library/unity default resources\Cube" → Unity ref, or null */
function builtinRef(lunaPath, typeName) {
  const p = String(lunaPath || '');
  if (!isBuiltinPath(p)) return null;
  const name = p.split(/[\\/]/).pop();
  if (typeName && BUILTIN_BY_TYPE[typeName]) return builtinOf(BUILTIN_BY_TYPE[typeName], name);
  for (const t of [B.materials, B.meshes, B.sprites, B.fonts, B.textures]) { const r = builtinOf(t, name); if (r) return r; }
  return null;
}
const isBuiltinPath = (p) => /unity_builtin_extra|unity default resources/i.test(String(p || ''));

/** Shader by name: Unity builtin, known package shader (TMP, Spine, URP…), or null (→ placeholder). */
function shaderRef(name) {
  const b = builtinOf(B.shaders, name);
  if (b) return { ref: b, source: 'builtin' };
  const g = KNOWN.shaders[name];
  if (g) return { ref: assetRef(4800000, g, 3), source: 'package' };
  return null;
}
const fontFallback = () => builtinOf(B.fonts, 'LegacyRuntime');

/** GUID of a package script (UGUI, TMP, Spine…) by full class name. */
const packageScriptGuid = (fullName) => KNOWN.scripts[fullName] || null;
/** m_Script target of a package class: a .cs file (fileID 11500000) or a class inside a plugin DLL (DOTween…),
 *  which Unity addresses as {DLL guid, fileID hashed from the class name}. */
function packageScript(fullName) {
  if (KNOWN.scripts[fullName]) return { guid: KNOWN.scripts[fullName], fileID: 11500000 };
  const d = KNOWN.dllScripts && KNOWN.dllScripts[fullName];
  return d ? { guid: d[0], fileID: d[1] } : null;
}
/** Asset Store package ("DOTween Pro"…) a script GUID belongs to — what the user has to import by hand. */
const packageLabel = (guid) => (KNOWN.packages && KNOWN.packages[guid]) || null;
/** GUID of a TextMesh Pro Essential Resources asset, by path under Assets/. */
const knownAssetGuid = (rel) => KNOWN.assets[String(rel).replace(/^Assets\//, '')] || null;

module.exports = {
  guidOf, fileIdOf, NULL_REF, localRef, assetRef, MAIN, builtinRef, isBuiltinPath, shaderRef, packageScriptGuid, packageScript, packageLabel, knownAssetGuid,
  EXTRA, DEFAULT, fontFallback,
};
