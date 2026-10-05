/*
 * Test luna-core trên một playable Luna tổng hợp (không cần file thật):
 *   payload nén Brotli (base122 chuẩn + base64), sound nhúng 2 lần, code game mang schema DTO,
 *   bundle.json có mesh (half-float 2 submesh, float32 có skin), texture, sound; ảnh data-src122/data-b122.
 * Chạy: node tests/luna-core.test.js
 */
"use strict";
var assert = require("assert");
var Conv = require("../converter-core");
var B = require("../brotli-core");
var L = require("../luna-core");

var passed = 0;
function ok(name, fn) {
    try { fn(); passed++; console.log("  ✓ " + name); }
    catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}
function same(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }
function utf8(s) { return new Uint8Array(Buffer.from(s, "utf8")); }
function text(bytes) { return Buffer.from(bytes).toString("utf8"); }

// ───────── fixture ─────────
// Runtime Luna bản 2026: có useSimplification chen ở vị trí 2 → mọi field sau lệch so với bản cũ.
var FIELDS_2026 = "{name:0,halfPrecision:1,useSimplification:2,useUInt32IndexFormat:3,vertexCount:4,aabb:5,streams:6,vertices:7,subMeshes:8,bindposes:9,blendShapes:10}";
var FIELDS_2023 = "{name:0,halfPrecision:1,vertexCount:2,aabb:3,streams:4,vertices:5,subMeshes:6,bindposes:7,blendShapes:8}";
var STREAM_ARRAY = "p=[" + [["POSITION", 3], ["NORMAL", 3], ["TANGENT", 4], ["BLENDWEIGHT", 4], ["BLENDINDICES", 4], ["COLOR", 4], ["TEXCOORD0", 2], ["TEXCOORD1", 2], ["TEXCOORD2", 2], ["TEXCOORD3", 2]]
    .map(function (s) { return "{semantic:r.d.SEMANTIC_" + s[0] + ",components:" + s[1] + ",type:r.d.TYPE_FLOAT32}"; }).join(",") + "]";
function runtimeCode(fields) {
    return 'var Deserializers={fields:{"Luna.Unity.DTO.UnityEngine.Assets.Mesh":' + fields + ',"Luna.Unity.DTO.UnityEngine.Assets.Mesh+SubMesh":{triangles:0}}};var ' + STREAM_ARRAY + ";console.log('game');";
}

function halfBytes(values) {
    var out = new Uint8Array(values.length * 2), dv = new DataView(out.buffer);
    values.forEach(function (v, i) { dv.setUint16(i * 2, L.floatToHalf(v), true); });
    return out;
}
function floatBytes(values) { return new Uint8Array(new Float32Array(values).buffer); }
function u16Bytes(values) { return new Uint8Array(new Uint16Array(values).buffer); }
function cat(list) {
    var n = list.reduce(function (s, b) { return s + b.length; }, 0), out = new Uint8Array(n), at = 0;
    list.forEach(function (b) { out.set(b, at); at += b.length; });
    return out;
}

// Mesh A (hệ Unity): quad 4 đỉnh, POSITION+NORMAL+UV0, half-float, 2 submesh (mỗi submesh 1 tam giác).
var QUAD_POS = [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]];
var QUAD_UV = [[0, 0], [0, 1], [1, 1], [1, 0]];
var quadVerts = [];
QUAD_POS.forEach(function (p, i) { quadVerts.push(p[0], p[1], p[2], 0, 0, -1, QUAD_UV[i][0], QUAD_UV[i][1]); });
// Mesh B: tam giác 3 đỉnh có skin, float32; mỗi đỉnh gắn 1 xương khác nhau.
var TRI_POS = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
var triVerts = [];
TRI_POS.forEach(function (p, i) {
    triVerts.push(p[0], p[1], p[2], 0, 0, -1, 1, 0, 0, 1, /*weight*/ 1, 0, 0, 0, /*index*/ i, 0, 0, 0, /*uv*/ 0, 0);
});

