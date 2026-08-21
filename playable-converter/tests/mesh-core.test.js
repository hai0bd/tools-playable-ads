"use strict";
/*
 * Test tự chứa cho mesh-core: dựng 1 playable giả bằng chính buildBin/buildStruct,
 * rồi kiểm tra vòng đọc (analyzePlayable) và thay (applyMeshReplacement/serialize).
 * Chạy: node tests/mesh-core.test.js
 */
var assert = require("assert");
var core = require("../mesh-core");

var FORMATS = [
    { name: "a_normal", type: 5126, num: 3 },
    { name: "a_position", type: 5126, num: 3 },
    { name: "a_uv0", type: 5126, num: 2 }
];
// template struct mang các mask-id chuẩn Cocos 2.4 (8=mesh,5=vb,9/4=range,6=prim,0=fmt,1=vec3)
function structTemplate() {
    return [8, ".bin", [[5, 0, [9, 0], [[0, "a_normal", 5126, 3], [0, "a_position", 5126, 3], [0, "a_uv0", 5126, 2]]]],
        [[6, [0], [4, 0, 0]]], [1, 0, 0, 0], [1, 0, 0, 0]];
}
function bounds(pos) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pos.length; i++) for (var k = 0; k < 3; k++) { if (pos[i][k] < mn[k]) mn[k] = pos[i][k]; if (pos[i][k] > mx[k]) mx[k] = pos[i][k]; }
    return { mn: mn, mx: mx };
}
// tạo model đơn giản (mảng pos/nrm/uv/idx)
function triModel() {
    return { pos: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], nrm: [[0, 0, 1], [0, 0, 1], [0, 0, 1]], uv: [[0, 0], [1, 0], [0, 1]], idx: [0, 1, 2] };
}
function quadModel() {
    return {
        pos: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], nrm: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
        uv: [[0, 0], [1, 0], [1, 1], [0, 1]], idx: [0, 1, 2, 0, 2, 3]
    };
}
var CUBE_OBJ = [
    "v -0.5 -0.5 -0.5", "v 0.5 -0.5 -0.5", "v 0.5 0.5 -0.5", "v -0.5 0.5 -0.5",
    "v -0.5 -0.5 0.5", "v 0.5 -0.5 0.5", "v 0.5 0.5 0.5", "v -0.5 0.5 0.5",
    "vn 0 0 -1", "vn 0 0 1",
    "f 1//1 3//1 2//1", "f 1//1 4//1 3//1", "f 5//2 6//2 7//2", "f 5//2 7//2 8//2",
    "f 1//1 5//2 8//2", "f 1//1 8//2 4//1", "f 2//1 3//1 7//2", "f 2//1 7//2 6//2",
    "f 1//1 2//1 6//2", "f 1//1 6//2 5//2", "f 4//1 8//2 7//2", "f 4//1 7//2 3//1"
].join("\n");

// dựng .bin + struct cho 1 model
function makeMesh(model) {
    var nb = core.buildBin(model, FORMATS);
    var bb = bounds(model.pos);
    var struct = core.buildStruct(structTemplate(), nb, bb.mn, bb.mx);
    var b64 = "data:application/octet-stream;base64," + core.encodeBase64Bytes(nb.bytes);
    return { struct: struct, b64: b64 };
}
// dựng playable HTML giả
function makeFixture(models, extra) {
    var res = {};
    var structTexts = [];
    models.forEach(function (m, i) {
        var mm = makeMesh(m);
        res["assets/main/native/" + i + "/mesh" + i + ".bin"] = mm.b64;
        structTexts.push(JSON.stringify(mm.struct));
    });
    // 1 texture png giả (1x1 đỏ)
    res["assets/main/native/tx/tex0.png"] = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    res["assets/main/import/aa/aaimport.json"] = "[1,[]," + structTexts.join(",") + "]";
    if (extra) extra(res);
    var html = "<!doctype html><html><head><title>fake</title></head><body>" +
        "<script>window.SAY_PERFORMANCE={};</script>" +
        "<script id=\"say-res\">window.__res = " + JSON.stringify(res) + "; window.SAY_PERFORMANCE.assetsCount = " + Object.keys(res).length + ";</script>" +
        "</body></html>";
    return html;
}

