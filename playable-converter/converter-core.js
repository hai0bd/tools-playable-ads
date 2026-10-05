(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.PlayableConverter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var NETWORKS = {
        applovin: { label: "AppLovin", folder: "applovin", file: "index.html" },
        mintegral: { label: "Mintegral", folder: "mintegral", file: "mintegral.html" },
        unity: { label: "Unity", folder: "unity", file: "index.html" },
        google: { label: "Google", folder: "google", file: "index.html" },
        pangle: { label: "Pangle", folder: "pangle", file: "index.html" }
    };

    function normalizeNetwork(value) {
        value = String(value || "").toLowerCase();
        if (value === "mindwork" || value === "mindworks" || value === "mobvista") return "mintegral";
        if (value === "adword" || value === "adwords") return "google";
        if (value.indexOf("pangle") >= 0 || value.indexOf("pangolin") >= 0) return "pangle";
        return value || "unknown";
    }

    function detectBuild(html) {
        if (/\bspNetwork\s*=/.test(html) && /\bspVars\s*=/.test(html)) return "saygames";
        if (/\bopenAdUrl\s*=\s*function/.test(html) && /window\._CCSettings|var\s+adNetwork\s*=/.test(html)) return "cocos-old";
        if (isThreejsAvk(html)) return "threejs";
        // Bingo (app đóng gói riêng): có hàm CTA bingoPlayableApiDemo, hoặc khai báo __zipEncoding mà
        // không có API super_html. Rule chuyển đổi nằm ở bingo-core.js (registerBuild).
        if (/\bbingoPlayableApiDemo\b/.test(html) || (/window\.__zipEncoding\s*=/.test(html) && !/super[-_ ]?html/i.test(html))) return "bingo";
        if (/super[-_ ]?html/i.test(html)) return "super-html";
        // Chỉ nhận Luna qua dấu hiệu do trình build sinh ra. Chuỗi "luna" trần
        // hay khớp ngẫu nhiên bên trong khối base64 của asset.
        if (/Bridge\.(?:ready|startup)|LunaCompilerV|Luna\.Unity\.(?:Playable|LifeCycle|Analytics)|LunaUnity\.Objects/.test(html)) return "luna";
        if (/window\.setupConfig\s*=/.test(html) && /added_api\s*:/.test(html)) return "setup-config";
        // PlaySmart / QICI (creative Mintegral–Zingfront): runtime namespace ps.* + config của engine
        // QICI. Bắt cả bản còn trỏ CDN lẫn bản đã nhúng, vì hai dấu hiệu này nằm ở file game.
        // Rule chuyển đổi ở playsmart-core.js (registerBuild).
        if (/\bqici\s*\.\s*config\s*=/.test(html) && /\bps\.(?:mainState|checkLaunch|Behaviour)\b/.test(html)) return "playsmart";
        // MindWorks / Mintegral offline package: build Cocos 2.4 nén thành JSON map trong
        // __adapter_zip__. Luật cocos-old không bao giờ khớp được creative này vì dấu hiệu của nó
        // (_CCSettings, openAdUrl) nằm TRONG payload nén, mọi regex chạy trên HTML đều mù.
        // Rule chuyển đổi ở mindworks-core.js (registerBuild).
        if (/window\s*\.\s*__adapter_zip__\s*\+?=/.test(html)) return "mindworks";
        return "unknown";
    }

    // Framework playable dạng setupConfig tự chọn hành vi theo network.added_api
    // (xem gameIsReady/setScreenSize trong build). Đổi network nghĩa là đổi đúng
    // hai giá trị này, không phải chèn adapter từ ngoài vào.
    var SETUP_CONFIG_API = {
        applovin: "mraid",
        unity: "mraid",
        google: "mraid",
        pangle: "mraid",
        mintegral: "mobvista"
    };

    function networkFromFilename(filename) {
        var name = String(filename || "").toLowerCase().replace(/\\/g, "/").split("/").pop();
        if (/app.?lovin/.test(name)) return "applovin";
        if (/mintegral|mindwork|mobvista/.test(name)) return "mintegral";
        if (/unity/.test(name)) return "unity";
        if (/google|adword/.test(name)) return "google";
        if (/pangle|pangolin/.test(name)) return "pangle";
        return "unknown";
    }

    // File do Bingo xuất: tên file theo mẫu {date}_{Channel}_{name} là nguồn đáng tin nhất; không có
    // thì đoán từ hàm CTA bingoPlayableApiDemo (AppLovin và Unity cùng mraid.open, chỉ khác Unity có
    // thẻ mraid.js). Các rule chung phía dưới sẽ đoán nhầm AppLovin thành Unity vì thấy mraid.open.
    function detectBingoNetwork(html, filename) {
        var fromName = networkFromFilename(filename);
        if (fromName !== "unknown") return fromName;
        var name = String(filename || "").toLowerCase();
        if (/ironsource|levelplay/.test(name)) return "ironsource";
        if (/facebook/.test(name)) return "facebook";
        if (/vungle|liftoff/.test(name)) return "vungle";
        if (/moloco/.test(name)) return "moloco";
        if (/chartboost/.test(name)) return "chartboost";
        var demo = (html.match(/function bingoPlayableApiDemo\(\)\s*\{[\s\S]{0,3000}?<\/script>/) || [""])[0];
        if (/ExitApi/.test(demo)) return "google";
        if (/window\.install|\binstall\s*\(/.test(demo)) return "mintegral";
        if (/FbPlayableAd/.test(demo)) return "facebook";
        if (/\bdapi\./.test(demo)) return "ironsource";
        if (/openAppStore/.test(demo)) return "pangle";
        if (/postMessage\(\s*['"]download/.test(demo)) return "vungle";
        if (/mraid\.open/.test(demo)) return /<script\b[^>]*\bsrc\s*=\s*["']mraid\.js["']/i.test(html) ? "unity" : "applovin";
        return "unknown";
    }

    // Three.js template AVK (bundle Parcel 1 + three.js): entry chọn lớp API mạng lúc window.load theo biến
    // playableSource; mỗi lớp API gắn thuộc tính avk_play_class. Rule chuyển đổi ở convertThreejs.
    function isThreejsAvk(html) {
        return /\bvar\s+playableSource\s*=/.test(html) && /\bavk_play_class\b/.test(html);
    }

    // Giá trị playableSource cho từng mạng đầu ra, theo đúng các bản studio đang chạy ("mr" = MRAID chung
    // cho AppLovin). Template không có nhánh Pangle, và bản cũ không có nhánh "gg": giá trị lạ rơi xuống dò
    // TJ_API → dapi → mraid → BrowserClientAPI, adapter lo phần CTA.
    var THREEJS_SOURCE = { applovin: "mr", unity: "un", mintegral: "mn", google: "gg", pangle: "pg" };
    var THREEJS_SOURCE_NETWORK = { un: "unity", mn: "mintegral", gg: "google", pg: "pangle", fb: "facebook", vu: "vungle", lf: "vungle", ml: "moloco", imr: "ironsource" };

    function detectThreejsNetwork(html, filename) {
        var match = html.match(/\bvar\s+playableSource\s*=\s*["']([^"']*)["']/);
        var source = match ? match[1].toLowerCase() : "";
        if (THREEJS_SOURCE_NETWORK[source]) return THREEJS_SOURCE_NETWORK[source];
        var fromName = networkFromFilename(filename);
        if (source === "mr") return fromName !== "unknown" ? fromName : "applovin";
        return fromName;
    }

    function detectSourceNetwork(html, filename) {
        if (/\bbingoPlayableApiDemo\b/.test(html)) return detectBingoNetwork(html, filename);
        // Build AVK chứa lớp MintegralClientAPI (window.install && window.install()) ở mọi mạng, nên phải
        // đọc playableSource trước khi các rule chung phía dưới đoán nhầm thành Mintegral.
        if (isThreejsAvk(html)) return detectThreejsNetwork(html, filename);
        // Nội dung file luôn đáng tin hơn tên file: tên do người đặt, còn các
        // dấu hiệu dưới đây do chính trình build của network sinh ra.
        var match = html.match(/\bspNetwork\s*=\s*['"]([^'"]+)['"]/);
        if (match) return normalizeNetwork(match[1]);
        match = html.match(/\bvar\s+adNetwork\s*=\s*['"]([^'"]+)['"]/);
        if (match) return normalizeNetwork(match[1]);
        // Build setupConfig khai báo network ngay trong initConfig; tên file
        // thường lệch với giá trị này nên phải đọc từ chính config.
        match = html.match(/network\s*:\s*\{[^}]*\bname\s*:\s*['"`]([^'"`]+)['"`]/);
        if (match) return normalizeNetwork(match[1]);
        if (/window\.install\s*&&\s*window\.install|mark=["']mobvista/i.test(html)) return "mintegral";
        if (/ALPlayableAnalytics/i.test(html)) return "applovin";
        if (/ExitApi|googlesyndication/i.test(html)) return "google";
        if (/pangle|byteoversea|pangolin/i.test(html)) return "pangle";
        if (/mraid\.open/.test(html)) return "unity";
        return networkFromFilename(filename);
    }

    function detectSuperHtmlVersion(html) {
        if (/window\.(?:__zip|zip)\s*=/.test(html)) return "new";
        if (/window\.__res\s*=\s*\{/.test(html)) return "old";
        return "unknown";
    }

    function analyze(html, filename) {
        var build = detectBuild(html);
        var sourceNetwork = detectSourceNetwork(html, filename);
        var gameManagers = findCocosGameManagers(html);
        var stageQueue = readSayGamesStageQueue(html);
        return {
            build: build,
            sourceNetwork: sourceNetwork,
            bytes: byteLength(html),
            scripts: (html.match(/<script\b/gi) || []).length,
            externalScripts: (html.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length,
            mouseSupport: /mousedown/.test(html) && /mousemove/.test(html) && /mouseup/.test(html),
            hasGameReady: /window\.gameReady/.test(html),
            hasGameEnd: /window\.gameEnd/.test(html),
            superHtmlVersion: build === "super-html" ? detectSuperHtmlVersion(html) : "unknown",
            zipEncoding: build === "super-html" || build === "bingo" ? detectZipEncoding(html) : "unknown",
            avkProduct: build === "threejs" ? readAvkProduct(html) : "",
            stageQueueLength: stageQueue.length,
            gameManagers: gameManagers
        };
    }

    // Tên + phiên bản template trong PROJECT.DAT = new function () { this.product = "AVK_Maze", this.version = "0.1.0", … }.
    function readAvkProduct(html) {
        var at = html.search(/PROJECT\.DAT\s*=\s*new\s+function/);
        if (at < 0) return "";
        var head = html.slice(at, at + 2000);
        var product = head.match(/\bthis\.product\s*=\s*["']([^"']*)["']/);
        var version = head.match(/\bthis\.version\s*=\s*["']([^"']*)["']/);
        return product ? product[1] + (version ? " " + version[1] : "") : "";
    }

    var HTML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", apos: "'" };

    function unescapeHtmlText(text) {
        return String(text).replace(/&(lt|gt|amp|quot|apos|#39);/g, function (all, name) {
            return HTML_ENTITIES[name] !== undefined ? HTML_ENTITIES[name] : all;
        });
    }

    function escapeHtmlAttribute(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    /* Luna (Luna Playground): ảnh KHÔNG nằm ở data: URI mà ở <img data-mime="image/png"
     * data-src122="…">, nên mọi bộ thu khác đều không thấy — creative Paper Doll có 115 ảnh, 2 MB,
     * mà bảng asset chỉ hiện 6.
     *
     * Payload là PNG/JPEG THÔ mã base122 chuẩn — khác sound/json/blob của Luna (những thứ đó còn
     * nén Brotli, do luna-core.js đọc). Nằm trong thuộc tính HTML nên '<' '>' '&' đã bị escape:
     * phải gỡ trước khi giải, và escape lại khi ghi (xem replaceEmbeddedData).
     *
     * Bản đi qua tool spy/đổi mạng dùng cặp thuộc tính khác: data-b122 + data-b122m (cùng bảng
     * base122 chuẩn, mime mặc định image/jpeg theo bộ giải đi kèm file).
     */
    function collectLunaImages(html, matches) {
        var regex = /<img\b[^>]*\sdata-(src122|b122)\s*=\s*"([^"]*)"[^>]*>/gi;
        var match;
        while ((match = regex.exec(html))) {
            var tag = match[0], marker = "data-" + match[1] + '="';
            var start = match.index + tag.indexOf(marker) + marker.length;
            var mimeAttr = match[1] === "b122" ? /\sdata-b122m\s*=\s*"([^"]*)"/i : /\sdata-mime\s*=\s*"([^"]*)"/i;
            addEmbeddedMatch(matches, {
                encoding: "base122",
                payload: unescapeHtmlText(match[2]),
                start: start,
                end: start + match[2].length,
                context: (tag.match(/\sid\s*=\s*"([^"]*)"/i) || [])[1] || "luna image",
                source: "luna-img",
                mediaType: (tag.match(mimeAttr) || [])[1] || (match[1] === "b122" ? "image/jpeg" : "image/png"),
                quote: '"',
                htmlEscaped: true,
                base122Standard: true
            });
        }
    }

    function extractEmbeddedData(html) {
        html = String(html || "");
        var matches = [];

        collectDataUris(html, matches);
        collectDecoderCalls(html, matches);
        collectSuperHtmlZipPayloads(html, matches);
        collectNamedPayloads(html, matches);
        collectLikelyBase64Properties(html, matches);
        collectAvkDataAssets(html, matches);
        collectLunaImages(html, matches);

        matches.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
        var filtered = matches.filter(function (item, index) {
            return !matches.some(function (other, otherIndex) {
                return otherIndex !== index && other.start <= item.start && other.end >= item.end &&
                    (other.start < item.start || other.end > item.end);
            });
        });
        var counts = { base64: 0, base122: 0 };
        return filtered.map(function (item) {
            counts[item.encoding]++;
            item.id = item.encoding + "-" + counts[item.encoding];
            item.index = counts[item.encoding];
            item.bytes = byteLength(item.payload);
            item.line = html.slice(0, item.start).split(/\r?\n/).length;
            item.preview = payloadPreview(item.payload);
            item.fullValue = item.fullValue || item.payload;
            item.kind = assetKind(item);
            return item;
        });
    }

    function collectDataUris(html, matches) {
        // Payload base64 dùng danh sách CHO PHÉP, không phải danh sách loại trừ:
        // file đã minify hay bọc data URI trong template literal (backtick), và
        // mọi danh sách loại trừ đều có nguy cơ bỏ sót ký tự kết thúc chuỗi.
        //
        // Base122 buộc phải dùng loại trừ, và chỉ được loại 5 ký tự CHUNG cho
        // mọi biến thể: null \n \r " \  (0, 10, 13, 34, 92) — cộng & cho an
        // toàn khi payload nằm trong HTML.
        // Không loại '<': Bingo cấm nó (shortMap có 60) nhưng SayGames thì không
        // (K_ILLEGALS = [0,10,13,34,38,92]), nên payload SayGames chứa '<' và
        // chặn nó sẽ cắt payload giữa chừng.
        // Cũng không chặn \s: base122 nhồi 7 bit mỗi ký tự nên dùng cả dấu
        // cách, tab và ký tự điều khiển.
        // Media type: dấu "/" là tuỳ chọn. Build tự chế đặt tên riêng không theo
        // chuẩn MIME — SayGames dùng "data:sayMesh;base122," cho toàn bộ model.
        var regex = /data:([a-z0-9.+-]+(?:\/[a-z0-9.+-]+)?)?((?:;[a-z0-9.+-]+=[^;,\s"'`<>]+)*);(?:(base64),([A-Za-z0-9+/=_-]+)|(base122),([^\x00\x0A\x0D"&\\]+))/gi;
        var match;
        while ((match = regex.exec(html))) {
            var encoding = match[3] ? "base64" : "base122";
            var payload = match[3] ? match[4] : match[6];
            var start = match.index + match[0].lastIndexOf(payload);
            addEmbeddedMatch(matches, {
                encoding: encoding,
                payload: payload,
                start: start,
                end: start + payload.length,
                context: match[1] || "data URI",
                source: "data-uri",
                mediaType: match[1] || "application/octet-stream",
                fullValue: "data:" + (match[1] || "") + match[2] + ";" + encoding + "," + payload,
                quote: ""
            });
        }
    }

    function collectDecoderCalls(html, matches) {
        var regex = /\b(atob|(?:Base64|base64)\s*\.\s*decode|decodeBase64|(?:Base122|base122)\s*\.\s*(?:decode|decodeBase122)|decodeBase122)\s*\(\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2\s*\)/g;
        var match;
        while ((match = regex.exec(html))) {
            var encoding = /122/i.test(match[1]) ? "base122" : "base64";
            if (encoding === "base64" && !isProbablyBase64(match[3])) continue;
            var start = match.index + match[0].indexOf(match[3]);
            addEmbeddedMatch(matches, {
                encoding: encoding,
                payload: match[3],
                start: start,
                end: start + match[3].length,
                context: match[1].replace(/\s+/g, ""),
                source: "decoder-call",
                quote: match[2]
            });
        }
    }

    function collectNamedPayloads(html, matches) {
        var regex = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]{0,40}(?:base64|base122)[\w$]{0,20})\s*=\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/gi;
        // Tách riêng nhánh có quote và không quote. Gộp chung bằng (["']?) khiến
        // backreference khớp chuỗi rỗng, engine phải thử mọi vị trí trong file —
        // trên file vài MB là hàng chục giây cho zero kết quả.
        var quotedPropertyRegex = /(["'])([A-Za-z_$][\w$]{0,40}(?:base64|base122)[\w$]{0,20})\1\s*:\s*(["'])((?:\\.|(?!\3)[\s\S])*?)\3/gi;
        var barePropertyRegex = /[{,]\s*([A-Za-z_$][\w$]{0,40}(?:base64|base122)[\w$]{0,20})\s*:\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2/gi;
        var match;
        while ((match = regex.exec(html))) addNamedPayload(matches, match, match[1], match[2], match[3]);
        while ((match = quotedPropertyRegex.exec(html))) addNamedPayload(matches, match, match[2], match[3], match[4]);
        while ((match = barePropertyRegex.exec(html))) addNamedPayload(matches, match, match[1], match[2], match[3]);

        function addNamedPayload(list, found, name, quote, payload) {
            var encoding = /122/i.test(name) ? "base122" : "base64";
            if (/^data:/i.test(payload)) return;
            if (!payload || (encoding === "base64" && !isProbablyBase64(payload))) return;
            var start = found.index + found[0].lastIndexOf(payload);
            addEmbeddedMatch(list, {
                encoding: encoding,
                payload: payload,
                start: start,
                end: start + payload.length,
                context: name,
                source: "named-value",
                quote: quote
            });
        }
    }

    function collectSuperHtmlZipPayloads(html, matches) {
        var regex = /\bwindow\s*(?:\.\s*(?:__zip|zip)|\[\s*["'](?:__zip|zip)["']\s*\])\s*=\s*(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g;
        var match;
        while ((match = regex.exec(html))) {
            var encoding = detectSuperHtmlZipEncoding(html, match.index);
            var start = match.index + match[0].lastIndexOf(match[2]);
            addEmbeddedMatch(matches, {
                encoding: encoding,
                payload: match[2],
                start: start,
                end: start + match[2].length,
                context: /__zip/.test(match[0]) ? "window.__zip" : "window.zip",
                source: "super-html-zip",
                mediaType: "application/zip",
                quote: match[1]
            });
        }
    }

    function detectZipEncoding(html) {
        var match = /\bwindow\s*\.\s*(?:__zip|zip)\s*=\s*["']/.exec(html);
        return match ? detectSuperHtmlZipEncoding(html, match.index) : "unknown";
    }

    function detectSuperHtmlZipEncoding(html, zipIndex) {
        var scriptStart = html.lastIndexOf("<script", zipIndex);
        var scriptEnd = html.indexOf("</script>", zipIndex);
        var scopedStart = scriptStart >= 0 ? scriptStart : Math.max(0, zipIndex - 2000);
        var scopedEnd = scriptEnd >= 0 ? scriptEnd : Math.min(html.length, zipIndex + 2000);
        var scoped = html.slice(scopedStart, scopedEnd);
        var scopedMatch = scoped.match(/\b(?:window\s*(?:\.\s*__zipEncoding|\[\s*["']__zipEncoding["']\s*\])|__zipEncoding)\s*=\s*(["'])(base64|base122)\1/i);
        if (scopedMatch) return scopedMatch[2].toLowerCase();
        var near = html.slice(Math.max(0, zipIndex - 4000), Math.min(html.length, zipIndex + 4000));
        var nearMatch = near.match(/\b(?:window\s*(?:\.\s*__zipEncoding|\[\s*["']__zipEncoding["']\s*\])|__zipEncoding)\s*=\s*(["'])(base64|base122)\1/i);
        return nearMatch ? nearMatch[2].toLowerCase() : "base64";
    }

    function collectLikelyBase64Properties(html, matches) {
        var regex = /(["'])([^"'\\\r\n]{1,180})\1\s*:\s*(["'])((?:[A-Za-z0-9+/_-]{32,}={0,2}))\3/g;
        var match;
        while ((match = regex.exec(html))) {
            if (!isProbablyBase64(match[4]) || !looksLikeAssetPayload(match[4])) continue;
            var start = match.index + match[0].lastIndexOf(match[4]);
            addEmbeddedMatch(matches, {
                encoding: "base64",
                payload: match[4],
                start: start,
                end: start + match[4].length,
                context: match[2],
                source: "resource-property",
                quote: match[3]
            });
        }
    }

    // Template Three.js AVK gán asset thành chuỗi base64 trần (không có data URI):
    //   PROJECT.DAT.pictures.shadow = "…"  ·  PROJECT.DAT.textures["Zombi [Albedo]"] = "…"  ·  PROJECT.DAT.other["gun.mp3"] = "…"
    // và PROJECT.DAT.mtl = "…" (base64 của file .mtl). Bỏ PROJECT.DAT.obj: chuỗi đó nén LZString
    // (game gọi decompressFromBase64) nên không phải base64 của file; thay bằng base64 thường là hỏng model.
    function collectAvkDataAssets(html, matches) {
        var regex = /\bPROJECT\.DAT\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\\r\n]{1,160})\3\s*\])?\s*=\s*(["'])([A-Za-z0-9+/]{16,}={0,2})\5/g;
        var extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav" };
        var match, modelName = null;
        while ((match = regex.exec(html))) {
            var group = match[1], key = match[2] || match[4], payload = match[6];
            if (!key && group !== "mtl") continue;
            var mediaType = key ? sniffBase64MediaType(payload) : "";
            var name = key || readAvkModelName() + ".mtl";
            if (key && extensions[mediaType] && !/\.[A-Za-z0-9]{2,5}$/.test(key)) name += "." + extensions[mediaType];
            var start = match.index + match[0].lastIndexOf(payload);
            addEmbeddedMatch(matches, {
                encoding: "base64",
                payload: payload,
                start: start,
                end: start + payload.length,
                context: group + "/" + name,
                source: "avk-data",
                mediaType: mediaType || undefined,
                quote: match[5]
            });
        }

        function readAvkModelName() {
            if (modelName === null) modelName = (html.match(/\bthis\.obj\s*=\s*["']([\w .-]{1,60})["']/) || [])[1] || "model";
            return modelName;
        }
    }

    // Đoán media type từ vài byte đầu của payload base64 (cho asset không có data URI đi kèm).
    function sniffBase64MediaType(payload) {
        var b;
        try { b = decodeBase64Bytes(String(payload).slice(0, 24)); }
        catch (error) { return ""; }
        var head = String.fromCharCode.apply(null, b);
        if (b[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
        if (head.slice(0, 4) === "GIF8") return "image/gif";
        if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
        if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE") return "audio/wav";
        if (head.slice(0, 4) === "OggS") return "audio/ogg";
        if (head.slice(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
        return "";
    }

    function addEmbeddedMatch(matches, item) {
        if (!item.payload) return;
        var duplicate = matches.some(function (existing) {
            return existing.start === item.start && existing.end === item.end;
        });
        if (!duplicate) matches.push(item);
    }

    function replaceEmbeddedData(html, id, replacement) {
        var item = extractEmbeddedData(html).filter(function (candidate) { return candidate.id === id; })[0];
        if (!item) throw new Error("Không tìm thấy payload " + id + ". Hãy tải lại file và thử lại.");
        var payload = normalizeEmbeddedReplacement(replacement, item.encoding);
        if (item.quote && payload.indexOf(item.quote) >= 0) {
            throw new Error("Payload mới chứa ký tự " + item.quote + " làm hỏng chuỗi JavaScript.");
        }
        // Payload nằm trong thuộc tính HTML (ảnh Luna) thì phải escape lại đúng như lúc đọc đã gỡ.
        if (item.htmlEscaped) payload = escapeHtmlAttribute(payload);
        return html.slice(0, item.start) + payload + html.slice(item.end);
    }

    function normalizeEmbeddedReplacement(value, encoding) {
        var payload = String(value == null ? "" : value).trim();
        var dataUri = payload.match(/^data:[^,]*;(base64|base122),([\s\S]+)$/i);
        if (dataUri) {
            if (dataUri[1].toLowerCase() !== encoding) throw new Error("Kiểu dữ liệu thay thế không khớp " + encoding + ".");
            payload = dataUri[2].trim();
        }
        if (!payload) throw new Error("Dữ liệu thay thế đang trống.");
        if (encoding === "base122" && /^"[\s\S]*"$/.test(payload)) {
            try { payload = JSON.parse(payload); }
            catch (error) { }
        }
        if (encoding === "base64" && !isProbablyBase64(payload)) {
            throw new Error("Chuỗi Base64 không hợp lệ. Có thể dán cả data URI hoặc chỉ phần payload.");
        }
        return payload;
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
        else throw new Error("Môi trường hiện tại không hỗ trợ giải mã Base64.");
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function encodeBase64Bytes(value) {
        var bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
        if (typeof btoa !== "function") throw new Error("Môi trường hiện tại không hỗ trợ mã hóa Base64.");
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
        var shortMap = [0, 10, 13, 34, 38, 92, 60];
        var sentinel = 7;
        var out = [];
        var current = 0;
        var bits = 0;

        function pushSeven(value7) {
            value7 = (value7 & 0x7f) << 1;
            current |= value7 >>> bits;
            bits += 7;
            if (bits >= 8) {
                out.push(current & 0xff);
                bits -= 8;
                current = (value7 << (7 - bits)) & 0xff;
            }
        }

        for (var i = 0; i < payload.length; i++) {
            var code = payload.charCodeAt(i);
            if (code > 127) {
                var shortIndex = (code >>> 8) & 7;
                if (shortIndex !== sentinel) pushSeven(shortMap[shortIndex]);
                pushSeven(code & 0x7f);
            } else {
                pushSeven(code);
            }
        }

        return new Uint8Array(out);
    }

    /* Base122 có HAI biến thể trong thực tế, và chúng KHÔNG đọc được của nhau:
     *
     *   chuẩn (6 ký tự né)  : [0, 10, 13, 34, 38, 92]       — Luna dùng bản này
     *   biến thể repo (7)   : thêm 60 tức '<'               — Bingo / Super HTML / mesh dùng bản này
     *
     * Thêm '<' là để payload nằm an toàn trong <script> (chuỗi "</" sẽ đóng thẻ sớm). Nhưng bộ giải
     * 6 phần tử tra chỉ số 6 ra undefined → dữ liệu hỏng im lặng. Đã đo: mã lại ảnh Luna bằng bảng
     * 7 phần tử làm playable đứng ở màn loading dù nội dung byte không đổi.
     *
     * Vì vậy options.standard = true khi ghi vào nơi mà bộ giải bên kia là bản 6 phần tử
     * (thuộc tính data-src122 của Luna). Mặc định giữ nguyên hành vi cũ.
     */
    var BASE122_SHORT = [0, 10, 13, 34, 38, 92];
    var BASE122_SHORT_LT = [0, 10, 13, 34, 38, 92, 60];

    function encodeBase122Bytes(value, options) {
        var bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        var shortMap = options && options.standard ? BASE122_SHORT : BASE122_SHORT_LT;
        var shortIndexByValue = {};
        for (var s = 0; s < shortMap.length; s++) shortIndexByValue[shortMap[s]] = s;

        var values = [];
        var accumulator = 0;
        var bits = 0;
        for (var i = 0; i < bytes.length; i++) {
            accumulator = (accumulator << 8) | bytes[i];
            bits += 8;
            while (bits >= 7) {
                bits -= 7;
                values.push((accumulator >>> bits) & 0x7f);
                accumulator &= (1 << bits) - 1;
            }
        }
        if (bits > 0) values.push((accumulator << (7 - bits)) & 0x7f);

        var output = "";
        for (var index = 0; index < values.length; index++) {
            var value7 = values[index];
            var shortIndex = shortIndexByValue[value7];
            if (shortIndex === undefined) {
                output += String.fromCharCode(value7);
            } else if (index + 1 < values.length) {
                output += String.fromCharCode((shortIndex << 8) | 0x80 | values[++index]);
            } else {
                output += String.fromCharCode((7 << 8) | 0x80 | value7);
            }
        }
        return output;
    }

    // Nhóm asset để UI chia tab. Ưu tiên media type vì nó do trình build ghi ra;
    // khi media type mơ hồ (octet-stream, tên tự chế) thì đoán theo đuôi file
    // hoặc tên khoá đi kèm.
    var ASSET_KINDS = ["image", "audio", "font", "model", "data", "other"];

    function assetKind(item) {
        var t = String((item && (item.mediaType || item.context)) || "").toLowerCase();
        if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif|bmp|tiff?|ico)$/.test(t)) return "image";
        if (/^audio\//.test(t) || /\.(mp3|ogg|wav|m4a|aac|flac)$/.test(t)) return "audio";
        if (/^font\//.test(t) || /\.(ttf|otf|woff2?|eot|ttc)$/.test(t)) return "font";
        if (/mesh|model|geometry/.test(t) || /\.(bin|cconb|glb|gltf|fbx|obj|dbbin|skel)$/.test(t)) return "model";
        if (/^(application\/)?json$/.test(t) || /\.(json|txt|xml|atlas|plist|mtl)$/.test(t)) return "data";
        if (/^video\//.test(t)) return "other";
        return "other";
    }

    function isProbablyBase64(value) {
        value = String(value || "").replace(/\s+/g, "");
        return value.length >= 4 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && value.length % 4 !== 1;
    }

    // Dùng cho việc DÒ TÌM payload theo phỏng đoán, không dùng để validate.
    // isProbablyBase64 chỉ xét hình dạng ký tự nên nhận nhầm hash hex, UUID và
    // định danh thường; các chuỗi đó không bao giờ là asset nhúng.
    function looksLikeAssetPayload(value) {
        value = String(value || "").replace(/\s+/g, "");
        if (/^[0-9a-f]+$/i.test(value)) return false;
        return /[A-Z]/.test(value) && /[a-z]/.test(value);
    }

    function payloadPreview(value) {
        value = String(value || "");
        if (value.length <= 56) return value;
        return value.slice(0, 36) + "..." + value.slice(-16);
    }

    // Kiểu build đăng ký từ module khác (bingo-core.js đăng ký "bingo"): handler(html, target, options)
    // → { html, warnings }. Giữ converter-core không phụ thuộc ngược vào module đó.
    var BUILD_HANDLERS = {};
    function registerBuild(name, handler) { BUILD_HANDLERS[name] = handler; }

    // notes: việc tool đã tự làm để người dùng biết (không phải cảnh báo) — hiện ở thẻ kết quả.
    function convert(html, build, target, options) {
        options = options || {};
        build = build || detectBuild(html);
        target = normalizeNetwork(target);
        if (!NETWORKS[target]) throw new Error("Mạng đầu ra không được hỗ trợ: " + target);
        var serving = stripServingLayers(html);
        var result = convertBuild(serving.html, build, target, options);
        result.notes = serving.removed.length ? ["Đã gỡ lớp phát hành Mintegral dính theo bản SocialPeta: " + serving.removed.join(", ")] : [];
        return result;
    }

    function convertBuild(html, build, target, options) {
        if (build === "saygames") return convertSayGames(html, target, options);
        if (build === "cocos-old") return convertCocosOld(html, target, options);
        if (build === "luna") return convertLuna(html, target, options);
        if (build === "setup-config") return convertSetupConfig(html, target, options);
        if (build === "super-html") return convertSuperHtml(html, target, options);
        if (build === "threejs") return convertThreejs(html, target, options);
        if (BUILD_HANDLERS[build]) return BUILD_HANDLERS[build](html, target, options);
        if (build === "bingo") throw new Error("Cần nạp bingo-core.js để chuyển đổi build Bingo.");
        if (build === "playsmart") throw new Error("Cần nạp playsmart-core.js để chuyển đổi build PlaySmart.");
        if (build === "mindworks") throw new Error("Cần nạp mindworks-core.js để chuyển đổi build MindWorks.");
        throw new Error("Chưa có rule chuyển đổi cho kiểu build này.");
    }

    function convertAll(html, build, targets, options) {
        targets = targets && targets.length ? targets : Object.keys(NETWORKS);
        return targets.map(function (target) {
            var converted = convert(html, build, target, options);
            var validation = validate(converted.html, target, build);
            return {
                target: target,
                label: NETWORKS[target].label,
                folder: NETWORKS[target].folder,
                filename: NETWORKS[target].file,
                html: converted.html,
                warnings: converted.warnings.concat(validation.warnings),
                notes: converted.notes || [],
                errors: validation.errors,
                bytes: byteLength(converted.html)
            };
        });
    }

    function convertSayGames(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "unity");
        out = replaceVariable(out, "spNetwork", target);
        out = out.replace(/(_spCampaign\s*=\s*)['"][^'"]*['"]/, "$1\"" + target + "#campaign#creative\"");
        out = replaceStoreUrls(out, options);

        var macroIndex = out.indexOf("<!-- MACROS_CURSOR -->");
        var adapterStart = findSayGamesAdapterStart(out, macroIndex);
        var adapter = "/* playable-converter:saygames-adapter:start */\n" + buildSayGamesAdapter(target, options) + "\n        /* playable-converter:saygames-adapter:end */";
        if (adapterStart >= 0 && macroIndex >= 0) {
            var launchKeep = extractLaunchMechanism(out.slice(adapterStart, macroIndex));
            var keep = launchKeep ? "/* playable-converter:saygames-launch */\n        " + launchKeep + "\n\n        " : "";
            out = out.slice(0, adapterStart) + keep + adapter + "\n\n        " + out.slice(macroIndex);
        } else {
            warnings.push("Không tìm thấy toàn bộ adapter SayGames; đã chèn adapter ghi đè.");
            out = insertBeforeClosingBody(out, '<script data-playable-converter="saygames-adapter">\n' + adapter + "\n</script>");
        }
        out = configureGoogleExitApi(out, target);
        return { html: out, warnings: warnings };
    }

    function findSayGamesAdapterStart(html, macroIndex) {
        if (macroIndex < 0) return -1;
        var original = /\bvar\s+_spSequence\s*=/.exec(html);
        if (original && original.index < macroIndex) return original.index;

        var marker = html.lastIndexOf("/* playable-converter:saygames-adapter:start */", macroIndex);
        if (marker >= 0) return marker;

        var searchStart = Math.max(0, macroIndex - 20000);
        var beforeMacro = html.slice(searchStart, macroIndex);
        var launch = beforeMacro.lastIndexOf("function _pcLaunchPlayable");
        if (launch < 0) return -1;
        var track = beforeMacro.lastIndexOf("function spTrackEvent", launch);
        var map = beforeMacro.lastIndexOf("var _pcAlMap", launch);
        var legacyStart = map >= 0 && (track < 0 || map < track) ? map : track;
        return legacyStart >= 0 ? searchStart + legacyStart : -1;
    }

    // Đọc 1 câu lệnh JS từ start tới dấu ";" ở độ sâu 0, bỏ qua chuỗi/template/comment.
    function readJsStatement(str, start) {
        var i = start, depth = 0, n = str.length;
        while (i < n) {
            var c = str.charAt(i);
            if (c === '"' || c === "'" || c === "`") {
                var q = c; i++;
                while (i < n && str.charAt(i) !== q) { if (str.charAt(i) === "\\") i++; i++; }
                i++; continue;
            }
            if (c === "/" && str.charAt(i + 1) === "/") { while (i < n && str.charAt(i) !== "\n") i++; continue; }
            if (c === "/" && str.charAt(i + 1) === "*") { i += 2; while (i < n && !(str.charAt(i) === "*" && str.charAt(i + 1) === "/")) i++; i += 2; continue; }
            if (c === "{" || c === "(" || c === "[") depth++;
            else if (c === "}" || c === ")" || c === "]") depth--;
            else if (c === ";" && depth <= 0) return str.slice(start, i + 1);
            i++;
        }
        return str.slice(start, i);
    }

    // SayGames đặt cơ chế khởi động game (window.LAUNCH bật cờ + vòng lặp poll cờ -> spBoot)
    // NGAY TRONG khối wrapper mà convert thay bằng adapter. Trích giữ lại 2 mảnh đó để adapter
    // gọi LAUNCH() vẫn boot được (spBoot nằm trong bundle, không bị đụng). Playable nào đặt
    // LAUNCH ngoài khối này thì region không chứa "window.LAUNCH" -> trả "" -> giữ nguyên hành vi.
    function extractLaunchMechanism(region) {
        var li = region.indexOf("window.LAUNCH");
        if (li < 0) return "";
        var parts = ["window._launchCalled = false; window._launched = false; window._launchDelayMs = window._launchDelayMs || 0;"];
        parts.push(readJsStatement(region, li));
        var ii = region.indexOf("_startGameInterval");
        if (ii >= 0) {
            var v = region.lastIndexOf("var ", ii);
            if (v >= 0 && ii - v <= 5) ii = v;
            parts.push(readJsStatement(region, ii));
        }
        return parts.join("\n        ");
    }

    function buildSayGamesAdapter(target) {
        var tracking;
        if (target === "applovin") {
            tracking = [
                'var _pcAlMap = { init: "LOADING", load: "LOADED", impression: "DISPLAYED", click: "CTA_CLICKED" }, _pcAlSent = {};',
                'function spTrackEvent(name) { var eventName = _pcAlMap[name]; if (!eventName || (eventName !== "CTA_CLICKED" && _pcAlSent[eventName])) return; _pcAlSent[eventName] = true; if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent(eventName); }'
            ].join("\n        ");
        } else {
            tracking = "function spTrackEvent() { }";
        }

        var click = targetClickCode(target, "spStoreUrl()");
        var init = target === "mintegral" || target === "google"
            ? 'function spInit() { spTrackEvent("load"); _pcLaunchPlayable(); }'
            : [
                'function spInit() {',
                '    spTrackEvent("load");',
                '    if (!window.mraid || typeof window.mraid.getState !== "function") return _pcLaunchPlayable();',
                '    var safetyTimer = window.setTimeout(_pcLaunchPlayable, 2000);',
                '    var launch = function () { window.clearTimeout(safetyTimer); _pcLaunchPlayable(); };',
                '    var onViewable = function (viewable) { if (window._spIsGameCreated) { viewable ? spResumeGame() : spPauseGame(); } else if (viewable) launch(); };',
                '    var bind = function () { if (typeof window.mraid.addEventListener === "function") window.mraid.addEventListener("viewableChange", onViewable); if (typeof window.mraid.isViewable !== "function" || window.mraid.isViewable()) launch(); };',
                '    if (window.mraid.getState() === "loading" && typeof window.mraid.addEventListener === "function") window.mraid.addEventListener("ready", bind); else bind();',
                '}'
            ].join("\n        ");

        var lines = [
            tracking,
            'spTrackEvent("init");',
            'function spClick(data) { spTrackEvent("click", data); ' + click + ' }',
            'function _pcLaunchPlayable() { if (window._spIsGameCreated) return; window._spIsGameCreated = true; spTrackEvent("impression"); LAUNCH(); }',
            init,
            'window.addEventListener("load", spInit);'
        ];
        if (target === "mintegral") lines.push(buildSayGamesMintegralLifecycle());
        return "        " + lines.join("\n        ");
    }

    function buildSayGamesMintegralLifecycle() {
        return [
            'window._mintegralStarted = false;',
            'window.gameStart = function () { window._mintegralStarted = true; if (window._spIsGameCreated) spResumeGame(); };',
            'window.gameClose = function () { window._mintegralStarted = false; if (window._spIsGameCreated) spPauseGame(); };',
            'window.addEventListener("load", function () {',
            '    var timer = window.setInterval(function () {',
            '        if (!window.cc || !cc.director || !cc.systemEvent || !window.saykit) return;',
            '        window.clearInterval(timer);',
            '        cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function () {',
            '            if (!window._mintegralStarted) spPauseGame();',
            '            window.gameReady && window.gameReady();',
            '            var ended = false;',
            '            function notifyGameEnd() { if (!ended) { ended = true; window.gameEnd && window.gameEnd(); } }',
            '            var config = window.spVars && window.spVars.stages && window.spVars.stages.value, queueLength = 0;',
            '            try { if (typeof config === "string") config = JSON.parse(config); queueLength = config && config.queue ? config.queue.length : 0; } catch (e) { }',
            '            var gameEvents = window.saykit && saykit.GameEvent, coreEvents = window.saykit && saykit.Event;',
            '            var switchStageEvent = gameEvents && gameEvents.SWITCH_STAGE || coreEvents && coreEvents.SWITCH_STAGE;',
            '            var screenToggleEvent = gameEvents && gameEvents.UI_SCREEN_TOGGLE || coreEvents && coreEvents.UI_SCREEN_TOGGLE;',
            '            if (switchStageEvent) cc.systemEvent.on(switchStageEvent, function (previousIndex, nextIndex) { if (queueLength > 0 && nextIndex >= queueLength) notifyGameEnd(); });',
            '            if (screenToggleEvent) cc.systemEvent.on(screenToggleEvent, function (screenName, active) { if (active && (screenName === "Result" || screenName === "Redirect" || screenName === "IntersectionScreen" || screenName === "Victory" || screenName === "Complete")) notifyGameEnd(); });',
            '        });',
            '    }, 50);',
            '});'
        ].join("\n        ");
    }

    function convertCocosOld(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "unity");
        out = replaceVariable(out, "adNetwork", cocosNetworkName(target));
        out = replaceStoreUrls(out, options);
        out = configureGoogleExitApi(out, target);

        var adapterScript = '<script data-playable-converter="cocos-adapter">\n' + buildCocosAdapter(target, options) + "\n</script>";
        var adapterRegex = /<script\b[^>]*>[\s\S]*?\bopenAdUrl\s*=\s*function[\s\S]*?<\/script>/i;
        var match = adapterRegex.exec(out);
        if (match) {
            out = out.slice(0, match.index + match[0].length) + "\n" + adapterScript + out.slice(match.index + match[0].length);
        } else {
            warnings.push("Không tìm thấy openAdUrl; adapter CTA được chèn ở cuối trang.");
            out = insertBeforeClosingBody(out, adapterScript);
        }

        if (target === "mintegral") {
            var directHooks = enableNativeCocosMintegralHooks(out);
            out = directHooks.html;
            var managers = findCocosGameManagers(out);
            if (!managers.length) warnings.push("Không tìm thấy tên GameManager; sẽ dò component EndGame lúc runtime.");
            out = insertBeforeClosingBody(out, '<script data-playable-converter="cocos-mintegral">\n' + buildCocosMintegralLifecycle(managers, directHooks.nativeReady, directHooks.nativeEnd) + "\n</script>");
        }
        return { html: out, warnings: warnings };
    }

    function enableNativeCocosMintegralHooks(html) {
        var readyCount = 0, endCount = 0;
        var out = html.replace(/this\.mindworks\s*&&\s*window\.gameReady\s*&&\s*window\.gameReady\s*\(\s*\)\s*[,;]?/g, function () {
            readyCount++;
            return "window.gameReady && window.gameReady();";
        });
        out = out.replace(/this\.mindworks\s*&&\s*window\.gameEnd\s*&&\s*window\.gameEnd\s*\(\s*\)\s*[,;]?/g, function () {
            endCount++;
            return "window.gameEnd && window.gameEnd();";
        });
        var nativeReady = readyCount > 0 || /prototype\.start\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]{0,1200}?window\.gameReady\s*&&\s*window\.gameReady\s*\(\s*\)/.test(out);
        var nativeEnd = endCount > 0 || /prototype\.(?:EndGame|endGame)\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]{0,1200}?window\.gameEnd\s*&&\s*window\.gameEnd\s*\(\s*\)/.test(out);
        return { html: out, readyCount: readyCount, endCount: endCount, nativeReady: nativeReady, nativeEnd: nativeEnd };
    }

    /* Link CTA phải được GHIM tại đây, không đọc lại biến toàn cục lúc click.
     * Nút CTA của build Cocos thường không gọi window.openAdUrl trực tiếp: nó gọi method
     * openAdUrl của component AdsManager trong scene, và method đó làm đúng một việc trước
     * khi gọi tiếp ra ngoài:
     *     window.androidLink = this.androidLink;  // giá trị NHÚNG TRONG SCENE
     *     window.iosLink = this.iosLink; window.defaultLink = this.defaultLink;
     *     window.openAdUrl ? window.openAdUrl() : window.open();
     * Link trong scene nằm trong JSON đã base64 hoá trong window.resMap nên replaceStoreUrls()
     * — vốn chạy regex trên văn bản HTML — không thấy và không thay được. Adapter đọc
     * androidLink lúc click sẽ nhận link app CŨ của build gốc, dù <head> đã được sửa đúng.
     * Vì vậy: có URL người dùng nhập thì nhúng thẳng dạng hằng số; không có thì chụp biến
     * toàn cục NGAY LÚC script này chạy — adapter được chèn liền sau script <head> khai báo
     * chúng, tức trước khi Cocos nạp scene, nên đó là lúc giá trị còn nguyên. */
    function buildCocosAdapter(target, options) {
        options = options || {};
        var android = options.androidUrl && String(options.androidUrl).trim();
        var ios = options.iosUrl && String(options.iosUrl).trim();
        var click = targetClickCode(target, "clickTag");
        var analytics = target === "applovin" ? [
            'var sent = {};',
            'function track(name) { if (name !== "CTA_CLICKED" && sent[name]) return; sent[name] = true; if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent(name); }',
            'track("LOADING");',
            'window.addEventListener("load", function () { track("LOADED"); track("DISPLAYED"); });'
        ].join("\n    ") : "function track() { }";
        function pin(url, globalName) {
            if (url) return JSON.stringify(url);
            return 'typeof ' + globalName + ' === "string" ? ' + globalName + ' : ""';
        }
        return [
            '(function () {',
            '    ' + analytics,
            '    var ctaAndroid = ' + pin(android, "androidLink") + ';',
            '    var ctaIos = ' + pin(ios, "iosLink") + ';',
            '    var ctaDefault = ' + pin(android || ios, "defaultLink") + ';',
            '    window.openAdUrl = function () {',
            '        if (window.cc && cc.sys && cc.sys.os === cc.sys.OS_ANDROID) clickTag = ctaAndroid || ctaDefault || ctaIos;',
            '        else if (window.cc && cc.sys && cc.sys.os === cc.sys.OS_IOS) clickTag = ctaIos || ctaDefault || ctaAndroid;',
            '        else clickTag = ctaDefault || ctaAndroid || ctaIos;',
            target === "applovin" ? '        track("CTA_CLICKED");' : "",
            '        ' + click,
            '    };',
            '})();'
        ].filter(Boolean).join("\n");
    }

    function buildCocosMintegralLifecycle(gameManagers, hasNativeReady, hasNativeEnd) {
        var managerJson = JSON.stringify(gameManagers);
        return [
            '(function () {',
            '    var nativeReady = ' + Boolean(hasNativeReady) + ', nativeEnd = ' + Boolean(hasNativeEnd) + ';',
            '    var readySent = false, ended = false;',
            '    function notifyReady() { if (!readySent) { readySent = true; window.gameReady && window.gameReady(); } }',
            '    function notifyEnd() { if (!ended) { ended = true; window.gameEnd && window.gameEnd(); } }',
            '    function patchTarget(target) {',
            '        if (nativeEnd || !target || target.__pcMintegralPatched) return;',
            '        target.__pcMintegralPatched = true;',
            '        ["EndGame", "endGame"].forEach(function (method) {',
            '            var original = target[method];',
            '            if (typeof original !== "function" || original.__pcWrapped) return;',
            '            var wrapped = function () { this.mindworks = false; var result = original.apply(this, arguments); notifyEnd(); return result; };',
            '            wrapped.__pcWrapped = true;',
            '            target[method] = wrapped;',
            '        });',
            '    }',
            '    function patchModules() {',
            '        ' + managerJson + '.forEach(function (name) { try { var module = window.__require && window.__require(name); var Type = module && (module.default || module); if (Type && Type.prototype) patchTarget(Type.prototype); } catch (e) { } });',
            '    }',
            '    function patchScene() {',
            '        var scene = window.cc && cc.director && cc.director.getScene && cc.director.getScene();',
            '        function visit(node) { if (!node) return; (node._components || []).forEach(patchTarget); (node.children || []).forEach(visit); }',
            '        visit(scene);',
            '    }',
            '    window.gameStart = function () { if (window.cc && cc.game && typeof cc.game.resume === "function") cc.game.resume(); };',
            '    window.gameClose = function () { if (window.cc && cc.game && typeof cc.game.pause === "function") cc.game.pause(); };',
            '    patchModules();',
            '    if (window.cc && cc.director && cc.Director) cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function () { patchModules(); patchScene(); if (!nativeReady) notifyReady(); });',
            '    else window.addEventListener("load", function () { var timer = setInterval(function () { if (window.cc && cc.director && cc.Director) { clearInterval(timer); cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function () { patchModules(); patchScene(); if (!nativeReady) notifyReady(); }); } }, 50); });',
            '})();'
        ].join("\n");
    }

    function convertLuna(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        out = removeLunaMintegralHooks(out, target);
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "unity");
        out = replaceStoreUrls(out, options);
        out = configureGoogleExitApi(out, target);
        out = insertBeforeClosingBody(out, '<script data-playable-converter="luna-adapter">\n' + buildLunaAdapter(target, options) + "\n</script>");
        return { html: out, warnings: warnings };
    }

    function removeLunaMintegralHooks(html, target) {
        if (target === "mintegral") return html;
        return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, function (all, attrs, code) {
            if (/\bsrc\s*=/.test(attrs)) return all;
            var installHook = /window\.gameClose\s*=/.test(code) && /window\.install\s*&&\s*window\.install/.test(code) && /window\.gameEnd/.test(code);
            var pauseGate = /window\.gameStart\s*=/.test(code) && /window\.gameReady/.test(code) && /luna:unsafe:pause/.test(code);
            if (!installHook && !pauseGate) return all;
            return '<!-- playable-converter: removed Luna Mintegral ' + (pauseGate ? "pause gate" : "install lifecycle") + ' -->';
        });
    }

    function buildLunaAdapter(target, options) {
        options = options || {};
        var android = escapeJsString(options.androidUrl || "");
        var ios = escapeJsString(options.iosUrl || "");
        var click = targetClickCode(target, "_pcStoreUrl()");
        var lines = [
            '(function () {',
            '    function _pcStoreUrl() {',
            '        var config = window.$environment && window.$environment.packageConfig || {};',
            '        var android = \'' + android + '\' || config.androidLink || config.iosLink || "";',
            '        var ios = \'' + ios + '\' || config.iosLink || config.androidLink || "";',
            '        return /iphone|ipad|ipod|macintosh/i.test((navigator.userAgent || "").toLowerCase()) ? ios : android;',
            '    }',
            '    function _pcClick() {',
            target === "applovin" ? '        if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent("CTA_CLICKED");' : '',
            '        ' + click,
            '    }',
            '    function _pcBindInstall() {',
            '        function apply() {',
            '            if (!window.Luna || !Luna.Unity || !Luna.Unity.Playable) return false;',
            '            Luna.Unity.Playable.InstallFullGame = _pcClick;',
            '            return true;',
            '        }',
            '        if (window.Bridge && typeof Bridge.ready === "function") Bridge.ready(apply);',
            '        if (!apply()) { var attempts = 0, timer = setInterval(function () { if (apply() || ++attempts > 200) clearInterval(timer); }, 50); }',
            '    }',
            '    window.addEventListener("luna:build", _pcBindInstall);',
            '    _pcBindInstall();'
        ];
        if (target === "applovin") lines.push(
            '    var _pcAlEvents = { "luna:start": "LOADING", "luna:started": "LOADED", "luna:postrender": "DISPLAYED" };',
            '    Object.keys(_pcAlEvents).forEach(function (eventName) { window.addEventListener(eventName, function () { if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent(_pcAlEvents[eventName]); }); });'
        );
        if (target !== "mintegral") lines.push(
            '    var _pcLunaStartSent = false, _pcLunaResumed = false;',
            '    function _pcLunaStart() { if (_pcLunaStartSent) return; _pcLunaStartSent = true; window.dispatchEvent(new Event("luna:start")); }',
            '    function _pcLunaResume() { if (_pcLunaResumed) return; _pcLunaResumed = true; window.dispatchEvent(new Event("luna:unsafe:resume")); }',
            '    function _pcLunaPause() { if (!_pcLunaResumed) return; _pcLunaResumed = false; window.dispatchEvent(new Event("luna:pause")); }',
            '    function _pcBindLunaLifecycle() {',
            (target === "applovin" || target === "unity")
                ? '        if (!window.mraid || typeof window.mraid.getState !== "function") { window.setTimeout(_pcLunaResume, 0); return; }'
                : '        window.setTimeout(_pcLunaResume, 0); return;',
            '        var safetyTimer = window.setTimeout(_pcLunaResume, 2000);',
            '        var resume = function () { window.clearTimeout(safetyTimer); _pcLunaResume(); };',
            '        var onViewable = function (viewable) { viewable ? resume() : _pcLunaPause(); };',
            '        var bind = function () { if (typeof mraid.addEventListener === "function") mraid.addEventListener("viewableChange", onViewable); if (typeof mraid.isViewable !== "function" || mraid.isViewable()) resume(); };',
            '        if (mraid.getState() === "loading" && typeof mraid.addEventListener === "function") mraid.addEventListener("ready", bind); else bind();',
            '    }',
            '    window.gameStart = _pcLunaResume;',
            '    window.gameClose = _pcLunaPause;',
            '    window.addEventListener("luna:build", function () { _pcLunaStart(); _pcBindLunaLifecycle(); });',
            '    _pcBindLunaLifecycle();'
        );
        if (target === "mintegral") lines.push(
            '    var _pcEnded = false;',
            '    window.gameStart = function () { window.dispatchEvent(new Event("luna:unsafe:resume")); };',
            '    window.gameClose = function () { window.dispatchEvent(new Event("luna:pause")); };',
            '    window.addEventListener("luna:started", function () { window.gameReady && window.gameReady(); });',
            '    window.addEventListener("luna:ended", function () { if (!_pcEnded) { _pcEnded = true; window.gameEnd && window.gameEnd(); } });'
        );
        lines.push('})();');
        return lines.filter(Boolean).join("\n");
    }

    function convertSetupConfig(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "unity");
        out = replaceSetupConfigNetwork(out, target, warnings);
        out = replaceSetupConfigRedirect(out, options);
        out = replaceStoreUrls(out, options);
        out = configureGoogleExitApi(out, target);
        out = insertBeforeClosingBody(out, '<script data-playable-converter="setup-config-adapter">\n' + buildSetupConfigAdapter(target) + "\n</script>");
        return { html: out, warnings: warnings };
    }

    // Khối network nằm trong initConfig, quyết định build gọi API nào lúc chạy.
    // Đây là toàn bộ việc cần làm để đổi mạng - build tự xử lý phần còn lại.
    function replaceSetupConfigNetwork(html, target, warnings) {
        var api = SETUP_CONFIG_API[target];
        if (!api) {
            warnings.push("Chưa có ánh xạ added_api cho " + target + "; giữ nguyên khối network.");
            return html;
        }
        var found = false;
        var out = html.replace(/(network\s*:\s*\{)([^{}]*)(\})/g, function (all, open, body, close) {
            if (!/added_api\s*:/.test(body)) return all;
            found = true;
            var patched = replaceStringAssignment(body, "name", target);
            patched = replaceStringAssignment(patched, "added_api", api);
            return open + patched + close;
        });
        if (!found) warnings.push("Không thấy khối network{...added_api...} trong initConfig; build có thể vẫn chạy ở mạng cũ.");
        return out;
    }

    // Store URL nằm trong redirect:{android,ios}. Hai khóa này quá chung để thay
    // toàn cục nên chỉ thay bên trong đúng khối redirect.
    function replaceSetupConfigRedirect(html, options) {
        options = options || {};
        var android = options.androidUrl && String(options.androidUrl).trim();
        var ios = options.iosUrl && String(options.iosUrl).trim();
        if (!android && !ios) return html;
        return html.replace(/redirect\s*:\s*\{([^{}]*)\}/g, function (all, body) {
            var patched = body;
            if (android) patched = replaceStringAssignment(patched, "android", android);
            if (ios) patched = replaceStringAssignment(patched, "ios", ios);
            var at = all.indexOf(body);
            return all.slice(0, at) + patched + all.slice(at + body.length);
        });
    }

    // Build định nghĩa window.openStorePage ở cuối file (mraid.open hoặc
    // location.href). Ghi đè sau đó để CTA dùng đúng API của mạng đích.
    function buildSetupConfigAdapter(target) {
        return [
            '(function () {',
            '    var _pcOpen = window.openStorePage;',
            '    window.openStorePage = function (url) {',
            '        try { ' + targetClickCode(target, "url") + ' }',
            '        catch (error) { if (typeof _pcOpen === "function") _pcOpen(url); }',
            '    };',
            '})();'
        ].join("\n");
    }

    function convertSuperHtml(html, target, options) {
        var warnings = [];
        var out = removeInjected(html);
        var version = detectSuperHtmlVersion(out);
        if (version === "unknown") warnings.push("Không xác định được phiên bản Super HTML (__res/__zip).");
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "unity");
        out = configureGoogleExitApi(out, target);
        var adapter = buildSuperHtmlAdapter(target, version, options);
        var wrapperRegex = /window\.super_html\s*=\s*\{[\s\S]*?\}\s*;+(?=\s*window\.(?:__res|__zip|zip)\s*=)/;
        if (wrapperRegex.test(out)) {
            out = out.replace(wrapperRegex, adapter + "\n");
        } else {
            warnings.push("Không tìm thấy block window.super_html; adapter được chèn trước payload.");
            var payload = /window\.(?:__res|__zip|zip)\s*=/;
            out = payload.test(out) ? out.replace(payload, adapter + "\n$&") : insertBeforeClosingBody(out, '<script data-playable-converter="super-html-adapter">\n' + adapter + "\n</script>");
        }
        return { html: out, warnings: warnings };
    }

    function buildSuperHtmlAdapter(target, version, options) {
        options = options || {};
        var android = escapeJsString(options.androidUrl || "");
        var ios = escapeJsString(options.iosUrl || "");
        var prefix = [
            'function _pcSuperUrl(fallback) {',
            '    var android = \'' + android + '\', ios = \'' + ios + '\';',
            '    var preferred = /iphone|ipad|ipod|macintosh/i.test((navigator.userAgent || "").toLowerCase()) ? ios : android;',
            '    return preferred || fallback || android || ios || "";',
            '}'
        ];
        if (target === "applovin") return prefix.concat([
            'window._pcSuperStarted = false;',
            'window._pcSuperTracked = {};',
            'function _pcSuperTrack(name) { if (name !== "CTA_CLICKED" && window._pcSuperTracked[name]) return; window._pcSuperTracked[name] = true; if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent(name); }',
            'function _pcSuperBoot() { if (window._pcSuperStarted) return; window._pcSuperStarted = true; _pcSuperTrack("DISPLAYED"); super_boot_engine(); }',
            '_pcSuperTrack("LOADING");',
            'window.super_html = {',
            '    download: function (url) { _pcSuperTrack("CTA_CLICKED"); url = _pcSuperUrl(typeof super_get_url === "function" ? super_get_url(url) : url); if (window.mraid && typeof window.mraid.open === "function") mraid.open(url); else window.open(url, "_blank"); },',
            '    game_ready: function () {',
            '        super_log("game ready"); _pcSuperTrack("LOADED");',
            '        if (!window.mraid || typeof window.mraid.getState !== "function") return _pcSuperBoot();',
            '        var safetyTimer = window.setTimeout(_pcSuperBoot, 2000);',
            '        var boot = function () { window.clearTimeout(safetyTimer); _pcSuperBoot(); };',
            '        var onViewable = function (viewable) { if (viewable) boot(); };',
            '        var bind = function () { try { if (typeof super_check_channel === "function") super_check_channel(window.mraid); } catch (e) { } if (typeof mraid.addEventListener === "function") mraid.addEventListener("viewableChange", onViewable); if (typeof mraid.isViewable !== "function" || mraid.isViewable()) boot(); };',
            '        if (mraid.getState() === "loading" && typeof mraid.addEventListener === "function") mraid.addEventListener("ready", bind); else bind();',
            '    }',
            '};'
        ]).join("\n");
        if (target === "mintegral") return prefix.concat([
            'window.gameStart = function () { super_log("game start"); super_boot_engine(); };',
            'window.gameClose = function () { };',
            'window.super_html = {',
            '    download: function () { super_log("game download"); window.install && window.install(); },',
            '    game_ready: function () { super_log("game ready"); if (typeof super_check_channel === "function" && super_check_channel(window.gameReady)) window.gameReady && window.gameReady(); else window.gameStart(); },',
            '    game_end: function () { super_log("game end"); window.gameEnd && window.gameEnd(); }',
            '};'
        ]).join("\n");
        if (target === "google") return prefix.concat([
            'window.super_html = {',
            '    download: function (url) { super_log("game download"); if (window.ExitApi && typeof window.ExitApi.exit === "function") window.ExitApi.exit(); else window.open(_pcSuperUrl(url), "_blank"); },',
            '    game_ready: function () { super_log("game ready"); super_boot_engine(); },',
            '    is_hide_download: function () { return true; }',
            '};'
        ]).join("\n");
        if (target === "pangle") return prefix.concat([
            'window.super_html = {',
            '    download: function () { super_log("game download"); if (typeof window.openAppStore === "function") window.openAppStore(); },',
            '    game_ready: function () { super_log("game ready"); if (typeof super_check_channel === "function") super_check_channel(window.openAppStore); super_boot_engine(); }',
            '};'
        ]).join("\n");
        if (target === "unity" && version === "old") return prefix.concat([
            'function _pcUnityOldStart() { super_log("game ready"); if (typeof mraid !== "undefined" && typeof super_check_channel === "function") super_check_channel(window.mraid); super_boot_engine(); }',
            'window.super_html = {',
            '    download: function (url) { url = _pcSuperUrl(url); if (typeof mraid !== "undefined") mraid.open(url); else window.open(url, "_blank"); },',
            '    game_ready: function () { if (typeof mraid !== "undefined") { if (mraid.getState() === "loading") mraid.addEventListener("ready", _pcUnityOldStart); else _pcUnityOldStart(); } else _pcUnityOldStart(); }',
            '};'
        ]).join("\n");
        if (target === "unity") return prefix.concat([
            'window._pcUnityStarted = false;',
            'function _pcUnityViewableStart() { if (!window._pcUnityStarted) { super_boot_engine(); window._pcUnityStarted = true; } }',
            'function _pcUnityViewableChange(viewable) { if (viewable) _pcUnityViewableStart(); }',
            'function _pcUnitySdkReady() { mraid.addEventListener("viewableChange", _pcUnityViewableChange); if (mraid.isViewable()) _pcUnityViewableStart(); }',
            'window.super_html = {',
            '    download: function (url) { url = _pcSuperUrl(typeof super_get_url === "function" ? super_get_url(url) : url); if (window.mraid) { if (url) mraid.open(url); else mraid.open(); } else window.open(url, "_blank"); },',
            '    game_ready: function () { if (typeof super_check_channel === "function" && super_check_channel(window.mraid)) { if (mraid.getState() === "loading") mraid.addEventListener("ready", _pcUnitySdkReady); else _pcUnitySdkReady(); } else _pcUnityViewableStart(); }',
            '};'
        ]).join("\n");
        return prefix.concat([
            'window.super_html = {',
            '    download: function (url) { url = _pcSuperUrl(url); if (window.mraid && typeof mraid.open === "function") mraid.open(url); else window.open(url, "_blank"); },',
            '    game_ready: function () { try { if (window.mraid && typeof super_check_channel === "function") super_check_channel(window.mraid); } catch (e) { } super_boot_engine(); }',
            '};'
        ]).join("\n");
    }

    function convertThreejs(html, target, options) {
        options = options || {};
        var warnings = [];
        var out = removeInjected(html);
        // Bản Google vá tay (window.install = window.download = … → ExitApi) sẽ đè hàm install thật của Mintegral.
        if (target === "mintegral" && /\bwindow\.install\s*=/.test(out)) warnings.push("File nguồn tự gán window.install (bản vá tay cho Google?); trên Mintegral CTA có thể không gọi được install thật. Nên convert từ bản AppLovin/Unity gốc.");
        out = removeForeignNetworkSdks(out, target);

        out = setMraidTag(out, target === "applovin" || target === "unity");   // lệ riêng của template AVK
        out = configureGoogleExitApi(out, target);
        var sourceRegex = /(\bvar\s+playableSource\s*=\s*)(["'])[^"']*\2/;
        if (sourceRegex.test(out)) out = out.replace(sourceRegex, "$1$2" + THREEJS_SOURCE[target] + "$2");
        else warnings.push("Không tìm thấy var playableSource; build vẫn chạy theo mạng cũ.");
        out = replaceThreejsStoreUrls(out, target, options, warnings);
        if (!/\bparcelRequire\s*=/.test(out) || !/\bBrowserClientAPI\b/.test(out)) warnings.push("Không thấy bundle Parcel có BrowserClientAPI; adapter CTA có thể không gắn được vào game.");
        out = insertBeforeClosingBody(out, '<script data-playable-converter="threejs-adapter">\n' + buildThreejsAdapter(target) + "\n</script>");
        return { html: out, warnings: warnings };
    }

    /* Thẻ <script src="mraid.js"> trong <head>. File mraid.js do SDK của mạng phục vụ lúc serve,
     * không nằm trong gói — nên thừa thẻ là Google validator báo thiếu file, còn thiếu thẻ thì
     * Unity không bơm được MRAID vào.
     *
     * Ai cần: theo bảng kênh của bingo-core.js (bản có lý lẽ rõ nhất trong repo) thì CHỈ Unity.
     * AppLovin tự chèn mraid.js; Mintegral/Pangle không dùng MRAID; Google dùng ExitApi.
     * Bảng đó còn là luật nhận diện: detectBingoNetwork phân biệt AppLovin với Unity bằng đúng
     * sự có mặt của thẻ này.
     *
     * NGOẠI LỆ build AVK (threejs): template của studio mở <head> bằng thẻ này ở CẢ AppLovin lẫn
     * Unity, và nhận diện của nó đọc `playableSource` chứ không đọc thẻ — nên giữ nguyên lệ riêng
     * đó thay vì ép theo bảng chung.
     */
    function setMraidTag(html, needed) {
        var out = html.replace(/\s*<script\b[^>]*\bsrc\s*=\s*["']mraid\.js["'][^>]*>\s*<\/script>/gi, "");
        if (!needed) return out;
        var anchor = /<head\b[^>]*>/i.exec(out) || /<html\b[^>]*>/i.exec(out);
        if (!anchor) return '<script src="mraid.js"></script>\n' + out;
        var at = anchor.index + anchor[0].length;
        return out.slice(0, at) + '\n\t<script src="mraid.js"></script>' + out.slice(at);
    }

    // Link store nằm trong PROJECT.DAT (this.android_url / this.ios_url); CTA chọn link theo isMobile.Android().
    function replaceThreejsStoreUrls(html, target, options, warnings) {
        var android = options.androidUrl && String(options.androidUrl).trim();
        var ios = options.iosUrl && String(options.iosUrl).trim();
        var out = html;
        if (android) out = replaceStringAssignment(out, "android_url", android);
        if (ios) out = replaceStringAssignment(out, "ios_url", ios);
        // Chỉ AppLovin/Unity truyền link này vào mraid.open(url); Mintegral/Google/Pangle gọi install/ExitApi/openAppStore.
        var iosUrl = (out.match(/\bios_url\s*=\s*["']([^"']*)["']/) || [])[1] || "";
        if ((target === "applovin" || target === "unity") && /play\.google\.com/i.test(iosUrl)) {
            warnings.push("ios_url đang là link Google Play: trên iOS, CTA gọi mraid.open với link này. Nhập iOS URL ở mục Store URL tùy chọn.");
        }
        return out;
    }

    // Adapter chèn sau bundle Parcel, chạy trước window.load: module src/api đã nạp nhưng entry chưa tạo lớp
    // API nào, nên vá prototype là đủ. Tìm module theo hình dạng (exports có BrowserClientAPI) vì id module
    // Parcel là hash, đổi theo từng bản build.
    //  - open: CTA theo mạng đích. Google/Pangle ở template cũ rơi vào BrowserClientAPI có open = alert(url).
    //  - getSize: MraidClientAPI gọi mraid.getMaxSize(), xem thử trên trình duyệt không có MRAID là lỗi.
    //  - init (AppLovin/Unity): chờ mraid ready → viewable rồi mới chạy game, quá 2 s thì chạy luôn. Bản gốc
    //    đọc tham số viewableChange như object {isViewable} trong khi MRAID truyền boolean, nên quảng cáo
    //    chưa hiện lúc ready thì game không bao giờ chạy.
    function buildThreejsAdapter(target) {
        var mraidTarget = target === "applovin" || target === "unity";
        var lines = ['(function () {'];
        if (target === "applovin") lines.push(
            '    var sent = {};',
            '    function track(name) { if (name !== "CTA_CLICKED" && sent[name]) return; sent[name] = true; if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") window.ALPlayableAnalytics.trackEvent(name); }',
            '    track("LOADING");',
            '    window.addEventListener("load", function () { track("LOADED"); });'
        );
        else lines.push('    function track() { }');
        lines.push(
            '    var cache = window.parcelRequire && window.parcelRequire.cache, api = null;',
            '    for (var id in cache || {}) { var exported = cache[id] && cache[id].exports; if (exported && typeof exported.BrowserClientAPI === "function") { api = exported; break; } }',
            '    if (!api) return;',
            '    function open(url) { track("CTA_CLICKED"); ' + targetClickCode(target, "url") + ' }',
            '    function windowSize() { return { width: window.innerWidth, height: window.innerHeight }; }'
        );
        if (mraidTarget) lines.push(
            '    function mraidInit(start) {',
            '        track("LOADED");',
            '        var self = this, started = false, mraid = window.mraid;',
            '        function launch() { if (started) return; started = true; self.gameStarted = true; track("DISPLAYED"); start(); }',
            '        if (!mraid || typeof mraid.getState !== "function") return launch();',
            '        var safetyTimer = window.setTimeout(launch, 2000);',
            '        var go = function () { window.clearTimeout(safetyTimer); launch(); };',
            '        var onViewable = function (viewable) { if (viewable === true || (viewable && viewable.isViewable === true)) go(); };',
            '        var bind = function () { if (typeof mraid.addEventListener === "function") mraid.addEventListener("viewableChange", onViewable); if (typeof mraid.isViewable !== "function" || mraid.isViewable()) go(); };',
            '        if (mraid.getState() === "loading" && typeof mraid.addEventListener === "function") mraid.addEventListener("ready", bind); else bind();',
            '    }'
        );
        lines.push(
            '    Object.keys(api).forEach(function (name) {',
            '        var proto = typeof api[name] === "function" && api[name].prototype;',
            '        if (!proto || typeof proto.init !== "function" || typeof proto.open !== "function") return;',
            '        var getSize = proto.getSize;',
            '        proto.getSize = function () { try { var size = typeof getSize === "function" && getSize.apply(this, arguments); if (size && size.width > 0 && size.height > 0) return size; } catch (e) { } return windowSize(); };',
            '        proto.open = open;'
        );
        if (mraidTarget) lines.push('        proto.init = mraidInit;');
        lines.push('    });', '})();');
        return lines.join("\n");
    }

    // selfName: tên hàm CTA đang sinh. Adapter nào gán chính hàm đó vào window.install khi SDK vắng mặt
    // (MindWorks, PlaySmart) thì nhánh Mintegral "window.install()" gọi lại chính nó: đệ quy vô hạn,
    // bấm CTA là RangeError. Lộ ra khi mở file ngoài môi trường Mintegral — nhất là sau khi đã gỡ gói
    // offline (stub window.install) của lớp phát hành.
    function targetClickCode(target, urlExpression, selfName) {
        if (target === "mintegral") return 'if (typeof window.install === "function"' + (selfName ? ' && window.install !== ' + selfName : '') + ') window.install(); else if (window.mraid && typeof window.mraid.open === "function") window.mraid.open(' + urlExpression + '); else window.open(' + urlExpression + ', "_blank")';
        if (target === "google") return 'if (window.ExitApi && typeof window.ExitApi.exit === "function") window.ExitApi.exit(); else window.open(' + urlExpression + ', "_blank")';
        if (target === "pangle") return 'if (typeof window.openAppStore === "function") window.openAppStore(); else window.open(' + urlExpression + ', "_blank")';
        return 'if (window.mraid && typeof window.mraid.open === "function") window.mraid.open(' + urlExpression + '); else window.open(' + urlExpression + ', "_blank")';
    }

    function cocosNetworkName(target) {
        return target === "google" ? "adword" : target;
    }

    function replaceVariable(html, name, value) {
        var regex = new RegExp("(\\bvar\\s+" + escapeRegex(name) + "\\s*=\\s*)['\"][^'\"]*['\"]");
        return html.replace(regex, "$1'" + value + "'");
    }

    function replaceStoreUrls(html, options) {
        options = options || {};
        var android = options.androidUrl && String(options.androidUrl).trim();
        var ios = options.iosUrl && String(options.iosUrl).trim();
        var out = html;
        if (android) {
            out = replaceStringAssignment(out, "spUrlAndroid", android);
            out = replaceStringAssignment(out, "androidLink", android);
        }
        if (ios) {
            out = replaceStringAssignment(out, "spUrlIos", ios);
            out = replaceStringAssignment(out, "iosLink", ios);
        }
        if (android || ios) out = replaceStringAssignment(out, "defaultLink", android || ios);
        return out;
    }

    function replaceStringAssignment(html, name, value) {
        // Cờ "g": cùng một khóa (androidLink, iosLink…) thường xuất hiện ở nhiều
        // nơi — biến toàn cục, object config, packageConfig — phải thay hết.
        // "[:=]": khóa có thể là phép gán (androidLink = '…') hoặc thuộc tính
        // object (androidLink: '…'); chỉ bắt "=" sẽ bỏ sót toàn bộ dạng thứ hai.
        // "$" trong URL phải escape thành "$$" vì replace() coi $& / $1 là ký hiệu.
        // Bắt cả template literal: build đã minify hay dùng backtick cho chuỗi.
        var regex = new RegExp("(\\b(?:var\\s+)?" + escapeRegex(name) + "\\s*[:=]\\s*)(['\"`])[^'\"`]*\\2", "g");
        var escaped = escapeJsString(value).replace(/\$/g, "$$$$");
        return html.replace(regex, "$1$2" + escaped + "$2");
    }

    function configureGoogleExitApi(html, target) {
        var out = html.replace(/\s*<script\b[^>]*\bsrc\s*=\s*["'][^"']*googlesyndication\.com\/pagead\/gadgets\/html5\/api\/exitapi\.js[^"']*["'][^>]*>\s*<\/script>/gi, "");
        out = out.replace(/\s*<meta\b[^>]*name\s*=\s*["']ad\.orientation["'][^>]*>/gi, "");
        if (target !== "google") return out;
        var tags = '\n    <meta name="ad.orientation" content="portrait,landscape">\n    <script type="text/javascript" src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>';
        return /<\/head>/i.test(out) ? out.replace(/<\/head>/i, tags + "\n</head>") : tags + "\n" + out;
    }

    /* ───────────── lớp PHÁT HÀNH của Mintegral trong bản tải từ SocialPeta ─────────────
     * SocialPeta không lưu creative gốc mà chụp nó LÚC ĐANG PHÁT trên Mintegral, nên dính theo các
     * script mà mạng tự chèn khi phục vụ. Công cụ test Mindworks (preview_util.js) và runtime thật của
     * Mintegral đều chèn LẠI bản của chúng; bản chụp chạy sau và đè lên. Đã đo bằng preview_util.js thật:
     *   - PlProtocol.js (chế độ inner) thay gameReady/install/gameEnd bằng postMessage lên trang cha:
     *     SDK chấm điểm không bao giờ nhận gameReady, màn đen loading không tắt, trượt gần hết mục;
     *   - DynamicLoader document.write m_util.js từ CDN SocialPeta (chặn hotlink: 403, thử lại 6 lần):
     *     trượt mục "Storage requirements" (outer_chain);
     *   - module mtg-package-loading vẽ tên + icon + mô tả app GỐC, chỉ gỡ khi có PLAYABLE:gameStart:
     *     mở ngoài Mintegral thì đứng mãi;
     *   - web-audio-check giữ mọi AudioContext ở suspended tới khi có MW_gameStartCheck(): game câm;
     *   - MW_CONFIG của chiến dịch gốc đè MW_CONFIG mà Mintegral chèn cho chiến dịch mới.
     * Luật NEO vào đầu script và có trần kích thước: code game hay nhắc lại tên biến của SDK (runtime
     * PlaySmart đọc window.MW_CONFIG), khớp lỏng giữa thân script là xoá nhầm cả game mà vẫn báo thành công.
     */
    var SERVING_SRC = /rayjump\.com\/(?:hyplug|util)\/|zingfront\.com\/sp_opera\/(?:mobvista_playable_js\/|js\/web-audio-check\.js)/i;
    var BABEL_HEAD = /^"use strict";\s*var _typeof\s*=/;

    // UMD của webpack: !function(e,t){"object"==typeof exports&&…define("Tên",[],t)… — tên nằm ngay đầu.
    function isNamedUmd(code, name) {
        return /^!function\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{/.test(code) && code.slice(0, 400).indexOf('define("' + name + '"') >= 0;
    }

    var SERVING_SCRIPTS = [
        { label: "PlProtocol.js", max: 20000, test: function (c) { return isNamedUmd(c, "PlProtocol"); } },
        { label: "loader m_util (DynamicLoader)", max: 20000, test: function (c) { return isNamedUmd(c, "DynamicLoader") && c.indexOf("MTG_UTIL") >= 0; } },
        { label: "MtgLoading", max: 300000, test: function (c) { return isNamedUmd(c, "MtgLoading"); } },
        { label: "ReportLog", max: 100000, test: function (c) { return isNamedUmd(c, "ReportLog"); } },
        { label: "PlHacks", max: 30000, test: function (c) { return isNamedUmd(c, "PlHacks"); } },
        { label: "web-audio-check", max: 8000, test: function (c) { return /^(?:\/\*[\s\S]*?\*\/\s*)?\(\s*function\s*\(\s*window\s*,\s*document\s*\)/.test(c) && c.indexOf("MW_gameStartCheck") >= 0 && c.indexOf("audioCtxList") >= 0; } },
        { label: "gói offline MTG_OFFLINE_PACKAGE", max: 60000, test: function (c) { return BABEL_HEAD.test(c) && c.indexOf("window.MTG_OFFLINE_PACKAGE={") >= 0 && /MTG_OFFLINE_PACKAGE\.init\(\)\s*;?\s*$/.test(c); } },
        { label: "trang loading tên/icon app gốc (mtg-package-loading)", max: 300000, test: function (c) { return BABEL_HEAD.test(c) && c.indexOf("packageLoading=new function") >= 0 && c.indexOf("mtg-package-loading") >= 0; } },
        { label: "m_util.js", max: 300000, test: function (c) { return BABEL_HEAD.test(c) && c.indexOf("window.MUTIL_ONLINE=!0") >= 0 && c.indexOf("loadMUTILJS") >= 0; } },
        { label: "m_toolkit.js", max: 600000, test: function (c) { return BABEL_HEAD.test(c) && c.indexOf("window.MW_PREVIEWLAYER=") >= 0 && c.indexOf("triggerGameStart") >= 0; } },
        { label: "preview_util.js", max: 600000, test: function (c) { return BABEL_HEAD.test(c) && c.indexOf("MW_PREVIEWER_LIFECYCLE") >= 0 && c.indexOf("previewer:review") >= 0; } }
    ];

    // Khoá mang danh tính chiến dịch/app gốc: chỉ trang loading/end card của lớp phát hành đọc chúng.
    var MW_CONFIG_IDENTITY = ["MTGMaterialUUID", "MTGMaterialVersion", "app_icons", "languages", "store_url", "end_screen_info"];

    // Vị trí "}" khớp với "{" tại openAt; bỏ qua ngoặc nằm trong chuỗi. -1 nếu không khớp.
    function matchBrace(code, openAt) {
        var depth = 0;
        for (var i = openAt; i < code.length; i++) {
            var c = code[i];
            if (c === '"' || c === "'" || c === "`") {
                for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
                continue;
            }
            if (c === "{") depth++;
            else if (c === "}" && --depth === 0) return i;
        }
        return -1;
    }

    /* MW_CONFIG KHÔNG xoá được: runtime PlaySmart đọc channel và các cờ disable_*_click, thiếu thì
     * vpInstall2/3 gọi thẳng window.install() — tức tự chuyển store. preview_util.js cũng tự tạo một
     * MW_CONFIG tối thiểu nếu chưa có, nên bọc kiểu "MW_CONFIG || {…}" sẽ làm mất các cờ đó.
     * Bọc lại theo kiểu CHỈ ĐIỀN KHOÁ CÒN THIẾU và bỏ khoá danh tính: Mintegral chèn cấu hình chiến dịch
     * mới thì cấu hình đó thắng; chạy trong công cụ test thì game vẫn giữ cờ của nó.
     */
    function wrapBakedMwConfig(code) {
        var head = code.match(/^window\s*\.\s*MW_CONFIG\s*=\s*\{/);
        if (!head) return null;
        var openAt = head[0].length - 1, closeAt = matchBrace(code, openAt);
        if (closeAt < 0) return null;
        var literal = code.slice(openAt, closeAt + 1), rest = code.slice(closeAt + 1).replace(/^\s*;/, "");
        try { new Function("return (" + literal + ");"); } catch (e) { return null; }
        return [
            "(function (baked) {",
            "    " + JSON.stringify(MW_CONFIG_IDENTITY) + ".forEach(function (key) { delete baked[key]; });",
            "    var live = window.MW_CONFIG;",
            "    if (!live || typeof live !== \"object\") { window.MW_CONFIG = baked; return; }",
            "    for (var key in baked) if (!Object.prototype.hasOwnProperty.call(live, key)) live[key] = baked[key];",
            "})(" + literal + ");"
        ].join("\n") + (rest.trim() ? "\n" + rest : "");
    }

    function servingLabelFromUrl(url) {
        return String(url).split(/[?#]/)[0].split("/").pop() || url;
    }

    /**
     * Gỡ lớp phát hành Mintegral (xem ghi chú trên). → { html, removed: [nhãn] }
     * Lớp vỏ lồng iframe #MW_PLFRAME thì để nguyên: ở đó PlProtocol (chế độ outer) là cầu thật tới game
     * trong iframe — cách đúng là chuyển sang tài liệu con rồi mới convert (app.js: useInnerDocument).
     */
    function stripServingLayers(html) {
        var removed = [];
        if (/<iframe\b[^>]*\bid\s*=\s*["']MW_PLFRAME["']/i.test(html)) return { html: html, removed: removed };
        // Dấu vết để đọc lại file biết đã gỡ gì — KHÔNG kèm URL: máy quét link ngoài của Mindworks đọc cả comment.
        function drop(label, gap) {
            removed.push(label);
            return "<!-- playable-converter: removed Mintegral serving layer: " + escapeHtmlComment(label) + " -->" + gap;
        }
        var out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>(\s*)/gi, function (all, attrs, body, gap) {
            var src = (attrs.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1];
            var from = (attrs.match(/\sdata-inlined-from\s*=\s*["']([^"']+)["']/i) || [])[1];
            if ((src && SERVING_SRC.test(src)) || (from && SERVING_SRC.test(from))) return drop(servingLabelFromUrl(src || from), gap);
            if (src) return all;
            var code = body.trim();
            for (var i = 0; i < SERVING_SCRIPTS.length; i++) {
                if (code.length <= SERVING_SCRIPTS[i].max && SERVING_SCRIPTS[i].test(code)) return drop(SERVING_SCRIPTS[i].label, gap);
            }
            if (/^window\s*\.\s*MW_CONFIG\s*=/.test(code) && code.indexOf("MTGMaterialUUID") >= 0) {
                var wrapped = wrapBakedMwConfig(code);
                if (wrapped) {
                    removed.push("MW_CONFIG của app gốc (bọc lại: chỉ điền khoá còn thiếu, bỏ tên/icon/link app gốc)");
                    return "<script" + attrs + ">\n" + wrapped + "\n</script>" + gap;
                }
            }
            return all;
        });
        return { html: out, removed: unique(removed) };
    }

    function removeForeignNetworkSdks(html, target) {
        // `\ssrc` chứ không `\bsrc`: gạch nối là ranh giới từ nên `\b` khớp cả data-src="…", biến một
        // thẻ đã nhúng thành "script ngoài" và bỏ sót. Thuộc tính thật luôn có khoảng trắng đứng trước.
        return html.replace(/<script\b([^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*)>\s*<\/script>/gi, function (all, attrs, src) {
            var lower = src.toLowerCase();
            if (/pangle|pangolin|byteoversea|vungle|dapi\.js|fbplayablead/.test(lower)) return '<!-- playable-converter: disabled source SDK ' + escapeHtmlComment(src) + ' -->';
            if (target !== "google" && /googlesyndication\.com\/pagead\/gadgets\/html5\/api\/exitapi/.test(lower)) return "";
            // Cầu SDK của Mintegral (play.rayjump.com/hyplug/PlProtocol.js) định nghĩa window.install,
            // gameReady, gameEnd, gameStart, gameClose, gameRetry. Bản phẳng đã bị stripServingLayers gỡ
            // cho MỌI mạng đích (kể cả Mintegral: công cụ test chạy game ngay trong trang của nó, PlProtocol
            // chế độ inner cướp gameReady). Tới được đây chỉ còn lớp vỏ #MW_PLFRAME — ở đó nó là cầu outer
            // thật nên giữ khi đích là Mintegral.
            if (target !== "mintegral" && /rayjump\.com\/hyplug\//.test(lower)) return '<!-- playable-converter: disabled source SDK ' + escapeHtmlComment(src) + ' -->';
            return all;
        });
    }

    function removeInjected(html) {
        return html.replace(/\s*<script\b[^>]*data-playable-converter=["'][^"']+["'][^>]*>[\s\S]*?<\/script>/gi, "");
    }

    // Hàm thay thế chứ không phải chuỗi: content có thể chứa $& $` $' $1 (URL store, code adapter,
    // payload nhúng) mà String.replace coi là ký hiệu — $' chèn lại cả phần đuôi chuỗi đích.
    function insertBeforeClosingBody(html, content) {
        return /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, function () { return content + "\n</body>"; })
            : html + "\n" + content;
    }

    function readSayGamesStageQueue(html) {
        var match = html.match(/\bspVars\s*=\s*JSON\.parse\(decodeURIComponent\(['"]([^'"]+)['"]\)\)/);
        if (!match) return [];
        try {
            var vars = JSON.parse(decodeURIComponent(match[1]));
            var config = vars && vars.stages && vars.stages.value;
            if (typeof config === "string") config = JSON.parse(config);
            return config && Array.isArray(config.queue) ? config.queue : [];
        } catch (e) {
            return [];
        }
    }

    function findCocosGameManagers(html) {
        var names = [], seen = {}, regex = /\b(GameManager[A-Za-z0-9_$]*)\s*:\s*\[function/g, match;
        while ((match = regex.exec(html))) {
            if (!seen[match[1]]) { seen[match[1]] = true; names.push(match[1]); }
        }
        return names;
    }

    function validate(html, target, build) {
        var errors = [], warnings = [];
        var syntaxErrors = validateInlineScripts(html);
        if (syntaxErrors.length) errors.push.apply(errors, syntaxErrors);
        // Build Bingo, Super HTML (window.__zip) và MindWorks (window.__adapter_zip__) đều để code
        // game trong khối nén nên không soi được mouse event từ HTML ngoài. Với MindWorks đã đo:
        // cocos2d-js-min.js bên trong payload có đủ mousedown/mousemove/mouseup, còn HTML ngoài
        // thiếu mousemove — cảnh báo ở đây là báo nhầm.
        var packed = build === "bingo" || build === "mindworks"
            || (build === "super-html" && /\bwindow\s*\.\s*(?:__zip|zip)\s*=/.test(html));
        if (!packed && (!/mousedown/.test(html) || !/mousemove/.test(html) || !/mouseup/.test(html))) warnings.push("Không phát hiện đầy đủ mouse down/move/up; nên kiểm tra thao tác PC.");
        if (byteLength(html) > 5 * 1024 * 1024) warnings.push("File lớn hơn 5 MB.");
        if (target === "mintegral") {
            if (!/window\.gameReady\s*&&\s*window\.gameReady\s*\(\s*\)/.test(html)) errors.push("Thiếu gameReady của Mintegral.");
            if (!/window\.gameEnd\s*&&\s*window\.gameEnd\s*\(\s*\)/.test(html)) errors.push("Thiếu gameEnd của Mintegral.");
            // Khai báo function gameStart() {} cấp cao nhất của script thường cũng là window.gameStart (build AVK dùng cách này).
            if (!/window\.gameStart\s*=|\bfunction\s+gameStart\s*\(/.test(html) || !/window\.gameClose\s*=|\bfunction\s+gameClose\s*\(/.test(html)) warnings.push("Thiếu gameStart/gameClose rõ ràng.");
        }
        if (target === "google" && !/ExitApi\.exit/.test(html)) errors.push("Thiếu ExitApi.exit của Google.");
        if (target === "applovin" && !/mraid\.open/.test(html)) errors.push("Thiếu CTA mraid.open của AppLovin.");
        if (target === "unity" && !/mraid\.open/.test(html)) errors.push("Thiếu CTA mraid.open của Unity.");
        if (target === "pangle" && !/openAppStore/.test(html)) errors.push("Thiếu openAppStore của Pangle.");
        if (build === "saygames" && !new RegExp("spNetwork\\s*=\\s*['\"]" + target + "['\"]").test(html)) errors.push("Sai spNetwork đầu ra.");
        return { errors: errors, warnings: unique(warnings) };
    }

    function validateInlineScripts(html) {
        var errors = [], regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, match, index = 0;
        while ((match = regex.exec(html))) {
            if (/\bsrc\s*=/.test(match[1]) || /type\s*=\s*["'](?:text\/plain|application\/json|systemjs-importmap)/i.test(match[1])) continue;
            index++;
            try { new Function(match[2]); }
            catch (error) { errors.push("Script " + index + ": " + error.message); if (errors.length >= 3) break; }
        }
        return errors;
    }

    function byteLength(value) {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
        if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
        return unescape(encodeURIComponent(value)).length;
    }

    function unique(values) {
        return values.filter(function (value, index) { return values.indexOf(value) === index; });
    }

    function escapeRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function escapeJsString(value) {
        return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]+/g, "");
    }

    function escapeHtmlComment(value) {
        return String(value).replace(/--/g, "—");
    }

    // ---- ZIP writer (store + deflate) ----
    // Tự dựng file .zip không cần thư viện ngoài: Local File Header + data +
    // Central Directory + EOCD. Phần nén DEFLATE (async, CompressionStream) do
    // phía gọi cung cấp qua entry.deflated; core chỉ ráp byte nên chạy đồng bộ,
    // tất định -> test được ở Node.
    var CRC_TABLE = null;
    function crcTable() {
        if (CRC_TABLE) return CRC_TABLE;
        var table = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        CRC_TABLE = table;
        return table;
    }

    function crc32(bytes) {
        var table = crcTable();
        var crc = 0xffffffff;
        for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function utf8Bytes(value) {
        if (value instanceof Uint8Array) return value;
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(value));
        if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(String(value), "utf8"));
        var s = unescape(encodeURIComponent(String(value))), b = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        return b;
    }

    function dosDateTime(date) {
        // Trả [time, date], mỗi cái 16-bit theo định dạng MS-DOS của ZIP.
        var y = date.getFullYear();
        if (y < 1980) return [0, 0x21]; // 1980-01-01 khi ngày quá cũ/không hợp lệ
        var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1);
        var day = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        return [time & 0xffff, day & 0xffff];
    }

    // entries = [{ name, data:(Uint8Array|string), deflated:(Uint8Array|null) }]
    // deflated có và nhỏ hơn data -> method 8 (deflate); ngược lại store (method 0).
    function assembleZip(entries, when) {
        var dt = dosDateTime(when || new Date(1980, 0, 1));
        var parts = [], central = [], offset = 0;

        function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
        function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var data = e.data instanceof Uint8Array ? e.data : utf8Bytes(e.data);
            var nameBytes = utf8Bytes(e.name);
            var useDeflate = e.deflated && e.deflated.length < data.length;
            var method = useDeflate ? 8 : 0;
            var stored = useDeflate ? e.deflated : data;
            var crc = crc32(data);
            var flag = 0x0800; // đánh dấu tên file là UTF-8

            var local = [].concat(
                u32(0x04034b50), u16(20), u16(flag), u16(method),
                u16(dt[0]), u16(dt[1]), u32(crc), u32(stored.length), u32(data.length),
                u16(nameBytes.length), u16(0)
            );
            parts.push(new Uint8Array(local), nameBytes, stored);

            var cdir = [].concat(
                u32(0x02014b50), u16(20), u16(20), u16(flag), u16(method),
                u16(dt[0]), u16(dt[1]), u32(crc), u32(stored.length), u32(data.length),
                u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
            );
            central.push(new Uint8Array(cdir), nameBytes);

            offset += local.length + nameBytes.length + stored.length;
        }

        var centralStart = offset, centralSize = 0;
        for (var c = 0; c < central.length; c++) centralSize += central[c].length;

        var eocd = new Uint8Array([].concat(
            u32(0x06054b50), u16(0), u16(0),
            u16(entries.length), u16(entries.length),
            u32(centralSize), u32(centralStart), u16(0)
        ));

        var out = new Uint8Array(offset + centralSize + eocd.length), pos = 0;
        for (var p = 0; p < parts.length; p++) { out.set(parts[p], pos); pos += parts[p].length; }
        for (var q = 0; q < central.length; q++) { out.set(central[q], pos); pos += central[q].length; }
        out.set(eocd, pos);
        return out;
    }

    return {
        NETWORKS: NETWORKS,
        ASSET_KINDS: ASSET_KINDS,
        assetKind: assetKind,
        analyze: analyze,
        extractEmbeddedData: extractEmbeddedData,
        replaceEmbeddedData: replaceEmbeddedData,
        normalizeEmbeddedReplacement: normalizeEmbeddedReplacement,
        decodeBase64Bytes: decodeBase64Bytes,
        encodeBase64Bytes: encodeBase64Bytes,
        decodeBase122Bytes: decodeBase122Bytes,
        encodeBase122Bytes: encodeBase122Bytes,
        detectBuild: detectBuild,
        detectSourceNetwork: detectSourceNetwork,
        detectBingoNetwork: detectBingoNetwork,
        detectZipEncoding: detectZipEncoding,
        registerBuild: registerBuild,
        // Mở cho module build ngoài (playsmart-core.js) dùng đúng một bộ luật CTA với các build có sẵn.
        targetClickCode: targetClickCode,
        setMraidTag: setMraidTag,
        configureGoogleExitApi: configureGoogleExitApi,
        escapeJsString: escapeJsString,
        stripServingLayers: stripServingLayers,
        convert: convert,
        convertAll: convertAll,
        validate: validate,
        networkFromFilename: networkFromFilename,
        detectSuperHtmlVersion: detectSuperHtmlVersion,
        readSayGamesStageQueue: readSayGamesStageQueue,
        findCocosGameManagers: findCocosGameManagers,
        crc32: crc32,
        dosDateTime: dosDateTime,
        utf8Bytes: utf8Bytes,
        assembleZip: assembleZip
    };
});
