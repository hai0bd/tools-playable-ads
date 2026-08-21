/*
 * script-core.js — đọc & thay file .js bên trong playable HTML (logic thuần, không DOM).
 * ------------------------------------------------------------------------------------
 * UMD, zero-dependency → chạy cả browser (panel) lẫn Node (tests).
 * Global: window.ScriptCore   |   Node: require("./script-core")
 *
 * Hai nguồn script trong 1 playable:
 *   1. "res"    — value của các key `*.js` trong `window.__res` (Cocos 2.4 / super-html).
 *                 Đây là STRING LITERAL đã escape → phải unescape khi đọc, escape khi ghi.
 *   2. "inline" — nội dung các thẻ <script> không có src (boot/CTA/SDK stub).
 *                 Là JS thô trong HTML → đọc/ghi trực tiếp.
 *
 * NGUYÊN TẮC GHI (quan trọng): thay THEO OFFSET trên HTML gốc, KHÔNG serialize lại `__res`.
 * JSON.stringify cả __res sẽ escape asset base122 (~20% ký tự điều khiển) thành \uXXXX →
 * phình file ~1.5×, vượt giới hạn ad-network. Ở đây chỉ đắp đúng đoạn [start,end).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.ScriptCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ───────────────────────── quét window.__res ─────────────────────────
    function braceMatch(s, i) {
        var d = 0, q = false, esc = false;
        for (; i < s.length; i++) {
            var c = s[i];
            if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = false; continue; }
            if (c === '"' || c === "'") q = c;
            else if (c === "{") d++;
            else if (c === "}") { if (--d === 0) return i; }
        }
        return -1;
    }
    // Đọc 1 string literal bắt đầu tại i (html[i] là dấu nháy) → {start,end,quote} với
    // start/end là offset NỘI DUNG (không gồm nháy). end là exclusive.
    function readString(html, i) {
        var quote = html[i], j = i + 1;
        for (; j < html.length; j++) {
            var c = html[j];
            if (c === "\\") { j++; continue; }
            if (c === quote) return { start: i + 1, end: j, quote: quote, next: j + 1 };
        }
        return null;
    }
    function skipWs(html, i) { while (i < html.length && /\s/.test(html[i])) i++; return i; }

    // Trả mảng {key, start, end, quote} cho MỌI cặp key:"value-string" ở cấp 1 của __res.
    function scanResEntries(html) {
        var p = html.indexOf("window.__res");
        if (p < 0) return [];
        var brace = html.indexOf("{", p);
        if (brace < 0) return [];
        var close = braceMatch(html, brace);
        if (close < 0) return [];
        var out = [], i = brace + 1;
        while (i < close) {
            i = skipWs(html, i);
            if (html[i] === "," ) { i++; continue; }
            if (i >= close) break;
            if (html[i] !== '"' && html[i] !== "'") { i++; continue; } // không phải key string → bỏ qua
            var k = readString(html, i);
            if (!k) break;
            var key = html.slice(k.start, k.end);
            i = skipWs(html, k.next);
            if (html[i] !== ":") { i = k.next; continue; }
            i = skipWs(html, i + 1);
            if (html[i] === '"' || html[i] === "'") {
                var v = readString(html, i);
                if (!v) break;
                out.push({ key: key, start: v.start, end: v.end, quote: v.quote });
                i = v.next;
            } else {
                // value không phải string (số/object/mảng) → nhảy qua an toàn
                var depth = 0;
                while (i < close) {
                    var c = html[i];
                    if (c === '"' || c === "'") { var s = readString(html, i); if (!s) break; i = s.next; continue; }
                    if (c === "{" || c === "[") depth++;
                    else if (c === "}" || c === "]") { if (depth === 0) break; depth--; }
                    else if (c === "," && depth === 0) break;
                    i++;
                }
            }
        }
        return out;
    }

    // ───────────────────────── escape / unescape string literal JS ─────────────────────────
    function unescapeJs(raw) {
        var out = "", i = 0;
        while (i < raw.length) {
            var c = raw[i];
            if (c !== "\\") { out += c; i++; continue; }
            var n = raw[i + 1];
            i += 2;
            switch (n) {
                case "n": out += "\n"; break;
                case "r": out += "\r"; break;
                case "t": out += "\t"; break;
                case "b": out += "\b"; break;
                case "f": out += "\f"; break;
                case "v": out += "\v"; break;
                case "0": out += "\0"; break;
                case "x": out += String.fromCharCode(parseInt(raw.substr(i, 2), 16) || 0); i += 2; break;
                case "u":
                    if (raw[i] === "{") { var e = raw.indexOf("}", i); out += String.fromCodePoint(parseInt(raw.slice(i + 1, e), 16) || 0); i = e + 1; }
                    else { out += String.fromCharCode(parseInt(raw.substr(i, 4), 16) || 0); i += 4; }
                    break;
                case "\n": break;              // line continuation
                case "\r": if (raw[i] === "\n") i++; break;
                default: out += n;             // \" \' \\ \/ …
            }
        }
        return out;
    }
    function escapeJs(text, quote) {
        var out = JSON.stringify(String(text)); // escape chuẩn, nháy kép
        out = out.slice(1, -1);
        if (quote === "'") out = out.replace(/\\"/g, '"').replace(/'/g, "\\'");
        // Chuỗi nằm TRONG <script> của HTML: "</script>" sẽ đóng thẻ sớm → phải cắt.
        out = out.replace(/<\//g, "<\\/");
        return out;
    }

    // ───────────────────────── quét <script> inline ─────────────────────────
    function scanInlineScripts(html) {
        var out = [], re = /<script\b([^>]*)>/gi, m;
        while ((m = re.exec(html))) {
            var attrs = m[1] || "";
            if (/\bsrc\s*=/i.test(attrs)) continue;                 // script ngoài → không có nội dung
            // Chỉ loại khi type CÓ và KHÔNG phải JS (json/template…). Lưu ý: không dùng
            // lookahead với ["']? optional — nó khớp nhầm và loại cả type="text/javascript".
            var mt = attrs.match(/\btype\s*=\s*["']?([^"'\s>]*)/i);
            if (mt && mt[1] && !/^(?:text|application)\/javascript$|^module$/i.test(mt[1])) continue;
            var start = m.index + m[0].length;
            var close = html.indexOf("</script", start);
            if (close < 0) continue;
            // Bỏ qua ĐÚNG thẻ định nghĩa kho asset (`window.__res = {…}`): nó nặng vài MB và
            // các file .js bên trong đã liệt kê riêng. Thẻ chỉ *đọc* __res thì vẫn giữ lại.
            if (/window\.__res\s*=\s*[\{\[]/.test(html.slice(start, Math.min(close, start + 4000)))) { re.lastIndex = close; continue; }
            out.push({ start: start, end: close, attrs: attrs.trim() });
            re.lastIndex = close;
        }
        return out;
    }

    // ───────────────────────── phân loại ─────────────────────────
    function scriptKind(name) {
        // .json phải xét TRƯỚC các quy tắc theo đường dẫn (assets/main/config.json không phải "game").
        if (/config\.json$/i.test(name)) return "config";      // bảng uuids/types/paths — sửa dễ hỏng playable
        if (/\.json$/i.test(name)) return "data";              // import metadata / scene nén
        if (/cocos2d|physics|\bbox2d\b/i.test(name)) return "engine";
        if (/settings\.js$/i.test(name)) return "settings";
        if (/^assets\/main\//i.test(name)) return "game";
        if (/^assets\//i.test(name)) return "internal";
        if (/^main\.js$/i.test(name)) return "boot";
        return "other";
    }
    // file dạng JSON (config/metadata) — dùng để chọn cách "định dạng lại" phù hợp
    function isJSON(name) { return /\.json$/i.test(name); }

    // ───────────────────────── API chính ─────────────────────────
    // listScripts(html) → [{id, name, kind, source, start, end, quote, text, size}]
    function listScripts(html) {
        var out = [];
        scanResEntries(html).forEach(function (e) {
            if (!/\.(js|json)$/i.test(e.key)) return;   // gồm cả config.json / import .json
            var raw = html.slice(e.start, e.end);
            out.push({
                id: "res:" + e.key, name: e.key, kind: scriptKind(e.key), source: "res",
                start: e.start, end: e.end, quote: e.quote,
                text: unescapeJs(raw), size: 0
            });
        });
        scanInlineScripts(html).forEach(function (e, i) {
            var text = html.slice(e.start, e.end);
            if (!text.trim()) return;
            // Tên có nghĩa: ưu tiên id="…", kèm trích đoạn code đầu để dễ nhận ra thẻ nào là thẻ nào.
            var idm = e.attrs.match(/\bid\s*=\s*["']?([^"'\s>]+)/i);
            var head = text.replace(/\s+/g, " ").trim().slice(0, 46);
            out.push({
                id: "inline:" + i, idx: i,
                name: (idm ? '<script id="' + idm[1] + '">' : "<script> #" + (i + 1)) + " · " + head,
                kind: "inline", source: "inline", start: e.start, end: e.end, quote: null,
                text: text, size: 0
            });
        });
        out.forEach(function (s) { s.size = s.text.length; });
        var order = { game: 0, config: 1, boot: 2, settings: 3, inline: 4, data: 5, internal: 6, engine: 7, other: 8 };
        out.sort(function (a, b) {
            var d = order[a.kind] - order[b.kind]; if (d) return d;
            if (a.source === "inline" && b.source === "inline") return a.idx - b.idx; // giữ thứ tự trong file
            return a.name.localeCompare(b.name);
        });
        return out;
    }

    // Thay nội dung 1 script → HTML mới. Quét lại theo id để offset luôn khớp html hiện tại.
    function replaceScript(html, id, newText) {
        var list = listScripts(html), cur = null;
        for (var i = 0; i < list.length; i++) if (list[i].id === id) { cur = list[i]; break; }
        if (!cur) throw new Error("Không tìm thấy script " + id + " trong HTML hiện tại.");
        var payload;
        if (cur.source === "res") {
            payload = escapeJs(newText, cur.quote);
        } else {
            if (/<\/script/i.test(newText)) throw new Error("Nội dung chứa '</script>' — không thể nhúng vào thẻ <script> inline.");
            payload = newText;
        }
        return html.slice(0, cur.start) + payload + html.slice(cur.end);
    }

    // ───────────────────────── beautify (an toàn chuỗi/regex/comment, giữ ASI) ─────────────────────────
    function beautifyJS(src, maxLen) {
        if (maxLen && src.length > maxLen) return null;
        var out = "", ind = 0, i = 0, n = src.length;
        function NL() { out += "\n" + new Array(ind + 1).join("  "); }
        function prevSig() { for (var j = out.length - 1; j >= 0; j--) { var c = out[j]; if (c !== " " && c !== "\n") return c; } return ""; }
        // Sau các từ khóa này, dấu "/" mở REGEX chứ không phải phép chia (vd `return/a;b/.test(x)`).
        var KW_RE = { return: 1, typeof: 1, case: 1, "in": 1, of: 1, "new": 1, "delete": 1, "void": 1, "do": 1, "else": 1, yield: 1, instanceof: 1, "throw": 1 };
        function prevWord() { var m = out.match(/([A-Za-z_$][\w$]*)[ \n]*$/); return m ? m[1] : ""; }
        while (i < n) {
            var c = src[i];
            if (c === '"' || c === "'" || c === "`") {
                var q = c; out += c; i++;
                while (i < n) { var d = src[i]; out += d; if (d === "\\") { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } } if (d === q) { i++; break; } i++; }
                continue;
            }
            if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") out += src[i++]; continue; }
            if (c === "/" && src[i + 1] === "*") { out += "/*"; i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) out += src[i++]; out += "*/"; i += 2; continue; }
            if (c === "/") {
                var p = prevSig();
                if (p === "" || "(,=:[!&|?{};+-*%~^<>".indexOf(p) >= 0 || KW_RE[prevWord()]) {
                    out += c; i++; var inCls = false;
                    while (i < n) { var e = src[i]; out += e; if (e === "\\") { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } } else if (e === "[") inCls = true; else if (e === "]") inCls = false; else if (e === "/" && !inCls) { i++; break; } i++; }
                    while (i < n && /[a-z]/i.test(src[i])) out += src[i++];
                    continue;
                }
            }
            if (c === "{") { ind++; out += "{"; NL(); i++; continue; }
            if (c === "}") { ind = Math.max(0, ind - 1); out = out.replace(/[ \n]+$/, ""); NL(); out += "}"; i++; if (src[i] !== ";" && src[i] !== "," && src[i] !== ")") NL(); continue; }
            if (c === ";") { out += ";"; i++; if (src[i] !== "\n") NL(); continue; }
            // GIỮ newline gốc: bỏ đi sẽ nuốt comment `//` và phá ASI ở code không minified
            if (c === "\n" || c === "\r") { i++; if (!/\n[ ]*$/.test(out)) NL(); continue; }
            out += c; i++;
        }
        return out.replace(/\n[ ]*\n+/g, "\n").trim();
    }

    return {
        listScripts: listScripts,
        replaceScript: replaceScript,
        beautifyJS: beautifyJS,
        scriptKind: scriptKind,
        isJSON: isJSON,
        // nội bộ (cho tests)
        scanResEntries: scanResEntries,
        scanInlineScripts: scanInlineScripts,
        unescapeJs: unescapeJs,
        escapeJs: escapeJs
    };
});