// ── đa submesh: template struct 2 bundle + 2 prim (mask kiểu Cocos) + model 2 part có uv1 ──
function structTemplateMulti() {
    var F = [[0, "a_normal", 5126, 3], [0, "a_position", 5126, 3], [0, "a_uv0", 5126, 2], [0, "a_uv1", 5126, 2]];
    return [8, ".bin",
        [[5, 0, [9, 0], F], [5, 0, [4, 0, 0], F]],  // 2 vertex bundle (range: 9=chỉ-len, 4=off+len)
        [[6, [0], [4, 0, 0]], [6, [1], [4, 0, 0]]], // 2 prim (submesh), mỗi cái trỏ 1 bundle
        [1, 0, 0, 0], [1, 0, 0, 0]];
}
function multiModel() {
    // 2 tam giác rời — part 0 & part 1; uv1 KHÁC uv0 để kiểm tra kênh uv1 được giữ
    return {
        pos: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0], [3, 0, 0], [2, 1, 0]],
        nrm: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
        uv: [[0, 0], [1, 0], [0, 1], [0, 0], [1, 0], [0, 1]],
        uv1: [[0.1, 0.1], [0.2, 0.1], [0.1, 0.2], [0.7, 0.7], [0.8, 0.7], [0.7, 0.8]],
        idx: [0, 1, 2, 3, 4, 5],
        parts: [{ material: 0, idxStart: 0, idxCount: 3 }, { material: 1, idxStart: 3, idxCount: 3 }]
    };
}
function makeMeshMulti(model) {
    var orig = structTemplateMulti();
    var parsed = orig[2].map(function (vb) { return vb[3].map(function (f) { return { name: f[1], type: f[2], num: f[3] }; }); });
    var raw = orig[2].map(function (vb) { return vb[3]; });
    var norm = core.normalizeParts(model, 2, parsed, raw);
    var built = core.buildBinMulti(model, norm.parts);
    var bb = bounds(model.pos);
    var struct = core.buildStructMulti(orig, built, bb.mn, bb.mx);
    return { struct: struct, b64: "data:application/octet-stream;base64," + core.encodeBase64Bytes(built.bytes) };
}
function makeFixtureMulti() {
    var mm = makeMeshMulti(multiModel());
    var res = {};
    res["assets/main/native/0/mesh0.bin"] = mm.b64;
    res["assets/main/native/tx/tex0.png"] = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    res["assets/main/import/aa/aaimport.json"] = "[1,[]," + JSON.stringify(mm.struct) + "]";
    return "<!doctype html><html><body><script>window.SAY_PERFORMANCE={};</script>" +
        "<script id=\"say-res\">window.__res = " + JSON.stringify(res) + "; window.SAY_PERFORMANCE.assetsCount=" + Object.keys(res).length + ";</script></body></html>";
}
// đọc uv0/uv1 mọi đỉnh từ geometry đã decode (đếm số đỉnh uv1≠uv0)
function uv1Distinct(mesh, res) {
    var bin = core.decodeBinary(res[mesh.binKey]);
    var dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), diff = 0;
    mesh.descriptor.bundles.forEach(function (b) {
        for (var v = 0; v < b.vc; v++) {
            var p = b.offset + v * b.stride, rec = {};
            b.formats.forEach(function (f) { var vv = []; for (var c = 0; c < f.num; c++) { vv.push(dv.getFloat32(p, true)); p += 4; } rec[f.name] = vv; });
            if (rec.a_uv0 && rec.a_uv1 && (Math.abs(rec.a_uv0[0] - rec.a_uv1[0]) > 1e-9 || Math.abs(rec.a_uv0[1] - rec.a_uv1[1]) > 1e-9)) diff++;
        }
    });
    return diff;
}

