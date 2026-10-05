/*
 * Test fbx-core: dựng FBX tổng hợp (nhị phân 7400/7500 + ASCII) có cây Model, xoay, scale âm, geometric
 * transform, hệ trục Z-up + đơn vị mét, material theo polygon — so với toạ độ tính tay.
 * Chạy: node tests/fbx-core.test.js
 */
"use strict";
var assert = require("assert");
var zlib = require("zlib");
var F = require("../fbx-core");
var M = require("../mesh-core");

var passed = 0;
function ok(name, fn) {
    try { fn(); passed++; console.log("  ✓ " + name); }
    catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}
function near(a, b, msg) {
    assert.strictEqual(a.length, b.length, msg);
    for (var i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, (msg || "") + " — " + JSON.stringify(a) + " ≠ " + JSON.stringify(b));
}

// ───────── bộ ghi FBX nhị phân tối giản ─────────
var I = function (v) { return { t: "I", v: v }; }, D = function (v) { return { t: "D", v: v }; };
var L = function (v) { return { t: "L", v: BigInt(v) }; }, S = function (v) { return { t: "S", v: v }; };
var dA = function (a) { return { t: "d", v: a }; }, iA = function (a) { return { t: "i", v: a }; };
function node(name, props, children) { return { name: name, props: props || [], children: children || [] }; }

function encodeProp(p, compress) {
    var b;
    switch (p.t) {
        case "I": b = Buffer.alloc(5); b.writeInt32LE(p.v, 1); break;
        case "D": b = Buffer.alloc(9); b.writeDoubleLE(p.v, 1); break;
        case "L": b = Buffer.alloc(9); b.writeBigInt64LE(p.v, 1); break;
        case "S": var s = Buffer.from(p.v, "utf8"); b = Buffer.alloc(5 + s.length); b.writeUInt32LE(s.length, 1); s.copy(b, 5); break;
        case "d": case "i":
            var raw = p.t === "d" ? Buffer.from(new Float64Array(p.v).buffer) : Buffer.from(new Int32Array(p.v).buffer);
            var data = compress ? zlib.deflateSync(raw) : raw;
            b = Buffer.alloc(13 + data.length);
            b.writeUInt32LE(p.v.length, 1); b.writeUInt32LE(compress ? 1 : 0, 5); b.writeUInt32LE(data.length, 9);
            data.copy(b, 13);
            break;
    }
    b[0] = p.t.charCodeAt(0);
    return b;
}
function encodeNode(n, offset, wide, compress) {
    var head = wide ? 25 : 13, name = Buffer.from(n.name, "latin1");
    var props = n.props.map(function (p) { return encodeProp(p, compress); });
    var propLen = props.reduce(function (s, b) { return s + b.length; }, 0);
    var cursor = offset + head + name.length + propLen, kids = [];
    n.children.forEach(function (c) { var b = encodeNode(c, cursor, wide, compress); kids.push(b); cursor += b.length; });
    if (n.children.length) { kids.push(Buffer.alloc(head)); cursor += head; }
    var h = Buffer.alloc(head);
    if (wide) { h.writeBigUInt64LE(BigInt(cursor), 0); h.writeBigUInt64LE(BigInt(n.props.length), 8); h.writeBigUInt64LE(BigInt(propLen), 16); h[24] = name.length; }
    else { h.writeUInt32LE(cursor, 0); h.writeUInt32LE(n.props.length, 4); h.writeUInt32LE(propLen, 8); h[12] = name.length; }
    return Buffer.concat([h, name].concat(props, kids));
}
function writeBinary(nodes, version, compress) {
    var wide = version >= 7500;
    var header = Buffer.concat([Buffer.from("Kaydara FBX Binary  \x00\x1a\x00", "latin1"), Buffer.alloc(4)]);
    header.writeUInt32LE(version, 23);
    var out = [header], offset = header.length;
    nodes.forEach(function (n) { var b = encodeNode(n, offset, wide, compress); out.push(b); offset += b.length; });
    out.push(Buffer.alloc(wide ? 25 : 13));
    return new Uint8Array(Buffer.concat(out));
}

