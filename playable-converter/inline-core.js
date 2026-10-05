/*
 * inline-core.js — nhúng tham chiếu từ xa vào playable HTML (logic thuần, không DOM).
 * ----------------------------------------------------------------------------------
 * UMD, zero-dependency → chạy cả browser (app.js) lẫn Node (tests).
 * Global: window.InlineCore   |   Node: require("./inline-core")
 *
 * VÌ SAO CẦN: file tải từ SocialPeta thường chỉ là cái vỏ vài KB — toàn bộ game nằm sau
 * <script src> trên CDN, đôi khi sau cả <iframe>. detectBuild() không có gì để đọc nên trả
 * "unknown" với MỌI kiểu build, kể cả build Luna/SayGames mà converter vốn đã hỗ trợ.
 * Nhúng xong thì 7 kiểu build hiện có nhận ra ngay, không phải sửa dòng nào trong chúng.
 *
 * KHÔNG TỰ GỌI MẠNG: caller truyền options.fetchText(url) vào. Browser đưa fetch() thật,
 * test đưa bảng tra — cùng một logic, không cần mock mạng.
 *
 * BASE URL LÀ CỦA TÀI LIỆU CHỨA THAM CHIẾU, không phải của file người dùng thả vào.
 * Trong iframe lồng nhau, file con nằm trên CDN nên "js/web-audio-check.js" của nó phải
 * resolve theo URL CDN đó. Sai chỗ này là hỏng toàn bộ nhánh iframe.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.InlineCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // KHÔNG BỎ GÌ Ở BƯỚC NÀY. Việc của bước nhúng là làm file ĐỦ để đọc được, không phải
    // dọn dẹp — dọn là việc của convert(). Bỏ SDK ở đây gây hai hỏng hóc đã đo được:
    //   1. detectNetwork() nhận mạng nguồn qua chính dấu vết SDK (window.install, dapi…);
    //      bỏ đi là xoá luôn bằng chứng.
    //   2. Lớp vỏ và game trong iframe bắt tay nhau qua script cầu nối (PlProtocol.js của
    //      Mintegral); bỏ nó thì game load xong mà màn "Loading Playable Ads" không bao giờ tắt.

    // Thẻ mà bước convert xử lý bằng CHÍNH chuỗi <script src>: configureGoogleExitApi() và
    // removeForeignNetworkSdks() tìm theo URL. Nhúng vào là làm hai hàm đó mất mục tiêu.
    //
    // rayjump.com/hyplug (PlProtocol.js — cầu SDK Mintegral) nằm ở đây vì hai lý do cùng chiều:
    // host này KHÔNG trả Access-Control-Allow-Origin nên trình duyệt không đọc nổi nội dung, mà
    // convert cho mạng khác Mintegral thì cũng gỡ hẳn thẻ đó. Không tải thứ sắp bị xoá.
    var CONVERTER_HANDLED = /pangle|pangolin|byteoversea|vungle|\bdapi\.js|fbplayablead|googlesyndication\.com\/pagead\/gadgets\/html5\/api\/exitapi|rayjump\.com\/hyplug\//i;

    // Thẻ do chính mạng đầu ra chèn lúc serve — không bao giờ nhúng.
    var KEEP_RAW = /^(?:\.\/)?mraid\.js(?:\?.*)?$/i;

    // Thư viện debug hay sót lại trong build; vẫn nhúng cho file self-contained, chỉ nhắc.
    var DEV_URL = /mrdoob\.github\.io|\bstats(?:\.min)?\.js\b|\beruda\b|\bvconsole\b/i;

    // Chữ ký SDK mạng trong NỘI DUNG file (URL là hash nên không đoán được từ tên).
    var AD_SDK_CODE = /MtgDispatch|window\.install\s*=|\bmraid\.open\s*\(|\bExitApi\b|\bFbPlayableAd\b|\bopenAppStore\s*=|\bdapi\.(?:isReady|open)/;

    // `\ssrc` chứ không `\bsrc`: `\b` khớp cả data-src="…" (gạch nối là ranh giới từ) nên một thẻ
    // đã nhúng sẽ bị tưởng là còn trỏ ra ngoài. Thuộc tính thật luôn có khoảng trắng đứng trước.
    var SCRIPT_TAG = /<script\b([^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*)>\s*<\/script>/gi;
    var IFRAME_TAG = /<iframe\b([^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*)>/gi;
    var LINK_TAG = /<link\b([^>]*\shref\s*=\s*["']([^"']+)["'][^>]*)>/gi;

    // ───────────────────────── phân loại ─────────────────────────

    function resolveUrl(raw, baseUrl) {
        var url = String(raw || "").trim();
        if (!url || /^(?:data|blob|javascript|about):/i.test(url)) return null;
        if (/^\/\//.test(url)) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        if (!baseUrl) return null;
        try {
            return new URL(url, baseUrl).href;
        } catch (e) {
            return null;
        }
    }

    // action: "inline" | "keep" | "skip"
    //   keep = cố ý giữ nguyên thẻ (mraid.js, hoặc SDK mà convert() sẽ tự xử lý)
    //   skip = không resolve được (tương đối mà không biết base) → giữ nguyên + cảnh báo
    function classify(raw, baseUrl) {
        if (KEEP_RAW.test(String(raw || "").trim())) return { action: "keep", reason: "thẻ mraid.js do mạng chèn lúc serve" };
        var url = resolveUrl(raw, baseUrl);
        if (!url) {
            if (/^(?:data|blob|javascript|about):/i.test(String(raw || "").trim())) return { action: "keep", reason: "không phải tham chiếu từ xa" };
            return { action: "skip", reason: "đường dẫn tương đối nhưng không biết base URL" };
        }
        if (CONVERTER_HANDLED.test(url)) return { action: "keep", url: url, reason: "SDK mạng — để bước convert xử lý theo thẻ src" };
        return { action: "inline", url: url, reason: DEV_URL.test(url) ? "thư viện debug" : "" };
    }

    function looksLikeAdSdk(code) {
        return AD_SDK_CODE.test(String(code || ""));
    }

    // ───────────────────────── quét ─────────────────────────

    function collect(html, regex, kind, attrIndex, urlIndex, baseUrl, refs) {
        var match;
        regex.lastIndex = 0;
        while ((match = regex.exec(html))) {
            var attrs = match[attrIndex];
            var raw = match[urlIndex];
            if (kind === "style" && !/\brel\s*=\s*["']?stylesheet/i.test(attrs)) continue;
            var verdict = classify(raw, baseUrl);
            refs.push({
                kind: kind,
                raw: raw,
                url: verdict.url || "",
                action: verdict.action,
                reason: verdict.reason,
                tag: match[0]
            });
        }
    }

    /* Vỏ tải từ SocialPeta không mang theo URL gốc, nên đường dẫn tương đối trong đó
     * (`js/web-audio-check.js` của template Cocos là ví dụ thật) không resolve được và nằm lại
     * thành thẻ 404. Suy ra base từ chính các tham chiếu TUYỆT ĐỐI trong cùng tài liệu: một
     * creative luôn nằm gọn trong một thư mục trên CDN.
     *
     * Đòi ít nhất 2 tham chiếu cùng thư mục thì mới dám suy — một link lạ đơn độc (ảnh tracking,
     * CDN thư viện) không đủ để đoán nơi file gốc nằm.
     */
    function inferBaseUrl(html) {
        var dirs = {}, best = "", bestCount = 0, match;
        var regex = /\s(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
        while ((match = regex.exec(html))) {
            var dir;
            try { dir = new URL(".", match[1]).href; } catch (e) { continue; }
            dirs[dir] = (dirs[dir] || 0) + 1;
            if (dirs[dir] > bestCount) { bestCount = dirs[dir]; best = dir; }
        }
        return bestCount >= 2 ? best : "";
    }

    // Danh sách tham chiếu từ xa trong 1 tài liệu (không đệ quy vào iframe).
    function scan(html, baseUrl) {
        var refs = [];
        collect(html, SCRIPT_TAG, "script", 1, 2, baseUrl, refs);
        collect(html, IFRAME_TAG, "iframe", 1, 2, baseUrl, refs);
        collect(html, LINK_TAG, "style", 1, 2, baseUrl, refs);
        return refs;
    }

    // Cho UI: có gì để nhúng không? (rẻ hơn scan đầy đủ khi chỉ cần bật/tắt nút)
    // Tính cả playable trong #ad-context: vỏ AppLovin có thể không còn thẻ src nào sống.
    function countPending(html, baseUrl) {
        var tags = scan(html, baseUrl || inferBaseUrl(html)).filter(function (ref) {
            return ref.action === "inline";
        }).length;
        var context = readAdContext(html);
        return tags + (context && context.playableUrl ? 1 : 0);
    }

    /* AppLovin VIDEO_PLAYABLE_ENDCARD_V1: playable THẬT không nằm ở thẻ <script src> nào —
     * nó là một URL trong JSON #ad-context, tải về ở dạng JSONP `al_renderHtml({"html":"…"})`
     * với toàn bộ HTML playable làm chuỗi JSON. Các thẻ <script src> trong vỏ chỉ là code
     * template của AppLovin, và thường đã 404 khi creative hết hạn — quét thẻ thì chỉ ra lỗi.
     */
    function readAdContext(html) {
        var match = html.match(/<script\b[^>]*\bid\s*=\s*["']ad-context["'][^>]*>([\s\S]*?)<\/script>/i);
        if (!match) return null;
        try {
            var data = JSON.parse(match[1]);
            return {
                template: data.ad && data.ad.template ? String(data.ad.template) : "",
                playableUrl: data.playable && data.playable.url ? String(data.playable.url) : "",
                videoUrl: data.video && data.video.url ? String(data.video.url) : "",
                redirectUrl: data.open && data.open.redirectUrl ? String(data.open.redirectUrl) : ""
            };
        } catch (e) {
            return null;
        }
    }

    function blankAdContextUrl(html) {
        return html.replace(/(<script\b[^>]*\bid\s*=\s*["']ad-context["'][^>]*>)([\s\S]*?)(<\/script>)/i, function (all, open, body, close) {
            try {
                var data = JSON.parse(body);
                if (!data.playable) return all;
                data.playable.url = "";
                return open + JSON.stringify(data, null, 4) + close;
            } catch (e) {
                return all;
            }
        });
    }

    /* Phải dùng HÀM thay thế, không dùng chuỗi: content ở đây là cả payload playable, mà trong JS
     * thật có đầy `$&`, `` $` `` và `$'` (bản Race Master: 157 lần `` $` ``, 140 lần `$'`).
     * String.replace coi chúng là ký hiệu — `$'` chèn lại toàn bộ phần đuôi chuỗi đích, làm file
     * 3,8 MB phồng thành 164 MB. Hàm thay thế không diễn giải ký hiệu nào.
     */
    function insertBeforeBodyEnd(html, content) {
        return /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, function () { return content + "\n</body>"; })
            : html + "\n" + content;
    }

    // `al_renderHtml({"html":"…"})` → trả về chuỗi HTML bên trong.
    function unwrapRenderedHtml(text) {
        var match = String(text).match(/^\s*al_renderHtml\(([\s\S]*)\)\s*;?\s*$/);
        if (!match) return null;
        try {
            var data = JSON.parse(match[1]);
            return typeof data.html === "string" ? data.html : null;
        } catch (e) {
            return null;
        }
    }

    // Tham chiếu từ xa còn sót ở các thẻ module này CHƯA xử lý (img/audio/video/source).
    // Không nhúng, chỉ báo để người dùng biết file có thể chưa thật sự self-contained.
    function scanRemaining(html) {
        var out = [], seen = {}, match;
        var regex = /<(img|audio|video|source|embed)\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
        while ((match = regex.exec(html))) {
            if (seen[match[2]]) continue;
            seen[match[2]] = true;
            out.push({ kind: match[1].toLowerCase(), url: match[2] });
        }
        return out;
    }

    // ───────────────────────── ghi ─────────────────────────

    // "</script" trong JS chỉ hợp lệ bên trong chuỗi/regex/comment, nên thay thành "<\/script"
    // là an toàn — và bắt buộc, nếu không trình duyệt đóng thẻ sớm giữa chừng.
    function escapeScriptBody(code) {
        return String(code).replace(/<\/(script)/gi, "<\\/$1");
    }

    function escapeAttr(value) {
        return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }

    // Giữ nguyên các thuộc tính khác của thẻ (type, id, class…), chỉ gỡ src ra.
    function stripSrcAttr(attrs) {
        return attrs.replace(/\ssrc\s*=\s*["'][^"']*["']/i, "").trim();
    }

    function buildScriptTag(ref, code) {
        var attrs = stripSrcAttr(" " + ref.tag.replace(/^<script\b/i, "").replace(/>\s*<\/script>$/i, ""));
        var extra = attrs ? " " + attrs : "";
        return '<script data-inlined-from="' + escapeAttr(ref.url) + '"' + extra + ">\n" + escapeScriptBody(code) + "\n</script>";
    }

    function buildStyleTag(ref, css) {
        return '<style data-inlined-from="' + escapeAttr(ref.url) + '">\n' + String(css).replace(/<\/(style)/gi, "<\\/$1") + "\n</style>";
    }

    // srcdoc thay vì data:text/html — srcdoc giữ iframe CÙNG ORIGIN với trang cha nên
    // window.parent / postMessage giữa lớp ngoài và game vẫn chạy; data: biến nó thành
    // origin mờ và cắt đứt cầu nối đó.
    function buildIframeTag(ref, childHtml) {
        var attrs = stripSrcAttr(ref.tag.replace(/^<iframe\b/i, "").replace(/>$/, ""));
        var extra = attrs ? " " + attrs : "";
        return "<iframe" + extra + ' data-inlined-from="' + escapeAttr(ref.url) + '" srcdoc="' + escapeAttr(childHtml) + '">';
    }

    // ───────────────────────── nhúng ─────────────────────────

    function reportOf() {
        return { inlined: 0, kept: 0, skipped: 0, failed: 0, bytes: 0 };
    }

    /*
     * inline(html, options) → Promise<{ html, refs, stats, warnings, errors, remaining }>
     *
     * options:
     *   fetchText(url)  bắt buộc — trả Promise<string>; ném lỗi thì thẻ được giữ nguyên
     *   baseUrl         URL gốc của tài liệu (để resolve đường dẫn tương đối)
     *   maxDepth        số lớp iframe tối đa, mặc định 3
     *   onProgress(p)   p = { done, total, url }
     */
    function inline(html, options) {
        options = options || {};
        var fetchText = options.fetchText;
        if (typeof fetchText !== "function") return Promise.reject(new Error("inline(): thiếu options.fetchText"));

        var maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : 3;
        var stats = reportOf();
        var warnings = [];
        var errors = [];
        var allRefs = [];
        var documents = [];
        var done = 0;

        function progress(url) {
            done++;
            if (typeof options.onProgress === "function") options.onProgress({ done: done, url: url });
        }

        function processDoc(doc, baseUrl, depth) {
            var refs = scan(doc, baseUrl);
            refs.forEach(function (ref) { allRefs.push(ref); });

            // defer/async trên thẻ có src: nhúng vào sẽ chạy ngay thay vì chạy sau khi parse xong,
            // đổi thứ tự thực thi. Không tự sửa — chỉ báo để người dùng kiểm.
            refs.forEach(function (ref) {
                if (ref.kind === "script" && ref.action === "inline" && /\b(?:defer|async)\b/i.test(ref.tag)) {
                    warnings.push("Script có defer/async bị nhúng thành inline nên chạy sớm hơn: " + (ref.url || ref.raw));
                }
            });

            var jobs = refs.map(function (ref) {
                if (ref.action === "keep") {
                    stats.kept++;
                    if (ref.url) warnings.push("Giữ nguyên thẻ " + ref.reason + ": " + ref.url);
                    return Promise.resolve(null);
                }
                if (ref.action === "skip") {
                    stats.skipped++;
                    warnings.push("Không resolve được đường dẫn tương đối: " + ref.raw + (baseUrl ? "" : " (thả file kèm base URL để xử lý)"));
                    return Promise.resolve(null);
                }
                if (ref.kind === "iframe" && depth >= maxDepth) {
                    stats.skipped++;
                    warnings.push("Vượt quá " + maxDepth + " lớp iframe, dừng ở: " + ref.url);
                    return Promise.resolve(null);
                }
                return fetchText(ref.url).then(function (text) {
                    progress(ref.url);
                    stats.bytes += text.length;
                    if (ref.kind === "script") {
                        stats.inlined++;
                        if (looksLikeAdSdk(text)) warnings.push("Script vừa nhúng trông như SDK mạng, nên kiểm trước khi convert: " + ref.url);
                        if (ref.reason) warnings.push("Nhúng " + ref.reason + ": " + ref.url);
                        return { ref: ref, replacement: buildScriptTag(ref, text) };
                    }
                    if (ref.kind === "style") {
                        stats.inlined++;
                        if (/url\(\s*['"]?(?!data:|https?:|#)/i.test(text)) warnings.push("CSS vừa nhúng có url() tương đối, có thể gãy: " + ref.url);
                        return { ref: ref, replacement: buildStyleTag(ref, text) };
                    }
                    // iframe: nhúng xong phần của tài liệu con rồi mới gắn vào cha.
                    return processDoc(text, ref.url, depth + 1).then(function (childHtml) {
                        stats.inlined++;
                        // Giữ riêng tài liệu con ở dạng HTML THẬT. Trong srcdoc nó bị HTML-escape
                        // (" thành &quot;) nên mọi regex của convert() — replaceStoreUrls,
                        // removeLunaMintegralHooks… — đều trượt: file trông như đã convert mà
                        // code game không hề bị sửa. Ai cần sửa code thì phải lấy bản này.
                        documents.push({ url: ref.url, html: childHtml, label: "tài liệu trong iframe" });
                        return { ref: ref, replacement: buildIframeTag(ref, childHtml) };
                    });
                }, function (error) {
                    progress(ref.url);
                    stats.failed++;
                    errors.push("Không tải được " + ref.url + ": " + (error && error.message ? error.message : error));
                    return null;
                });
            });

            return Promise.all(jobs).then(function (results) {
                var out = doc;
                results.forEach(function (item) {
                    if (!item) return;
                    // Thay theo chuỗi thẻ gốc: mỗi thẻ có src riêng nên không đụng nhau.
                    // Dùng split/join để tránh $& $1 trong nội dung bị replace() hiểu thành ký hiệu.
                    out = out.split(item.ref.tag).join(item.replacement);
                });
                return out;
            });
        }

        // Vỏ AppLovin: đi lấy playable trong #ad-context, vì không thẻ nào trỏ tới nó.
        function pullAdContextPlayable(out) {
            var context = readAdContext(html);
            if (!context || !context.playableUrl) return Promise.resolve(out);
            return fetchText(context.playableUrl).then(function (text) {
                progress(context.playableUrl);
                var inner = unwrapRenderedHtml(text);
                if (!inner && /^\s*<(?:!doctype|html)\b/i.test(text)) inner = text;
                if (!inner) {
                    warnings.push("Không bóc được playable trong #ad-context (không phải al_renderHtml cũng không phải HTML): " + context.playableUrl);
                    return out;
                }
                stats.bytes += inner.length;
                stats.inlined++;
                documents.push({ url: context.playableUrl, html: inner, label: "playable trong #ad-context" });
                // Nhúng luôn vào vỏ: thay lời gọi động bằng script tĩnh rồi xoá URL khỏi JSON —
                // đúng việc mà shim của SocialPeta vẫn làm — để vỏ tự chạy được và không tải lại.
                out = blankAdContextUrl(out);
                out = insertBeforeBodyEnd(out, '<script data-inlined-from="' + escapeAttr(context.playableUrl) + '">\n' + escapeScriptBody(text) + "\n</script>");
                warnings.push("Playable thật nằm trong JSON #ad-context" + (context.template ? " (AppLovin " + context.template + ")" : "") + ", không ở thẻ script nào. Dùng nó làm file chính để convert.");
                if (context.redirectUrl) warnings.push("Link store hiện tại trong vỏ: " + context.redirectUrl);
                return out;
            }, function (error) {
                stats.failed++;
                errors.push("Không tải được playable trong #ad-context " + context.playableUrl + ": " + (error && error.message ? error.message : error));
                return out;
            });
        }

        var rootBase = options.baseUrl || inferBaseUrl(html);
        if (!options.baseUrl && rootBase) warnings.push("Không biết URL gốc của file nên suy base từ các tham chiếu tuyệt đối trong đó: " + rootBase);

        return processDoc(html, rootBase, 0).then(pullAdContextPlayable).then(function (out) {
            if (documents.some(function (doc) { return doc.label === "tài liệu trong iframe"; })) {
                warnings.push("Game nằm trong iframe: code trong srcdoc đã bị HTML-escape nên convert() sẽ không sửa được. Dùng tài liệu con làm file chính nếu cần convert.");
            }
            return {
                html: out,
                refs: allRefs,
                documents: documents,
                stats: stats,
                warnings: warnings,
                errors: errors,
                remaining: scanRemaining(out)
            };
        });
    }

    return {
        scan: scan,
        scanRemaining: scanRemaining,
        countPending: countPending,
        readAdContext: readAdContext,
        unwrapRenderedHtml: unwrapRenderedHtml,
        classify: classify,
        resolveUrl: resolveUrl,
        looksLikeAdSdk: looksLikeAdSdk,
        inline: inline
    };
});
