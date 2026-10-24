/*
 * luna-core.js — đọc & sửa asset bên trong playable Luna (Unity → Luna Playground).
 * ------------------------------------------------------------------------------------
 * UMD, logic thuần (không DOM) → chạy cả browser lẫn Node (tests).
 * Global: window.LunaCore   |   Node: require("./luna-core")
 * Cần: brotli-core.js (BrotliCore), converter-core.js (PlayableConverter — base64/base122).
 *
 * Luna nhúng asset theo ba cách:
 *   1. Ảnh: <img id="assets/bundles/<bundle>/<id>.png" src="data:…"> hoặc data-src122="…".
 *      converter-core đã đọc/thay được; ở đây chỉ gắn tên thật lấy từ bundle.json.
 *   2. Mọi thứ khác: decompressString / decompressArrayBuffer("<payload>", isBase122)
 *        .then(function (x) { window.jsons|blobs|sounds["<key>"] = … })
 *      payload = Brotli, mã base122 CHUẨN (cờ true) hoặc base64 (cờ false — bản đi qua tool spy).
 *   3. Code game (Bridge.NET): decompressString("…").then(function (code) { window.eval(code) }).
 *
 * Mesh nằm trong assets/bundles/<id>/data.blob; bundle.json mô tả từng mesh theo DTO
 * Luna.Unity.DTO.UnityEngine.Assets.Mesh (đọc thẳng từ runtime Luna):
 *   data = [name, halfPrecision, useUInt32IndexFormat, vertexCount, aabb(center,extents),
 *           streams[10], [offset,len] đỉnh, submeshes[[[offset,len]]], bindposes, blendShapes]
 *   Đỉnh xếp xen kẽ theo thứ tự POSITION3 NORMAL3 TANGENT4 BLENDWEIGHT4 BLENDINDICES4 COLOR4
 *   UV0..UV3 (2), stream nào tắt thì bỏ; half-float hoặc float32.
 *
 * Hệ trục: Unity là tay TRÁI, UV gốc ở dưới. Model GLB/OBJ (và mesh-core) dùng tay phải, UV gốc
 * trên. Geometry đưa cho panel luôn ở hệ của model (lật X, đảo chiều tam giác, v → 1-v); chỉ
 * đổi về hệ Unity lúc ghi — nếu không model mới bị soi gương và mất mặt vì backface culling.
 */