function buildFixture(opts) {
    opts = opts || {};
    var old = opts.schema === 2023;
    var aV = halfBytes(quadVerts), aI0 = u16Bytes([0, 1, 2]), aI1 = u16Bytes([0, 2, 3]);
    var bV = floatBytes(triVerts), bI = u16Bytes([0, 1, 2]);
    var blob = cat([aV, aI0, aI1, bV, bI]);
    var off = 0;
    var oA = off; off += aV.length; var oA0 = off; off += aI0.length; var oA1 = off; off += aI1.length;
    var oB = off; off += bV.length; var oBI = off;
    function meshData(name, half, vc, aabb, streams, verts, subs, bindposes) {
        return old
            ? [name, half, vc, aabb, streams, verts, subs, bindposes, []]
            : [name, half, 0, 0, vc, aabb, streams, verts, subs, bindposes, []];
    }
    var bundle = {
        meshes: [
            { id: 100, path: "Assets/Models/Quad.fbx", assetBundleId: -1, data: meshData("Quad", true, 4, [0.5, 0.5, 0, 0.5, 0.5, 0], [1, 1, 0, 0, 0, 0, 1, 0, 0, 0], [oA, aV.length], [[[oA0, 6]], [[oA1, 6]]], []) },
            { id: 101, path: "Assets/Models/Char.fbx", assetBundleId: -1, data: meshData("Body", false, 3, [1, 1, 0, 1, 1, 0], [1, 1, 1, 1, 1, 0, 1, 0, 0, 0], [oB, bV.length], [[[oBI, 6]]], new Array(48).fill(0)) }
        ],
        textures: [{ id: 42, type: 0, path: "Assets/UI/Hand_icon.png", assetBundleId: -1, data: ["Hand_icon", 2, 2] }, { id: 43, type: 0, assetBundleId: -1, data: [null, 4, 4] }],
        sounds: [{ id: 7, path: "Assets/SFX/Dig_01.mp3", assetBundleId: -1, data: ["Dig_01"] }]
    };
    var sound = new Uint8Array(4000).map(function (_, i) { return (i * 37) & 255; });
    var png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 60, 47, 62, 38, 34]);
    var jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 60, 60, 47]);
    function call(fn, bytes, base122, then) {
        var comp = B.compress(bytes);
        return "window._compressedAssets.push( " + fn + '( "' + L.encodePayload(comp, base122) + '", ' + base122 + " ).then( " + then + " ) );";
    }
    var b122 = opts.base64 ? false : true;
    var html = "<!doctype html><html><body>" +
        '<img id="assets/bundles/-1/42.png" data-src122="' + Conv.encodeBase122Bytes(png, { standard: true }).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '" data-mime="image/png" style="display:none">' +
        '<img id="assets/bundles/-1/43.jpeg" data-b122="' + Conv.encodeBase122Bytes(jpg, { standard: true }).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '" data-b122m="image/jpeg" style="display:none">' +
        '<script>window.LunaCompilerV = "3.1";</script>' +
        "<script>window.jsons = window.jsons || {}; window._compressedAssets = window._compressedAssets || [];" +
        call("decompressString", utf8(JSON.stringify(bundle)), b122, 'function( json ) { window.jsons[ "assets/bundles/-1/bundle.json" ] = JSON.parse( json ); }') + "</script>" +
        "<script>window.blobs = window.blobs || {};" +
        call("decompressArrayBuffer", blob, b122, 'function( buffer ) { window.blobs[ "assets/bundles/-1/data.blob" ] = buffer; }') + "</script>" +
        "<script>window.sounds = window.sounds || {};" +
        call("decompressArrayBuffer", sound, b122, 'function( buffer ) { window.sounds[ "assets/bundles/-1/7.mp3" ] = buffer; }') +
        call("decompressArrayBuffer", sound, b122, 'function( buffer ) { window.sounds[ "assets/bundles/-1/7.mp3" ] = buffer; }') + "</script>" +
        "<script>" + call("decompressString", utf8(runtimeCode(old ? FIELDS_2023 : FIELDS_2026)), false, "function( code ) { window.eval( code ); }") + "</script>" +
        "</body></html>";
    return { html: html, blob: blob, bundle: bundle, sound: sound, png: png, jpg: jpg };
}

