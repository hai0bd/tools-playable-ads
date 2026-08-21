/*
 * mesh-core.js — logic lõi cho Playable Mesh Replacer
 * ----------------------------------------------------
 * Đọc / giải mã / thay mesh 3D + texture trong playable Cocos Creator 2.4.x
 * (wrapper SayGames: asset nhúng trong window.__res).
 *
 * UMD, zero-dependency, ES5 → chạy được cả browser lẫn Node (để test).
 * Global: window.MeshReplacer   |   Node: require("./mesh-core")
 *
 * Các hàm decode base64/base122 mượn nguyên từ playable-converter (converter-core.js).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.MeshReplacer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ───────────────────────── base64 (mượn từ converter-core) ─────────────────────────
    function isProbablyBase64(value) {
        value = String(value || "").replace(/\s+/g, "");
        return value.length >= 4 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && value.length % 4 !== 1;
    }
    function decodeBase64Bytes(value) {
        var payload = String(value == null ? "" : value).trim();
        var dataUri = payload.match(/^data:[^,]*;base64,([\s\S]+)$/i);
        if (dataUri) payload = dataUri[1];
        payload = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
        while (payload.length % 4) payload += "=";
        if (!isProbablyBase64(payload)) throw new Error("Chuỗi Base64 không hợp lệ.");
        var binary;
        if (typeof atob === "function") binary = atob(payload);
        else if (typeof Buffer !== "undefined") binary = Buffer.from(payload, "base64").toString("binary");
        else throw new Error("Môi trường không hỗ trợ giải mã Base64.");
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    function encodeBase64Bytes(value) {
        var bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
        if (typeof btoa !== "function") throw new Error("Môi trường không hỗ trợ mã hóa Base64.");
        var binary = "", chunkSize = 0x8000;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
        }
        return btoa(binary);
    }
    function decodeBase122Bytes(value) {
        var payload = String(value == null ? "" : value);
        var dataUri = payload.match(/^data:[^,]*;base122,([\s\S]+)$/i);
        if (dataUri) payload = dataUri[1];
        var shortMap = [0, 10, 13, 34, 38, 92, 60], sentinel = 7, out = [], current = 0, bits = 0;
        function pushSeven(v) {
            v = (v & 0x7f) << 1; current |= v >>> bits; bits += 7;
            if (bits >= 8) { out.push(current & 0xff); bits -= 8; current = (v << (7 - bits)) & 0xff; }
        }
        for (var i = 0; i < payload.length; i++) {
            var code = payload.charCodeAt(i);
            if (code > 127) { var k = (code >>> 8) & 7; if (k !== sentinel) pushSeven(shortMap[k]); pushSeven(code & 0x7f); }
            else pushSeven(code);
        }
        return new Uint8Array(out);
    }

    // ───────────────────────── giải mã .bin ("SAY" packed) ─────────────────────────
    var MESH_HEADER_LENGTH = 15;
    function baseToArray(dataUri) {
        var e = dataUri.indexOf(";") + 1, n = dataUri.indexOf(",", e), enc = dataUri.substring(e, n);
        if (enc === "base64") return decodeBase64Bytes(dataUri);
        if (enc === "base122") return decodeBase122Bytes(dataUri);
        if (enc === "raw") return new Uint8Array(dataUri.substring(dataUri.indexOf(",") + 1).split(",").map(Number));
        throw new Error("Kiểu mã hóa chưa hỗ trợ: " + enc);
    }
    function unpackMesh(e) {
        var n = e.length;
        var a = e[3] | e[4] << 8 | e[5] << 16 | e[6] << 24;
        var t = e[7] | e[8] << 8 | e[9] << 16 | e[10] << 24;
        var r = e[11] | e[12] << 8, d = e[13], l = e[14];
        var s = MESH_HEADER_LENGTH + a, iEnd = s + t;
        var u = new Uint8Array(r * d + 1 + (n - MESH_HEADER_LENGTH - a - t));
        var c = 0, w = MESH_HEADER_LENGTH;
        for (; w < s;) {
            var o = e[w] << 8 | e[w + 1], isRef = !(128 & ~e[w]), av = o & (o <= 255 ? 127 : 32767);
            w += 2;
            if (isRef) { var off = s + av * l; u.set(e.subarray(off, off + l), c); c += l; }
            else { u.set(e.subarray(w, w + av), c); w += av; c += av; }
        }
        c++; u.set(e.subarray(iEnd, n), c);
        return u;
    }
    function decodeBinary(dataUri) {
        var a = baseToArray(dataUri);
        if (a[0] === 83 && a[1] === 65 && a[2] === 89) a = unpackMesh(a); // "SAY"
        return a;
    }
    // Định dạng gốc của 1 bin: {mime, encoding, packed}. Cần để GHI LẠI đúng định dạng
    // engine yêu cầu (vd CarRace: data:sayMesh;base122, + nén SAY).
    function binFormat(dataUri) {
        var m = dataUri.match(/^data:([^;,]*);([a-z0-9]+),/i);
        var mime = m ? m[1] : "application/octet-stream", enc = m ? m[2].toLowerCase() : "base64";
        var packed = false;
        try { var b = baseToArray(dataUri); packed = (b[0] === 83 && b[1] === 65 && b[2] === 89); } catch (e) {}
        return { mime: mime, encoding: enc, packed: packed };
    }
    // ── base122 encoder (shortMap = K_ILLEGALS của playable) ──
    function encodeBase122Bytes(bytes, shortMap) {
        var idx = {}; for (var s = 0; s < shortMap.length; s++) idx[shortMap[s]] = s;
        var vals = [], acc = 0, bits = 0, i;
        for (i = 0; i < bytes.length; i++) { acc = (acc << 8) | bytes[i]; bits += 8; while (bits >= 7) { bits -= 7; vals.push((acc >>> bits) & 0x7f); acc &= (1 << bits) - 1; } }
        if (bits > 0) vals.push((acc << (7 - bits)) & 0x7f);
        var out = "";
        for (var x = 0; x < vals.length; x++) {
            var v = vals[x], si = idx[v];
            if (si === undefined) out += String.fromCharCode(v);
            else if (x + 1 < vals.length) out += String.fromCharCode((si << 8) | 0x80 | vals[++x]);
            else out += String.fromCharCode((7 << 8) | 0x80 | v);
        }
        return out;
    }
    // ── SAY-packer: gói bytes thành package mà unpackMesh bung lại đúng bytes (toàn reference, không dedup) ──
    function sayPack(bytes) {
        var l = 64, padded = Math.ceil(bytes.length / l) * l, r = padded / l;
        while (r > 32767) { l *= 2; padded = Math.ceil(bytes.length / l) * l; r = padded / l; }
        var a = r * 2, t = padded, out = new Uint8Array(15 + a + t);
        out[0] = 83; out[1] = 65; out[2] = 89;
        out[3] = a & 255; out[4] = (a >>> 8) & 255; out[5] = (a >>> 16) & 255; out[6] = (a >>> 24) & 255;
        out[7] = t & 255; out[8] = (t >>> 8) & 255; out[9] = (t >>> 16) & 255; out[10] = (t >>> 24) & 255;
        out[11] = r & 255; out[12] = (r >>> 8) & 255; out[13] = l; out[14] = l;
        for (var i = 0; i < r; i++) { var o = 0x8000 | i; out[15 + i * 2] = (o >>> 8) & 255; out[15 + i * 2 + 1] = o & 255; }
        out.set(bytes, 15 + a);
        return out;
    }
    var DEFAULT_KILLEGALS = [0, 10, 13, 34, 38, 92];
    function parseKIllegals(html) {
        var m = html.match(/K_ILLEGALS\s*=\s*\[([0-9,\s]*)\]/);
        if (!m) return DEFAULT_KILLEGALS.slice();
        return m[1].split(",").map(function (x) { return parseInt(x.trim(), 10); }).filter(function (x) { return !isNaN(x); });
    }
    // Ghi bytes theo ĐÚNG định dạng gốc (mime/encoding/packed) → engine nhận đúng.
    function encodeBinaryLikeOriginal(bytes, fmt, kIllegals) {
        if (fmt.encoding === "base122") {
            var payload = fmt.packed ? sayPack(bytes) : bytes;
            return "data:" + fmt.mime + ";base122," + encodeBase122Bytes(payload, kIllegals || DEFAULT_KILLEGALS);
        }
        // base64 (PocketSort): giữ nguyên hành vi cũ
        var b64 = fmt.packed ? sayPack(bytes) : bytes;
        return "data:" + (fmt.mime || "application/octet-stream") + ";base64," + encodeBase64Bytes(b64);
    }
    function dvOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

    // ───────────────────────── đọc window.__res ─────────────────────────
    function braceMatch(s, i) {
        var d = 0, q = false, esc = false;
        for (; i < s.length; i++) {
            var c = s[i];
            if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') q = false; continue; }
            if (c === '"') q = true; else if (c === "{") d++; else if (c === "}") { if (--d === 0) return i; }
        }
        return -1;
    }
    function arrMatch(s, i) {
        var d = 0, q = false, esc = false;
        for (; i < s.length; i++) {
            var c = s[i];
            if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') q = false; continue; }
            if (c === '"') q = true; else if (c === "[") d++; else if (c === "]") { if (--d === 0) return i; }
        }
        return -1;
    }
    function extractRes(html) {
        var p = html.indexOf("window.__res");
        if (p < 0) throw new Error("Không tìm thấy window.__res — file có thể không phải playable Cocos/SayGames.");
        var braceStart = html.indexOf("{", p), braceEnd = braceMatch(html, braceStart);
        if (braceEnd < 0) throw new Error("Object window.__res bị lỗi cú pháp (không đóng ngoặc).");
        var objText = html.slice(braceStart, braceEnd + 1);
        var res = (new Function("return (" + objText + ")"))(); // object literal chịu được dấu phẩy thừa
        return { res: res, braceStart: braceStart, braceEnd: braceEnd };
    }

    // ───────────────────────── mesh metadata (cc.Mesh) ─────────────────────────
    var GL_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4, 5126: 4 };
    function parseRange(r) { return r.length === 2 ? { offset: 0, length: r[1] } : { offset: r[1], length: r[2] }; }

    function parseMeshStructs(res) {
        var structs = [];
        for (var k in res) {
            if (!res.hasOwnProperty(k)) continue;
            if (!/\.json$/i.test(k) || res[k].indexOf('".bin"') < 0) continue;
            var txt = res[k], re = /\[\d+,"\.bin"/g, m;
            while ((m = re.exec(txt))) {
                var s = m.index, e = arrMatch(txt, s);
                var sub = txt.slice(s, e + 1), arr;
                try { arr = JSON.parse(sub); } catch (err) { continue; }
                if (arr[1] !== ".bin" || !isArray(arr[2]) || !isArray(arr[3])) continue;
                var bundles = arr[2].map(function (vb) {
                    var formats = vb[3].map(function (f) { return { name: f[1], type: f[2], num: f[3] }; });
                    var stride = 0; for (var i = 0; i < formats.length; i++) stride += GL_SIZE[formats[i].type] * formats[i].num;
                    var rng = parseRange(vb[2]);
                    return { vc: vb[1], offset: rng.offset, length: rng.length, formats: formats, stride: stride };
                });
                var prims = arr[3].map(function (p) {
                    var rng = parseRange(p[2]);
                    return { bundle: (p[1] && p[1][0]) || 0, offset: rng.offset, length: rng.length };
                });
                var total = 0, i;
                for (i = 0; i < bundles.length; i++) total = Math.max(total, bundles[i].offset + bundles[i].length);
                for (i = 0; i < prims.length; i++) total = Math.max(total, prims[i].offset + prims[i].length);
                structs.push({ importKey: k, structText: sub, arr: arr, bundles: bundles, prims: prims, total: total, minPos: arr[4], maxPos: arr[5] });
            }
        }
        return structs;
    }
    function isArray(x) { return Object.prototype.toString.call(x) === "[object Array]"; }

    // giải mã geometry của 1 mesh từ buffer .bin
    function decodeMeshGeometry(desc, u8) {
        var dv = dvOf(u8);
        var bundles = desc.bundles.map(function (b) {
            var pos = [], nrm = [], uv = [];
            for (var v = 0; v < b.vc; v++) {
                var p = b.offset + v * b.stride, rec = {};
                for (var fi = 0; fi < b.formats.length; fi++) {
                    var f = b.formats[fi], vals = [];
                    for (var c = 0; c < f.num; c++) { vals.push(dv.getFloat32(p, true)); p += 4; }
                    rec[f.name] = vals;
                }
                pos.push(rec.a_position || [0, 0, 0]);
                nrm.push(rec.a_normal || [0, 0, 1]);
                uv.push(rec.a_uv0 || rec.a_uv || [0, 0]); // CHỈ lấy uv0 (bỏ a_uv1/lightmap — trước đây gộp nhầm)
            }
            return { vc: b.vc, pos: pos, nrm: nrm, uv: uv };
        });
        var prims = desc.prims.map(function (p) {
            var stride = desc.bundles[p.bundle].vc > 65535 ? 4 : 2;
            var count = p.length / stride, idx = [];
            for (var k = 0; k < count; k++) idx.push(stride === 2 ? dv.getUint16(p.offset + k * 2, true) : dv.getUint32(p.offset + k * 4, true));
            return { bundle: p.bundle, idx: idx, indexStride: stride };
        });
        return { bundles: bundles, prims: prims };
    }

    // ───────────────────────── texture ─────────────────────────
    function extToMime(ext) {
        if (/jpe?g/.test(ext)) return "image/jpeg";
        if (/webp/.test(ext)) return "image/webp";
        return "image/png";
    }
    function encOf(dataUri) {
        var m = dataUri.match(/^data:[^,]*;([a-z0-9]+),/i);
        return m ? m[1].toLowerCase() : "";
    }
    // previewUri LUÔN là base64 để <img> render được (base122/raw sẽ được giải mã + re-encode)
    function listTextures(res) {
        var out = [];
        for (var k in res) {
            if (!res.hasOwnProperty(k)) continue;
            if (!/\.(png|jpe?g|webp)$/i.test(k)) continue;
            var val = res[k];
            if (typeof val !== "string" || val.indexOf("data:") !== 0) continue;
            var ext = (k.match(/\.[^.]+$/) || [""])[0].toLowerCase();
            var enc = encOf(val), previewUri = val, bytes = Math.floor(val.length * 0.75);
            if (enc && enc !== "base64") {
                try { var b = baseToArray(val); bytes = b.length; previewUri = "data:" + extToMime(ext) + ";base64," + encodeBase64Bytes(b); }
                catch (e) { previewUri = ""; }
            }
            out.push({ key: k, uuid: k.split("/").pop().replace(/\.[^.]+$/, ""), ext: ext, dataUri: val, previewUri: previewUri, encoding: enc, bytes: bytes });
        }
        return out;
    }

    // ───────────────────────── phân tích tổng thể playable ─────────────────────────
    function analyzePlayable(html) {
        var ex = extractRes(html), res = ex.res;
        // decode tất cả .bin
        var bins = {};
        for (var k in res) {
            if (!res.hasOwnProperty(k) || !/\.bin$/i.test(k)) continue;
            bins[k] = decodeBinary(res[k]);
        }
        var binKeys = Object.keys(bins);
        var structs = parseMeshStructs(res);

        // match struct ↔ bin theo size + bounding-box
        var used = {};
        var meshes = structs.map(function (st, idx) {
            // ưu tiên khớp size chính xác; nếu không (vd bin đã bị tool này SAY-pack lại,
            // có padding), chấp nhận bin lớn hơn ≤128 byte — struct đọc theo offset nên vẫn đúng.
            var exact = binKeys.filter(function (bk) { return bins[bk].length === st.total; });
            var pool = exact.length ? exact : binKeys.filter(function (bk) { return bins[bk].length >= st.total && bins[bk].length <= st.total + 128; });
            var chosen = null, best = Infinity, geo = null;
            var free = pool.filter(function (bk) { return !used[bk]; });
            var candidates = free.length ? free : pool;
            for (var ci = 0; ci < candidates.length; ci++) {
                var bk = candidates[ci];
                var g = decodeMeshGeometry(st, bins[bk]);
                var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
                for (var bi = 0; bi < g.bundles.length; bi++) for (var pi = 0; pi < g.bundles[bi].pos.length; pi++) {
                    var pp = g.bundles[bi].pos[pi];
                    for (var d = 0; d < 3; d++) { if (pp[d] < mn[d]) mn[d] = pp[d]; if (pp[d] > mx[d]) mx[d] = pp[d]; }
                }
                var score = 0;
                if (st.minPos && st.maxPos) for (var q = 0; q < 3; q++) score += Math.abs(mn[q] - st.minPos[q + 1]) + Math.abs(mx[q] - st.maxPos[q + 1]);
                if (score < best) { best = score; chosen = bk; geo = g; }
            }
            if (chosen) used[chosen] = true;
            var verts = 0, tris = 0;
            for (var b2 = 0; b2 < st.bundles.length; b2++) verts += st.bundles[b2].vc;
            for (var p2 = 0; p2 < geo.prims.length; p2++) tris += geo.prims[p2].idx.length / 3;
            return {
                index: idx, binKey: chosen, binUuid: chosen ? chosen.split("/").pop().replace(/\.bin$/i, "") : null,
                binFmt: chosen ? binFormat(res[chosen]) : { mime: "application/octet-stream", encoding: "base64", packed: false },
                descriptor: st, geometry: geo, verts: verts, tris: tris, submeshes: st.prims.length, matchScore: best
            };
        });

        return { html: html, braceStart: ex.braceStart, braceEnd: ex.braceEnd, res: res, kIllegals: parseKIllegals(html), meshes: meshes, textures: listTextures(res) };
    }

    // ───────────────────────── nạp model mới (.glb/.obj) ─────────────────────────
    function loadModel(arrayBuffer, name) {
        var ext = (String(name).match(/\.[^.]+$/) || [""])[0].toLowerCase();
        if (ext === ".glb") return loadGLB(arrayBuffer);
        if (ext === ".obj") return loadOBJ(typeof arrayBuffer === "string" ? arrayBuffer : new TextDecoder().decode(new Uint8Array(arrayBuffer)));
        if (ext === ".gltf") throw new Error("Chỉ hỗ trợ .glb (glTF nhị phân), không hỗ trợ .gltf rời. Hãy export dạng .glb.");
        throw new Error("Chỉ hỗ trợ .glb hoặc .obj");
    }
    function loadGLB(arrayBuffer) {
        var buf = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
        var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (dv.getUint32(0, true) !== 0x46546C67) throw new Error("File .glb sai magic (không phải glTF nhị phân).");
        var o = 12, json = null, bin = null;
        while (o < buf.length) {
            var len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true); o += 8;
            var chunk = buf.subarray(o, o + len); o += len;
            if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
            else if (type === 0x004E4942) bin = chunk;
        }
        if (!json) throw new Error("File .glb thiếu chunk JSON.");
        var bdv = bin ? new DataView(bin.buffer, bin.byteOffset, bin.byteLength) : null;
        var CT = { 5121: [1, "getUint8"], 5123: [2, "getUint16"], 5125: [4, "getUint32"], 5126: [4, "getFloat32"] };
        var TN = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
        function read(ai) {
            if (ai == null) return null;
            var a = json.accessors[ai], bv = json.bufferViews[a.bufferView];
            var cs = CT[a.componentType][0], fn = CT[a.componentType][1], n = TN[a.type];
            var base = (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || cs * n, out = [];
            for (var e = 0; e < a.count; e++) {
                var row = [];
                for (var c = 0; c < n; c++) row.push(bdv[fn](base + e * st + c * cs, true));
                out.push(n === 1 ? row[0] : row);
            }
            return out;
        }
        // ── bake transform node (T·R·S) vào geometry — nếu không, model bị sai hướng/scale
        // (Blender thường gắn xoay 90°X + scale vào node) → model dẹt có thể nhìn nghiêng cạnh → "biến mất".
        function composeTRS(node) {
            if (node.matrix) return node.matrix.slice(); // đã column-major 16 phần tử
            var t = node.translation || [0, 0, 0], q = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
            var x = q[0], y = q[1], z = q[2], w = q[3], sx = s[0], sy = s[1], sz = s[2];
            return [
                (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + w * z)) * sx, (2 * (x * z - w * y)) * sx, 0,
                (2 * (x * y - w * z)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + w * x)) * sy, 0,
                (2 * (x * z + w * y)) * sz, (2 * (y * z - w * x)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
                t[0], t[1], t[2], 1
            ];
        }
        function mul(a, b) {
            var m = new Array(16);
            for (var col = 0; col < 4; col++) for (var row = 0; row < 4; row++)
                m[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
            return m;
        }
        function tPoint(m, v) { return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]; }
        function tDir(m, v) { var x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
        var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

        // uv1 = kênh UV thứ 2 (TEXCOORD_1, thường là lightmap). parts = ranh giới từng
        // primitive (mỗi primitive ~ 1 material/submesh) để giữ được binding đa-material.
        var pos = [], nrm = [], uv = [], uv1 = [], idx = [], parts = [];
        function addMesh(meshIdx, world) {
            var prims = json.meshes[meshIdx].primitives;
            for (var pi = 0; pi < prims.length; pi++) {
                var pr = prims[pi];
                var P = read(pr.attributes.POSITION), N = read(pr.attributes.NORMAL),
                    U = read(pr.attributes.TEXCOORD_0), U1 = read(pr.attributes.TEXCOORD_1);
                var I = read(pr.indices);
                if (!I) { I = []; for (var t = 0; t < P.length; t++) I.push(t); }
                var b = pos.length, idxStart = idx.length;
                for (var v = 0; v < P.length; v++) {
                    pos.push(tPoint(world, P[v]));
                    nrm.push(N ? tDir(world, N[v]) : [0, 0, 1]);
                    uv.push(U ? U[v] : [0, 0]);
                    uv1.push(U1 ? U1[v] : null); // null → buildBin sẽ fallback uv0 cho a_uv1
                }
                for (var ii = 0; ii < I.length; ii++) idx.push(I[ii] + b);
                parts.push({ material: pr.material == null ? -1 : pr.material, idxStart: idxStart, idxCount: I.length });
            }
        }
        function visit(nodeIdx, parent) {
            var node = json.nodes[nodeIdx];
            var world = mul(parent, composeTRS(node));
            if (node.mesh != null) addMesh(node.mesh, world);
            var ch = node.children || [];
            for (var k = 0; k < ch.length; k++) visit(ch[k], world);
        }
        if (json.nodes && json.nodes.length) {
            var scene = json.scenes && json.scenes[json.scene || 0];
            var roots = scene && scene.nodes ? scene.nodes : json.nodes.map(function (_, i) { return i; });
            for (var r = 0; r < roots.length; r++) visit(roots[r], IDENT);
        } else {
            for (var mi = 0; mi < json.meshes.length; mi++) addMesh(mi, IDENT);
        }
        return { pos: pos, nrm: nrm, uv: uv, uv1: uv1, idx: idx, parts: parts };
    }
    function loadOBJ(text) {
        var vs = [], vns = [], vts = [], map = {}, pos = [], nrm = [], uv = [], idx = [];
        // parts theo 'usemtl' — mỗi nhóm material là 1 submesh. Nếu OBJ không có usemtl → 1 part.
        var groups = [], curName = null, curStart = 0;
        function closeGroup() { if (idx.length > curStart) groups.push({ material: curName, idxStart: curStart, idxCount: idx.length - curStart }); }
        var lines = text.split(/\r?\n/);
        for (var li = 0; li < lines.length; li++) {
            var t = lines[li].trim(); if (!t || t.charAt(0) === "#") continue;
            var pp = t.split(/\s+/);
            if (pp[0] === "v") vs.push([+pp[1], +pp[2], +pp[3]]);
            else if (pp[0] === "vn") vns.push([+pp[1], +pp[2], +pp[3]]);
            else if (pp[0] === "vt") vts.push([+pp[1], 1 - (+pp[2])]);
            else if (pp[0] === "usemtl") { closeGroup(); curName = pp[1] || ""; curStart = idx.length; }
            else if (pp[0] === "f") {
                var verts = [];
                for (var fi = 1; fi < pp.length; fi++) {
                    var tok = pp[fi];
                    if (map.hasOwnProperty(tok)) { verts.push(map[tok]); continue; }
                    var parts = tok.split("/");
                    var vi = +parts[0] - 1, ti = parts[1] ? +parts[1] - 1 : -1, ni = parts[2] ? +parts[2] - 1 : -1;
                    var id = pos.length;
                    pos.push(vs[vi]); uv.push(ti >= 0 ? vts[ti] : [0, 0]); nrm.push(ni >= 0 ? vns[ni] : [0, 0, 1]);
                    map[tok] = id; verts.push(id);
                }
                for (var k = 1; k + 1 < verts.length; k++) idx.push(verts[0], verts[k], verts[k + 1]);
            }
        }
        closeGroup();
        if (!groups.length) groups.push({ material: null, idxStart: 0, idxCount: idx.length });
        var uv1 = []; for (var u = 0; u < pos.length; u++) uv1.push(null); // OBJ không có kênh UV2
        return { pos: pos, nrm: nrm, uv: uv, uv1: uv1, idx: idx, parts: groups };
    }

    // ───────────────────────── build .bin + struct mới ─────────────────────────
    function strideOf(formats) { var s = 0; for (var i = 0; i < formats.length; i++) s += GL_SIZE[formats[i].type] * formats[i].num; return s; }
    // Giá trị attribute của đỉnh v cho 1 format — phân biệt a_uv0 vs a_uv1 (trước đây gộp
    // nhầm cả hai về uv0). a_uv1 lấy từ kênh uv1 (lightmap); thiếu thì fallback uv0.
    function attrValue(model, v, f) {
        var n = f.name;
        if (n === "a_position") return model.pos[v];
        if (n === "a_normal") return model.nrm[v] || [0, 0, 1];
        if (/uv1|uv_1|lightmap/i.test(n)) return (model.uv1 && model.uv1[v]) || model.uv[v] || [0, 0];
        if (/uv/i.test(n)) return model.uv[v] || [0, 0]; // a_uv0 / a_uv / a_texcoord0
        if (/color/i.test(n)) return [1, 1, 1, 1];       // mặc định trắng (0,0,0,0 sẽ làm mesh đen)
        if (n === "a_tangent") return [1, 0, 0, 1];
        return [];
    }
    // build 1 vertex-buffer + 1 index-buffer (mesh 1 submesh). Giữ nguyên chữ ký cũ.
    function buildBin(model, formats) {
        var stride = strideOf(formats);
        var vc = model.pos.length;
        var vbuf = new Uint8Array(vc * stride), vdv = new DataView(vbuf.buffer);
        var o = 0, v, fi2, f, c, vals;
        for (v = 0; v < vc; v++) {
            for (fi2 = 0; fi2 < formats.length; fi2++) {
                f = formats[fi2]; vals = attrValue(model, v, f);
                for (c = 0; c < f.num; c++) { vdv.setFloat32(o, vals[c] || 0, true); o += 4; }
            }
        }
        var ibuf = new Uint8Array(model.idx.length * 2), idv = new DataView(ibuf.buffer);
        for (var i = 0; i < model.idx.length; i++) idv.setUint16(i * 2, model.idx[i], true);
        var out = new Uint8Array(vbuf.length + ibuf.length);
        out.set(vbuf, 0); out.set(ibuf, vbuf.length);
        return { bytes: out, vbytes: vbuf.length, ibytes: ibuf.length, vc: vc };
    }
    // Chuẩn hoá số part của model mới về ĐÚNG N submesh của mesh cũ (để khớp N material của
    // renderer). N==M: map 1-1. Khác: dồn toàn bộ vào submesh 0, các submesh còn lại rỗng
    // (vẫn giữ đủ N binding material — engine vẽ 0 tam giác cho material thừa, không vỡ).
    function normalizeParts(model, N, parsedList, rawList) {
        var mp = (model.parts && model.parts.length) ? model.parts : [{ idxStart: 0, idxCount: model.idx.length }];
        function P(i) { return parsedList[i] || parsedList[0]; }
        function R(i) { return rawList[i] || rawList[0]; }
        var out = [], i;
        if (mp.length === N) {
            for (i = 0; i < N; i++) out.push({ idxStart: mp[i].idxStart, idxCount: mp[i].idxCount, formats: P(i), rawFormats: R(i) });
            return { parts: out, mode: "1-1" };
        }
        out.push({ idxStart: 0, idxCount: model.idx.length, formats: P(0), rawFormats: R(0) });
        for (i = 1; i < N; i++) out.push({ idxStart: 0, idxCount: 0, formats: P(i), rawFormats: R(i) });
        return { parts: out, mode: mp.length + "→" + N };
    }
    // build .bin đa submesh. parts[i]={idxStart,idxCount,formats} (đã chuẩn hoá, dài N).
    // Bố cục [vb0,ib0,vb1,ib1,...] khớp layout gốc SayGames. Mỗi submesh có bundle riêng,
    // vertices được tách + reindex local; submesh rỗng → prim 0-index trỏ bundle 0.
    function buildBinMulti(model, parts) {
        var perPart = [], i, k;
        for (i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p.idxCount) { perPart.push({ empty: true }); continue; }
            var remap = {}, localVerts = [], localIdx = [];
            for (k = 0; k < p.idxCount; k++) {
                var g = model.idx[p.idxStart + k], loc = remap[g];
                if (loc === undefined) { loc = localVerts.length; remap[g] = loc; localVerts.push(g); }
                localIdx.push(loc);
            }
            var stride = strideOf(p.formats);
            var vbuf = new Uint8Array(localVerts.length * stride), vdv = new DataView(vbuf.buffer), o = 0;
            for (var lv = 0; lv < localVerts.length; lv++) {
                for (var fi = 0; fi < p.formats.length; fi++) {
                    var f = p.formats[fi], vals = attrValue(model, localVerts[lv], f);
                    for (var c = 0; c < f.num; c++) { vdv.setFloat32(o, vals[c] || 0, true); o += 4; }
                }
            }
            var ibuf = new Uint8Array(localIdx.length * 2), idv = new DataView(ibuf.buffer);
            for (var ii = 0; ii < localIdx.length; ii++) idv.setUint16(ii * 2, localIdx[ii], true);
            perPart.push({ empty: false, vbuf: vbuf, ibuf: ibuf, vc: localVerts.length, formats: p.formats, rawFormats: p.rawFormats });
        }
        var offset = 0, bundles = [], prims = [];
        for (i = 0; i < perPart.length; i++) {
            var pp = perPart[i];
            if (pp.empty) { prims.push({ bundleRef: 0, iboff: offset, ibytes: 0, ibuf: null }); continue; }
            var vboff = offset; offset += pp.vbuf.length;
            var iboff = offset; offset += pp.ibuf.length;
            var bidx = bundles.length;
            bundles.push({ vc: pp.vc, vboff: vboff, vbytes: pp.vbuf.length, formats: pp.formats, rawFormats: pp.rawFormats, vbuf: pp.vbuf });
            prims.push({ bundleRef: bidx, iboff: iboff, ibytes: pp.ibuf.length, ibuf: pp.ibuf });
        }
        var bytes = new Uint8Array(offset);
        for (i = 0; i < bundles.length; i++) bytes.set(bundles[i].vbuf, bundles[i].vboff);
        for (i = 0; i < prims.length; i++) if (prims[i].ibuf) bytes.set(prims[i].ibuf, prims[i].iboff);
        return { bytes: bytes, total: offset, bundles: bundles, prims: prims };
    }
    function boundsOf(pos) {
        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (var i = 0; i < pos.length; i++) for (var k = 0; k < 3; k++) { if (pos[i][k] < mn[k]) mn[k] = pos[i][k]; if (pos[i][k] > mx[k]) mx[k] = pos[i][k]; }
        return { mn: mn, mx: mx };
    }
    // Scale + căn giữa model mới cho khớp bounding-box [mn,mx] (thường là của mesh cũ).
    // stretch=false: scale đều (giữ tỉ lệ). stretch=true: khớp từng trục (lấp đầy đúng bbox).
    // Trả { model, scale:[sx,sy,sz] }.
    function fitModelToBounds(model, mn, mx, stretch) {
        var nb = boundsOf(model.pos);
        var oldC = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
        var newC = [(nb.mn[0] + nb.mx[0]) / 2, (nb.mn[1] + nb.mx[1]) / 2, (nb.mn[2] + nb.mx[2]) / 2];
        var oS = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
        var nS = [nb.mx[0] - nb.mn[0], nb.mx[1] - nb.mn[1], nb.mx[2] - nb.mn[2]];
        var sx, sy, sz;
        if (stretch) { sx = nS[0] ? oS[0] / nS[0] : 1; sy = nS[1] ? oS[1] / nS[1] : 1; sz = nS[2] ? oS[2] / nS[2] : 1; }
        else { var om = Math.max(oS[0], oS[1], oS[2]), nm = Math.max(nS[0], nS[1], nS[2]); sx = sy = sz = nm ? om / nm : 1; }
        var pos = model.pos.map(function (p) { return [(p[0] - newC[0]) * sx + oldC[0], (p[1] - newC[1]) * sy + oldC[1], (p[2] - newC[2]) * sz + oldC[2]]; });
        var nrm = model.nrm;
        if (stretch) nrm = model.nrm.map(function (n) { var x = n[0] / sx, y = n[1] / sy, z = n[2] / sz, l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; });
        return { model: { pos: pos, nrm: nrm, uv: model.uv, uv1: model.uv1, idx: model.idx, parts: model.parts }, scale: [sx, sy, sz] };
    }

    // Ánh xạ UV của model vào ô texture [umin,umax]x[vmin,vmax] mà mesh cũ đang dùng — để dùng
    // chung material/atlas: hình dạng mới nhưng LẤY ĐÚNG vùng màu của part cũ. Ô bề rộng 0
    // (part cũ chỉ lấy 1 điểm/1 màu đặc) -> mọi UV dồn về tâm ô -> ra đúng màu đặc đó.
    function remapModelUV(model, box) {
        var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (var i = 0; i < model.uv.length; i++) {
            var u = model.uv[i][0], v = model.uv[i][1];
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        var du = uMax - uMin, dv = vMax - vMin, tu = box.umax - box.umin, tv = box.vmax - box.vmin;
        var uv = model.uv.map(function (p) {
            return [
                du ? box.umin + (p[0] - uMin) / du * tu : box.umin + tu / 2,
                dv ? box.vmin + (p[1] - vMin) / dv * tv : box.vmin + tv / 2
            ];
        });
        return { pos: model.pos, nrm: model.nrm, uv: uv, uv1: model.uv1, idx: model.idx, parts: model.parts };
    }

    // ───────────────────────── định hướng (PCA + xoay khớp trục mỏng) ─────────────────────────
    var IDENT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    function mat3mul(a, b) {
        var m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (var r = 0; r < 3; r++) for (var col = 0; col < 3; col++) m[r * 3 + col] = a[r * 3] * b[col] + a[r * 3 + 1] * b[3 + col] + a[r * 3 + 2] * b[6 + col];
        return m;
    }
    function mat3apply(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
    // ma trận xoay 90°·k quanh 1 trục (0=X,1=Y,2=Z) — cho nút xoay tay
    function rot90mat(axis, k) {
        var C = [1, 0, -1, 0], S = [0, 1, 0, -1], i = ((k % 4) + 4) % 4, c = C[i], s = S[i];
        if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
        if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
        return [c, -s, 0, s, c, 0, 0, 0, 1];
    }
    function normalize3(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
    // eigen của ma trận đối xứng 3x3 bằng Jacobi → {val:[3], vec:[[cột],[cột],[cột]]}
    function jacobi3(A) {
        var a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
        var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (var iter = 0; iter < 50; iter++) {
            var p = 0, q = 1, mx = Math.abs(a[0][1]);
            if (Math.abs(a[0][2]) > mx) { mx = Math.abs(a[0][2]); p = 0; q = 2; }
            if (Math.abs(a[1][2]) > mx) { mx = Math.abs(a[1][2]); p = 1; q = 2; }
            if (mx < 1e-14) break;
            var phi = 0.5 * Math.atan2(2 * a[p][q], a[p][p] - a[q][q]);
            var c = Math.cos(phi), s = Math.sin(phi);
            var i;
            for (i = 0; i < 3; i++) { var aip = a[i][p], aiq = a[i][q]; a[i][p] = c * aip - s * aiq; a[i][q] = s * aip + c * aiq; }
            for (i = 0; i < 3; i++) { var api = a[p][i], aqi = a[q][i]; a[p][i] = c * api - s * aqi; a[q][i] = s * api + c * aqi; }
            for (i = 0; i < 3; i++) { var vip = v[i][p], viq = v[i][q]; v[i][p] = c * vip - s * viq; v[i][q] = s * vip + c * viq; }
        }
        return { val: [a[0][0], a[1][1], a[2][2]], vec: v };
    }
    // trục mỏng (disc-axis) + độ dẹt (var nhỏ nhất / var kế tiếp; càng nhỏ càng dẹt rõ)
    function thinAxis(pos) {
        var n = pos.length, cx = 0, cy = 0, cz = 0, i;
        for (i = 0; i < n; i++) { cx += pos[i][0]; cy += pos[i][1]; cz += pos[i][2]; }
        cx /= n; cy /= n; cz /= n;
        var m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < n; i++) { var dx = pos[i][0] - cx, dy = pos[i][1] - cy, dz = pos[i][2] - cz; m[0][0] += dx * dx; m[1][1] += dy * dy; m[2][2] += dz * dz; m[0][1] += dx * dy; m[0][2] += dx * dz; m[1][2] += dy * dz; }
        m[1][0] = m[0][1]; m[2][0] = m[0][2]; m[2][1] = m[1][2];
        var e = jacobi3(m);
        var i0 = 0; if (e.val[1] < e.val[i0]) i0 = 1; if (e.val[2] < e.val[i0]) i0 = 2;
        var sorted = e.val.slice().sort(function (x, y) { return x - y; });
        var flat = sorted[1] > 1e-20 ? sorted[0] / sorted[1] : 1;
        return { axis: normalize3([e.vec[0][i0], e.vec[1][i0], e.vec[2][i0]]), flatness: flat };
    }
    // ma trận xoay đưa vector đơn vị a → b (Rodrigues)
    function rotationBetween(a, b) {
        var v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        var c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        if (c > 0.99999) return IDENT3.slice();
        if (c < -0.99999) { var p = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; var ax = normalize3([a[1] * p[2] - a[2] * p[1], a[2] * p[0] - a[0] * p[2], a[0] * p[1] - a[1] * p[0]]); return [2 * ax[0] * ax[0] - 1, 2 * ax[0] * ax[1], 2 * ax[0] * ax[2], 2 * ax[0] * ax[1], 2 * ax[1] * ax[1] - 1, 2 * ax[1] * ax[2], 2 * ax[0] * ax[2], 2 * ax[1] * ax[2], 2 * ax[2] * ax[2] - 1]; }
        var vx = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0], vx2 = mat3mul(vx, vx), k = 1 / (1 + c), m = [];
        for (var i = 0; i < 9; i++) m[i] = IDENT3[i] + vx[i] + vx2[i] * k;
        return m;
    }
    // xoay geometry model theo ma trận 3x3 (áp cả normal, chuẩn hoá lại)
    function rotateModel(model, m3) {
        return {
            pos: model.pos.map(function (p) { return mat3apply(m3, p); }),
            nrm: model.nrm.map(function (nn) { return normalize3(mat3apply(m3, nn)); }),
            uv: model.uv, uv1: model.uv1, idx: model.idx, parts: model.parts
        };
    }
    // Tính ma trận tự-xoay: đưa trục mỏng model mới → trục mỏng mesh cũ. Chỉ khi cả hai đủ dẹt.
    function autoOrientRotation(newPos, oldPos) {
        var nt = thinAxis(newPos), ot = thinAxis(oldPos);
        if (nt.flatness > 0.5 || ot.flatness > 0.5) return { mat: IDENT3.slice(), aligned: false, reason: "không dẹt rõ" };
        var a = nt.axis, b = ot.axis;
        if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) b = [-b[0], -b[1], -b[2]]; // chọn chiều gần nhất
        return { mat: rotationBetween(a, b), aligned: true };
    }

    // clone mask-id từ struct gốc, gộp về 1 bundle + 1 prim
    function buildStruct(orig, nb, mn, mx) {
        var vbMask = orig[2][0][0], rangeMask = orig[2][0][2][0];
        var primMask = orig[3][0][0], primRangeMask = orig[3][0][2][0], vec3Mask = orig[4][0];
        return [
            orig[0], ".bin",
            [[vbMask, nb.vc, [rangeMask, nb.vbytes], orig[2][0][3]]],
            [[primMask, [0], [primRangeMask, nb.vbytes, nb.ibytes]]],
            [vec3Mask, mn[0], mn[1], mn[2]],
            [vec3Mask, mx[0], mx[1], mx[2]]
        ];
    }
    // struct đa submesh: N bundle + N prim, offset lấy từ built (buildBinMulti). Mask-id +
    // định dạng formats lấy đúng từng bundle gốc để engine deserialize khớp. Range dùng dạng
    // [mask,length] khi offset==0 (bundle đầu) và [mask,offset,length] khi offset>0 (như gốc).
    function buildStructMulti(orig, built, mn, mx) {
        var vbMask = orig[2][0][0], primMask = orig[3][0][0], vec3Mask = orig[4][0];
        var offMask = orig[3][0][2][0]; // range kiểu offset+length (prim gốc luôn có)
        var lenMask = (orig[2][0][2].length === 2) ? orig[2][0][2][0] : offMask; // range kiểu chỉ-length
        var bundlesArr = built.bundles.map(function (b) {
            var range = (b.vboff === 0) ? [lenMask, b.vbytes] : [offMask, b.vboff, b.vbytes];
            return [vbMask, b.vc, range, b.rawFormats];
        });
        var primsArr = built.prims.map(function (p) {
            return [primMask, [p.bundleRef], [offMask, p.iboff, p.ibytes]];
        });
        return [orig[0], ".bin", bundlesArr, primsArr, [vec3Mask, mn[0], mn[1], mn[2]], [vec3Mask, mx[0], mx[1], mx[2]]];
    }

    // ───────────────────────── áp dụng thay đổi ─────────────────────────
    // Escape 1 chuỗi như khi nằm trong string-literal của __res (để khớp HTML thô).
    function escapeJsStr(s) { return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }
    // Thay chuỗi con (literal) đầu tiên trong html; lỗi nếu không có, lỗi nếu trùng >1.
    function rawReplace(html, find, repl, what) {
        var i = html.indexOf(find);
        if (i < 0) throw new Error("Không định vị được " + what + " trong HTML (file đã bị sửa / định dạng khác?).");
        if (html.indexOf(find, i + find.length) >= 0) throw new Error("Chuỗi " + what + " xuất hiện >1 lần — dừng để tránh sửa nhầm.");
        return html.slice(0, i) + repl + html.slice(i + find.length);
    }

    // Thay THẲNG trên HTML gốc thay vì JSON.stringify lại toàn bộ __res.
    // Lý do: __res có thể chứa asset base122 với ~20% ký tự điều khiển (<0x20); JSON.stringify
    // sẽ escape chúng thành \uXXXX làm phình file ~1.5× (vượt giới hạn ad-network như Applovin).
    function applyMeshReplacement(analysis, meshIndex, model) {
        var mesh = analysis.meshes[meshIndex];
        if (!mesh || !mesh.binKey) throw new Error("Mesh #" + meshIndex + " không có buffer để thay.");
        if (model.pos.length > 65535) throw new Error("Model mới có " + model.pos.length + " đỉnh, vượt giới hạn index 16-bit (65535).");
        var desc = mesh.descriptor;
        var bb = boundsOf(model.pos);
        var multi = desc.prims.length > 1 || desc.bundles.length > 1 || (model.parts && model.parts.length > 1);
        var newStruct, newBinBytes, newBundles, newPrims, vertsTotal;
        if (multi) {
            // Số submesh phải khớp SỐ MATERIAL của renderer = số prim gốc (mỗi prim ~ 1 material).
            var N = desc.prims.length;
            var parsedList = desc.prims.map(function (p) { return desc.bundles[p.bundle].formats; });
            var rawList = desc.prims.map(function (p) { return desc.arr[2][p.bundle][3]; });
            var norm = normalizeParts(model, N, parsedList, rawList);
            var built = buildBinMulti(model, norm.parts);
            newStruct = buildStructMulti(desc.arr, built, bb.mn, bb.mx);
            newBinBytes = built.bytes;
            newBundles = built.bundles.map(function (b) { return { vc: b.vc, offset: b.vboff, length: b.vbytes, formats: b.formats, stride: b.vc ? b.vbytes / b.vc : 0 }; });
            newPrims = built.prims.map(function (p) { return { bundle: p.bundleRef, offset: p.iboff, length: p.ibytes }; });
            vertsTotal = built.bundles.reduce(function (s, b) { return s + b.vc; }, 0);
            mesh.replaceMode = norm.mode;
        } else {
            var formats = desc.bundles[0].formats;
            var nb = buildBin(model, formats);
            newStruct = buildStruct(desc.arr, nb, bb.mn, bb.mx);
            newBinBytes = nb.bytes;
            newBundles = [{ vc: nb.vc, offset: 0, length: nb.vbytes, formats: formats, stride: nb.vc ? nb.vbytes / nb.vc : 0 }];
            newPrims = [{ bundle: 0, offset: nb.vbytes, length: nb.ibytes }];
            vertsTotal = nb.vc;
            mesh.replaceMode = "1-1";
        }
        var newText = JSON.stringify(newStruct);
        var oldBin = analysis.res[mesh.binKey];
        // GHI ĐÚNG ĐỊNH DẠNG GỐC (vd CarRace: data:sayMesh;base122, + nén SAY) — nếu ghi base64
        // cho mesh gốc nén SAY/base122 thì engine render vô hình dù bytes giống hệt.
        var newBin = encodeBinaryLikeOriginal(newBinBytes, mesh.binFmt, analysis.kIllegals);
        // edit trực tiếp trên HTML: struct (dạng escaped trong import JSON) + giá trị .bin (nguyên văn)
        analysis.html = rawReplace(analysis.html, escapeJsStr(desc.structText), escapeJsStr(newText), "struct mesh #" + meshIndex);
        analysis.html = rawReplace(analysis.html, oldBin, newBin, "buffer .bin mesh #" + meshIndex);
        // đồng bộ in-memory (cho preview + lần thay sau)
        analysis.res[mesh.binKey] = newBin;
        analysis.res[desc.importKey] = analysis.res[desc.importKey].split(desc.structText).join(newText);
        desc.structText = newText; desc.arr = newStruct;
        desc.bundles = newBundles;
        desc.prims = newPrims;
        desc.total = newBinBytes.length; desc.minPos = newStruct[4]; desc.maxPos = newStruct[5];
        mesh.geometry = decodeMeshGeometry(desc, newBinBytes);
        mesh.verts = vertsTotal; mesh.tris = model.idx.length / 3; mesh.submeshes = newPrims.length;
        return mesh;
    }
    function applyTextureReplacement(analysis, texKey, newDataUri) {
        if (!analysis.res.hasOwnProperty(texKey)) throw new Error("Không tìm thấy texture " + texKey);
        if (!/^data:/.test(newDataUri)) throw new Error("Texture mới phải là data URI (data:image/...;base64,...).");
        var oldVal = analysis.res[texKey];
        analysis.html = rawReplace(analysis.html, oldVal, newDataUri, "texture " + texKey);
        analysis.res[texKey] = newDataUri;
        for (var i = 0; i < analysis.textures.length; i++) if (analysis.textures[i].key === texKey) {
            analysis.textures[i].dataUri = newDataUri;
            analysis.textures[i].previewUri = newDataUri; // ảnh mới luôn base64 → render trực tiếp
            analysis.textures[i].encoding = "base64";
        }
    }
    // dựng data URI ảnh từ bytes (dùng khi lấy texture nhúng trong GLB)
    function imageDataUri(bytes, mime) {
        return "data:" + (mime || "image/png") + ";base64," + encodeBase64Bytes(bytes);
    }

    // ───────────────────────── xuất HTML mới ─────────────────────────
    // Trả HTML đã sửa trực tiếp (các apply* đã cập nhật analysis.html tại chỗ).
    function serialize(analysis) { return analysis.html; }

    return {
        // đọc / phân tích
        extractRes: extractRes,
        analyzePlayable: analyzePlayable,
        parseMeshStructs: parseMeshStructs,
        decodeMeshGeometry: decodeMeshGeometry,
        listTextures: listTextures,
        // decode/encode
        decodeBinary: decodeBinary,
        baseToArray: baseToArray,
        binFormat: binFormat,
        sayPack: sayPack,
        encodeBinaryLikeOriginal: encodeBinaryLikeOriginal,
        decodeBase64Bytes: decodeBase64Bytes,
        encodeBase64Bytes: encodeBase64Bytes,
        decodeBase122Bytes: decodeBase122Bytes,
        encodeBase122Bytes: encodeBase122Bytes,
        imageDataUri: imageDataUri,
        // model mới
        loadModel: loadModel,
        loadGLB: loadGLB,
        loadOBJ: loadOBJ,
        // thay & xuất
        buildBin: buildBin,
        buildStruct: buildStruct,
        buildBinMulti: buildBinMulti,
        buildStructMulti: buildStructMulti,
        normalizeParts: normalizeParts,
        fitModelToBounds: fitModelToBounds,
        remapModelUV: remapModelUV,
        autoOrientRotation: autoOrientRotation,
        rotateModel: rotateModel,
        rot90mat: rot90mat,
        mat3mul: mat3mul,
        thinAxis: thinAxis,
        applyMeshReplacement: applyMeshReplacement,
        applyTextureReplacement: applyTextureReplacement,
        serialize: serialize
    };
});