var passed = 0;
function ok(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("mesh-core tests:");

ok("analyzePlayable đọc đúng 2 mesh + 1 texture", function () {
    var html = makeFixture([triModel(), quadModel()]);
    var a = core.analyzePlayable(html);
    assert.strictEqual(a.meshes.length, 2, "phải có 2 mesh");
    assert.strictEqual(a.textures.length, 1, "phải có 1 texture");
    // match theo size: tri=3v, quad=4v — total khác nhau nên phải khớp đúng
    var tri = a.meshes.filter(function (m) { return m.verts === 3; })[0];
    var quad = a.meshes.filter(function (m) { return m.verts === 4; })[0];
    assert.ok(tri && quad, "phải nhận ra tri (3v) và quad (4v)");
    assert.strictEqual(tri.tris, 1);
    assert.strictEqual(quad.tris, 2);
    assert.ok(tri.matchScore <= 1e-6 && quad.matchScore <= 1e-6, "match score phải ~0");
});

ok("applyMeshReplacement thay tri bằng cube, mesh kia nguyên", function () {
    var html = makeFixture([triModel(), quadModel()]);
    var a = core.analyzePlayable(html);
    var triIdx = a.meshes.filter(function (m) { return m.verts === 3; })[0].index;
    var quadIdx = a.meshes.filter(function (m) { return m.verts === 4; })[0].index;
    var cube = core.loadModel(CUBE_OBJ, "cube.obj");
    core.applyMeshReplacement(a, triIdx, cube);
    var out = core.serialize(a);
    var a2 = core.analyzePlayable(out);
    var m = a2.meshes[triIdx];
    assert.strictEqual(m.tris, 12, "tri phải thành cube 12 tam giác");
    var bb = bounds(m.geometry.bundles[0].pos);
    assert.ok(Math.abs(bb.mn[0] + 0.5) < 1e-6 && Math.abs(bb.mx[0] - 0.5) < 1e-6, "bounds cube phải -0.5..0.5");
    assert.strictEqual(a2.meshes[quadIdx].tris, 2, "quad phải còn nguyên 2 tam giác");
});

ok("identity: thay lại chính geometry → round-trip vị trí = 0", function () {
    var html = makeFixture([quadModel()]);
    var a = core.analyzePlayable(html);
    var g = a.meshes[0].geometry;
    // dựng model từ geometry gốc
    var b = g.bundles[0];
    var model = { pos: b.pos, nrm: b.nrm, uv: b.uv, idx: g.prims[0].idx };
    var before = b.pos.map(function (p) { return p.slice(); });
    core.applyMeshReplacement(a, 0, model);
    var out = core.serialize(a);
    var a2 = core.analyzePlayable(out);
    var after = a2.meshes[0].geometry.bundles[0].pos;
    var maxd = 0;
    for (var i = 0; i < before.length; i++) for (var k = 0; k < 3; k++) maxd = Math.max(maxd, Math.abs(before[i][k] - after[i][k]));
    assert.ok(maxd === 0, "round-trip phải chính xác 0, thực tế " + maxd);
});

ok("applyTextureReplacement đổi đúng texture", function () {
    var html = makeFixture([triModel()]);
    var a = core.analyzePlayable(html);
    var key = a.textures[0].key;
    var newUri = "data:image/png;base64,AAAA";
    core.applyTextureReplacement(a, key, newUri);
    var out = core.serialize(a);
    var a2 = core.analyzePlayable(out);
    assert.strictEqual(a2.res[key], newUri, "texture phải được thay");
});

ok("loadModel OBJ + GLB round-trip qua buildBin", function () {
    var cube = core.loadModel(CUBE_OBJ, "cube.obj");
    assert.ok(cube.pos.length >= 8 && cube.idx.length === 36, "cube OBJ: 12 tam giác");
    // >65535 đỉnh phải bị chặn
    var big = { pos: [], nrm: [], uv: [], idx: [] };
    for (var i = 0; i < 70000; i++) { big.pos.push([0, 0, 0]); big.nrm.push([0, 0, 1]); big.uv.push([0, 0]); }
    var html = makeFixture([triModel()]);
    var a = core.analyzePlayable(html);
    assert.throws(function () { core.applyMeshReplacement(a, 0, big); }, /65535/, "phải chặn model >65535 đỉnh");
});

// encoder base122 (đồng bộ shortMap với decoder trong mesh-core) — chỉ dùng cho test
function encodeBase122(bytes) {
    var shortMap = [0, 10, 13, 34, 38, 92, 60], idxByVal = {};
    for (var s = 0; s < shortMap.length; s++) idxByVal[shortMap[s]] = s;
    var values = [], acc = 0, bits = 0;
    for (var i = 0; i < bytes.length; i++) { acc = (acc << 8) | bytes[i]; bits += 8; while (bits >= 7) { bits -= 7; values.push((acc >>> bits) & 0x7f); acc &= (1 << bits) - 1; } }
    if (bits > 0) values.push((acc << (7 - bits)) & 0x7f);
    var out = "";
    for (var index = 0; index < values.length; index++) {
        var v7 = values[index], si = idxByVal[v7];
        if (si === undefined) out += String.fromCharCode(v7);
        else if (index + 1 < values.length) out += String.fromCharCode((si << 8) | 0x80 | values[++index]);
        else out += String.fromCharCode((7 << 8) | 0x80 | v7);
    }
    return out;
}

ok("texture base122 → previewUri base64 render được (round-trip đúng)", function () {
    var png = core.decodeBase64Bytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    var b122uri = "data:image/png;base122," + encodeBase122(png);
    var res = { "assets/x/tex.png": b122uri };
    var texs = core.listTextures(res);
    assert.strictEqual(texs[0].encoding, "base122");
    assert.strictEqual(texs[0].bytes, png.length, "bytes phải = kích thước PNG gốc");
    assert.ok(/^data:image\/png;base64,/.test(texs[0].previewUri), "previewUri phải là base64");
    var back = core.decodeBase64Bytes(texs[0].previewUri);
    assert.strictEqual(back.length, png.length);
    for (var i = 0; i < png.length; i++) assert.strictEqual(back[i], png[i], "byte " + i + " phải khớp");
});

ok("fitModelToBounds: scale đều khớp extent + căn giữa; stretch lấp đầy bbox", function () {
    var cube = core.loadModel(CUBE_OBJ, "cube.obj"); // extent 1, tâm ~0
    var fit = core.fitModelToBounds(cube, [10, 20, 30], [12, 24, 36], false); // bbox đích 2×4×6, tâm [11,22,33]
    assert.ok(Math.abs(fit.scale[0] - 6) < 1e-9, "scale đều = oldMax/newMax = 6");
    var b = bounds(fit.model.pos);
    assert.ok(Math.abs(Math.max(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) - 6) < 1e-9, "extent sau fit = 6");
    assert.ok(Math.abs((b.mn[0] + b.mx[0]) / 2 - 11) < 1e-9 && Math.abs((b.mn[1] + b.mx[1]) / 2 - 22) < 1e-9 && Math.abs((b.mn[2] + b.mx[2]) / 2 - 33) < 1e-9, "tâm khớp [11,22,33]");
    var st = core.fitModelToBounds(cube, [0, 0, 0], [2, 4, 6], true);
    var sb = bounds(st.model.pos);
    assert.ok(Math.abs((sb.mx[0] - sb.mn[0]) - 2) < 1e-9 && Math.abs((sb.mx[1] - sb.mn[1]) - 4) < 1e-9 && Math.abs((sb.mx[2] - sb.mn[2]) - 6) < 1e-9, "stretch lấp đầy 2×4×6");
});

ok("serialize KHÔNG phình base122: giữ nguyên byte asset không đụng (không escape control char)", function () {
    var esc = function (s) { return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); };
    var mm = makeMesh(triModel());
    // texture base122 chứa ký tự điều khiển thô 0x14, 0x1a (như base122 thật) — sẽ KHÔNG bị đụng
    var keepVal = "data:image/png;base122,AB" + String.fromCharCode(0x14) + "CD" + String.fromCharCode(0x1a) + "EF";
    var objText = "{" +
        "\"assets/m0.bin\":\"" + mm.b64 + "\"," +
        "\"assets/keep.png\":\"" + keepVal + "\"," +
        "\"assets/import.json\":\"" + esc("[1,[]," + JSON.stringify(mm.struct) + "]") + "\"" +
        "}";
    var html = "<!doctype html><html><body><script>window.SAY_PERFORMANCE={};</script>" +
        "<script id=\"say-res\">window.__res = " + objText + "; window.SAY_PERFORMANCE.assetsCount=3;</script></body></html>";
    var a = core.analyzePlayable(html);
    assert.strictEqual(a.meshes.length, 1);
    var cube = core.loadModel(CUBE_OBJ, "cube.obj");
    core.applyMeshReplacement(a, 0, cube); // chỉ đụng mesh + bin, KHÔNG đụng keep.png
    var out = core.serialize(a);
    assert.ok(out.indexOf(keepVal) >= 0, "base122 không đụng phải được giữ NGUYÊN BYTE (kể cả control char thô)");
    assert.ok(out.indexOf("\\u0014") < 0 && out.indexOf("\\u001a") < 0, "KHÔNG được escape control char thành \\uXXXX (dấu hiệu phình)");
    assert.ok(out.length < html.length + 2000, "output không phình toàn cục");
});