console.log("luna-core tests:");

[{ label: "base122" }, { label: "base64", base64: true }].forEach(function (variant) {
    var fx = buildFixture(variant);

    ok(variant.label + ": nhận diện Luna và quét đủ payload nén", function () {
        assert.ok(L.isLuna(fx.html));
        var entries = L.scanPayloads(fx.html);
        var byStore = {};
        entries.forEach(function (e) { byStore[e.store] = (byStore[e.store] || 0) + 1; });
        assert.deepStrictEqual(byStore, { jsons: 1, blobs: 1, sounds: 2, code: 1 });
        assert.strictEqual(entries.filter(function (e) { return e.base122; }).length, variant.base64 ? 0 : 4);
        assert.ok(same(L.readPayload(fx.html, entries.filter(function (e) { return e.store === "blobs"; })[0]), fx.blob));
    });

    ok(variant.label + ": sound có tên thật, thay 1 lần ghi cả 2 bản nhúng", function () {
        var list = L.assets(fx.html);
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].label, "Dig_01.mp3 — Assets/SFX/Dig_01.mp3");
        assert.strictEqual(list[0].count, 2);
        assert.strictEqual(list[0].kind, "audio");
        assert.ok(same(L.readAsset(fx.html, list[0].key), fx.sound));
        var fresh = new Uint8Array(3000).fill(9);
        var html = L.writePayload(fx.html, list[0].key, fresh);
        var sounds = L.scanPayloads(html).filter(function (e) { return e.store === "sounds"; });
        assert.strictEqual(sounds.length, 2);
        sounds.forEach(function (e) { assert.ok(same(L.readPayload(html, e), fresh)); });
        // payload khác giữ nguyên từng ký tự
        var before = L.scanPayloads(fx.html).filter(function (e) { return e.store === "blobs"; })[0];
        var after = L.scanPayloads(html).filter(function (e) { return e.store === "blobs"; })[0];
        assert.strictEqual(html.slice(after.start, after.end), fx.html.slice(before.start, before.end));
    });
});

var fx = buildFixture();

ok("scripts: code game + bundle.json, sửa JSON rồi nén lại", function () {
    var list = L.scripts(fx.html);
    var code = list.filter(function (s) { return s.kind === "game"; })[0];
    var json = list.filter(function (s) { return s.key === "assets/bundles/-1/bundle.json"; })[0];
    assert.ok(code && /Deserializers/.test(code.text));
    assert.ok(json && json.kind === "data");
    var html = L.replaceText(fx.html, json.key, json.text.replace('["Hand_icon"', '["Hand_edited"'));
    var again = L.scripts(html).filter(function (s) { return s.key === json.key; })[0];
    assert.strictEqual(JSON.parse(again.text).textures[0].data[0], "Hand_edited");
});

ok("ảnh: data-src122 gắn tên từ bundle.json, data-b122 được converter nhận và giải đúng", function () {
    var items = Conv.extractEmbeddedData(fx.html).filter(function (i) { return i.source === "luna-img"; });
    assert.strictEqual(items.length, 2);
    var labels = L.imageLabels(fx.html);
    var png = items.filter(function (i) { return i.context === "assets/bundles/-1/42.png"; })[0];
    var jpg = items.filter(function (i) { return i.context === "assets/bundles/-1/43.jpeg"; })[0];
    assert.strictEqual(labels[png.start], "Hand_icon.png — Assets/UI/Hand_icon.png");
    assert.ok(/texture sinh khi build/.test(labels[jpg.start]), "texture không tên phải được ghi chú");
    assert.strictEqual(jpg.mediaType, "image/jpeg");
    assert.ok(same(Conv.decodeBase122Bytes(jpg.payload), fx.jpg));
    assert.ok(same(Conv.decodeBase122Bytes(png.payload), fx.png));
});

