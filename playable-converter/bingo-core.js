/*
 * bingo-core.js — kiểu build "Bingo" cho playable-converter (logic thuần, không DOM).
 * -------------------------------------------------------------------------------------------------
 * Bingo (app đóng gói riêng) và plugin Super HTML cùng xuất một định dạng: cả build web-mobile của
 * Cocos Creator gói thành ZIP → mã hoá base122 (Google: base64) → nhét vào window.__zip, kèm một
 * runtime giải mã và adapter cho mạng quảng cáo. Game gọi PlayableSDK.download() / game_end().
 *
 * File này làm hai việc:
 *   1. ĐỌC GÓI: giải mã window.__zip, đọc mục lục ZIP, bung từng file khi cần, thay một file rồi ghép
 *      lại ZIP (entry không đổi chép nguyên byte đã nén — không giải nén, không nén lại) và ghi ngược
 *      vào HTML. Tab "Asset nhúng" và "Scripts" của converter dùng phần này (qua bingo-panel.js).
 *   2. ĐỔI MẠNG (retarget): file Bingo → mạng khác. Không vá runtime mã hoá của Bingo; thay bằng runtime
 *      viết ở đây (ổ đĩa ảo blob URL + adapter kênh), payload ZIP giữ nguyên. Đăng ký với converter-core
 *      qua registerBuild("bingo") nên convert()/convertAll() dùng như mọi build khác.
 *
 * UMD, không phụ thuộc package nào → chạy cả browser lẫn Node (tests). Cần converter-core.js (base122,
 * ZIP, CRC): browser phải nạp trước, Node tự require.
 * Global: window.BingoBuilder   |   Node: require("./bingo-core")
 *
 * File xuất ra giữ đúng khung Super HTML (super_* + window.super_html = {…}; đứng ngay trước
 * window.__zip=) nên chính playable-converter nhận diện được và build-size-analyzer đọc được.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports && typeof require === "function";
    var core = isNode ? require("./converter-core") : root.PlayableConverter;
    var api = factory(core);
    if (isNode) module.exports = api;
    root.BingoBuilder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
    "use strict";

    if (!core) throw new Error("bingo-core.js cần converter-core.js (window.PlayableConverter) được nạp trước.");

    var VERSION = "1.0";
    var EMPTY = new Uint8Array(0);

    /* ================================================================================ kênh */

    var MRAID_TAG = '<script src="mraid.js"><\/script>';
    // Google App campaigns: khai báo hướng + ExitApi cho CTA. Không dùng ad.size (đó là của display ads).
    var GOOGLE_HEAD = '<meta name="ad.orientation" content="portrait,landscape">'
        + '<script type="text/javascript" src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"><\/script>';

    /* Đúng 5 mạng đầu ra của converter. key theo enum CHANNEL trong PlayableSDK.d.ts của Bingo (game có thể
       đọc PlayableSDK.channel), nên Pangle mang tên "TikTok".
       encoding: Google dùng base64 (như Bingo) — validator của Google không ưa ký tự ngoài ASCII trong script.
       head:     thẻ đặc thù kênh chèn vào <head>. AppLovin tự chèn mraid.js nên KHÔNG khai báo thẻ đó. */
    var CHANNELS = [
        { key: "AppLovin",  label: "AppLovin",        encoding: "base122", head: "" },
        { key: "Unity",     label: "Unity Ads",       encoding: "base122", head: MRAID_TAG },
        { key: "Google",    label: "Google Ads",      encoding: "base64",  head: GOOGLE_HEAD },
        { key: "Mintegral", label: "Mintegral",       encoding: "base122", head: "" },
        { key: "TikTok",    label: "Pangle / TikTok", encoding: "base122", head: "" }
    ];
    var CHANNEL_BY_KEY = {};
    CHANNELS.forEach(function (c) { CHANNEL_BY_KEY[c.key.toLowerCase()] = c; });
    // Tên mạng của converter → kênh ở đây (các tên còn lại trùng sẵn khi viết thường).
    var TARGET_CHANNEL = { pangle: "TikTok" };
    function channel(key) {
        var k = String(key || "").toLowerCase();
        return CHANNEL_BY_KEY[k] || CHANNEL_BY_KEY[String(TARGET_CHANNEL[k] || "").toLowerCase()] || null;
    }

    /* ============================================================================ adapter kênh */

    /* Bốn hàm super_* giữ đúng tên như Super HTML, và khối window.super_html = {...}; đứng ngay trước
       window.__zip= — nhờ vậy playable-converter (convertSuperHtml) đổi mạng cho file này bằng cách
       thay đúng khối đó, y như với file do plugin Super HTML xuất ra. */
    var PRELUDE = [
        'function super_log() { var p = window.__playable; if (p && p.debug) { try { console.log.apply(console, ["[playable]"].concat([].slice.call(arguments))); } catch (e) { } } }',
        'function super_boot_engine() { if (window.__playable) window.__playable.boot(); else window.__playableBootPending = true; }',
        'function super_check_channel(api) { return !!api; }',
        'function super_get_url(url) { return window.__playable ? window.__playable.url(url) : (url || ""); }'
    ].join("\n");

    function adapterSource(key) {
        var body, pre = [];
        switch (key) {
            case "Google":
                body = [
                    '    download: function (url) { super_log("download"); if (window.ExitApi && typeof window.ExitApi.exit === "function") { try { window.ExitApi.exit(); return; } catch (e) { } } window.__playable.open(url); },',
                    '    game_end: function () { super_log("game end"); },',
                    '    game_ready: function () { super_log("game ready"); super_boot_engine(); },'
                ];
                break;
            case "Mintegral":
                // Container của Mintegral gọi gameStart/gameClose và cung cấp install/gameReady/gameEnd.
                // Viết đúng dạng "window.gameReady && window.gameReady()" vì validate() của converter tìm chuỗi đó.
                pre = [
                    'window.gameStart = function () { super_log("gameStart"); if (window.__playable) window.__playable.fire("resume"); };',
                    'window.gameClose = function () { super_log("gameClose"); if (window.__playable) window.__playable.fire("pause"); };'
                ];
                body = [
                    '    download: function (url) { super_log("download"); if (typeof window.install === "function") { try { window.install(); return; } catch (e) { } } window.__playable.open(url); },',
                    '    game_end: function () { super_log("game end"); try { window.gameEnd && window.gameEnd(); } catch (e) { } },',
                    '    game_ready: function () { super_log("game ready"); super_boot_engine(); try { window.gameReady && window.gameReady(); } catch (e) { } },'
                ];
                break;
            case "TikTok":
                body = [
                    '    download: function (url) { super_log("download"); var s = window.playableSDK; if (s && typeof s.openAppStore === "function") { try { s.openAppStore(); return; } catch (e) { } } if (typeof window.openAppStore === "function") { try { window.openAppStore(); return; } catch (e) { } } window.__playable.open(url); },',
                    '    game_end: function () { super_log("game end"); var s = window.playableSDK; if (s && typeof s.gameEnd === "function") { try { s.gameEnd(); } catch (e) { } } },',
                    '    game_ready: function () { super_log("game ready"); super_boot_engine(); },'
                ];
                break;
            default: // AppLovin, Unity — MRAID
                body = [
                    '    download: function (url) { super_log("download"); window.__playable.mraidOpen(url); },',
                    '    game_end: function () { super_log("game end"); },',
                    '    game_ready: function () { super_log("game ready"); window.__playable.mraidHooks(); super_boot_engine(); },'
                ];
        }
        return pre.concat(["window.super_html = {"], body, [
            "    is_hide_download: function () { return false; },",
            '    google_play_url: "",',
            '    appstore_url: ""',
            "};"
        ]).join("\n");
    }

    /* ============================================================================== inflate */

    /* inflate (RFC 1951) thuần JS. Dùng ở tool (bung file trong gói một cách đồng bộ) và được chép
       nguyên văn vào runtime của file xuất ra làm đường dự phòng khi WebView không có
       DecompressionStream — nên phải tự chứa hoàn toàn (bảng mã khai báo bên trong), ES5. */
    function inflateRaw(src, outSize) {
        var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
        var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        var out = new Uint8Array(outSize > 0 ? outSize : Math.max(1024, src.length * 4)), op = 0;
        var ip = 0, bitBuf = 0, bitCnt = 0;
        function need(n) {
            if (op + n <= out.length) return;
            var bigger = new Uint8Array(Math.max(out.length * 2, op + n));
            bigger.set(out); out = bigger;
        }
        function bits(n) {
            while (bitCnt < n) {
                if (ip >= src.length) throw new Error("inflate: hết dữ liệu");
                bitBuf |= src[ip++] << bitCnt; bitCnt += 8;
            }
            var v = bitBuf & ((1 << n) - 1);
            bitBuf >>>= n; bitCnt -= n;
            return v;
        }
        function huff(lengths, n) {
            var count = new Uint16Array(16), offs = new Uint16Array(16), symbol = new Uint16Array(n), i;
            for (i = 0; i < n; i++) count[lengths[i]]++;
            count[0] = 0;
            for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
            for (i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
            return { count: count, symbol: symbol };
        }
        function decode(h) {
            var code = 0, first = 0, index = 0, len, count;
            for (len = 1; len < 16; len++) {
                code |= bits(1);
                count = h.count[len];
                if (code - count < first) return h.symbol[index + (code - first)];
                index += count; first += count; first <<= 1; code <<= 1;
            }
            throw new Error("inflate: mã Huffman hỏng");
        }
        function codes(lit, dist) {
            for (;;) {
                var sym = decode(lit);
                if (sym < 256) { need(1); out[op++] = sym; }
                else if (sym === 256) return;
                else {
                    sym -= 257;
                    if (sym >= 29) throw new Error("inflate: length code hỏng");
                    var len = LBASE[sym] + bits(LEXT[sym]);
                    var ds = decode(dist);
                    if (ds >= 30) throw new Error("inflate: distance code hỏng");
                    var d = DBASE[ds] + bits(DEXT[ds]);
                    if (d > op) throw new Error("inflate: distance vượt đầu buffer");
                    need(len);
                    var from = op - d;
                    while (len--) out[op++] = out[from++];
                }
            }
        }
        var fixedLit = null, fixedDist = null, last, type, i;
        do {
            last = bits(1);
            type = bits(2);
            if (type === 0) {
                bitBuf = 0; bitCnt = 0; // bỏ phần bit lẻ, LEN/NLEN nằm ở biên byte
                var len0 = src[ip] | (src[ip + 1] << 8), nlen0 = src[ip + 2] | (src[ip + 3] << 8);
                ip += 4;
                if ((len0 ^ 0xffff) !== nlen0) throw new Error("inflate: stored block hỏng");
                need(len0);
                out.set(src.subarray(ip, ip + len0), op);
                op += len0; ip += len0;
            } else if (type === 1) {
                if (!fixedLit) {
                    var fl = new Uint8Array(288), fd = new Uint8Array(30);
                    for (i = 0; i < 144; i++) fl[i] = 8;
                    for (; i < 256; i++) fl[i] = 9;
                    for (; i < 280; i++) fl[i] = 7;
                    for (; i < 288; i++) fl[i] = 8;
                    for (i = 0; i < 30; i++) fd[i] = 5;
                    fixedLit = huff(fl, 288); fixedDist = huff(fd, 30);
                }
                codes(fixedLit, fixedDist);
            } else if (type === 2) {
                var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
                var clens = new Uint8Array(19);
                for (i = 0; i < ncode; i++) clens[ORDER[i]] = bits(3);
                var lencode = huff(clens, 19);
                var total = nlen + ndist, lens = new Uint8Array(total), idx = 0;
                while (idx < total) {
                    var sym2 = decode(lencode), rep, val;
                    if (sym2 < 16) { lens[idx++] = sym2; continue; }
                    if (sym2 === 16) { if (!idx) throw new Error("inflate: repeat không có mã trước"); val = lens[idx - 1]; rep = 3 + bits(2); }
                    else if (sym2 === 17) { val = 0; rep = 3 + bits(3); }
                    else { val = 0; rep = 11 + bits(7); }
                    if (idx + rep > total) throw new Error("inflate: bảng mã tràn");
                    while (rep--) lens[idx++] = val;
                }
                codes(huff(lens.subarray(0, nlen), nlen), huff(lens.subarray(nlen), ndist));
            } else throw new Error("inflate: block type hỏng");
        } while (!last);
        return op === out.length ? out : out.subarray(0, op);
    }

    /* ============================================================================== runtime */

    /* Toàn bộ hàm này được toString() rồi nhúng vào file xuất ra (cùng inflateRaw ở trên), nên:
         - chỉ dùng cú pháp ES5 (WebView cũ vẫn chạy được phần giải mã và báo lỗi tử tế),
         - KHÔNG được chứa chuỗi "</script" hay "<!--",
         - ngoài CFG và inflateRaw không tham chiếu gì khác của module. */
    function playableRuntime(CFG) {
        var W = window, D = document;
        var files = {}, urls = {}, order = [];
        var state = { booted: false, ended: false, paused: false, muted: null };
        var on = { mute: [], unmute: [], pause: [], resume: [] };

        function log() { if (PB.debug) { try { console.log.apply(console, ["[playable]"].concat([].slice.call(arguments))); } catch (e) { } } }
        function warn(m) { try { console.warn("[playable] " + m); } catch (e) { } }

        /* ---------- chuỗi → byte ---------- */
        // base122 kiểu Bingo: 7 bit/ký tự, 7 ký tự cấm [NUL \n \r " & \ <] được ghép vào ký tự 2 byte.
        function decodeBase122(s) {
            var map = [0, 10, 13, 34, 38, 92, 60];
            var out = new Uint8Array(Math.floor(s.length * 14 / 8) + 8), n = 0, cur = 0, bits = 0;
            function push(v) {
                v = (v & 127) << 1;
                cur |= v >>> bits;
                bits += 7;
                if (bits >= 8) { out[n++] = cur & 255; bits -= 8; cur = (v << (7 - bits)) & 255; }
            }
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if (c > 127) { var k = (c >>> 8) & 7; if (k !== 7) push(map[k]); push(c & 127); }
                else push(c);
            }
            return out.subarray(0, n);
        }
        function decodeBase64(s) {
            var bin = W.atob(String(s).replace(/[^A-Za-z0-9+\/=]/g, "")), out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        function utf8(bytes) {
            if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
            var s = "";
            for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
        }

        var nativeInflate = (function () {
            try { new W.DecompressionStream("deflate-raw"); return true; } catch (e) { return false; }
        })();
        function inflateAsync(raw, size) {
            if (!nativeInflate) return new Promise(function (res) { res(inflateRaw(raw, size)); });
            try {
                var ds = new W.DecompressionStream("deflate-raw");
                var done = new W.Response(ds.readable).arrayBuffer();
                var w = ds.writable.getWriter();
                w.write(raw.slice()); w.close();
                return done.then(function (ab) { return new Uint8Array(ab); }, function () { return inflateRaw(raw, size); });
            } catch (e) { return new Promise(function (res) { res(inflateRaw(raw, size)); }); }
        }

        /* ---------- ZIP ---------- */
        function readZip(buf) {
            var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), n = buf.length, eocd = -1, p;
            for (p = n - 22; p >= 0 && p >= n - 65558; p--) if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
            if (eocd < 0) throw new Error("ZIP hỏng: không thấy EOCD");
            var count = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), list = [];
            for (var i = 0; i < count; i++) {
                if (dv.getUint32(off, true) !== 0x02014b50) break;
                var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), usize = dv.getUint32(off + 24, true);
                var nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
                var lofs = dv.getUint32(off + 42, true);
                var name = utf8(buf.subarray(off + 46, off + 46 + nlen));
                if (name.charAt(name.length - 1) !== "/") {
                    var ln = dv.getUint16(lofs + 26, true), le = dv.getUint16(lofs + 28, true), start = lofs + 30 + ln + le;
                    list.push({ name: name, method: method, usize: usize, raw: buf.subarray(start, start + csize) });
                }
                off += 46 + nlen + elen + clen;
            }
            return list;
        }
        function unpack() {
            var enc = String(W.__zipEncoding || "base122").toLowerCase();
            var text = W.__zip;
            if (typeof text !== "string" || !text) throw new Error("không thấy window.__zip");
            var zip = enc === "base64" ? decodeBase64(text) : decodeBase122(text);
            try { W.__zip = null; } catch (e) { }
            if (zip.length < 22 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error("payload không phải ZIP");
            var list = readZip(zip);
            return Promise.all(list.map(function (ent) {
                if (ent.method === 0) return ent.raw;
                if (ent.method !== 8) throw new Error("ZIP method không hỗ trợ: " + ent.method);
                return inflateAsync(ent.raw, ent.usize);
            })).then(function (datas) {
                for (var i = 0; i < list.length; i++) { files[list[i].name] = datas[i]; order.push(list[i].name); }
            });
        }

        /* ---------- ổ đĩa ảo + chặn nạp tài nguyên ---------- */
        var MIME = {
            js: "text/javascript", mjs: "text/javascript", json: "application/json", wasm: "application/wasm",
            css: "text/css", html: "text/html", htm: "text/html", txt: "text/plain", xml: "text/xml", atlas: "text/plain",
            fnt: "text/plain", plist: "text/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            webp: "image/webp", gif: "image/gif", bmp: "image/bmp", ico: "image/x-icon", mp3: "audio/mpeg", ogg: "audio/ogg",
            oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", mp4: "video/mp4", webm: "video/webm",
            ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", bin: "application/octet-stream",
            cconb: "application/octet-stream", mem: "application/octet-stream"
        };
        function mimeOf(name) {
            var ext = (name.match(/\.([a-z0-9]+)$/i) || ["", ""])[1].toLowerCase();
            return MIME[ext] || "application/octet-stream";
        }
        function urlFor(name) {
            if (!urls[name]) urls[name] = W.URL.createObjectURL(new W.Blob([files[name]], { type: mimeOf(name) }));
            return urls[name];
        }
        // Thư mục chứa file HTML này — để cắt tiền tố khỏi URL tuyệt đối mà SystemJS/engine sinh ra.
        var base = (function () {
            try {
                var u = new W.URL(D.baseURI || W.location.href);
                if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") return null;
                return { origin: u.protocol === "file:" ? "" : u.origin, dir: u.pathname.replace(/[^\/]*$/, "") };
            } catch (e) { return null; }
        })();
        function normalize(p) {
            try { p = decodeURIComponent(p); } catch (e) { }
            var parts = String(p).replace(/\\/g, "/").split("/"), out = [];
            for (var i = 0; i < parts.length; i++) {
                var s = parts[i];
                if (!s || s === ".") continue;
                if (s === "..") { out.pop(); continue; }
                out.push(s);
            }
            return out;
        }
        /* URL bất kỳ → tên file trong gói, hoặc null nếu không phải của mình (mraid.js, SDK mạng, analytics…).
           URL tuyệt đối: khi biết thư mục của file HTML thì chỉ nhận URL nằm trong thư mục đó (so khớp chính
           xác, không đoán) — nhờ vậy /sdk/x/index.js của mạng không bị nhầm với index.js trong gói. Chỉ khi
           không biết gốc (about:, data:) mới so đuôi đường dẫn. URL tương đối: khớp chính xác rồi mới so đuôi. */
        function resolve(input) {
            var u = input;
            if (u && typeof u === "object") u = typeof u.url === "string" ? u.url : (typeof u.href === "string" ? u.href : "");
            if (typeof u !== "string" || !u) return null;
            if (/^(blob|data|javascript|mailto|tel|ws|wss):/i.test(u) || /^\/\//.test(u)) return null;
            var s = u.replace(/[?#][\s\S]*$/, ""), anchored = false;
            var m = s.match(/^([a-z][a-z0-9+.\-]*):(?:\/\/([^\/]*))?([\s\S]*)$/i);
            if (m) {
                var scheme = m[1].toLowerCase();
                if (scheme === "http" || scheme === "https") {
                    if (base && base.origin && (scheme + "://" + (m[2] || "")).toLowerCase() !== base.origin.toLowerCase()) return null;
                    s = m[3] || "";
                } else if (scheme === "file") {
                    s = m[3] || "";
                } else if (scheme === "about") {
                    s = m[3] || "";
                    if (s === "blank" || s === "srcdoc") return null;
                } else return null;
                if (base && scheme !== "about") {
                    if (s.indexOf(base.dir) !== 0) return null;
                    s = s.slice(base.dir.length);
                    anchored = true;
                }
            }
            var parts = normalize(s);
            if (!parts.length) return null;
            var key = parts.join("/");
            if (files[key]) return key;
            if (anchored) return null;
            for (var i = 1; i < parts.length; i++) { key = parts.slice(i).join("/"); if (files[key]) return key; }
            return null;
        }
        function map(value) { var hit = resolve(value); return hit ? urlFor(hit) : null; }
        function cssFix(css) {
            return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (all, q, u) {
                var b = map(u);
                return b ? 'url("' + b + '")' : all;
            });
        }
        // CSS viết sẵn trong thẻ style của trang (vd. #splash với url(./splash.png)) được trình duyệt đọc trước khi
        // có ổ đĩa ảo, nên url() trỏ ra ngoài gói. Viết lại một lần sau khi giải nén.
        function fixStaticStyles() {
            var list = D.getElementsByTagName("style");
            for (var i = 0; i < list.length; i++) {
                var css = list[i].textContent || "";
                if (css.indexOf("url(") < 0) continue;
                var fixed = cssFix(css);
                if (fixed !== css) list[i].textContent = fixed;
            }
        }
        function patchAccessor(proto, name, transform) {
            var d = proto && Object.getOwnPropertyDescriptor(proto, name);
            if (!d || !d.set || !d.configurable) return;
            Object.defineProperty(proto, name, {
                configurable: true, enumerable: d.enumerable, get: d.get,
                set: function (v) { d.set.call(this, transform(v, this)); }
            });
        }
        function patch() {
            var XO = W.XMLHttpRequest.prototype.open;
            W.XMLHttpRequest.prototype.open = function (method, url) {
                var b = map(url);
                if (b) arguments[1] = b;
                return XO.apply(this, arguments);
            };
            if (typeof W.fetch === "function") {
                var F = W.fetch;
                W.fetch = function (input, init) {
                    var b = map(input);
                    if (b) return F.call(W, b, init);
                    return F.apply(W, arguments);
                };
            }
            var srcFix = function (v) { var b = typeof v === "string" ? map(v) : null; return b || v; };
            patchAccessor(W.HTMLImageElement && W.HTMLImageElement.prototype, "src", srcFix);
            patchAccessor(W.HTMLScriptElement && W.HTMLScriptElement.prototype, "src", srcFix);
            patchAccessor(W.HTMLMediaElement && W.HTMLMediaElement.prototype, "src", srcFix);
            patchAccessor(W.HTMLSourceElement && W.HTMLSourceElement.prototype, "src", srcFix);
            patchAccessor(W.HTMLLinkElement && W.HTMLLinkElement.prototype, "href", srcFix);
            patchAccessor(W.HTMLVideoElement && W.HTMLVideoElement.prototype, "poster", srcFix);
            var SA = W.Element.prototype.setAttribute;
            W.Element.prototype.setAttribute = function (name, value) {
                var n = String(name).toLowerCase();
                if ((n === "src" || n === "href" || n === "poster") && typeof value === "string") { var b = map(value); if (b) value = b; }
                return SA.call(this, name, value);
            };
            if (typeof W.Audio === "function") {
                var OA = W.Audio;
                var A = function Audio(src) { var a = new OA(); if (src !== undefined) a.src = src; return a; };
                A.prototype = OA.prototype;
                W.Audio = A;
            }
            // Font TTF: Cocos ghi "@font-face { src: url(...) }" vào <style> — đổi url() sang blob trước khi chèn.
            if (W.HTMLStyleElement) {
                var SP = W.HTMLStyleElement.prototype, styleFix = function (v) { return typeof v === "string" ? cssFix(v) : v; };
                var tc = Object.getOwnPropertyDescriptor(W.Node.prototype, "textContent");
                if (tc && tc.set) Object.defineProperty(SP, "textContent", { configurable: true, get: tc.get, set: function (v) { tc.set.call(this, styleFix(v)); } });
                var ih = Object.getOwnPropertyDescriptor(W.Element.prototype, "innerHTML");
                if (ih && ih.set) Object.defineProperty(SP, "innerHTML", { configurable: true, get: ih.get, set: function (v) { ih.set.call(this, styleFix(v)); } });
                var AC = W.Node.prototype.appendChild, IB = W.Node.prototype.insertBefore;
                W.Node.prototype.appendChild = function (c) { if (c && c.nodeType === 3 && this instanceof W.HTMLStyleElement) c.data = cssFix(c.data); return AC.call(this, c); };
                W.Node.prototype.insertBefore = function (c, r) { if (c && c.nodeType === 3 && this instanceof W.HTMLStyleElement) c.data = cssFix(c.data); return IB.call(this, c, r); };
            }
            if (W.CSSStyleSheet && W.CSSStyleSheet.prototype.insertRule) {
                var IR = W.CSSStyleSheet.prototype.insertRule;
                W.CSSStyleSheet.prototype.insertRule = function (rule, idx) { return IR.call(this, cssFix(rule), idx); };
            }
            if (typeof W.FontFace === "function") {
                var OF = W.FontFace;
                var FF = function FontFace(family, source, desc) { return new OF(family, typeof source === "string" ? cssFix(source) : source, desc); };
                FF.prototype = OF.prototype;
                W.FontFace = FF;
            }
        }

        /* ---------- khởi động engine: chạy lại đúng các <script> của index.html gốc ---------- */
        function runScript(step) {
            return new Promise(function (ok, fail) {
                var s = D.createElement("script");
                if (step.src) {
                    s.onload = function () { ok(); };
                    s.onerror = function () { fail(new Error("Không nạp được " + step.src)); };
                    s.src = step.src; // setter đã vá → blob URL
                    D.body.appendChild(s);
                } else {
                    s.text = step.text || "";
                    D.body.appendChild(s); // inline chạy đồng bộ ngay khi chèn
                    ok();
                }
            });
        }
        function boot() {
            if (state.booted) return;
            state.booted = true;
            log("boot", CFG.channel, order.length + " file");
            var p = Promise.resolve();
            (CFG.scripts || []).forEach(function (st) { p = p.then(function () { return runScript(st); }); });
            p.then(function () { log("engine scripts loaded"); }, function (e) { warn("boot: " + (e && e.message || e)); });
        }

        /* ---------- SDK cho game + móc sự kiện của mạng ---------- */
        function fire(name) {
            if (name === "pause") { if (state.paused) return; state.paused = true; }
            else if (name === "resume") { if (!state.paused) return; state.paused = false; }
            else if (name === "mute") { if (state.muted === true) return; state.muted = true; }
            else if (name === "unmute") { if (state.muted === false) return; state.muted = false; }
            log(name);
            var list = on[name] || [];
            for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { warn(name + " callback: " + e); } }
        }
        function storeUrl(fallback) {
            var sh = W.super_html || {};
            var ios = CFG.ios || sh.appstore_url || "", android = CFG.android || sh.google_play_url || "";
            var isIOS = /iPhone|iPad|iPod/i.test(W.navigator && W.navigator.userAgent || "");
            return (isIOS ? (ios || android) : (android || ios)) || fallback || "";
        }
        function openUrl(url) {
            url = storeUrl(url);
            if (!url) { warn("chưa cấu hình store URL"); return; }
            try { var w = W.open(url, "_blank"); if (!w) W.location.href = url; } catch (e) { try { W.location.href = url; } catch (x) { } }
        }
        // Viết rõ "W.mraid.open" (không qua biến tạm): validate() của converter tìm chuỗi mraid.open.
        function mraidOpen(url) {
            url = storeUrl(url);
            if (W.mraid && typeof W.mraid.open === "function") {
                var go = function () { try { if (url) W.mraid.open(url); else W.mraid.open(); } catch (e) { openUrl(url); } };
                try { if (typeof W.mraid.getState === "function" && W.mraid.getState() === "loading") { W.mraid.addEventListener("ready", go); return; } } catch (e) { }
                go();
                return;
            }
            openUrl(url);
        }
        function resizeEvent() {
            try { W.dispatchEvent(new W.Event("resize")); }
            catch (e) { try { var ev = D.createEvent("Event"); ev.initEvent("resize", true, true); W.dispatchEvent(ev); } catch (x) { } }
        }
        function mraidHooks() {
            var m = W.mraid;
            if (!m || typeof m.addEventListener !== "function") return;
            var bind = function () {
                try { m.addEventListener("viewableChange", function (v) { fire(v ? "resume" : "pause"); }); } catch (e) { }
                try { m.addEventListener("audioVolumeChange", function (vol) { fire(Number(vol) === 0 ? "mute" : "unmute"); }); } catch (e) { }
                try { m.addEventListener("orientationChange", resizeEvent); } catch (e) { }
                try { m.addEventListener("sizeChange", resizeEvent); } catch (e) { }
            };
            try { if (typeof m.getState === "function" && m.getState() === "loading") m.addEventListener("ready", bind); else bind(); } catch (e) { bind(); }
        }

        var PB = W.__playable = {
            version: CFG.version, channel: CFG.channel, debug: !!CFG.debug,
            files: files, order: order, state: state, on: on,
            resolve: resolve, urlFor: urlFor, boot: boot, fire: fire, url: storeUrl, open: openUrl,
            mraidOpen: mraidOpen, mraidHooks: mraidHooks,
            inflate: inflateRaw, decodeBase122: decodeBase122, decodeBase64: decodeBase64, readZip: readZip
        };
        W.PlayableSDK = {
            channel: CFG.channel,
            download: function () { try { W.super_html.download(); } catch (e) { warn("download: " + e); openUrl(); } },
            game_end: function () { if (state.ended) return; state.ended = true; try { W.super_html.game_end(); } catch (e) { warn("game_end: " + e); } },
            onMute: function (cb) { if (typeof cb === "function") on.mute.push(cb); },
            onUnmute: function (cb) { if (typeof cb === "function") on.unmute.push(cb); },
            onPause: function (cb) { if (typeof cb === "function") on.pause.push(cb); },
            onResume: function (cb) { if (typeof cb === "function") on.resume.push(cb); }
        };
        if (CFG.testOnly) return;

        D.addEventListener("visibilitychange", function () { fire(D.hidden ? "pause" : "resume"); });
        patch();
        unpack().then(function () {
            log("unpacked", order.length, "files");
            fixStaticStyles();
            var sh = W.super_html;
            if (sh && typeof sh.game_ready === "function") sh.game_ready(); else boot();
            if (W.__playableBootPending) boot();
        }, function (e) {
            var msg = String(e && e.message || e);
            warn("unpack: " + msg);
            try {
                D.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;left:0;right:0;top:40%;padding:0 20px;color:#f66;font:14px sans-serif;text-align:center">Playable lỗi: '
                    + msg.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</div>");
            } catch (x) { }
        });
    }

    function jsonForScript(o) {
        return JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    // Runtime hoàn chỉnh = inflateRaw + playableRuntime, bọc thành một function expression nhận CFG.
    function runtimeSource() {
        return "function (CFG) {\n" + inflateRaw.toString() + "\n(" + playableRuntime.toString() + ")(CFG);\n}";
    }
    function runtimeScript(cfg) { return "(" + runtimeSource() + ")(" + jsonForScript(cfg) + ");"; }

    /* =========================================================================== tiện ích chung */

    // Runtime riêng của Bingo nằm trong gói (loader + SDK). Runtime mới thay thế chúng nên bỏ khi đổi mạng.
    var BINGO_RUNTIME_FILES = /^(BingoEngine|PlayableSDK)\.js$/i;
    var MIME_TYPES = {
        js: "text/javascript", mjs: "text/javascript", json: "application/json", wasm: "application/wasm",
        css: "text/css", html: "text/html", htm: "text/html", txt: "text/plain", xml: "text/xml", atlas: "text/plain",
        fnt: "text/plain", plist: "text/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        webp: "image/webp", gif: "image/gif", bmp: "image/bmp", ico: "image/x-icon", mp3: "audio/mpeg", ogg: "audio/ogg",
        oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", mp4: "video/mp4", webm: "video/webm",
        ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", bin: "application/octet-stream",
        cconb: "application/octet-stream", mem: "application/octet-stream"
    };
    function mimeOf(name) {
        var ext = (String(name).match(/\.([a-z0-9]+)$/i) || ["", ""])[1].toLowerCase();
        return MIME_TYPES[ext] || "application/octet-stream";
    }
    // Nhóm để tab Asset nhúng chia loại. Không dùng "model" vì tab đó ẩn nhóm model (dành cho Mesh 3D).
    function packageKind(name) {
        var t = mimeOf(name);
        if (/^image\//.test(t)) return "image";
        if (/^audio\//.test(t)) return "audio";
        if (/^font\//.test(t)) return "font";
        if (/\.(json|js|txt|atlas|fnt|plist|xml|bin|cconb|css|html?)$/i.test(name)) return "data";
        return "other";
    }
    // Cùng bộ nhãn với ScriptCore.scriptKind để tab Scripts hiện nhất quán.
    function scriptKindOf(name) {
        if (/config\.json$/i.test(name)) return "config";
        if (/\.json$/i.test(name)) return "data";
        if (/^cocos-js\/|^src\/(system|polyfills)\.bundle\.js$|^cocos2d-js|^physics(-min)?\./i.test(name)) return "engine";
        if (/settings\.js$/i.test(name)) return "settings";
        if (/^assets\/main\//i.test(name)) return "game";
        if (/^assets\//i.test(name)) return "internal";
        if (/^(main|index|application)\.js$|^src\/chunks\//i.test(name)) return "boot";
        return "other";
    }

    function normalizePath(p) {
        var parts = String(p || "").replace(/\\/g, "/").split("/"), out = [];
        for (var i = 0; i < parts.length; i++) {
            var s = parts[i];
            if (!s || s === ".") continue;
            if (s === "..") { out.pop(); continue; }
            out.push(s);
        }
        return out.join("/");
    }
    function dirOf(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i + 1); }
    function joinPath(dir, rel) { return rel.charAt(0) === "/" ? normalizePath(rel) : normalizePath(dir + rel); }
    function text(bytes) {
        if (bytes == null) return "";
        if (typeof bytes === "string") return bytes;
        if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
        return Buffer.from(bytes).toString("utf8");
    }
    function attrOf(tag, name) {
        var m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
        return m ? (m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])) : "";
    }
    function minifyCss(css) {
        return String(css).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};:,>])\s*/g, "$1").replace(/;}/g, "}").trim();
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
    }
    function headOf(html) { return (String(html).match(/<head[^>]*>([\s\S]*?)<\/head>/i) || ["", ""])[1]; }
    function titleOf(head) { return (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ["", ""])[1].replace(/\s+/g, " ").trim(); }
    function metasOf(head) {
        return (head.match(/<meta\b[^>]*>/gi) || []).filter(function (t) { return !/charset|ad\.orientation|ad\.size/i.test(t); }).join("");
    }
    function inlineStylesOf(head) {
        return (head.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).map(function (block) {
            return minifyCss(block.replace(/^<style[^>]*>/i, "").replace(/<\/style>$/i, ""));
        }).join("");
    }
    function bodyMarkupOf(html) {
        var bodyHtml = (String(html).match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ["", ""])[1];
        return bodyHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
    }

    /* ================================================================ khung trang + khởi động */

    var BASE_CSS = "html{-ms-touch-action:none}body,canvas,div{display:block;outline:0;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}"
        + "body{position:absolute;top:0;left:0;width:100%;height:100%;padding:0;border:0;margin:0;cursor:default;color:#888;background-color:#333;text-align:center;font-family:Helvetica,Verdana,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden}"
        + "canvas{background-color:rgba(0,0,0,0)}";
    var DEFAULT_CSS_3X = BASE_CSS + "#Cocos3dGameContainer,#GameCanvas,#GameDiv{width:100%;height:100%}";
    var DEFAULT_CSS_2X = BASE_CSS + "#Cocos2dGameContainer{position:absolute;margin:0;left:0;top:0;display:-webkit-box;-webkit-box-orient:horizontal;-webkit-box-align:center;-webkit-box-pack:center}"
        + "#splash{position:absolute;top:0;left:0;width:100%;height:100%;background:#171717 url(./splash.png) no-repeat center;background-size:45%}"
        + ".progress-bar{position:absolute;left:27.5%;top:80%;height:3px;padding:2px;width:45%;border-radius:7px}.progress-bar span{display:block;height:100%;border-radius:3px;background-color:#3dc5de}";
    // main.js của 2.x đọc "#splash .progress-bar span" ngay khi khởi động — thiếu phần tử này là văng lỗi.
    var SPLASH_2X = '<div id="splash" style="display:none"><div class="progress-bar"><span></span></div></div>';

    // Khung index.html chuẩn của build web-mobile Cocos Creator 3.x (Bingo không giữ index.html trong gói).
    function defaultIndex3x(map) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Playable</title>'
            + '<meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1,minimal-ui=true">'
            + "<style>" + DEFAULT_CSS_3X + "</style></head><body>"
            + '<div id="GameDiv" cc_exact_fit_screen="true"><div id="Cocos3dGameContainer"><canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="99"></canvas></div></div>'
            + '<script src="src/polyfills.bundle.js"><\/script><script src="src/system.bundle.js"><\/script>'
            + (map["src/import-map.json"] ? '<script src="src/import-map.json" type="systemjs-importmap"><\/script>' : '<script type="systemjs-importmap">{"imports":{"cc":"./cocos-js/cc.js"}}<\/script>')
            + "<script>System.import('./index.js').catch(function (err) { console.error(err); });<\/script></body></html>";
    }

    /* Build web-mobile Cocos Creator 2.x: main.js (window.boot), src/settings.js, cocos2d-js-min.js và physics-min.js
       tuỳ dự án. Tên có thể kèm hash khi bật md5Cache (main.1a2b3.js). Trả null nếu gói không phải 2.x. */
    function findCocos2x(map) {
        var names = Object.keys(map);
        function pick(re) { return names.filter(function (n) { return re.test(n); }).sort(function (a, b) { return a.length - b.length; })[0] || ""; }
        var found = {
            settings: pick(/^src\/settings(\.[0-9a-f]{5,})?\.js$/i),
            main: pick(/^main(\.[0-9a-f]{5,})?\.js$/i),
            engine: pick(/^cocos2d-js-min(\.[0-9a-f]{5,})?\.js$/i) || pick(/^cocos2d-js(\.[0-9a-f]{5,})?\.js$/i),
            physics: pick(/^physics-min(\.[0-9a-f]{5,})?\.js$/i) || pick(/^physics(\.[0-9a-f]{5,})?\.js$/i)
        };
        return found.settings && found.main && found.engine ? found : null;
    }
    // Giống đoạn script cuối index.html của template web-mobile 2.x: nạp engine, physics (nếu engine bật), rồi window.boot().
    function loader2x(v2) {
        var afterEngine = v2.physics
            ? [
                '        var known = typeof CC_PHYSICS_BUILTIN !== "undefined" || typeof CC_PHYSICS_CANNON !== "undefined";',
                '        var need = !known || (typeof CC_PHYSICS_BUILTIN !== "undefined" && CC_PHYSICS_BUILTIN) || (typeof CC_PHYSICS_CANNON !== "undefined" && CC_PHYSICS_CANNON);',
                "        if (need) load(" + JSON.stringify(v2.physics) + ", window.boot); else window.boot();"
            ]
            : ["        window.boot();"];
        return [
            "(function () {",
            "    function load(src, done) {",
            '        var s = document.createElement("script");',
            "        s.async = true;",
            '        s.addEventListener("load", function () { if (s.parentNode) s.parentNode.removeChild(s); if (done) done(); }, false);',
            '        s.addEventListener("error", function () { console.error("[playable] Không nạp được " + src); }, false);',
            "        s.src = src;",
            "        document.body.appendChild(s);",
            "    }",
            "    load(" + JSON.stringify(v2.engine) + ", function () {"
        ].concat(afterEngine, ["    });", "})();"]).join("\n");
    }
    function defaultIndex2x(v2) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Playable</title>'
            + '<meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1">'
            + "<style>" + DEFAULT_CSS_2X + "</style></head><body>"
            + '<canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="0"></canvas>' + SPLASH_2X
            + '<script src="' + v2.settings + '"><\/script><script src="' + v2.main + '"><\/script>'
            + "<script>" + loader2x(v2) + "<\/script></body></html>";
    }

    /* map (tên file trong gói → byte; chỉ index.html / css / import map cần nội dung thật) → title, các
       <meta>, CSS (inline hoá), markup body, thứ tự <script> để runtime chạy lại y hệt, và import map
       (inline hoá, đường dẫn rebase về gốc). Gói không có index.html (Bingo bỏ nó đi) → dùng khung chuẩn
       Cocos 2.x hoặc 3.x; có shellHtml (file HTML đã đóng gói) thì lấy title / meta / style / markup body từ đó. */
    function preparePage(map, warnings, shellHtml) {
        var shell = "", v2 = findCocos2x(map);
        var html = map["index.html"] ? text(map["index.html"]) : "";
        if (!html) {
            if (v2) html = defaultIndex2x(v2);
            else if (map["index.js"] && map["src/system.bundle.js"]) html = defaultIndex3x(map);
            else throw new Error("Gói không có index.html và không nhận ra build web-mobile của Cocos Creator: cần main.js + src/settings.js + cocos2d-js (2.x) hoặc index.js + src/system.bundle.js (3.x).");
            if (shellHtml) shell = String(shellHtml);
            else warnings.push("Gói không có index.html — dùng khung index.html chuẩn của Cocos " + (v2 ? "2.x" : "3.x") + ".");
        }

        var head = headOf(html);
        var title = titleOf(head) || "Playable";
        var metas = metasOf(head);
        var css = "";
        (head.match(/<link\b[^>]*>/gi) || []).forEach(function (tag) {
            if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return;
            var href = normalizePath(attrOf(tag, "href"));
            if (!href) return;
            if (map[href]) css += minifyCss(text(map[href]));
            else warnings.push("index.html tham chiếu " + href + " nhưng không có file này trong gói.");
        });
        css += inlineStylesOf(head);

        var bodyHtml = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ["", html])[1];
        var scripts = [], importMap = null, m;
        var scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        while ((m = scriptRe.exec(bodyHtml))) {
            var type = attrOf(m[1], "type"), src = attrOf(m[1], "src");
            if (/importmap/i.test(type)) { importMap = { src: src ? normalizePath(src) : "", text: m[2] }; continue; }
            if (type && !/javascript|ecmascript/i.test(type)) { warnings.push('Bỏ qua <script type="' + type + '"> trong index.html.'); continue; }
            if (src) scripts.push({ src: normalizePath(src) });
            else if (m[2].trim()) scripts.push({ text: m[2] });
        }
        if (!scripts.length) throw new Error("index.html không có <script> nào để khởi động game.");
        scripts.forEach(function (s) {
            if (s.src && !map[s.src] && !/^[a-z]+:/i.test(s.src)) warnings.push("index.html tham chiếu " + s.src + " nhưng không có file này trong gói.");
        });
        var body = bodyMarkupOf(html);

        if (shell) {
            var sHead = headOf(shell), sBody = bodyMarkupOf(shell);
            title = titleOf(sHead) || title;
            metas = metasOf(sHead) || metas;
            css = inlineStylesOf(sHead) || css;
            // Chỉ lấy markup của vỏ khi nó có canvas cho engine; không thì giữ markup của khung chuẩn.
            if (/\bid\s*=\s*["']?GameCanvas\b/i.test(sBody)) body = sBody;
        }
        if (v2 && !/\bid\s*=\s*["']?splash\b/i.test(body)) body += SPLASH_2X;

        var importMapJson = null;
        if (importMap) {
            var raw = importMap.src ? (map[importMap.src] ? text(map[importMap.src]) : "") : importMap.text;
            var mapDir = dirOf(importMap.src);
            try {
                var obj = JSON.parse(raw);
                if (obj.imports) Object.keys(obj.imports).forEach(function (name) {
                    var v = obj.imports[name];
                    if (typeof v === "string" && !/^[a-z][a-z0-9+.\-]*:/i.test(v) && v.charAt(0) !== "/") obj.imports[name] = "./" + joinPath(mapDir, v);
                });
                importMapJson = JSON.stringify(obj);
            } catch (e) { warnings.push("Import map hỏng hoặc thiếu (" + (importMap.src || "inline") + "): " + e.message); }
        }
        return { title: title, metas: metas, css: css || DEFAULT_CSS, body: body, scripts: scripts, importMap: importMapJson };
    }

    function renderHtml(page, ch, payloadJs, cfg) {
        return '<!DOCTYPE html><html><head><base href="./"><meta charset="utf-8"><title>' + escapeHtml(page.title) + "</title>" + page.metas
            + "<style>" + page.css + "</style>" + (ch.head || "") + "</head><body>" + page.body
            + (page.importMap ? '<script type="systemjs-importmap">' + page.importMap + "<\/script>" : "")
            + "<script>" + PRELUDE + "\n" + adapterSource(ch.key) + "\n" + payloadJs + "<\/script>"
            + "<script>" + runtimeScript(cfg) + "<\/script></body></html>";
    }
    function payloadScript(payload, enc) { return 'window.__zip="' + payload + '";window.__zipEncoding="' + enc + '";'; }
    function encodePayload(zip, enc) { return enc === "base64" ? core.encodeBase64Bytes(zip) : core.encodeBase122Bytes(zip); }

    /* ======================================================================= đọc / ghép lại ZIP */

    // Đọc central directory của một ZIP. Không giải nén: raw là byte đã nén (method 8) hoặc thô (method 0).
    function readZipEntries(bytes) {
        var buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), n = buf.length, eocd = -1, p;
        for (p = n - 22; p >= 0 && p >= n - 65558; p--) if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
        if (eocd < 0) throw new Error("Không phải file ZIP hợp lệ.");
        var count = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), list = [];
        for (var i = 0; i < count; i++) {
            if (dv.getUint32(off, true) !== 0x02014b50) break;
            var method = dv.getUint16(off + 10, true), crc = dv.getUint32(off + 16, true) >>> 0;
            var csize = dv.getUint32(off + 20, true), usize = dv.getUint32(off + 24, true);
            var nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
            var lofs = dv.getUint32(off + 42, true);
            var name = text(buf.subarray(off + 46, off + 46 + nlen));
            if (name.charAt(name.length - 1) !== "/") {
                var ln = dv.getUint16(lofs + 26, true), le = dv.getUint16(lofs + 28, true), start = lofs + 30 + ln + le;
                list.push({ name: name, method: method, crc: crc, usize: usize, raw: buf.subarray(start, start + csize) });
            }
            off += 46 + nlen + elen + clen;
        }
        return list;
    }
    function inflateEntry(entry) {
        if (entry.method === 0) return entry.raw;
        if (entry.method !== 8) throw new Error("ZIP dùng method " + entry.method + " — chỉ hỗ trợ store/deflate.");
        return inflateRaw(entry.raw, entry.usize);
    }

    /* Ghép lại ZIP từ các entry đã đọc. Entry không đổi chép nguyên byte đã nén (không giải nén, không nén
       lại — vừa nhanh vừa giữ kích thước). changes[name] = { data, deflated? } thay/thêm một file, = null
       để bỏ file đó. Thứ tự giữ nguyên, file mới đưa xuống cuối. */
    function rebuildZip(entries, changes, when) {
        changes = changes || {};
        var dt = core.dosDateTime(when || new Date());
        function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
        function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
        function fromChange(name, c) {
            var data = c.data instanceof Uint8Array ? c.data : new Uint8Array(c.data);
            var useDeflate = c.deflated && c.deflated.length < data.length;
            return { name: name, method: useDeflate ? 8 : 0, crc: core.crc32(data), stored: useDeflate ? c.deflated : data, usize: data.length };
        }
        var records = [], has = Object.prototype.hasOwnProperty;
        entries.forEach(function (e) {
            if (has.call(changes, e.name)) { if (changes[e.name]) records.push(fromChange(e.name, changes[e.name])); }
            else records.push({ name: e.name, method: e.method, crc: e.crc, stored: e.raw, usize: e.usize });
        });
        Object.keys(changes).forEach(function (name) {
            if (changes[name] && !entries.some(function (e) { return e.name === name; })) records.push(fromChange(name, changes[name]));
        });
        var parts = [], central = [], offset = 0;
        records.forEach(function (r) {
            var nameBytes = core.utf8Bytes(r.name), flag = 0x0800;
            var local = [].concat(u32(0x04034b50), u16(20), u16(flag), u16(r.method), u16(dt[0]), u16(dt[1]),
                u32(r.crc), u32(r.stored.length), u32(r.usize), u16(nameBytes.length), u16(0));
            parts.push(new Uint8Array(local), nameBytes, r.stored);
            var cdir = [].concat(u32(0x02014b50), u16(20), u16(20), u16(flag), u16(r.method), u16(dt[0]), u16(dt[1]),
                u32(r.crc), u32(r.stored.length), u32(r.usize), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
            central.push(new Uint8Array(cdir), nameBytes);
            offset += local.length + nameBytes.length + r.stored.length;
        });
        var centralSize = central.reduce(function (s, p) { return s + p.length; }, 0);
        var eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(records.length), u16(records.length), u32(centralSize), u32(offset), u16(0)));
        var out = new Uint8Array(offset + centralSize + eocd.length), pos = 0;
        parts.concat(central, [eocd]).forEach(function (p) { out.set(p, pos); pos += p.length; });
        return out;
    }

    /* ===================================================== gói bên trong file HTML đã đóng gói */

    // window.__zip của file Bingo / Super HTML / file tool này xuất ra → { item (vị trí trong HTML), zip, entries }.
    function readPackage(html) {
        var items = core.extractEmbeddedData(String(html)).filter(function (it) { return it.source === "super-html-zip"; });
        if (!items.length) throw new Error("Không thấy window.__zip trong file (bản Facebook tách payload ra zip.js — hãy dùng file AppLovin / Unity / ironSource).");
        var item = items[0];
        var zip = item.encoding === "base64" ? core.decodeBase64Bytes(item.payload) : core.decodeBase122Bytes(item.payload);
        if (zip.length < 22 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error("Giải mã __zip không ra ZIP hợp lệ.");
        return { item: item, zip: zip, entries: readZipEntries(zip) };
    }

    /* Danh sách file trong gói, cùng khuôn item với extractEmbeddedData của converter để tab Asset nhúng
       xếp chung một danh sách (id / index / line / kind / context / bytes). Không bung dữ liệu ở đây —
       entryFile(item.entry) khi cần xem/tải. label: tên người đặt trong Cocos ("Audio/click.mp3"), context
       vẫn là tên entry thật vì dùng để thay file. */
    function packageItems(html) {
        var pkg = readPackage(html), names = assetNames(html, pkg);
        return pkg.entries.map(function (e, i) {
            return {
                id: "zip-" + (i + 1), index: i + 1, line: pkg.item.line,
                encoding: "zip", source: "bingo-zip", payload: "", preview: "", fullValue: "",
                context: e.name, label: assetLabel(e.name, names), bytes: e.usize, packed: e.raw.length, method: e.method,
                mediaType: mimeOf(e.name), kind: packageKind(e.name),
                zipItemId: pkg.item.id, zipEncoding: pkg.item.encoding, entry: e
            };
        });
    }

    /* Super HTML để file nhị phân trong gói ở dạng CHỮ "data:<mime>;base64,<…>": loader đọc mọi entry bằng
       JSZip async("text") rồi dùng thẳng làm URL. Bingo để byte gốc. entryFile() trả byte thật của file kèm
       phần đầu data URI (wrap, "" nếu không bọc); packFile() bọc file mới lại đúng dạng entry cũ đang dùng —
       nhét byte thô vào chỗ loader chờ chữ data URI là game hỏng. */
    function entryFile(entry) {
        var bytes = inflateEntry(entry);
        var isText = /^(text\/|application\/json)/.test(mimeOf(entry.name));
        if (isText || bytes.length < 6 || text(bytes.subarray(0, 5)) !== "data:") return { data: bytes, wrap: "" };
        var head = text(bytes.subarray(0, Math.min(bytes.length, 256))), comma = head.indexOf(",");
        if (comma < 0 || !/;base64$/i.test(head.slice(0, comma))) return { data: bytes, wrap: "" };
        return { data: core.decodeBase64Bytes(text(bytes.subarray(comma + 1))), wrap: head.slice(0, comma + 1) };
    }
    function packFile(entry, data) {
        var wrap = entryFile(entry).wrap;
        return wrap ? core.utf8Bytes(wrap + core.encodeBase64Bytes(data)) : data;
    }

    /* ============================================================ tên dễ đọc từ config.json của Cocos 2.x */

    /* File native của build Cocos mang tên theo uuid (assets/resources/native/0f/0f9073fe-….mp3). Tên người đặt
       nằm trong config.json của từng bundle: paths[i] = [đường dẫn, loại], uuids[i] = uuid nén 22 ký tự (2 ký tự
       hex đầu + base64, mỗi cặp base64 = 3 ký tự hex) hoặc 23 ký tự (5 ký tự hex đầu). */
    var UUID_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function decompressUuid(u) {
        u = String(u || "");
        if (!/^(?:[0-9a-f]{2}[A-Za-z0-9+\/]{20}|[0-9a-f]{5}[A-Za-z0-9+\/]{18})$/.test(u)) return u.toLowerCase();
        var head = u.length === 22 ? 2 : 5, hex = u.slice(0, head);
        for (var i = head; i < u.length; i += 2) {
            hex += ("00" + ((UUID_B64.indexOf(u.charAt(i)) << 6) | UUID_B64.indexOf(u.charAt(i + 1))).toString(16)).slice(-3);
        }
        return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }

    // Duyệt các cặp "khoá": "chuỗi" cấp một của window.__res (Super HTML: JSON, script, data URI của ảnh/âm thanh).
    // cb(key, start, end): start/end là vị trí nội dung chuỗi (chưa unescape) trong html.
    function eachResString(html, cb) {
        var at = html.search(/window\.__res\s*=\s*\{/);
        if (at < 0) return;
        var keyRe = /"([^"\\]{1,400})"\s*:\s*"/g, m;
        keyRe.lastIndex = at;
        while ((m = keyRe.exec(html))) {
            var start = m.index + m[0].length, i = start;
            while (i < html.length && html.charAt(i) !== '"') i += html.charAt(i) === "\\" ? 2 : 1;
            cb(m[1], start, i);
            var next = html.slice(i + 1, i + 40).match(/^\s*([,}])/);
            if (!next || next[1] === "}") return;
            keyRe.lastIndex = i + 1;
        }
    }

    // uuid → tên trong bundle ("Audio/click"), gom từ mọi config.json nằm trong gói ZIP lẫn trong window.__res.
    var BUNDLE_CONFIG = /(^|\/)config(\.[0-9a-f]{5,})?\.json$/i;
    function assetNames(html, pkg) {
        var names = {};
        function add(json) {
            var cfg;
            try { cfg = JSON.parse(json); } catch (e) { return; }
            if (!cfg || !cfg.paths || !cfg.uuids) return;
            Object.keys(cfg.paths).forEach(function (k) {
                var p = cfg.paths[k], u = cfg.uuids[k];
                if (p && typeof p[0] === "string" && u) names[decompressUuid(u)] = p[0];
            });
        }
        html = String(html);
        if (pkg === undefined) { try { pkg = readPackage(html); } catch (e) { pkg = null; } }
        if (pkg) pkg.entries.forEach(function (e) {
            if (BUNDLE_CONFIG.test(e.name)) { try { add(text(inflateEntry(e))); } catch (x) { } }
        });
        eachResString(html, function (key, start, end) {
            if (!BUNDLE_CONFIG.test(key)) return;
            try { add(JSON.parse('"' + html.slice(start, end) + '"')); } catch (e) { }
        });
        return names;
    }

    // "assets/resources/native/0f/0f9073fe-….mp3" → "Audio/click.mp3" (giữ đuôi file thật); không tra được → "".
    function assetLabel(path, names) {
        var m = String(path).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        var name = m && names[m[0].toLowerCase()];
        return name ? name + (String(path).match(/\.[a-z0-9]+$/i) || [""])[0] : "";
    }

    /* Asset để thẳng trong window.__res dạng "…/uuid.mp3": "data:audio/mpeg;base64,…" → { vị trí payload base64
       (trùng item.start của converter-core.extractEmbeddedData) → tên dễ đọc }. */
    function resAssetLabels(html) {
        html = String(html);
        var names = assetNames(html), labels = {};
        eachResString(html, function (key, start, end) {
            if (html.slice(start, start + 5) !== "data:") return;
            var comma = html.indexOf(",", start), label = assetLabel(key, names);
            if (label && comma > 0 && comma < end) labels[comma + 1] = label;
        });
        return labels;
    }

    // Ghi ZIP mới vào đúng chỗ payload cũ. Không dùng replaceEmbeddedData của converter vì nó trim()
    // chuỗi thay thế — base122 hợp lệ có thể bắt đầu/kết thúc bằng khoảng trắng.
    function writePackage(html, pkg, zip) {
        var payload = encodePayload(zip, pkg.item.encoding);
        if (pkg.item.quote && payload.indexOf(pkg.item.quote) >= 0) throw new Error("Payload mới chứa ký tự " + pkg.item.quote + " làm hỏng chuỗi JavaScript.");
        return html.slice(0, pkg.item.start) + payload + html.slice(pkg.item.end);
    }
    // Thay (hoặc thêm) một file trong gói → HTML mới. deflated (tuỳ chọn) do nơi gọi nén sẵn bằng CompressionStream.
    function replacePackageEntry(html, name, data, deflated) {
        var pkg = readPackage(html), changes = {};
        changes[name] = { data: data, deflated: deflated || null };
        return writePackage(html, pkg, rebuildZip(pkg.entries, changes));
    }

    // File .js / .json trong gói theo khuôn của ScriptCore.listScripts (id, name, kind, source, text, size)
    // để tab Scripts sửa được. text bung lười (cc.js 2 MB chỉ giải nén khi mở).
    function packageScripts(html) {
        var pkg = readPackage(html);
        return pkg.entries.filter(function (e) { return /\.(js|json)$/i.test(e.name) && !BINGO_RUNTIME_FILES.test(e.name); })
            .map(function (e) {
                var s = { id: "zip:" + e.name, name: e.name, kind: scriptKindOf(e.name), source: "zip", quote: null, size: e.usize, entry: e };
                var cached = null;
                Object.defineProperty(s, "text", { enumerable: true, get: function () { if (cached === null) cached = text(inflateEntry(e)); return cached; } });
                return s;
            });
    }

    /* ====================================================================== đổi mạng file Bingo */

    // Store URL Bingo ghi trong hàm CTA của nó: _i = iOS, _a = Android.
    function storeUrlsFromBingo(html) {
        var body = (String(html).match(/function bingoPlayableApiDemo\(\)\s*\{[\s\S]{0,3000}?<\/script>/) || [""])[0];
        return {
            ios: (body.match(/_i\s*=\s*"([^"]*)"/) || ["", ""])[1],
            android: (body.match(/_a\s*=\s*"([^"]*)"/) || ["", ""])[1]
        };
    }

    /* File đã đóng gói (Bingo / Super HTML / tool này) → mạng khác. Payload ZIP giữ nguyên byte (chỉ mã hoá
       lại khi kênh đích cần base64 hoặc phải bỏ file runtime của Bingo), vỏ HTML + runtime + adapter dựng
       mới. Đồng bộ, nên cắm thẳng vào convert() của converter-core. options: androidUrl, iosUrl. */
    function retarget(html, target, options) {
        options = options || {};
        var ch = channel(target);
        if (!ch) throw new Error("Không biết mạng đích " + target + ".");
        var warnings = [], pkg = readPackage(html);
        var bingoFiles = [], entries = pkg.entries.filter(function (e) {
            if (BINGO_RUNTIME_FILES.test(e.name)) { bingoFiles.push(e.name); return false; }
            return true;
        });
        var map = {};
        entries.forEach(function (e) { map[e.name] = /\.(html?|css)$/i.test(e.name) || /^src\/import-map\.json$/i.test(e.name) ? inflateEntry(e) : EMPTY; });
        var page = preparePage(map, warnings, html);
        var enc = ch.encoding;
        var payload = !bingoFiles.length && enc === pkg.item.encoding ? pkg.item.payload : encodePayload(bingoFiles.length ? rebuildZip(entries, {}) : pkg.zip, enc);
        var urls = storeUrlsFromBingo(html);
        var cfg = {
            version: VERSION, channel: ch.key, scripts: page.scripts,
            android: String(options.androidUrl || "").trim() || urls.android,
            ios: String(options.iosUrl || "").trim() || urls.ios
        };
        if (bingoFiles.length) warnings.push("Đã bỏ file runtime riêng của Bingo (" + bingoFiles.join(", ") + ") — runtime mới thay thế.");
        if (!cfg.android && !cfg.ios) warnings.push("Không có store URL: điền Android/iOS URL ở 'Store URL tùy chọn' hoặc để game tự set qua super_html.");
        return { html: renderHtml(page, ch, payloadScript(payload, enc), cfg), warnings: warnings };
    }
    if (typeof core.registerBuild === "function") core.registerBuild("bingo", retarget);

    return {
        VERSION: VERSION,
        CHANNELS: CHANNELS,
        channel: channel,
        adapterSource: adapterSource,
        runtimeSource: runtimeSource,
        inflateRaw: inflateRaw,
        preparePage: preparePage,
        readZipEntries: readZipEntries,
        inflateEntry: inflateEntry,
        rebuildZip: rebuildZip,
        readPackage: readPackage,
        packageItems: packageItems,
        packageScripts: packageScripts,
        replacePackageEntry: replacePackageEntry,
        entryFile: entryFile,
        packFile: packFile,
        decompressUuid: decompressUuid,
        assetNames: assetNames,
        assetLabel: assetLabel,
        resAssetLabels: resAssetLabels,
        retarget: retarget
    };
});