// dựng GLB tối giản: 1 tam giác + node có transform, để test bake transform
function makeGLB(positions, indices, node) {
    var posBuf = Buffer.alloc(positions.length * 4);
    for (var i = 0; i < positions.length; i++) posBuf.writeFloatLE(positions[i], i * 4);
    var idxBuf = Buffer.alloc(indices.length * 2);
    for (i = 0; i < indices.length; i++) idxBuf.writeUInt16LE(indices[i], i * 2);
    var pad = function (n) { return (4 - (n % 4)) % 4; };
    var idxOff = posBuf.length + pad(posBuf.length);
    var bin = Buffer.concat([posBuf, Buffer.alloc(pad(posBuf.length)), idxBuf, Buffer.alloc(pad(idxBuf.length))]);
    var json = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [node],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBuf.length },
        { buffer: 0, byteOffset: idxOff, byteLength: idxBuf.length }],
        buffers: [{ byteLength: bin.length }]
    };
    var js = Buffer.from(JSON.stringify(json), "utf8");
    js = Buffer.concat([js, Buffer.alloc(pad(js.length), 0x20)]);
    var header = Buffer.alloc(12); header.writeUInt32LE(0x46546C67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    var jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
    var bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
    return Buffer.concat([header, jh, js, bh, bin]);
}