ok("mesh: đọc schema từ runtime (bản 2026 có useSimplification) và giải về hệ model", function () {
    var a = L.analyzeMeshes(fx.html);
    assert.strictEqual(a.schema.source, "runtime");
    assert.strictEqual(a.schema.fields.vertexCount, 4);
    assert.strictEqual(a.meshes.length, 2);
    var quad = a.meshes[0], body = a.meshes[1];
    assert.strictEqual(quad.verts, 4);
    assert.strictEqual(quad.submeshes, 2);
    assert.strictEqual(quad.label, "Quad · Quad.fbx");
    // hệ model: x đảo dấu, v lật, chiều tam giác đảo
    assert.deepStrictEqual(quad.geometry.bundles[0].pos[2], [-1, 1, 0]);
    assert.deepStrictEqual(quad.geometry.bundles[0].uv[1], [0, 0]);
    assert.deepStrictEqual(quad.geometry.prims[0].idx, [0, 2, 1]);
    assert.ok(body.skinned && !quad.skinned);
});

ok("mesh: schema bản 2023 (không có useUInt32IndexFormat) cũng đọc đúng", function () {
    var a = L.analyzeMeshes(buildFixture({ schema: 2023 }).html);
    assert.strictEqual(a.schema.fields.vertexCount, 2);
    assert.strictEqual(a.meshes.length, 2);
    assert.strictEqual(a.meshes[1].verts, 3);
    assert.strictEqual(a.meshes[1].tris, 1);
});

ok("thay mesh: nối vào cuối blob, giữ số submesh, ghi về hệ Unity", function () {
    var a = L.analyzeMeshes(fx.html);
    var model = {
        pos: [[0, 0, 0], [3, 0, 0], [3, 2, 0], [0, 2, 0], [1, 1, 1]],
        nrm: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]], // toàn (0,0,1) = model không có normal → tự tính
        uv: [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]],
        idx: [0, 1, 2, 0, 2, 3, 0, 1, 4], parts: []
    };
    var mesh = L.applyMeshReplacement(a, 0, model);
    assert.strictEqual(mesh.submeshes, 2, "phải giữ 2 submesh cho 2 material");
    assert.strictEqual(mesh.replaceMode, "1→2");
    assert.strictEqual(mesh.verts, 5);

    var again = L.analyzeMeshes(a.html);
    var q = again.meshes[0];
    assert.strictEqual(q.verts, 5);
    assert.deepStrictEqual(q.geometry.bundles[0].pos[2], [3, 2, 0], "đọc lại về hệ model phải ra đúng vị trí (half-float đủ chính xác)");
    assert.deepStrictEqual(q.geometry.prims[0].idx, model.idx, "đọc lại phải ra đúng chỉ số & chiều tam giác của model");
    assert.deepStrictEqual(q.geometry.prims[1].idx, [0, 0, 0], "submesh thừa là tam giác suy biến");

    // dữ liệu thô trong blob (hệ Unity): x = -x của model, v = 1 - v
    var raw = q.luna.raw, st = raw.layout.stride;
    assert.strictEqual(raw.floats[2 * st + raw.layout.offsets.POSITION], -3);
    assert.strictEqual(raw.floats[1 * st + raw.layout.offsets.TEXCOORD0 + 1], 1);
    // normal tự tính: đỉnh 3 chỉ thuộc mặt z=0 (CCW trong hệ model) → +z; đổi hệ chỉ lật x → (0,0,1)
    assert.deepStrictEqual(Array.prototype.slice.call(raw.floats, 3 * st + raw.layout.offsets.NORMAL, 3 * st + raw.layout.offsets.NORMAL + 3), [0, 0, 1]);

    // blob: phần gốc giữ nguyên từng byte, dữ liệu mới nằm sau
    var blobEntry = L.scanPayloads(a.html).filter(function (e) { return e.store === "blobs"; })[0];
    var newBlob = L.readPayload(a.html, blobEntry);
    assert.ok(same(newBlob.subarray(0, fx.blob.length), fx.blob));
    assert.ok(again.jsons["assets/bundles/-1/bundle.json"].meshes[0].data[7][0] >= fx.blob.length);
    // mesh còn lại không đổi
    assert.strictEqual(again.meshes[1].verts, 3);
});

