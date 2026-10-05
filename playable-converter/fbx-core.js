/*
 * fbx-core.js — đọc model từ file .fbx (Autodesk FBX 7.x, nhị phân lẫn ASCII) cho tab Mesh 3D.
 * ------------------------------------------------------------------------------------
 * UMD, không phụ thuộc gì → chạy cả browser lẫn Node (tests).
 * Global: window.FbxCore   |   Node: require("./fbx-core")
 *
 * Vì sao FBX phải có module riêng, không đọc gọn như .glb/.obj:
 *   - Định dạng đóng của Autodesk, không có đặc tả chính thức; nhị phân là cây node, mảng số nén
 *     zlib — trình duyệt chỉ có DecompressionStream (bất đồng bộ), nên kèm một bộ inflate nhỏ.
 *   - Toạ độ đỉnh là "control point"; normal/UV gắn theo góc polygon (ByPolygonVertex) và có thể
 *     tra gián tiếp (IndexToDirect) → phải tách đỉnh theo cặp (vị trí, normal, UV).
 *   - Polygon nhiều cạnh, material theo từng polygon, cây Model với transform đủ kiểu (pivot,
 *     pre/post-rotation, geometric transform), hệ trục + đơn vị của từng phần mềm xuất.
 *
 *   loadFBX(bytes) → { pos, nrm, uv, uv1, idx, parts, objects }  (cùng dạng mesh-core.loadModel)
 *     hệ toạ độ đầu ra như glTF: tay phải, Y lên, UV gốc trên-trái; đơn vị mét.
 *     objects[i] = { name, idxStart, idxCount } — mỗi Model có mesh là một object (file hay chứa nhiều).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.FbxCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ───────────────────────── inflate (RFC 1950/1951) ─────────────────────────
    var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    function huffman(lengths, n) {
        var count = new Int32Array(16), symbol = new Int32Array(n), offs = new Int32Array(16);
        for (var s = 0; s < n; s++) count[lengths[s]]++;
        count[0] = 0;
        for (var len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
        for (s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
        return { count: count, symbol: symbol };
    }

    // Dòng zlib (FBX dùng) hoặc deflate thô. expected: độ dài đầu ra đã biết (FBX ghi sẵn) — chỉ để cấp phát.
    function inflate(data, expected) {
        var pos = 0;
        if (data.length >= 2 && (data[0] & 15) === 8 && ((data[0] << 8) | data[1]) % 31 === 0) pos = 2;
        var out = new Uint8Array(Math.max(64, expected || data.length * 4)), op = 0;
        var bitbuf = 0, bitcnt = 0;
        function bits(n) {
            while (bitcnt < n) {
                if (pos >= data.length) throw new Error("FBX: dữ liệu nén bị cụt");
                bitbuf |= data[pos++] << bitcnt;
                bitcnt += 8;
            }
            var v = bitbuf & ((1 << n) - 1);
            bitbuf >>>= n;
            bitcnt -= n;
            return v;
        }
        function decode(h) {
            var code = 0, first = 0, index = 0;
            for (var len = 1; len < 16; len++) {
                code |= bits(1);
                var c = h.count[len];
                if (code - c < first) return h.symbol[index + code - first];
                index += c;
                first += c;
                first <<= 1;
                code <<= 1;
            }
            throw new Error("FBX: mã Huffman sai trong dữ liệu nén");
        }
        function ensure(n) {
            if (op + n <= out.length) return;
            var bigger = new Uint8Array(Math.max(out.length * 2, op + n));
            bigger.set(out.subarray(0, op));
            out = bigger;
        }
        var fixedLit = null, fixedDist = null, last = 0;
        while (!last) {
            last = bits(1);
            var type = bits(2);
            if (type === 0) {
                bitbuf = 0; bitcnt = 0;
                var len = data[pos] | (data[pos + 1] << 8);
                pos += 4;
                ensure(len);
                out.set(data.subarray(pos, pos + len), op);
                op += len; pos += len;
                continue;
            }
            var lit, dist;
            if (type === 1) {
                if (!fixedLit) {
                    var l = new Uint8Array(288);
                    for (var i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
                    fixedLit = huffman(l, 288);
                    fixedDist = huffman(new Uint8Array(30).fill(5), 30);
                }
                lit = fixedLit; dist = fixedDist;
            } else if (type === 2) {
                var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
                var cl = new Uint8Array(19);
                for (i = 0; i < ncode; i++) cl[CL_ORDER[i]] = bits(3);
                var clh = huffman(cl, 19), lengths = new Uint8Array(nlen + ndist);
                for (i = 0; i < nlen + ndist;) {
                    var sym = decode(clh);
                    if (sym < 16) { lengths[i++] = sym; continue; }
                    var rep, val = 0;
                    if (sym === 16) { if (!i) throw new Error("FBX: dữ liệu nén sai"); val = lengths[i - 1]; rep = 3 + bits(2); }
                    else if (sym === 17) rep = 3 + bits(3);
                    else rep = 11 + bits(7);
                    while (rep--) lengths[i++] = val;
                }
                lit = huffman(lengths.subarray(0, nlen), nlen);
                dist = huffman(lengths.subarray(nlen), ndist);
            } else throw new Error("FBX: kiểu khối nén không hợp lệ");
            for (;;) {
                var s = decode(lit);
                if (s < 256) { ensure(1); out[op++] = s; continue; }
                if (s === 256) break;
                s -= 257;
                var length = LEN_BASE[s] + bits(LEN_EXTRA[s]);
                var ds = decode(dist), d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
                if (d > op) throw new Error("FBX: dữ liệu nén sai (khoảng cách)");
                ensure(length);
                for (var k = 0; k < length; k++, op++) out[op] = out[op - d];
            }
        }
        return out.slice(0, op);
    }

    // ───────────────────────── đọc cây node ─────────────────────────
    // Node = { name, props: [...], children: [...] } — cùng dạng cho nhị phân và ASCII.
    var BINARY_MAGIC = "Kaydara FBX Binary  ";

    function isBinary(u8) {
        if (u8.length < 27) return false;
        for (var i = 0; i < BINARY_MAGIC.length; i++) if (u8[i] !== BINARY_MAGIC.charCodeAt(i)) return false;
        return true;
    }

    function parseBinary(u8) {
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        var version = dv.getUint32(23, true), wide = version >= 7500, pos = 27;
        var utf8 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
        function text(start, len) {
            if (utf8) return utf8.decode(u8.subarray(start, start + len));
            return Buffer.from(u8.subarray(start, start + len)).toString("utf8");
        }
        function u64(p) { return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296; }
        // Id đối tượng FBX là int64 — vượt 2^53 thì Number làm trùng id, nên giữ dạng chuỗi.
        function i64(p) {
            if (typeof dv.getBigInt64 === "function") return dv.getBigInt64(p, true).toString();
            return String(dv.getInt32(p + 4, true) * 4294967296 + dv.getUint32(p, true));
        }
        function array(type, size) {
            var count = dv.getUint32(pos, true), encoding = dv.getUint32(pos + 4, true), clen = dv.getUint32(pos + 8, true);
            pos += 12;
            var raw = u8.subarray(pos, pos + clen);
            pos += clen;
            var bytes = encoding === 1 ? inflate(raw, count * size) : raw.slice(0);
            var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * size);
            if (type === "d") return new Float64Array(buf);
            if (type === "f") return new Float32Array(buf);
            if (type === "i") return new Int32Array(buf);
            if (type === "b") return new Uint8Array(buf);
            if (typeof BigInt64Array !== "undefined") return Array.from(new BigInt64Array(buf), function (v) { return v.toString(); });
            return [];
        }
        function readProp() {
            var t = String.fromCharCode(u8[pos++]), v, n;
            switch (t) {
                case "Y": v = dv.getInt16(pos, true); pos += 2; return v;
                case "C": v = !!u8[pos]; pos += 1; return v;
                case "I": v = dv.getInt32(pos, true); pos += 4; return v;
                case "F": v = dv.getFloat32(pos, true); pos += 4; return v;
                case "D": v = dv.getFloat64(pos, true); pos += 8; return v;
                case "L": v = i64(pos); pos += 8; return v;
                case "S": n = dv.getUint32(pos, true); pos += 4; v = text(pos, n); pos += n; return v;
                case "R": n = dv.getUint32(pos, true); pos += 4; v = u8.subarray(pos, pos + n); pos += n; return v;
                case "d": case "l": return array(t, 8);
                case "f": case "i": return array(t, 4);
                case "b": return array(t, 1);
                default: throw new Error("FBX: kiểu thuộc tính lạ '" + t + "' ở byte " + (pos - 1));
            }
        }
        var head = wide ? 25 : 13;
        function readNode() {
            if (pos + head > u8.length) return null;
            var end = wide ? u64(pos) : dv.getUint32(pos, true);
            var nprops = wide ? u64(pos + 8) : dv.getUint32(pos + 4, true);
            var nameLen = u8[pos + head - 1];
            pos += head;
            if (end === 0) return null;
            var name = text(pos, nameLen);
            pos += nameLen;
            var props = [];
            for (var i = 0; i < nprops; i++) props.push(readProp());
            var children = [];
            while (pos < end) {
                var c = readNode();
                if (!c) break;
                children.push(c);
            }
            pos = end;
            return { name: name, props: props, children: children };
        }
        var nodes = [];
        for (;;) {
            var node = readNode();
            if (!node) break;
            nodes.push(node);
        }
        return { version: version, nodes: nodes };
    }

    function parseAscii(text) {
        var i = 0, n = text.length;
        var vm = text.match(/FBX (\d+)\.(\d+)\.(\d+)/) || text.match(/FBXVersion:\s*(\d)(\d)(\d)\d?/);
        var version = vm ? (+vm[1]) * 1000 + (+vm[2]) * 100 + (+vm[3]) * 10 : 0;
        function isSpace(c) { return c === " " || c === "\t"; }
        function skipBlank() {
            while (i < n) {
                var c = text[i];
                if (c === ";") { while (i < n && text[i] !== "\n") i++; }
                else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") i++;
                else break;
            }
        }
        function readValue() {
            var c = text[i];
            if (c === '"') {
                var close = text.indexOf('"', i + 1);
                if (close < 0) close = n;
                var s = text.slice(i + 1, close);
                i = close + 1;
                return s;
            }
            var start = i;
            while (i < n) {
                c = text[i];
                if (c === "," || c === "{" || c === "}" || c === "\n" || c === "\r" || isSpace(c)) break;
                i++;
            }
            var tok = text.slice(start, i);
            if (/^-?\d{16,}$/.test(tok)) return tok; // id int64: giữ nguyên chữ số
            var num = Number(tok);
            return tok !== "" && !isNaN(num) ? num : tok;
        }
        function parseList() {
            var nodes = [];
            for (;;) {
                skipBlank();
                if (i >= n) return nodes;
                if (text[i] === "}") { i++; return nodes; }
                var colon = text.indexOf(":", i);
                if (colon < 0) { i = n; return nodes; }
                var name = text.slice(i, colon).trim();
                i = colon + 1;
                var props = [];
                for (;;) {
                    while (i < n && isSpace(text[i])) i++;
                    var c = text[i];
                    if (i >= n || c === "{" || c === "}" || c === "\n" || c === "\r" || c === ";") break;
                    props.push(readValue());
                    while (i < n && isSpace(text[i])) i++;
                    if (text[i] !== ",") break;
                    i++;
                    // giá trị kế tiếp có thể ở dòng sau (mảng số dài xuống dòng sau dấu phẩy)
                    while (i < n && (isSpace(text[i]) || text[i] === "\n" || text[i] === "\r")) i++;
                }
                while (i < n && isSpace(text[i])) i++;
                var children = [];
                if (text[i] === "{") { i++; children = parseList(); }
                var node = { name: name, props: props, children: children };
                // "Vertices: *24 { a: … }" → props = [mảng số]
                if (props.length === 1 && typeof props[0] === "string" && /^\*\d+$/.test(props[0])) {
                    var a = null;
                    for (var k = 0; k < children.length; k++) if (children[k].name === "a") a = children[k];
                    node.props = [a ? a.props : []];
                    node.children = [];
                }
                nodes.push(node);
            }
        }
        return { version: version, nodes: parseList() };
    }

    function parse(input) {
        var u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (isBinary(u8)) return parseBinary(u8);
        var text = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(u8) : Buffer.from(u8).toString("utf8");
        if (!/FBXHeaderExtension|; FBX \d/.test(text.slice(0, 2000))) throw new Error("Không phải file FBX.");
        return parseAscii(text);
    }

    // ───────────────────────── truy vấn cây ─────────────────────────
    function childNamed(node, name) {
        var list = node ? node.children || node.nodes || [] : [];
        for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
        return null;
    }
    function childrenNamed(node, name) {
        return (node ? node.children || node.nodes || [] : []).filter(function (c) { return c.name === name; });
    }
    // Properties70 { P: "Tên", "kiểu", "nhãn", "cờ", giá trị… } → { Tên: [giá trị…] }
    function props70(node) {
        var p = childNamed(node, "Properties70") || childNamed(node, "Properties60"), out = {};
        (p ? p.children : []).forEach(function (c) { out[c.props[0]] = c.props.slice(c.name === "P" ? 4 : 3); });
        return out;
    }
    // "Shovel\x00\x01Model" (nhị phân) hoặc "Model::Shovel" (ASCII) → "Shovel"
    function objectName(raw) {
        var s = String(raw == null ? "" : raw);
        var sep = s.indexOf("\x00\x01");
        if (sep >= 0) return s.slice(0, sep);
        var dc = s.indexOf("::");
        return dc >= 0 ? s.slice(dc + 2) : s;
    }
    function arrayOf(node) {
        var v = node && node.props[0];
        return v && typeof v.length === "number" && typeof v !== "string" ? v : [];
    }
    function stringOf(node, fallback) {
        return node && typeof node.props[0] === "string" ? node.props[0] : fallback;
    }

    // ───────────────────────── ma trận 4×4 (cột chính, như mesh-core) ─────────────────────────
    var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function mul(a, b) {
        var m = new Array(16);
        for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++)
            m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        return m;
    }
    function chain() { var m = IDENT; for (var i = 0; i < arguments.length; i++) m = mul(m, arguments[i]); return m; }
    function translate(v) { return v ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0] || 0, v[1] || 0, v[2] || 0, 1] : IDENT; }
    function untranslate(v) { return v ? translate([-(v[0] || 0), -(v[1] || 0), -(v[2] || 0)]) : IDENT; }
    function scale(v) { return v ? [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1] : IDENT; }
    function axisRot(axis, deg) {
        var r = (deg || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
        if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
        return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }
    // Thứ tự Euler của FBX: eEulerXYZ (0) = quay X trước, rồi Y, rồi Z → M = Rz·Ry·Rx.
    var EULER_ORDER = [[0, 1, 2], [0, 2, 1], [1, 2, 0], [1, 0, 2], [2, 0, 1], [2, 1, 0], [0, 1, 2]];
    function euler(v, order) {
        if (!v) return IDENT;
        var seq = EULER_ORDER[order || 0] || EULER_ORDER[0], m = IDENT;
        for (var i = 0; i < 3; i++) m = mul(axisRot(seq[i], v[seq[i]]), m);
        return m;
    }
    function transpose3(m) { // nghịch đảo của ma trận quay thuần (phần 3×3), bỏ tịnh tiến
        return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
    }

    // Transform cục bộ của Model theo công thức FBX SDK:
    //   T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
    function localMatrix(p) {
        var order = p.RotationOrder ? p.RotationOrder[0] : 0;
        var pre = euler(p.PreRotation, 0), post = euler(p.PostRotation, 0);
        return chain(
            translate(p["Lcl Translation"]), translate(p.RotationOffset), translate(p.RotationPivot),
            pre, euler(p["Lcl Rotation"], order), transpose3(post), untranslate(p.RotationPivot),
            translate(p.ScalingOffset), translate(p.ScalingPivot), scale(p["Lcl Scaling"]), untranslate(p.ScalingPivot)
        );
    }
    // Geometric transform chỉ áp cho mesh của chính Model, không truyền xuống con.
    function geometricMatrix(p) {
        return chain(translate(p.GeometricTranslation), euler(p.GeometricRotation, 0), scale(p.GeometricScaling));
    }

    // Hệ trục của file → tay phải, Y lên, Z hướng về người xem (như glTF / Maya mặc định).
    function axisMatrix(gs) {
        function get(name, def) { return gs[name] ? gs[name][0] : def; }
        var up = get("UpAxis", 1), upSign = get("UpAxisSign", 1);
        var front = get("FrontAxis", 2), frontSign = get("FrontAxisSign", 1);
        var coord = get("CoordAxis", 0), coordSign = get("CoordAxisSign", 1);
        if (up === front || up === coord || front === coord) return IDENT;
        var m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        m[coord * 4 + 0] = coordSign;  // x mới = coordSign · v[coord]
        m[up * 4 + 1] = upSign;        // y mới = upSign · v[up]
        m[front * 4 + 2] = frontSign;  // z mới = frontSign · v[front]
        return m;
    }

    function det3(m) {
        return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    }
    // Ma trận cho normal: nghịch đảo chuyển vị phần 3×3 (đúng cả khi scale không đều).
    function normalMatrix(m) {
        var a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
        var A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
        var D = -(b * k - c * h), E = a * k - c * g, F = -(a * h - b * g);
        var G = b * f - c * e, H = -(a * f - c * d), K = a * e - b * d;
        var det = a * A + b * B + c * C || 1;
        return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, K / det];
    }

    // ───────────────────────── dựng model ─────────────────────────
    function layerElement(node, dataName, indexName) {
        if (!node) return null;
        return {
            map: stringOf(childNamed(node, "MappingInformationType"), "ByPolygonVertex"),
            ref: stringOf(childNamed(node, "ReferenceInformationType"), "Direct"),
            data: arrayOf(childNamed(node, dataName)),
            index: indexName ? arrayOf(childNamed(node, indexName)) : []
        };
    }
    function elementIndex(le, pv, cp, poly) {
        var k = le.map === "ByPolygonVertex" ? pv : (le.map === "ByVertex" || le.map === "ByVertice") ? cp : le.map === "ByPolygon" ? poly : 0;
        if (le.ref !== "Direct" && le.index.length) k = le.index[k];
        return k;
    }
    function layerOrder(a, b) { return (+a.props[0] || 0) - (+b.props[0] || 0); }

    function loadFBX(input) {
        var doc = parse(input);
        if (doc.version && doc.version < 7000) {
            throw new Error("FBX " + (doc.version / 1000).toFixed(1) + " quá cũ (định dạng 6.x) — hãy xuất lại FBX 2011 trở lên hoặc .glb.");
        }
        var top = { nodes: doc.nodes };
        var objectsNode = childNamed(top, "Objects"), connections = childNamed(top, "Connections");
        if (!objectsNode) throw new Error("File FBX không có khối Objects.");
        var gs = props70(childNamed(top, "GlobalSettings"));

        var geometries = {}, models = {}, materials = {}, modelOrder = [];
        objectsNode.children.forEach(function (node) {
            var id = String(node.props[0]);
            if (node.name === "Geometry" && node.props[2] === "Mesh") geometries[id] = node;
            else if (node.name === "Model") { models[id] = { node: node, name: objectName(node.props[1]), props: props70(node) }; modelOrder.push(id); }
            else if (node.name === "Material") materials[id] = objectName(node.props[1]);
        });
        var parentOf = {}, geometryOf = {}, materialsOf = {};
        (connections ? connections.children : []).forEach(function (c) {
            if (c.name !== "C" && c.name !== "Connect") return;
            if (c.props[0] !== "OO") return;
            var child = String(c.props[1]), parent = String(c.props[2]);
            if (geometries[child] && models[parent]) (geometryOf[parent] = geometryOf[parent] || []).push(child);
            else if (models[child] && models[parent]) parentOf[child] = parent;
            else if (materials.hasOwnProperty(child) && models[parent]) (materialsOf[parent] = materialsOf[parent] || []).push(child);
        });

        var worldCache = {};
        function world(id, depth) {
            if (worldCache[id]) return worldCache[id];
            var m = localMatrix(models[id].props);
            if (parentOf[id] && depth < 64) m = mul(world(parentOf[id], depth + 1), m);
            worldCache[id] = m;
            return m;
        }
        var unit = (gs.UnitScaleFactor ? gs.UnitScaleFactor[0] : 1) / 100; // đơn vị file (mặc định cm) → mét
        var sceneMatrix = mul(scale([unit, unit, unit]), axisMatrix(gs));

        var pos = [], nrm = [], uv = [], uv1 = [], idx = [], parts = [], objects = [];
        modelOrder.forEach(function (modelId) {
            (geometryOf[modelId] || []).forEach(function (geoId) {
                var model = models[modelId], g = geometries[geoId];
                var m = chain(sceneMatrix, world(modelId, 0), geometricMatrix(model.props));
                var nm = normalMatrix(m), flip = det3(m) < 0;
                var V = arrayOf(childNamed(g, "Vertices")), P = arrayOf(childNamed(g, "PolygonVertexIndex"));
                if (!V.length || !P.length) return;
                var normals = layerElement(childrenNamed(g, "LayerElementNormal").sort(layerOrder)[0], "Normals", "NormalsIndex");
                var uvLayers = childrenNamed(g, "LayerElementUV").sort(layerOrder);
                var uv0 = layerElement(uvLayers[0], "UV", "UVIndex"), uvB = layerElement(uvLayers[1], "UV", "UVIndex");
                var matLayer = layerElement(childrenNamed(g, "LayerElementMaterial").sort(layerOrder)[0], "Materials");
                var slots = materialsOf[modelId] || [];

                // Tách đỉnh: cùng control point nhưng khác normal/UV (cạnh cứng, đường cắt UV) là đỉnh khác.
                var base = pos.length, local = new Map(), byMaterial = [];
                var hasNormals = !!(normals && normals.data.length), hasUv = !!(uv0 && uv0.data.length);
                function vertex(cp, pv, poly) {
                    var key = cp, nx = 0, ny = 0, nz = 1, u = 0, v = 0, u1 = null;
                    if (hasNormals) {
                        var ni = elementIndex(normals, pv, cp, poly) * 3;
                        nx = normals.data[ni]; ny = normals.data[ni + 1]; nz = normals.data[ni + 2];
                        key += "|" + Math.round(nx * 1e4) + "," + Math.round(ny * 1e4) + "," + Math.round(nz * 1e4);
                    }
                    if (hasUv) {
                        var ui = elementIndex(uv0, pv, cp, poly) * 2;
                        u = uv0.data[ui]; v = uv0.data[ui + 1];
                        key += "|" + Math.round(u * 1e5) + "," + Math.round(v * 1e5);
                    }
                    if (uvB && uvB.data.length) {
                        var ui1 = elementIndex(uvB, pv, cp, poly) * 2;
                        u1 = [uvB.data[ui1], 1 - uvB.data[ui1 + 1]];
                        key += "|" + Math.round(u1[0] * 1e5) + "," + Math.round(u1[1] * 1e5);
                    }
                    var found = local.get(key);
                    if (found !== undefined) return found;
                    var x = V[cp * 3], y = V[cp * 3 + 1], z = V[cp * 3 + 2];
                    pos.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
                    if (hasNormals) {
                        var tx = nm[0] * nx + nm[1] * ny + nm[2] * nz, ty = nm[3] * nx + nm[4] * ny + nm[5] * nz, tz = nm[6] * nx + nm[7] * ny + nm[8] * nz;
                        var len = Math.hypot(tx, ty, tz) || 1;
                        nrm.push([tx / len, ty / len, tz / len]);
                    } else {
                        nrm.push([0, 0, 1]); // như loadOBJ: (0,0,1) khắp nơi = "không có normal", bộ ghi sẽ tự tính
                    }
                    uv.push(hasUv ? [u, 1 - v] : [0, 0]); // FBX: UV gốc dưới-trái → quy ước glTF gốc trên-trái
                    uv1.push(u1);
                    found = pos.length - 1;
                    local.set(key, found);
                    return found;
                }

                var corners = [], poly = 0;
                for (var pv = 0; pv < P.length; pv++) {
                    var raw = P[pv], end = raw < 0, cp = end ? -raw - 1 : raw;
                    corners.push(vertex(cp, pv, poly));
                    if (!end) continue;
                    var mat = matLayer && matLayer.data.length ? matLayer.data[matLayer.map === "AllSame" ? 0 : poly] || 0 : 0;
                    var list = byMaterial[mat] || (byMaterial[mat] = []);
                    for (var k = 1; k + 1 < corners.length; k++) {
                        if (flip) list.push(corners[0], corners[k + 1], corners[k]);
                        else list.push(corners[0], corners[k], corners[k + 1]);
                    }
                    corners = [];
                    poly++;
                }

                var objStart = idx.length;
                byMaterial.forEach(function (list, mi) {
                    if (!list || !list.length) return;
                    parts.push({ material: slots[mi] != null ? materials[slots[mi]] : mi, idxStart: idx.length, idxCount: list.length });
                    for (var t = 0; t < list.length; t++) idx.push(list[t]);
                });
                if (idx.length > objStart) objects.push({ name: model.name || objectName(g.props[1]) || "mesh", idxStart: objStart, idxCount: idx.length - objStart, vertices: pos.length - base });
            });
        });
        if (!objects.length) throw new Error("File FBX không có mesh (chỉ có khung xương / animation?).");
        return { pos: pos, nrm: nrm, uv: uv, uv1: uv1, idx: idx, parts: parts, objects: objects };
    }

    return {
        loadFBX: loadFBX,
        parse: parse,
        inflate: inflate,
        // nội bộ (tests)
        parseAscii: parseAscii,
        axisMatrix: axisMatrix,
        localMatrix: localMatrix
    };
});