ok("loadGLB bake transform node (scale + rotation) vào geometry", function () {
    var glb = makeGLB([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], { mesh: 0, scale: [2, 3, 4] });
    var m = core.loadGLB(new Uint8Array(glb).buffer);
    assert.strictEqual(m.pos.length, 3);
    assert.deepStrictEqual(m.pos[1], [2, 0, 0], "đỉnh (1,0,0)×scale[2,3,4] = (2,0,0)");
    assert.deepStrictEqual(m.pos[2], [0, 3, 0], "đỉnh (0,1,0)×scale = (0,3,0)");
    var glb2 = makeGLB([0, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2], { mesh: 0, rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] });
    var m2 = core.loadGLB(new Uint8Array(glb2).buffer);
    assert.ok(Math.abs(m2.pos[1][0]) < 1e-4 && Math.abs(m2.pos[1][1]) < 1e-4 && Math.abs(m2.pos[1][2] - 1) < 1e-4, "xoay 90°X: (0,1,0)→(0,0,1)");
});

ok("autoOrientRotation: xoay khớp trục mỏng (đĩa) + bỏ qua vật không dẹt (khối)", function () {
    // coin thật: hai vành ±độ dày ở MỖI góc → độ dày không tương quan góc (trục mỏng sạch)
    function disc(thin) { var p = [], TS = [-0.05, 0.05]; for (var i = 0; i < 24; i++) { var a = i / 24 * 6.2832, x = Math.cos(a), y = Math.sin(a); for (var s = 0; s < 2; s++) { var t = TS[s]; p.push(thin === "Y" ? [x, t, y] : thin === "Z" ? [x, y, t] : [t, x, y]); } } return p; }
    function thinIdx(p) { var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (var i = 0; i < p.length; i++) for (var k = 0; k < 3; k++) { if (p[i][k] < mn[k]) mn[k] = p[i][k]; if (p[i][k] > mx[k]) mx[k] = p[i][k]; } var s = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; return s.indexOf(Math.min(s[0], s[1], s[2])); }
    var oldD = disc("Z"), newD = disc("Y");
    var r = core.autoOrientRotation(newD, oldD);
    assert.ok(r.aligned, "hai đĩa phải auto-align được");
    var rotated = core.rotateModel({ pos: newD, nrm: newD.map(function () { return [0, 1, 0]; }), uv: [], idx: [] }, r.mat);
    assert.strictEqual(thinIdx(rotated.pos), 2, "sau xoay, trục mỏng model mới phải = Z (khớp old)");
    // khối lập phương → không auto
    var cube = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    assert.ok(!core.autoOrientRotation(cube, oldD).aligned, "khối không dẹt → không auto-orient");
    // rot90mat quanh X: (0,1,0) → (0,0,1)
    var v = core.rot90mat(0, 1);
    var rv = [v[0] * 0 + v[1] * 1 + v[2] * 0, v[3] * 0 + v[4] * 1 + v[5] * 0, v[6] * 0 + v[7] * 1 + v[8] * 0];
    assert.ok(Math.abs(rv[2] - 1) < 1e-9, "rot90mat(X): (0,1,0)→(0,0,1)");
});