ok("thay mesh có skin: mỗi đỉnh mới lấy trọng số xương của đỉnh cũ gần nhất", function () {
    var a = L.analyzeMeshes(fx.html);
    // model (hệ model = x đảo dấu): đặt đỉnh gần lần lượt đỉnh cũ 2, 0, 1
    var model = { pos: [[0, 1.9, 0], [0.1, 0, 0], [-1.9, 0.1, 0]], nrm: [], uv: [[0, 0], [1, 0], [0, 1]], idx: [0, 1, 2], parts: [] };
    var mesh = L.applyMeshReplacement(a, 1, model);
    assert.ok(mesh.notes.some(function (n) { return /skin/.test(n); }));
    var raw = L.analyzeMeshes(a.html).meshes[1].luna.raw, st = raw.layout.stride, oi = raw.layout.offsets.BLENDINDICES, ow = raw.layout.offsets.BLENDWEIGHT;
    assert.deepStrictEqual([0, 1, 2].map(function (v) { return raw.floats[v * st + oi]; }), [2, 0, 1]);
    assert.deepStrictEqual([0, 1, 2].map(function (v) { return raw.floats[v * st + ow]; }), [1, 1, 1]);
    // tangent được tính (có w = ±1)
    var w = raw.floats[0 * st + raw.layout.offsets.TANGENT + 3];
    assert.ok(w === 1 || w === -1);
});

ok("encodePayload: base122 không để lọt '</' đóng thẻ <script>, đọc lại vẫn đúng byte", function () {
    // Math.imul: nhân thường vượt 2^53 làm LCG rơi vào chu kỳ ngắn → dữ liệu nén được, không còn "ngẫu nhiên".
    var r = 12345, big = new Uint8Array(400000).map(function () { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r >>> 24; });
    var comp = B.compress(big);
    var enc = L.encodePayload(comp, true);
    assert.ok(enc.indexOf("</") < 0 && enc.indexOf("<!--") < 0);
    assert.ok(enc.indexOf("<\\/") >= 0, "dữ liệu ngẫu nhiên đủ lớn phải có chỗ cần escape");
    var html = '<script>window._compressedAssets.push( decompressArrayBuffer( "' + enc + '", true ).then( function( buffer ) { window.blobs[ "x" ] = buffer; } ) );</script>';
    assert.ok(same(L.readPayload(html, L.scanPayloads(html)[0]), big));
});

ok("half-float: đổi qua lại đúng các giá trị biên", function () {
    [0, 1, -2.5, 0.5, 65504, -65504, 6.103515625e-5, 5.960464477539063e-8].forEach(function (v) {
        assert.strictEqual(L.halfToFloat(L.floatToHalf(v)), v);
    });
    assert.ok(Math.abs(L.halfToFloat(L.floatToHalf(0.1)) - 0.1) < 1e-4);
    assert.strictEqual(L.halfToFloat(L.floatToHalf(1e6)), Infinity);
});

ok("file không phải Luna: không có asset / script / mesh", function () {
    var html = "<html><body><script>var cc = {};</script></body></html>";
    assert.deepStrictEqual(L.assets(html), []);
    assert.deepStrictEqual(L.scripts(html), []);
    assert.strictEqual(L.analyzeMeshes(html), null);
});

console.log(passed + " test passed.");