(function (root, factory) {
    var api = factory(
        typeof module === "object" && module.exports ? require("./brotli-core") : root.BrotliCore,
        typeof module === "object" && module.exports ? require("./converter-core") : root.PlayableConverter
    );
    if (typeof module === "object" && module.exports) module.exports = api;
    root.LunaCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Brotli, Conv) {
    "use strict";

    function isLuna(html) {
        return /LunaCompilerV|Luna\.Unity\.(?:Playable|LifeCycle|Analytics)|LunaUnity\.Objects|window\._compressedAssets/.test(html);
    }

    // ───────────────────────── payload nén ─────────────────────────
    function readStringLiteral(html, quoteAt) {
        var quote = html[quoteAt];
        for (var j = quoteAt + 1; j < html.length; j++) {
            var c = html[j];
            if (c === "\\") { j++; continue; }
            if (c === quote) return j;
            if (c === "\n") return -1;
        }
        return -1;
    }

    // Payload Luna gốc không bao giờ có "\" (base122 chuẩn né 92), nhưng payload do tool ghi lại
    // có thể có "<\/" hoặc "<\!--" (chống đóng thẻ <script> sớm) → gỡ escape trước khi giải.
    function unescapeLiteral(raw) {
        if (raw.indexOf("\\") < 0) return raw;
        return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, function (_, e) {
            if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
            if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
            return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" })[e] || e;
        });
    }

    /**
     * Mọi lời gọi decompressString / decompressArrayBuffer có payload literal.
     * → [{ id, fn, base122, start, end, store: "jsons"|"blobs"|"sounds"|"code"|"unknown", key }]
     * start/end là offset NỘI DUNG chuỗi (không gồm dấu nháy).
     */
    function scanPayloads(html) {
        var out = [], re = /\b(decompressString|decompressArrayBuffer)\(\s*(["'])/g, m;
        while ((m = re.exec(html))) {
            var quoteAt = m.index + m[0].length - 1;
            var close = readStringLiteral(html, quoteAt);
            if (close < 0) continue;
            var tail = html.slice(close + 1, close + 400);
            var flag = tail.match(/^\s*,\s*(true|false|!0|!1)\s*\)/);
            var base122 = !!flag && (flag[1] === "true" || flag[1] === "!0");
            var store = "unknown", key = "";
            var assign = tail.match(/^[^;]*?\.then\(\s*(?:function\s*)?\(?\s*\w*\s*\)?\s*(?:=>)?\s*\{?\s*window\.(\w+)\s*\[\s*["']([^"']+)["']\s*\]\s*=/);
            if (assign) { store = assign[1]; key = assign[2]; }
            else if (/^[^;]*?\.then\([^;]*?\beval\(/.test(tail)) { store = "code"; key = "code"; }
            out.push({
                id: store + ":" + (key || m.index), fn: m[1], base122: base122,
                start: quoteAt + 1, end: close, store: store, key: key || ("payload@" + m.index)
            });
            re.lastIndex = close + 1;
        }
        return out;
    }

    function compressedOf(html, entry) {
        var raw = unescapeLiteral(html.slice(entry.start, entry.end));
        return entry.base122 ? Conv.decodeBase122Bytes(raw) : Conv.decodeBase64Bytes(raw);
    }

    // Ba panel (Asset, Scripts, Mesh) cùng đọc lại payload mỗi khi HTML đổi — code game 2–6 MB giải
    // vài lần liền. Cache theo đúng chuỗi HTML hiện tại; HTML khác là bỏ hết. Kết quả dùng chung,
    // người gọi không được sửa mảng trả về.
    var payloadCache = { html: null, bytes: {} };
    function readPayload(html, entry) {
        if (payloadCache.html !== html) { payloadCache.html = html; payloadCache.bytes = {}; }
        var key = entry.start + ":" + entry.end;
        if (!payloadCache.bytes[key]) payloadCache.bytes[key] = Brotli.decompress(compressedOf(html, entry));
        return payloadCache.bytes[key];
    }

    function encodePayload(compressed, base122) {
        if (!base122) return Conv.encodeBase64Bytes(compressed);
        // Base122 chuẩn (6 ký tự né) — bảng 7 phần tử của repo làm bộ giải Luna đọc sai.
        return Conv.encodeBase122Bytes(compressed, { standard: true })
            .replace(/<\//g, "<\\/")
            .replace(/<!--/g, "<\\!--");
    }

    // Ghi đè MỌI payload cùng key (file qua tay tool khác đôi khi nhân đôi thẻ sound).
    function writeCompressed(html, key, compressed) {
        var entries = scanPayloads(html).filter(function (e) { return e.key === key; });
        if (!entries.length) throw new Error("Không tìm thấy payload Luna \"" + key + "\" trong HTML hiện tại.");
        entries.sort(function (a, b) { return b.start - a.start; });
        for (var i = 0; i < entries.length; i++) {
            var text = encodePayload(compressed, entries[i].base122);
            html = html.slice(0, entries[i].start) + text + html.slice(entries[i].end);
        }
        return html;
    }

    function writePayload(html, key, bytes) {
        return writeCompressed(html, key, Brotli.compress(bytes));
    }

    // Nối thêm byte vào cuối payload (data.blob): phần gốc giữ nguyên từng bit.
    function appendPayload(html, key, extra) {
        var entry = scanPayloads(html).filter(function (e) { return e.key === key; })[0];
        if (!entry) throw new Error("Không tìm thấy payload Luna \"" + key + "\" trong HTML hiện tại.");
        return writeCompressed(html, key, Brotli.append(compressedOf(html, entry), extra));
    }

    function utf8Encode(text) {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
        return new Uint8Array(Buffer.from(text, "utf8"));
    }
    function utf8Decode(bytes) {
        if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
        return Buffer.from(bytes).toString("utf8");
    }

    // ───────────────────────── project: bundle, tên asset ─────────────────────────
    function readJsons(html, entries) {
        var jsons = {};
        entries.forEach(function (e) {
            if (e.store !== "jsons" || jsons.hasOwnProperty(e.key)) return;
            try { jsons[e.key] = JSON.parse(utf8Decode(readPayload(html, e))); } catch (err) { jsons[e.key] = null; }
        });
        return jsons;
    }

    function baseName(path) { return String(path || "").split("/").pop(); }

    // Bảng id asset → { path, name, type, bundle } từ mọi bundle.json.
    function assetIndex(jsons) {
        var index = {};
        Object.keys(jsons).forEach(function (key) {
            var m = key.match(/^assets\/bundles\/(-?\d+)\/bundle\.json$/), json = jsons[key];
            if (!m || !json) return;
            Object.keys(json).forEach(function (type) {
                if (!Array.isArray(json[type])) return;
                json[type].forEach(function (asset) {
                    if (!asset || asset.id == null) return;
                    index[m[1] + "/" + asset.id] = {
                        id: asset.id, bundle: m[1], type: type,
                        path: asset.path || "", name: (asset.data && typeof asset.data[0] === "string" && asset.data[0]) || asset.name || baseName(asset.path)
                    };
                });
            });
        });
        return index;
    }

    // "assets/bundles/-1/21668.png" → thông tin asset (nếu bundle.json có).
    function describeKey(index, key) {
        var m = String(key).match(/^assets\/bundles\/(-?\d+)\/(-?\d+)\.\w+$/);
        return m ? index[m[1] + "/" + m[2]] || null : null;
    }

    function labelOf(info, key) {
        if (!info) return baseName(key);
        // Texture không path/tên là thứ Unity sinh khi build (lightmap, reflection probe…).
        if (!info.path && !info.name) return baseName(key) + " — " + (info.type === "textures" ? "texture sinh khi build (lightmap/probe)" : info.type);
        var file = baseName(info.path) || info.name || baseName(key);
        return file + (info.path && info.path !== file ? " — " + info.path : "");
    }

    /**
     * Nhãn dễ đọc cho ảnh Luna, theo offset payload (khớp item.start của converter-core).
     * → { [start]: "Hand_icon.png — Assets/UI/…" }
     */
    function imageLabels(html, index) {
        var labels = {}, re = /<img\b[^>]*>/gi, m;
        while ((m = re.exec(html))) {
            var tag = m[0], id = (tag.match(/\sid\s*=\s*"([^"]*)"/i) || [])[1];
            if (!id || !/^assets\/bundles\//.test(id)) continue;
            var label = labelOf(describeKey(index, id), id);
            var srcAt = tag.search(/\s(?:src|data-src122|data-b122)\s*=\s*"/i);
            if (srcAt < 0) continue;
            var valueAt = tag.indexOf('"', srcAt) + 1;
            var value = tag.slice(valueAt, tag.indexOf('"', valueAt));
            var comma = /^data:/i.test(value) ? value.indexOf(",") + 1 : 0;
            labels[m.index + valueAt + comma] = label;
        }
        return labels;
    }

    function mediaTypeOf(key) {
        var ext = (String(key).match(/\.(\w+)$/) || [])[1] || "";
        return ({ mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" })[ext.toLowerCase()] || "application/octet-stream";
    }

    /**
     * Asset nén Brotli cho tab Asset nhúng (sound, video…) — mỗi key một dòng.
     * → [{ key, store, label, context, mediaType, kind, base122, count }]
     */
    function assets(html) {
        if (!isLuna(html)) return [];
        var entries = scanPayloads(html);
        var index = assetIndex(readJsons(html, entries));
        var seen = {}, out = [];
        entries.forEach(function (e) {
            if (e.store === "jsons" || e.store === "blobs" || e.store === "code" || e.store === "unknown") return;
            if (seen[e.key]) { seen[e.key].count++; return; }
            var mediaType = mediaTypeOf(e.key);
            var item = {
                key: e.key, store: e.store, base122: e.base122, count: 1,
                label: labelOf(describeKey(index, e.key), e.key), context: e.key, mediaType: mediaType,
                kind: /^audio\//.test(mediaType) ? "audio" : /^image\//.test(mediaType) ? "image" : "other"
            };
            seen[e.key] = item;
            out.push(item);
        });
        return out;
    }

    function readAsset(html, key) {
        var entry = scanPayloads(html).filter(function (e) { return e.key === key; })[0];
        if (!entry) throw new Error("Không tìm thấy asset " + key);
        return readPayload(html, entry);
    }

    // ───────────────────────── scripts (code game + JSON) ─────────────────────────
    function scripts(html) {
        if (!isLuna(html)) return [];
        var out = [], seen = {};
        scanPayloads(html).forEach(function (e) {
            if ((e.store !== "code" && e.store !== "jsons") || seen[e.key]) return;
            seen[e.key] = true;
            var text;
            try { text = utf8Decode(readPayload(html, e)); } catch (err) { return; }
            out.push({
                id: "luna:" + e.key, key: e.key, source: "luna",
                name: e.store === "code" ? "Luna · code game (Bridge.NET)" : e.key,
                kind: e.store === "code" ? "game" : "data",
                text: text, size: text.length
            });
        });
        return out;
    }

    function replaceText(html, key, text) {
        return writePayload(html, key, utf8Encode(text));
    }

    // ───────────────────────── half-float ─────────────────────────
    var HALF_TABLE = null;
    function halfToFloat(h) {
        if (!HALF_TABLE) {
            HALF_TABLE = new Float32Array(65536);
            for (var i = 0; i < 65536; i++) {
                var s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 31, f = i & 1023;
                HALF_TABLE[i] = e === 0 ? s * f * Math.pow(2, -24) : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * Math.pow(2, e - 15);
            }
        }
        return HALF_TABLE[h];
    }
    var f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    function floatToHalf(value) {
        f32[0] = value;
        var x = u32[0], sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
        if (exp === 255) return sign | 0x7c00 | (mant ? 0x200 : 0);
        var e = exp - 112;
        if (e >= 31) return sign | 0x7c00;
        if (e <= 0) {
            if (e < -10) return sign;
            var full = mant | 0x800000, shift = 14 - e, half = full >> shift;
            var rem = full & ((1 << shift) - 1), halfway = 1 << (shift - 1);
            if (rem > halfway || (rem === halfway && (half & 1))) half++;
            return sign | half;
        }
        var h = sign | (e << 10) | (mant >> 13), rem2 = mant & 0x1fff;
        if (rem2 > 0x1000 || (rem2 === 0x1000 && (h & 1))) h++;
        return h;
    }

    // ───────────────────────── mesh ─────────────────────────
    /* Thứ tự field của DTO và danh sách vertex stream ĐỔI theo phiên bản Luna (bản 2023 không có
       useUInt32IndexFormat nên mọi field sau lệch 1) → đọc từ chính runtime trong file:
         Deserializers.fields["Luna.Unity.DTO.UnityEngine.Assets.Mesh"] = {name:0,halfPrecision:1,…}
         mảng [{semantic:…SEMANTIC_POSITION,components:3,…}, …] mà defaultVertexBuffer tra theo streams[i].
       Không đọc được thì dùng bố cục của bản mới (đo trên build 2026). */
    var DEFAULT_SCHEMA = {
        fields: { name: 0, halfPrecision: 1, useUInt32IndexFormat: 2, vertexCount: 3, aabb: 4, streams: 5, vertices: 6, subMeshes: 7, bindposes: 8, blendShapes: 9 },
        triangles: 0,
        streams: [["POSITION", 3], ["NORMAL", 3], ["TANGENT", 4], ["BLENDWEIGHT", 4], ["BLENDINDICES", 4], ["COLOR", 4], ["TEXCOORD0", 2], ["TEXCOORD1", 2], ["TEXCOORD2", 2], ["TEXCOORD3", 2]]
    };

    function parseFieldMap(text) {
        var map = {};
        text.replace(/(\w+)\s*:\s*(\d+)/g, function (_, k, v) { map[k] = +v; });
        return map;
    }

    function meshSchema(code) {
        var schema = { fields: DEFAULT_SCHEMA.fields, triangles: DEFAULT_SCHEMA.triangles, streams: DEFAULT_SCHEMA.streams, source: "default" };
        if (!code) return schema;
        var f = code.match(/["']Luna\.Unity\.DTO\.UnityEngine\.Assets\.Mesh["']\s*:\s*\{([^}]*)\}/);
        if (f) {
            var fields = parseFieldMap(f[1]);
            if (fields.vertices != null && fields.subMeshes != null && fields.streams != null) { schema.fields = fields; schema.source = "runtime"; }
        }
        var s = code.match(/["']Luna\.Unity\.DTO\.UnityEngine\.Assets\.Mesh\+SubMesh["']\s*:\s*\{([^}]*)\}/);
        if (s) { var sub = parseFieldMap(s[1]); if (sub.triangles != null) schema.triangles = sub.triangles; }
        // Mảng stream đầy đủ là mảng duy nhất có cả BLENDWEIGHT lẫn TANGENT, mở đầu bằng POSITION.
        var arrays = code.match(/\[\s*\{\s*semantic\s*:\s*[\w.$]*SEMANTIC_POSITION\s*,\s*components\s*:\s*3[^\]]*\]/g) || [];
        for (var i = 0; i < arrays.length; i++) {
            if (!/SEMANTIC_BLENDWEIGHT/.test(arrays[i]) || !/SEMANTIC_TANGENT/.test(arrays[i])) continue;
            var list = [], re = /SEMANTIC_(\w+)\s*,\s*components\s*:\s*(\d+)/g, m;
            while ((m = re.exec(arrays[i]))) list.push([m[1], +m[2]]);
            if (list.length >= 6) { schema.streams = list; break; }
        }
        return schema;
    }

    function field(data, schema, name) {
        var i = schema.fields[name];
        return i == null ? undefined : data[i];
    }

    // streams (mảng cờ) → offset từng semantic trong 1 đỉnh + stride (đơn vị: số float).
    function layoutOf(streams, schema) {
        var offsets = {}, size = {}, stride = 0;
        schema.streams.forEach(function (s, i) {
            size[s[0]] = s[1];
            offsets[s[0]] = streams[i] ? stride : -1;
            if (streams[i]) stride += s[1];
        });
        return { offsets: offsets, size: size, stride: stride };
    }

    function readFloats(blob, offset, length, half) {
        var dv = new DataView(blob.buffer, blob.byteOffset + offset, length), n, out, i;
        if (half) {
            n = length >> 1; out = new Float32Array(n);
            for (i = 0; i < n; i++) out[i] = halfToFloat(dv.getUint16(i * 2, true));
        } else {
            n = length >> 2; out = new Float32Array(n);
            for (i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
        }
        return out;
    }

    function readIndices(blob, offset, length, u32idx) {
        var dv = new DataView(blob.buffer, blob.byteOffset + offset, length), size = u32idx ? 4 : 2, n = Math.floor(length / size), out = [];
        for (var i = 0; i < n; i++) out.push(u32idx ? dv.getUint32(i * size, true) : dv.getUint16(i * size, true));
        return out;
    }

    // DTO mesh → dữ liệu thô (hệ Unity) + geometry cho panel (hệ model).
    function decodeMesh(data, blob, schema) {
        var half = !!field(data, schema, "halfPrecision"), u32idx = !!field(data, schema, "useUInt32IndexFormat");
        var vc = field(data, schema, "vertexCount"), streams = field(data, schema, "streams") || [];
        var layout = layoutOf(streams, schema), vert = field(data, schema, "vertices");
        if (typeof vc !== "number" || !Array.isArray(vert) || vert[0] + vert[1] > blob.length) throw new Error("DTO mesh không đọc được (sai phiên bản?)");
        var floats = readFloats(blob, vert[0], vert[1], half);
        if (floats.length < vc * layout.stride) throw new Error("số đỉnh không khớp độ dài buffer");
        var pos = [], uv = [], st = layout.stride, po = layout.offsets.POSITION, uo = layout.offsets.TEXCOORD0;
        if (po == null || po < 0) throw new Error("mesh không có POSITION");
        for (var v = 0; v < vc; v++) {
            var b = v * st;
            pos.push([-floats[b + po], floats[b + po + 1], floats[b + po + 2]]);
            if (uo >= 0) uv.push([floats[b + uo], 1 - floats[b + uo + 1]]);
        }
        var prims = (field(data, schema, "subMeshes") || []).map(function (sub) {
            var tri = sub[schema.triangles], idx = readIndices(blob, tri[0], tri[1], u32idx);
            for (var i = 0; i + 2 < idx.length; i += 3) { var t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
            return { bundle: 0, idx: idx };
        });
        return { floats: floats, layout: layout, vc: vc, geometry: { bundles: [{ pos: pos, uv: uv }], prims: prims } };
    }

    function blobKeyOf(bundleId) { return "assets/bundles/" + bundleId + "/data.blob"; }

    function analyzeMeshes(html) {
        if (!isLuna(html)) return null;
        var entries = scanPayloads(html), jsons = readJsons(html, entries), blobs = {};
        var codeEntry = entries.filter(function (e) { return e.store === "code"; })[0], code = "";
        if (codeEntry) { try { code = utf8Decode(readPayload(html, codeEntry)); } catch (e) { code = ""; } }
        var schema = meshSchema(code);
        var meshes = [];
        Object.keys(jsons).forEach(function (key) {
            var m = key.match(/^assets\/bundles\/(-?\d+)\/bundle\.json$/), json = jsons[key];
            if (!m || !json || !Array.isArray(json.meshes) || !json.meshes.length) return;
            var bundleId = m[1], blobKey = blobKeyOf(bundleId);
            if (!blobs.hasOwnProperty(blobKey)) {
                var be = entries.filter(function (e) { return e.key === blobKey; })[0];
                blobs[blobKey] = be ? readPayload(html, be) : null;
            }
            var blob = blobs[blobKey];
            if (!blob) return;
            json.meshes.forEach(function (asset, k) {
                var d = asset.data;
                if (!Array.isArray(d)) return;
                var decoded;
                try { decoded = decodeMesh(d, blob, schema); } catch (err) { return; }
                var tris = decoded.geometry.prims.reduce(function (s, p) { return s + Math.floor(p.idx.length / 3); }, 0);
                var name = field(d, schema, "name") || "", streams = field(d, schema, "streams") || [];
                meshes.push({
                    index: meshes.length,
                    label: (name || "mesh") + " · " + baseName(asset.path),
                    name: name, path: asset.path || "", id: asset.id,
                    verts: decoded.vc, tris: tris, submeshes: decoded.geometry.prims.length,
                    skinned: decoded.layout.offsets.BLENDWEIGHT >= 0 && (field(d, schema, "bindposes") || []).length > 0,
                    blendShapes: (field(d, schema, "blendShapes") || []).length,
                    geometry: decoded.geometry,
                    luna: { bundleId: bundleId, jsonKey: key, meshIdx: k, raw: decoded, streams: streams }
                });
            });
        });
        return { engine: "luna", html: html, jsons: jsons, blobs: blobs, schema: schema, link: linkSchema(code), meshes: meshes };
    }

    // ── dựng mesh mới ──
    function computeNormals(pos, idx) {
        var nrm = pos.map(function () { return [0, 0, 0]; });
        for (var i = 0; i + 2 < idx.length; i += 3) {
            var a = pos[idx[i]], b = pos[idx[i + 1]], c = pos[idx[i + 2]];
            var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            [idx[i], idx[i + 1], idx[i + 2]].forEach(function (k) { nrm[k][0] += nx; nrm[k][1] += ny; nrm[k][2] += nz; });
        }
        return nrm.map(function (n) { var l = Math.hypot(n[0], n[1], n[2]); return l ? [n[0] / l, n[1] / l, n[2] / l] : [0, 1, 0]; });
    }

    function hasRealNormals(nrm) {
        if (!nrm || !nrm.length) return false;
        for (var i = 0; i < nrm.length; i++) {
            var n = nrm[i];
            if (n && !(n[0] === 0 && n[1] === 0 && n[2] === 1)) return true;
        }
        return false;
    }

    // Tangent kiểu Lengyel; w theo quy ước Unity: bitangent = cross(normal, tangent) * w.
    function computeTangents(pos, nrm, uv, idx) {
        var n = pos.length, t1 = new Float64Array(n * 3), t2 = new Float64Array(n * 3);
        for (var i = 0; i + 2 < idx.length; i += 3) {
            var i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
            var p0 = pos[i0], p1 = pos[i1], p2 = pos[i2], w0 = uv[i0], w1 = uv[i1], w2 = uv[i2];
            var e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            var du1 = w1[0] - w0[0], dv1 = w1[1] - w0[1], du2 = w2[0] - w0[0], dv2 = w2[1] - w0[1];
            var det = du1 * dv2 - du2 * dv1;
            if (!det) continue;
            var r = 1 / det;
            for (var k = 0; k < 3; k++) {
                var sd = (e1[k] * dv2 - e2[k] * dv1) * r, td = (e2[k] * du1 - e1[k] * du2) * r;
                t1[i0 * 3 + k] += sd; t1[i1 * 3 + k] += sd; t1[i2 * 3 + k] += sd;
                t2[i0 * 3 + k] += td; t2[i1 * 3 + k] += td; t2[i2 * 3 + k] += td;
            }
        }
        var out = [];
        for (var v = 0; v < n; v++) {
            var no = nrm[v], t = [t1[v * 3], t1[v * 3 + 1], t1[v * 3 + 2]];
            var d = no[0] * t[0] + no[1] * t[1] + no[2] * t[2];
            var tx = t[0] - no[0] * d, ty = t[1] - no[1] * d, tz = t[2] - no[2] * d, l = Math.hypot(tx, ty, tz);
            if (!l) { out.push([1, 0, 0, 1]); continue; }
            tx /= l; ty /= l; tz /= l;
            var cx = no[1] * tz - no[2] * ty, cy = no[2] * tx - no[0] * tz, cz = no[0] * ty - no[1] * tx;
            var w = cx * t2[v * 3] + cy * t2[v * 3 + 1] + cz * t2[v * 3 + 2] < 0 ? -1 : 1;
            out.push([tx, ty, tz, w]);
        }
        return out;
    }

    // Tìm đỉnh cũ gần nhất bằng lưới đều — để chép skin weight / màu / UV lightmap.
    function nearestFinder(points) {
        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        points.forEach(function (p) { for (var k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } });
        var extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
        var cell = extent / Math.max(1, Math.round(Math.cbrt(points.length / 2))), grid = new Map();
        function key(x, y, z) { return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791); }
        function cellOf(p, k) { return Math.floor((p[k] - mn[k]) / cell); }
        points.forEach(function (p, i) {
            var k = key(cellOf(p, 0), cellOf(p, 1), cellOf(p, 2));
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(i);
        });
        var maxRing = Math.ceil(extent / cell) + 2;
        return function (p) {
            var cx = cellOf(p, 0), cy = cellOf(p, 1), cz = cellOf(p, 2), best = -1, bestD = Infinity;
            for (var r = 0; r <= maxRing * 2; r++) {
                if (best >= 0 && (r - 1) * cell > Math.sqrt(bestD)) break;
                for (var x = cx - r; x <= cx + r; x++) for (var y = cy - r; y <= cy + r; y++) for (var z = cz - r; z <= cz + r; z++) {
                    if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue;
                    var list = grid.get(key(x, y, z));
                    if (!list) continue;
                    for (var j = 0; j < list.length; j++) {
                        var q = points[list[j]], dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], dd = dx * dx + dy * dy + dz * dz;
                        if (dd < bestD) { bestD = dd; best = list[j]; }
                    }
                }
            }
            return best;
        };
    }

    // Model (hệ tay phải, UV gốc trên) → mảng dữ liệu hệ Unity.
    function toUnitySpace(model) {
        var nrm = hasRealNormals(model.nrm) ? model.nrm : computeNormals(model.pos, model.idx);
        var idx = model.idx.slice();
        for (var i = 0; i + 2 < idx.length; i += 3) { var t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        return {
            pos: model.pos.map(function (p) { return [-p[0], p[1], p[2]]; }),
            nrm: nrm.map(function (n) { return [-n[0], n[1], n[2]]; }),
            uv: model.pos.map(function (_, v) { var w = model.uv && model.uv[v] || [0, 0]; return [w[0], 1 - w[1]]; }),
            idx: idx,
            parts: model.parts && model.parts.length ? model.parts : [{ idxStart: 0, idxCount: idx.length }]
        };
    }

    /**
     * Dựng buffer đỉnh + index cho mesh mới theo đúng streams / độ chính xác của mesh cũ.
     * old = decodeMesh(...) của mesh gốc (hệ Unity) — nguồn skin weight, màu, UV lightmap.
     */
    // Stream "phụ thuộc vị trí": model mới không có → chép từ đỉnh cũ gần nhất.
    var NEAREST = { BLENDWEIGHT: 1, BLENDINDICES: 1, COLOR: 1, TEXCOORD1: 1 };

    function buildMeshData(origData, old, model, schema) {
        var streams = field(origData, schema, "streams") || [], half = !!field(origData, schema, "halfPrecision");
        var nSub = Math.max(1, (field(origData, schema, "subMeshes") || []).length);
        var u = toUnitySpace(model), vc = u.pos.length, layout = layoutOf(streams, schema), st = layout.stride;
        var tangents = layout.offsets.TANGENT >= 0 ? computeTangents(u.pos, u.nrm, u.uv, u.idx) : null;

        var needNearest = Object.keys(NEAREST).some(function (s) { return layout.offsets[s] >= 0; });
        var nearest = null, oldSt = old.layout.stride, oldPo = old.layout.offsets.POSITION;
        if (needNearest && old.vc) {
            var oldPos = [];
            for (var ov = 0; ov < old.vc; ov++) {
                oldPos.push([old.floats[ov * oldSt + oldPo], old.floats[ov * oldSt + oldPo + 1], old.floats[ov * oldSt + oldPo + 2]]);
            }
            nearest = nearestFinder(oldPos);
        }

        var values = new Float32Array(vc * st), names = schema.streams.map(function (s) { return s[0]; });
        for (var v = 0; v < vc; v++) {
            var base = v * st, src = nearest ? nearest(u.pos[v]) : -1;
            for (var s = 0; s < names.length; s++) {
                var sem = names[s], off = layout.offsets[sem], n = layout.size[sem];
                if (off < 0) continue;
                var vals;
                if (sem === "POSITION") vals = u.pos[v];
                else if (sem === "NORMAL") vals = u.nrm[v];
                else if (sem === "TANGENT") vals = tangents[v];
                else if (sem === "TEXCOORD0") vals = u.uv[v];
                else if (NEAREST[sem] && src >= 0 && old.layout.offsets[sem] >= 0) {
                    var o = src * oldSt + old.layout.offsets[sem];
                    vals = Array.prototype.slice.call(old.floats, o, o + n);
                } else if (sem === "BLENDWEIGHT") vals = [1, 0, 0, 0];
                else if (sem === "COLOR") vals = [1, 1, 1, 1];
                else if (sem === "TEXCOORD1") vals = u.uv[v];
                else vals = [0, 0, 0, 0];
                for (var c = 0; c < n; c++) values[base + off + c] = vals[c] || 0;
            }
        }
        var vbytes;
        if (half) {
            vbytes = new Uint8Array(values.length * 2);
            var hv = new DataView(vbytes.buffer);
            for (var i = 0; i < values.length; i++) hv.setUint16(i * 2, floatToHalf(values[i]), true);
        } else {
            vbytes = new Uint8Array(values.buffer.slice(0));
            if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) { // máy big-endian: ghi lại LE
                var fv = new DataView(vbytes.buffer);
                for (var j = 0; j < values.length; j++) fv.setFloat32(j * 4, values[j], true);
            }
        }

        // Số submesh phải bằng số material của renderer → dồn về đúng nSub phần.
        var parts = u.parts, mode;
        var subIdx = [];
        if (parts.length === nSub) {
            mode = "1-1";
            parts.forEach(function (p) { subIdx.push(u.idx.slice(p.idxStart, p.idxStart + p.idxCount)); });
        } else {
            mode = parts.length + "→" + nSub;
            subIdx.push(u.idx.slice());
            for (var k = 1; k < nSub; k++) subIdx.push([0, 0, 0]); // tam giác suy biến: không vẽ gì, không để buffer rỗng
        }
        var wide = vc > 65535;
        var ibytes = subIdx.map(function (list) {
            var b = new Uint8Array(list.length * (wide ? 4 : 2)), dv = new DataView(b.buffer);
            list.forEach(function (x, n) { if (wide) dv.setUint32(n * 4, x, true); else dv.setUint16(n * 2, x, true); });
            return b;
        });

        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        u.pos.forEach(function (p) { for (var q = 0; q < 3; q++) { if (p[q] < mn[q]) mn[q] = p[q]; if (p[q] > mx[q]) mx[q] = p[q]; } });
        if (!vc) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
        var aabb = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2, (mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2];
        return { vbytes: vbytes, ibytes: ibytes, vc: vc, wide: wide, aabb: aabb, mode: mode, tris: u.idx.length / 3 };
    }

    /**
     * Thay mesh #meshIndex bằng model (hệ model: pos/nrm/uv/idx/parts như mesh-core.loadModel).
     * Dữ liệu mới NỐI vào cuối data.blob (Brotli.append — phần gốc giữ nguyên), bundle.json
     * trỏ sang vùng mới rồi được nén lại.
     */
    function applyMeshReplacement(analysis, meshIndex, model) {
        var mesh = analysis.meshes[meshIndex], schema = analysis.schema, F = schema.fields;
        if (!mesh || !mesh.luna) throw new Error("Mesh #" + meshIndex + " không có dữ liệu Luna.");
        if (!model || !model.pos || !model.pos.length) throw new Error("Model mới rỗng.");
        var L = mesh.luna, json = analysis.jsons[L.jsonKey], asset = json.meshes[L.meshIdx], d = asset.data;
        var blobKey = blobKeyOf(L.bundleId), blob = analysis.blobs[blobKey];
        var built = buildMeshData(d, L.raw, model, schema);
        if (built.wide && F.useUInt32IndexFormat == null) {
            throw new Error("Model mới có " + built.vc + " đỉnh — bản Luna này chỉ hỗ trợ index 16-bit (tối đa 65535 đỉnh).");
        }

        var extraLen = built.vbytes.length + built.ibytes.reduce(function (s, b) { return s + b.length; }, 0);
        var extra = new Uint8Array(extraLen), at = 0;
        var voff = blob.length;
        extra.set(built.vbytes, at); at += built.vbytes.length;
        var subs = built.ibytes.map(function (b) {
            var sub = [];
            sub[schema.triangles] = [blob.length + at, b.length];
            extra.set(b, at); at += b.length;
            return sub;
        });

        var newData = d.slice();
        if (F.useUInt32IndexFormat != null) {
            var was = d[F.useUInt32IndexFormat];
            newData[F.useUInt32IndexFormat] = typeof was === "boolean" ? built.wide : (built.wide ? 1 : 0);
        }
        newData[F.vertexCount] = built.vc;
        newData[F.aabb] = built.aabb;
        newData[F.vertices] = [voff, built.vbytes.length];
        newData[F.subMeshes] = subs;
        var notes = [], blend = F.blendShapes != null ? d[F.blendShapes] || [] : [];
        if (blend.length) { newData[F.blendShapes] = []; notes.push("bỏ " + blend.length + " blend shape của mesh cũ"); }
        if (mesh.skinned) notes.push("skin weight chép từ đỉnh cũ gần nhất");
        asset.data = newData;

        var html = appendPayload(analysis.html, blobKey, extra);
        html = writePayload(html, L.jsonKey, utf8Encode(JSON.stringify(json)));

        var newBlob = new Uint8Array(blob.length + extra.length);
        newBlob.set(blob);
        newBlob.set(extra, blob.length);
        analysis.blobs[blobKey] = newBlob;
        analysis.html = html;

        var decoded = decodeMesh(newData, newBlob, schema);
        L.raw = decoded;
        mesh.geometry = decoded.geometry;
        mesh.verts = built.vc;
        mesh.tris = built.tris;
        mesh.submeshes = subs.length;
        mesh.blendShapes = 0;
        mesh.replaceMode = built.mode;
        mesh.notes = notes;
        return mesh;
    }

    // ───────────────────────── texture gắn với mesh ─────────────────────────
    /* Scene/prefab nối mesh → ảnh qua 3 tầng: MeshFilter [tag, meshId] + MeshRenderer bên cạnh
       (hoặc SkinnedMeshRenderer tự giữ cả mesh lẫn material) → material [tag, matId] → material
       textureParameters [[tên, tag, texId]] → ảnh <img id="assets/bundles/<b>/<texId><ext||.png>">.
       Tham chiếu chiếm 2 ô (tag, id) nên field kế tiếp nhảy 2. Index field đọc từ runtime như mesh. */
    var DEFAULT_LINK = {
        material: { textureParameters: 8, vectorParameters: 7 },
        meshFilter: { sharedMesh: 0 },
        meshRenderer: { sharedMaterial: 3, sharedMaterials: 5 },
        skinned: { sharedMesh: 0, sharedMaterial: 9, sharedMaterials: 11 },
        texture: { name: 0, width: 1, height: 2, mipmapCount: 3 }
    };
    var LINK_DTO = {
        material: "Assets.Material", meshFilter: "Components.MeshFilter", meshRenderer: "Components.MeshRenderer",
        skinned: "Components.SkinnedMeshRenderer", texture: "Textures.Texture2D"
    };
    var MAIN_TEX = ["_MainTex", "_BaseMap", "_BaseColorMap", "_Albedo", "_MainTexture"];

    function linkSchema(code) {
        var out = {};
        Object.keys(DEFAULT_LINK).forEach(function (k) {
            var def = DEFAULT_LINK[k], f = code && code.match(new RegExp("[\"']Luna\\.Unity\\.DTO\\.UnityEngine\\." + LINK_DTO[k].replace(".", "\\.") + "[\"']\\s*:\\s*\\{([^}]*)\\}"));
            var map = f ? parseFieldMap(f[1]) : {};
            out[k] = Object.keys(def).every(function (n) { return map[n] != null; }) ? map : def;
        });
        return out;
    }

    // Mọi asset có id trong các bundle.json → { asset, jsonKey, bundle }, theo loại.
    function assetsById(jsons, type) {
        var out = {};
        Object.keys(jsons).forEach(function (key) {
            var m = key.match(/^assets\/bundles\/(-?\d+)\/bundle\.json$/), json = jsons[key];
            if (!m || !json || !Array.isArray(json[type])) return;
            json[type].forEach(function (a) { if (a && a.id != null) out[a.id] = { asset: a, jsonKey: key, bundle: m[1] }; });
        });
        return out;
    }

    function isRef(data, at, ids) { return Array.isArray(data) && typeof data[at] === "number" && ids.hasOwnProperty(data[at + 1]); }

    // Mọi renderer trong scene + prefab: { data, f (field map), meshId, jsonKey }.
    function findRenderers(analysis) {
        var S = analysis.link, meshIds = {}, mats = assetsById(analysis.jsons, "materials"), out = [];
        analysis.meshes.forEach(function (m) { meshIds[m.id] = true; });
        function visit(node, jsonKey) {
            if (Array.isArray(node)) { node.forEach(function (n) { visit(n, jsonKey); }); return; }
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node.components)) {
                var comps = node.components.map(function (c) { return c && c.data; });
                comps.forEach(function (d, i) {
                    if (isRef(d, S.skinned.sharedMesh, meshIds) && Array.isArray(d[S.skinned.sharedMaterials])) {
                        out.push({ data: d, f: S.skinned, meshId: d[S.skinned.sharedMesh + 1], jsonKey: jsonKey });
                    } else if (isRef(d, S.meshFilter.sharedMesh, meshIds) && d.length <= S.meshFilter.sharedMesh + 2) {
                        var r = comps.filter(function (o, j) { return j !== i && Array.isArray(o) && Array.isArray(o[S.meshRenderer.sharedMaterials]) && isRef(o, S.meshRenderer.sharedMaterial, mats); })[0];
                        if (r) out.push({ data: r, f: S.meshRenderer, meshId: d[S.meshFilter.sharedMesh + 1], jsonKey: jsonKey });
                    }
                });
            }
            Object.keys(node).forEach(function (k) { if (k !== "components" && typeof node[k] === "object") visit(node[k], jsonKey); });
        }
        Object.keys(analysis.jsons).forEach(function (key) {
            var json = analysis.jsons[key];
            if (!json || !/bundle\.json$/.test(key)) return;
            ["scenes", "prefabs"].forEach(function (t) { if (Array.isArray(json[t])) visit(json[t], key); });
        });
        return out;
    }

    function rendererMaterials(r) {
        var list = r.data[r.f.sharedMaterials] || [], ids = [];
        for (var k = 0; k + 1 < list.length; k += 2) if (list[k + 1] != null) ids.push(list[k + 1]);
        if (!ids.length && r.data[r.f.sharedMaterial + 1] != null) ids.push(r.data[r.f.sharedMaterial + 1]);
        return ids;
    }

    function mainTexParam(mat, S) {
        var params = (mat.data || [])[S.material.textureParameters] || [];
        for (var i = 0; i < MAIN_TEX.length; i++) for (var j = 0; j < params.length; j++) if (params[j][0] === MAIN_TEX[i]) return j;
        for (var k = 0; k < params.length; k++) if (params[k][2] != null) return k;
        return -1;
    }

    function textureKey(tex) { return "assets/bundles/" + tex.bundle + "/" + tex.asset.id + (tex.asset.ext || ".png"); }

    /**
     * Material + texture chính mà mesh #meshIndex đang dùng (qua mọi renderer trỏ tới nó).
     * → { renderers, materials: [{ id, name, path, texture: {id,key,label,width,height}|null,
     *      otherRenderers: số renderer KHÁC mesh này cùng dùng material, otherMaterials: số material khác cùng texture }] }
     */
    function meshTextureInfo(analysis, meshIndex) {
        var mesh = analysis.meshes[meshIndex], S = analysis.link;
        if (!mesh) throw new Error("Không có mesh #" + meshIndex);
        var renderers = findRenderers(analysis), mats = assetsById(analysis.jsons, "materials"), texs = assetsById(analysis.jsons, "textures");
        var mine = renderers.filter(function (r) { return r.meshId === mesh.id; });
        var matIds = [];
        mine.forEach(function (r) { rendererMaterials(r).forEach(function (id) { if (matIds.indexOf(id) < 0 && mats[id]) matIds.push(id); }); });
        var materials = matIds.map(function (id) {
            var mat = mats[id].asset, p = mainTexParam(mat, S), param = p >= 0 ? mat.data[S.material.textureParameters][p] : null;
            var tex = param && texs[param[2]], texInfo = null;
            if (tex) {
                var td = tex.asset.data || [];
                var otherMats = Object.keys(mats).filter(function (mid) {
                    if (+mid === id) return false;
                    return ((mats[mid].asset.data || [])[S.material.textureParameters] || []).some(function (q) { return q[2] === tex.asset.id; });
                }).length;
                texInfo = { id: tex.asset.id, key: textureKey(tex), label: labelOf({ path: tex.asset.path, name: td[S.texture.name] }, textureKey(tex)), width: td[S.texture.width], height: td[S.texture.height], otherMaterials: otherMats };
            }
            return {
                id: id, name: (mat.data || [])[0] || mat.name || "", path: mat.path || "", param: param ? param[0] : null, texture: texInfo,
                otherRenderers: renderers.filter(function (r) { return r.meshId !== mesh.id && rendererMaterials(r).indexOf(id) >= 0; }).length
            };
        });
        return { renderers: mine.length, materials: materials };
    }

    function nextFreeId(jsons) {
        var max = 0;
        (function walk(x) {
            if (Array.isArray(x)) { x.forEach(walk); return; }
            if (!x || typeof x !== "object") return;
            if (typeof x.id === "number" && x.id > max) max = x.id;
            for (var k in x) if (typeof x[k] === "object") walk(x[k]);
        })(jsons);
        return Math.max(max + 1, 990100);
    }

    function mipCount(w, h, old) { return old > 1 ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1; }

    // Thuộc tính base122 (data-b122) có thể chứa ">" thô → bỏ qua nội dung trong nháy.
    var IMG_TAG = /<img\b(?:[^>"]|"[^"]*")*>/gi;
    function imgTagRange(html, key) {
        var re = new RegExp(IMG_TAG.source, "gi"), m;
        while ((m = re.exec(html))) {
            var id = (m[0].match(/\sid\s*=\s*"([^"]*)"/i) || [])[1];
            if (id === key) return { start: m.index, end: m.index + m[0].length };
        }
        return null;
    }
    function lastTextureImgEnd(html) {
        var re = new RegExp(IMG_TAG.source, "gi"), m, end = -1;
        while ((m = re.exec(html))) if (/\sid\s*=\s*"assets\/bundles\//i.test(m[0])) end = m.index + m[0].length;
        return end;
    }
    // Ảnh của texture dưới dạng data URI (để xem trước): src="data:…" hoặc data-src122/data-b122 thô.
    function textureDataUri(html, key) {
        var range = imgTagRange(html, key);
        if (!range) return null;
        var tag = html.slice(range.start, range.end);
        var src = (tag.match(/\ssrc\s*=\s*"(data:[^"]*)"/i) || [])[1];
        if (src) return src;
        var b = tag.match(/\sdata-(src122|b122)\s*=\s*"([^"]*)"/i);
        if (!b) return null;
        var mime = (tag.match(b[1] === "b122" ? /\sdata-b122m\s*=\s*"([^"]*)"/i : /\sdata-mime\s*=\s*"([^"]*)"/i) || [])[1] || (b[1] === "b122" ? "image/jpeg" : "image/png");
        var raw = b[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        try { return "data:" + mime + ";base64," + Conv.encodeBase64Bytes(Conv.decodeBase122Bytes(raw)); } catch (e) { return null; }
    }
    function imgTag(key, dataUri) { return '<img crossorigin="" id="' + key + '" src="' + dataUri + '">'; }

    /**
     * Gắn ảnh mới làm texture chính cho mesh #meshIndex.
     *   image = { dataUri, width, height }
     *   mode "own" (mặc định): tạo texture + bản sao material riêng, chỉ renderer của mesh này trỏ sang
     *     → mesh khác dùng chung material/atlas cũ không bị đổi.
     *   mode "overwrite": thay luôn ảnh của texture cũ → MỌI thứ dùng texture đó đổi theo.
     */
    function applyMeshTexture(analysis, meshIndex, image, mode) {
        var mesh = analysis.meshes[meshIndex], S = analysis.link;
        if (!mesh) throw new Error("Không có mesh #" + meshIndex);
        if (!image || !/^data:image\//.test(image.dataUri || "")) throw new Error("Texture mới phải là data URI ảnh.");
        var info = meshTextureInfo(analysis, meshIndex);
        if (!info.renderers) throw new Error("Không tìm thấy renderer nào dùng mesh #" + meshIndex + " trong scene/prefab.");
        var mats = assetsById(analysis.jsons, "materials"), texs = assetsById(analysis.jsons, "textures");
        var html = analysis.html, dirty = {}, notes = [];

        function setDims(texAsset) {
            var d = texAsset.data;
            d[S.texture.width] = image.width; d[S.texture.height] = image.height;
            d[S.texture.mipmapCount] = mipCount(image.width, image.height, d[S.texture.mipmapCount]);
        }

        if (mode === "overwrite") {
            var done = {};
            info.materials.forEach(function (m) {
                if (!m.texture || done[m.texture.id]) return;
                done[m.texture.id] = true;
                var tex = texs[m.texture.id], range = imgTagRange(html, m.texture.key);
                setDims(tex.asset); dirty[tex.jsonKey] = true;
                var tag = imgTag(m.texture.key, image.dataUri);
                if (range) html = html.slice(0, range.start) + tag + html.slice(range.end);
                else { var at = lastTextureImgEnd(html); if (at < 0) throw new Error("Không tìm thấy chỗ đặt ảnh texture trong HTML."); html = html.slice(0, at) + "\n" + tag + html.slice(at); }
            });
            if (!Object.keys(done).length) throw new Error("Material của mesh này không có texture để ghi đè — dùng chế độ texture riêng.");
            notes.push("ghi đè " + Object.keys(done).length + " texture (mọi mesh dùng chung đổi theo)");
        } else {
            var nextId = nextFreeId(analysis.jsons);
            var srcMat = mats[info.materials[0] && info.materials[0].id];
            if (!srcMat) throw new Error("Renderer của mesh #" + meshIndex + " không có material.");
            var oldTexRef = info.materials.filter(function (m) { return m.texture; })[0];
            var oldTex = oldTexRef ? texs[oldTexRef.texture.id] : null;
            var texBundle = oldTex ? oldTex.bundle : mats[srcMat.asset.id].bundle;
            var texJsonKey = oldTex ? oldTex.jsonKey : srcMat.jsonKey, texJson = analysis.jsons[texJsonKey];
            var texBase = (mesh.name || "mesh") + "_tex";
            // Texture mới: chép cờ (format, filter, wrap, sRGB…) của texture cũ để shader đọc như cũ.
            var newTex = {
                id: nextId++, type: oldTex ? oldTex.asset.type : 0, path: "Assets/_Replaced/" + texBase + ".png", assetBundleId: +texBundle,
                data: oldTex ? oldTex.asset.data.slice() : [texBase, 0, 0, 1, 1, 1, 0, 4, 0, 0, 1, 8, 1, 0, 0, 0]
            };
            newTex.data[S.texture.name] = texBase;
            setDims(newTex);
            (texJson.textures = texJson.textures || []).push(newTex);
            dirty[texJsonKey] = true;
            var key = "assets/bundles/" + texBundle + "/" + newTex.id + ".png";
            var at = oldTexRef ? (imgTagRange(html, oldTexRef.texture.key) || {}).end : undefined;
            if (at == null) at = lastTextureImgEnd(html);
            if (at == null || at < 0) { at = html.lastIndexOf("</body>"); if (at < 0) throw new Error("Không tìm thấy chỗ đặt ảnh texture trong HTML."); }
            html = html.slice(0, at) + "\n" + imgTag(key, image.dataUri) + html.slice(at);

            // Mỗi material của mesh → một bản sao trỏ sang texture mới; tiling/offset về 1,1,0,0
            // vì UV của model mới phủ trọn ảnh.
            var cloneOf = {};
            info.materials.forEach(function (m) {
                var src = mats[m.id], json = analysis.jsons[src.jsonKey];
                var copy = JSON.parse(JSON.stringify(src.asset));
                copy.id = nextId++;
                copy.path = (src.asset.path || "Assets/_Replaced/" + m.name + ".mat").replace(/(\.mat)?$/i, "_" + (mesh.name || "mesh") + ".mat");
                if (typeof copy.data[0] === "string") copy.data[0] = copy.data[0] + "_" + (mesh.name || "mesh");
                var params = copy.data[S.material.textureParameters] = copy.data[S.material.textureParameters] || [];
                var p = mainTexParam(copy, S);
                if (p >= 0) params[p] = [params[p][0], params[p][1] != null ? params[p][1] : 1, newTex.id];
                else { params.push(["_MainTex", 1, newTex.id]); notes.push("material " + m.name + " vốn không có texture — shader có thể không đọc ảnh"); }
                var texName = params[p >= 0 ? p : params.length - 1][0];
                (copy.data[S.material.vectorParameters] || []).forEach(function (v) { if (v[0] === texName + "_ST") { v[1] = 1; v[2] = 1; v[3] = 0; v[4] = 0; } });
                json.materials.push(copy);
                dirty[src.jsonKey] = true;
                cloneOf[m.id] = copy.id;
            });
            findRenderers(analysis).forEach(function (r) {
                if (r.meshId !== mesh.id) return;
                var d = r.data, list = d[r.f.sharedMaterials] || [];
                if (cloneOf[d[r.f.sharedMaterial + 1]] != null) d[r.f.sharedMaterial + 1] = cloneOf[d[r.f.sharedMaterial + 1]];
                for (var k = 0; k + 1 < list.length; k += 2) if (cloneOf[list[k + 1]] != null) list[k + 1] = cloneOf[list[k + 1]];
                dirty[r.jsonKey] = true;
            });
            notes.push("texture riêng #" + newTex.id + " + " + info.materials.length + " material sao chép cho " + info.renderers + " renderer");
        }

        Object.keys(dirty).forEach(function (k) { html = writePayload(html, k, utf8Encode(JSON.stringify(analysis.jsons[k]))); });
        analysis.html = html;
        mesh._texture = image.dataUri;
        return { mesh: mesh, notes: notes };
    }

    function serialize(analysis) { return analysis.html; }

    var meshBackend = {
        engine: "luna",
        maxVertices: 16777215,
        analyzePlayable: analyzeMeshes,
        applyMeshReplacement: applyMeshReplacement,
        meshTextureInfo: meshTextureInfo,
        applyMeshTexture: applyMeshTexture,
        textureDataUri: function (analysis, key) { return textureDataUri(analysis.html, key); },
        serialize: serialize
    };

    return {
        isLuna: isLuna,
        scanPayloads: scanPayloads,
        readPayload: readPayload,
        writePayload: writePayload,
        appendPayload: appendPayload,
        encodePayload: encodePayload,
        assets: assets,
        readAsset: readAsset,
        imageLabels: function (html) { return imageLabels(html, assetIndex(readJsons(html, scanPayloads(html)))); },
        scripts: scripts,
        replaceText: replaceText,
        analyzeMeshes: analyzeMeshes,
        applyMeshReplacement: applyMeshReplacement,
        meshTextureInfo: meshTextureInfo,
        applyMeshTexture: applyMeshTexture,
        meshBackend: meshBackend,
        // nội bộ (tests)
        meshSchema: meshSchema,
        DEFAULT_SCHEMA: DEFAULT_SCHEMA,
        decodeMesh: decodeMesh,
        buildMeshData: buildMeshData,
        halfToFloat: halfToFloat,
        floatToHalf: floatToHalf,
        layoutOf: layoutOf
    };
});