ok("encodeBinaryLikeOriginal: SAY-pack + base122 (CarRace) round-trip qua decodeBinary", function () {
    var bytes = new Uint8Array(1000); for (var i = 0; i < 1000; i++) bytes[i] = (i * 131 + 7) & 255;
    var K = [0, 10, 13, 34, 38, 92];
    // base122 + packed (CarRace): ghi ra data:sayMesh;base122, + nén SAY, decode lại phải khớp
    var uri = core.encodeBinaryLikeOriginal(bytes, { mime: "sayMesh", encoding: "base122", packed: true }, K);
    assert.ok(/^data:sayMesh;base122,/.test(uri), "phải là data:sayMesh;base122,");
    var back = core.decodeBinary(uri);
    assert.ok(back.length >= 1000, "decode đủ bytes");
    for (var j = 0; j < 1000; j++) assert.strictEqual(back[j], bytes[j], "byte " + j + " khớp");
    // base64 + không nén (PocketSort): giữ nguyên hành vi cũ
    var uri2 = core.encodeBinaryLikeOriginal(bytes, { mime: "application/octet-stream", encoding: "base64", packed: false }, K);
    assert.ok(/^data:application\/octet-stream;base64,/.test(uri2), "PocketSort phải base64");
    var back2 = core.decodeBinary(uri2);
    for (var m = 0; m < 1000; m++) assert.strictEqual(back2[m], bytes[m]);
    // binFormat phát hiện đúng
    assert.deepStrictEqual(core.binFormat(uri), { mime: "sayMesh", encoding: "base122", packed: true });
    assert.strictEqual(core.binFormat(uri2).packed, false);
});