// ───────── cảnh thử ─────────
function P70(list) { return node("Properties70", [], list.map(function (p) { return node("P", p); })); }
function vec(name, x, y, z) { return [S(name), S(name), S(""), S("A"), D(x), D(y), D(z)]; }
function layer(name, mapping, ref, dataName, data, indexName, index) {
    var kids = [node("Version", [I(101)]), node("MappingInformationType", [S(mapping)]), node("ReferenceInformationType", [S(ref)]), node(dataName, [dataName === "Materials" ? iA(data) : dA(data)])];
    if (indexName) kids.push(node(indexName, [iA(index)]));
    return node(name, [I(0)], kids);
}
function scene(ids) {
    ids = ids || { quadGeo: 100, stripGeo: 101, parent: 200, quad: 201, strip: 202, matA: 300, matB: 301 };
    var geoQuad = node("Geometry", [L(ids.quadGeo), S("Quad\x00\x01Geometry"), S("Mesh")], [
        node("Vertices", [dA([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])]),
        node("PolygonVertexIndex", [iA([0, 1, 2, -4])]),
        layer("LayerElementNormal", "ByPolygonVertex", "Direct", "Normals", [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        layer("LayerElementUV", "ByPolygonVertex", "IndexToDirect", "UV", [0, 0, 1, 0, 1, 1, 0, 1], "UVIndex", [0, 1, 2, 3]),
        layer("LayerElementMaterial", "AllSame", "IndexToDirect", "Materials", [0])
    ]);
    var geoStrip = node("Geometry", [L(ids.stripGeo), S("Strip\x00\x01Geometry"), S("Mesh")], [
        node("Vertices", [dA([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])]),
        node("PolygonVertexIndex", [iA([0, 1, -3, 1, 3, -3])]),
        layer("LayerElementNormal", "ByVertice", "Direct", "Normals", [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        layer("LayerElementMaterial", "ByPolygon", "IndexToDirect", "Materials", [0, 1])
    ]);
    return [
        node("GlobalSettings", [], [P70([
            [S("UpAxis"), S("int"), S("Integer"), S(""), I(2)], [S("UpAxisSign"), S("int"), S("Integer"), S(""), I(1)],
            [S("FrontAxis"), S("int"), S("Integer"), S(""), I(1)], [S("FrontAxisSign"), S("int"), S("Integer"), S(""), I(-1)],
            [S("CoordAxis"), S("int"), S("Integer"), S(""), I(0)], [S("CoordAxisSign"), S("int"), S("Integer"), S(""), I(1)],
            [S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(100)]
        ])]),
        node("Objects", [], [
            geoQuad, geoStrip,
            node("Model", [L(ids.parent), S("Parent\x00\x01Model"), S("Null")], [P70([vec("Lcl Translation", 10, 0, 0)])]),
            node("Model", [L(ids.quad), S("QuadModel\x00\x01Model"), S("Mesh")], [P70([vec("Lcl Rotation", 0, 0, 90), vec("Lcl Scaling", 2, 2, 2)])]),
            node("Model", [L(ids.strip), S("StripModel\x00\x01Model"), S("Mesh")], [P70([vec("Lcl Scaling", 1, -1, 1), vec("GeometricTranslation", 0, 0, 5)])]),
            node("Material", [L(ids.matA), S("MatA\x00\x01Material"), S("")]),
            node("Material", [L(ids.matB), S("MatB\x00\x01Material"), S("")])
        ]),
        node("Connections", [], [
            [ids.quadGeo, ids.quad], [ids.quad, ids.parent], [ids.parent, 0], [ids.stripGeo, ids.strip], [ids.strip, 0],
            [ids.matA, ids.quad], [ids.matA, ids.strip], [ids.matB, ids.strip]
        ].map(function (c) { return node("C", [S("OO"), L(c[0]), L(c[1])]); }))
    ];
}

// Bản ASCII của đúng cảnh trên.
var ASCII = [
    "; FBX 7.4.0 project file",
    "FBXHeaderExtension:  {", "\tFBXHeaderVersion: 1003", "\tFBXVersion: 7400", "}",
    "GlobalSettings:  {", "\tVersion: 1000", "\tProperties70:  {",
    '\t\tP: "UpAxis", "int", "Integer", "",2', '\t\tP: "UpAxisSign", "int", "Integer", "",1',
    '\t\tP: "FrontAxis", "int", "Integer", "",1', '\t\tP: "FrontAxisSign", "int", "Integer", "",-1',
    '\t\tP: "CoordAxis", "int", "Integer", "",0', '\t\tP: "CoordAxisSign", "int", "Integer", "",1',
    '\t\tP: "UnitScaleFactor", "double", "Number", "",100', "\t}", "}",
    "Objects:  {",
    '\tGeometry: 100, "Geometry::Quad", "Mesh" {',
    "\t\tVertices: *12 {", "\t\t\ta: 0,0,0,1,0,0,", "1,1,0,0,1,0", "\t\t} ",
    "\t\tPolygonVertexIndex: *4 {", "\t\t\ta: 0,1,2,-4", "\t\t} ",
    "\t\tLayerElementNormal: 0 {", "\t\t\tVersion: 101", '\t\t\tName: ""', '\t\t\tMappingInformationType: "ByPolygonVertex"', '\t\t\tReferenceInformationType: "Direct"',
    "\t\t\tNormals: *12 {", "\t\t\t\ta: 0,0,1,0,0,1,0,0,1,0,0,1", "\t\t\t}", "\t\t}",
    "\t\tLayerElementUV: 0 {", '\t\t\tMappingInformationType: "ByPolygonVertex"', '\t\t\tReferenceInformationType: "IndexToDirect"',
    "\t\t\tUV: *8 {", "\t\t\t\ta: 0,0,1,0,1,1,0,1", "\t\t\t}", "\t\t\tUVIndex: *4 {", "\t\t\t\ta: 0,1,2,3", "\t\t\t}", "\t\t}",
    "\t\tLayerElementMaterial: 0 {", '\t\t\tMappingInformationType: "AllSame"', '\t\t\tReferenceInformationType: "IndexToDirect"', "\t\t\tMaterials: *1 {", "\t\t\t\ta: 0", "\t\t\t}", "\t\t}",
    "\t}",
    '\tGeometry: 101, "Geometry::Strip", "Mesh" {',
    "\t\tVertices: *12 {", "\t\t\ta: 0,0,0,1,0,0,0,1,0,1,1,0", "\t\t} ",
    "\t\tPolygonVertexIndex: *6 {", "\t\t\ta: 0,1,-3,1,3,-3", "\t\t} ",
    "\t\tLayerElementNormal: 0 {", '\t\t\tMappingInformationType: "ByVertice"', '\t\t\tReferenceInformationType: "Direct"', "\t\t\tNormals: *12 {", "\t\t\t\ta: 0,0,1,0,0,1,0,0,1,0,0,1", "\t\t\t}", "\t\t}",
    "\t\tLayerElementMaterial: 0 {", '\t\t\tMappingInformationType: "ByPolygon"', '\t\t\tReferenceInformationType: "IndexToDirect"', "\t\t\tMaterials: *2 {", "\t\t\t\ta: 0,1", "\t\t\t}", "\t\t}",
    "\t}",
    '\tModel: 200, "Model::Parent", "Null" {', "\t\tVersion: 232", "\t\tProperties70:  {", '\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",10,0,0', "\t\t}", "\t\tShading: T", "\t}",
    '\tModel: 201, "Model::QuadModel", "Mesh" {', "\t\tProperties70:  {", '\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,90', '\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",2,2,2', "\t\t}", "\t}",
    '\tModel: 202, "Model::StripModel", "Mesh" {', "\t\tProperties70:  {", '\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,-1,1', '\t\t\tP: "GeometricTranslation", "Vector3D", "Vector", "",0,0,5', "\t\t}", "\t}",
    '\tMaterial: 300, "Material::MatA", "" {', "\t}",
    '\tMaterial: 301, "Material::MatB", "" {', "\t}",
    "}",
    "Connections:  {",
    "\t;Geometry::Quad, Model::QuadModel", '\tC: "OO",100,201', '\tC: "OO",201,200', '\tC: "OO",200,0', '\tC: "OO",101,202', '\tC: "OO",202,0',
    '\tC: "OO",300,201', '\tC: "OO",300,202', '\tC: "OO",301,202',
    "}"
].join("\n");

// Kết quả tính tay (hệ đầu ra: tay phải, Y lên; file Z-up kiểu 3ds Max: (x, y, z) → (x, z, -y); đơn vị 100 → ×1).
//   Quad: world = T(10,0,0) · Rz(90°) · S(2) → (1,0,0) ↦ (10,2,0) ↦ (10,0,-2)
//   Strip: geometric T(0,0,5) rồi S(1,-1,1) (lật chiều tam giác) → (1,0,0) ↦ (1,0,5) ↦ (1,5,0)
function checkScene(model, label) {
    assert.deepStrictEqual(model.objects.map(function (o) { return o.name; }), ["QuadModel", "StripModel"], label + ": object theo thứ tự Model");
    near(model.pos[0], [10, 0, 0], label + ": quad đỉnh 0");
    near(model.pos[1], [10, 0, -2], label + ": quad đỉnh 1");
    near(model.pos[2], [8, 0, -2], label + ": quad đỉnh 2");
    near(model.pos[3], [8, 0, 0], label + ": quad đỉnh 3");
    near(model.nrm[0], [0, 1, 0], label + ": normal quad hướng lên sau khi đổi trục");
    near(model.uv[2], [1, 0], label + ": UV lật v (gốc dưới → gốc trên)");
    assert.deepStrictEqual(model.idx.slice(0, 6), [0, 1, 2, 0, 2, 3], label + ": tứ giác chia quạt");
    near(model.pos[4], [0, 5, 0], label + ": strip đỉnh 0");
    near(model.pos[5], [1, 5, 0], label + ": strip đỉnh 1");
    near(model.pos[6], [0, 5, 1], label + ": strip đỉnh 2");
    assert.deepStrictEqual(model.idx.slice(6, 9), [4, 6, 5], label + ": scale âm → đảo chiều tam giác");
    assert.deepStrictEqual(model.parts.map(function (p) { return [p.material, p.idxCount]; }), [["MatA", 6], ["MatA", 3], ["MatB", 3]], label + ": material theo polygon");
    // Mọi tam giác: normal hình học cùng chiều normal đỉnh (lật trục / winding sai sẽ lộ ở đây)
    for (var i = 0; i < model.idx.length; i += 3) {
        var a = model.pos[model.idx[i]], b = model.pos[model.idx[i + 1]], c = model.pos[model.idx[i + 2]];
        var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        var g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], n = model.nrm[model.idx[i]];
        assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, label + ": tam giác " + i / 3 + " ngược chiều normal");
    }
}

console.log("fbx-core tests:");

ok("inflate khớp zlib (khối lưu thô, Huffman cố định, Huffman động, deflate thô)", function () {
    var r = 7, noise = Buffer.from(new Uint8Array(50000).map(function () { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r >>> 24; }));
    var text = Buffer.from("Vertices PolygonVertexIndex LayerElementNormal ".repeat(3000));
    [zlib.deflateSync(noise, { level: 0 }), zlib.deflateSync(Buffer.from("abc")), zlib.deflateSync(text, { level: 9 }), zlib.deflateSync(noise)].forEach(function (z, k) {
        var want = k === 1 ? Buffer.from("abc") : k === 2 ? text : noise;
        assert.ok(Buffer.from(F.inflate(new Uint8Array(z))).equals(want), "mẫu " + k);
    });
    assert.ok(Buffer.from(F.inflate(new Uint8Array(zlib.deflateRawSync(text)))).equals(text), "deflate thô");
});

[[7400, false], [7400, true], [7500, true]].forEach(function (c) {
    ok("FBX nhị phân " + c[0] + (c[1] ? " (mảng nén zlib)" : " (mảng không nén)") + ": toạ độ, winding, UV, material", function () {
        checkScene(F.loadFBX(writeBinary(scene(), c[0], c[1])), "bin" + c[0]);
    });
});

ok("FBX ASCII ra đúng như bản nhị phân", function () {
    checkScene(F.loadFBX(new Uint8Array(Buffer.from(ASCII, "utf8"))), "ascii");
});

ok("id int64 vượt 2^53 không bị gộp nhầm (giữ dạng chuỗi)", function () {
    var big = "9007199254740993"; // 2^53 + 1 — Number làm tròn thành 2^53
    var ids = { quadGeo: big, stripGeo: "9007199254740994", parent: "9007199254740995", quad: "9007199254740997", strip: "9007199254740999", matA: "9007199254741001", matB: "9007199254741003" };
    checkScene(F.loadFBX(writeBinary(scene(ids), 7400, true)), "int64");
});

ok("mesh-core.loadModel nhận .fbx; subModel tách riêng một object", function () {
    var model = M.loadModel(writeBinary(scene(), 7400, true).buffer, "cảnh.FBX");
    assert.strictEqual(model.objects.length, 2);
    var strip = M.subModel(model, 1);
    assert.strictEqual(strip.pos.length, 4);
    assert.strictEqual(strip.idx.length, 6);
    // chỉ số được đánh lại, nhưng từng góc tam giác phải trỏ đúng toạ độ cũ (giữ cả chiều quấn)
    for (var k = 0; k < 6; k++) near(strip.pos[strip.idx[k]], model.pos[model.idx[6 + k]], "góc " + k);
    assert.deepStrictEqual(strip.parts.map(function (p) { return [p.material, p.idxStart, p.idxCount]; }), [["MatA", 0, 3], ["MatB", 3, 3]]);
    assert.deepStrictEqual(strip.objects.map(function (o) { return o.name; }), ["StripModel"]);
});

ok("OBJ nhiều object ('o') và GLB có tên node đều ra danh sách object", function () {
    var obj = M.loadOBJ(["o Hoe", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", "o Shovel", "v 0 0 1", "v 1 0 1", "v 0 1 1", "f 4 5 6"].join("\n"));
    assert.deepStrictEqual(obj.objects.map(function (o) { return [o.name, o.idxStart, o.idxCount]; }), [["Hoe", 0, 3], ["Shovel", 3, 3]]);
    assert.strictEqual(M.subModel(obj, 1).pos[0][2], 1);
});

ok("báo lỗi rõ: FBX 6.x và file chỉ có animation", function () {
    assert.throws(function () { F.loadFBX(new Uint8Array(Buffer.from("; FBX 6.1.0 project file\nFBXHeaderExtension:  {\n}\nObjects:  {\n}\n"))); }, /quá cũ/);
    var animOnly = [node("Objects", [], [node("Model", [L(1), S("Hips\x00\x01Model"), S("LimbNode")], [])]), node("Connections", [], [])];
    assert.throws(function () { F.loadFBX(writeBinary(animOnly, 7400, false)); }, /không có mesh/);
    assert.throws(function () { F.loadFBX(new Uint8Array(Buffer.from("xin chào"))); }, /Không phải file FBX/);
});

console.log(passed + " test passed.");