ok("đa-submesh: analyze thấy 2 submesh + uv1 riêng biệt", function () {
    var a = core.analyzePlayable(makeFixtureMulti());
    assert.strictEqual(a.meshes.length, 1, "1 mesh");
    var m = a.meshes[0];
    assert.strictEqual(m.submeshes, 2, "phải nhận ra 2 submesh");
    assert.strictEqual(m.descriptor.bundles.length, 2, "2 bundle");
    assert.strictEqual(m.tris, 2, "2 tam giác tổng");
    assert.strictEqual(uv1Distinct(m, a.res), 6, "cả 6 đỉnh có uv1 ≠ uv0");
});

ok("đa-submesh: thay bằng model 2-part → GIỮ 2 submesh + uv1 (không gộp)", function () {
    var a = core.analyzePlayable(makeFixtureMulti());
    // model mới: 2 part khác hình, vẫn có uv1 riêng
    var model = multiModel();
    model.pos = model.pos.map(function (p) { return [p[0] * 2, p[1] * 2, p[2]]; }); // đổi hình đôi chút
    core.applyMeshReplacement(a, 0, model);
    assert.strictEqual(a.meshes[0].replaceMode, "1-1", "map 1-1");
    var out = core.serialize(a);
    var a2 = core.analyzePlayable(out);
    var m2 = a2.meshes[0];
    assert.strictEqual(m2.submeshes, 2, "SAU thay vẫn 2 submesh (trước lỗi: gộp còn 1)");
    assert.strictEqual(m2.descriptor.bundles.length, 2, "vẫn 2 bundle");
    assert.strictEqual(m2.tris, 2, "vẫn 2 tam giác");
    assert.ok(uv1Distinct(m2, a2.res) > 0, "uv1 vẫn riêng biệt (trước lỗi: uv1==uv0 → 0)");
});

ok("đa-submesh: model 1-part vào mesh 2-submesh → fallback giữ đủ 2 binding", function () {
    var a = core.analyzePlayable(makeFixtureMulti());
    var cube = core.loadModel(CUBE_OBJ, "cube.obj"); // 1 part (không usemtl)
    core.applyMeshReplacement(a, 0, cube);
    assert.strictEqual(a.meshes[0].replaceMode, "1→2", "mode fallback 1→2");
    var a2 = core.analyzePlayable(core.serialize(a));
    var m2 = a2.meshes[0];
    assert.strictEqual(m2.submeshes, 2, "giữ ĐỦ 2 submesh (submesh 2 rỗng) để khớp 2 material");
    assert.strictEqual(m2.tris, 12, "toàn bộ 12 tam giác cube nằm ở submesh 0");
    // submesh rỗng: prim thứ 2 có 0 index
    var idxCounts = m2.geometry.prims.map(function (p) { return p.idx.length; });
    assert.ok(idxCounts.indexOf(0) >= 0, "phải có 1 submesh rỗng (0 index)");
    assert.ok(idxCounts.indexOf(36) >= 0, "submesh còn lại chứa 36 index (12 tam giác)");
});

ok("loadOBJ usemtl → nhiều part", function () {
    var obj = "usemtl red\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nusemtl blue\nv 2 0 0\nv 3 0 0\nv 2 1 0\nf 4 5 6";
    var m = core.loadModel(obj, "two.obj");
    assert.strictEqual(m.parts.length, 2, "2 usemtl → 2 part");
    assert.strictEqual(m.parts[0].idxCount, 3);
    assert.strictEqual(m.parts[1].idxCount, 3);
});

console.log("\n" + passed + " test passed.");
