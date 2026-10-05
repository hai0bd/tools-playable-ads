"use strict";

// Nhúng tham chiếu từ xa: file tải từ SocialPeta thường chỉ là vỏ vài KB, game nằm sau
// <script src> trên CDN và đôi khi sau cả <iframe>. Không có mạng trong test — fetchText
// là bảng tra, đúng thứ app.js sẽ đưa fetch() thật vào.
var assert = require("assert");
var core = require("../inline-core");

var CDN = "https://sp2cdn-idea-global.zingfront.com/sp_opera/";

// Bảng tra đóng vai CDN. Khoá là URL tuyệt đối đã resolve.
var FILES = {};
FILES[CDN + "engine.js"] = "window.PIXI = {};";
FILES[CDN + "game.js"] = "var ps = {}; ps.boot = function () { return '</script>'; };";
FILES[CDN + "style.css"] = "body { margin: 0 }";
FILES[CDN + "frame.html"] = [
    "<html><body>",
    '<script src="js/audio-check.js"></script>',
    '<script src="https://play.rayjump.com/hyplug/PlProtocol.js"></script>',
    '<script src="' + CDN + 'luna.js"></script>',
    "</body></html>"
].join("\n");
FILES[CDN + "js/audio-check.js"] = "window.audioOK = true;";
// Cầu nối giữa lớp vỏ và game trong iframe — bỏ nó thì game load xong mà loading không tắt.
FILES["https://play.rayjump.com/hyplug/PlProtocol.js"] = "window.PlProtocol = { ready: function () {} };";
FILES[CDN + "luna.js"] = "var LunaCompilerV = '1.2.3';";
FILES[CDN + "sdk.js"] = "var OMG=OMG||{}; window.install = function () {}; function MtgDispatch() {}";

function fetchText(url) {
    return Object.prototype.hasOwnProperty.call(FILES, url)
        ? Promise.resolve(FILES[url])
        : Promise.reject(new Error("404"));
}

// ── 1. resolveUrl: tuyệt đối, protocol-relative, tương đối theo base ──
assert.strictEqual(core.resolveUrl("https://a.com/x.js"), "https://a.com/x.js");
assert.strictEqual(core.resolveUrl("//a.com/x.js"), "https://a.com/x.js");
assert.strictEqual(core.resolveUrl("js/x.js", CDN + "frame.html"), CDN + "js/x.js", "resolve theo base của TÀI LIỆU CHỨA nó");
assert.strictEqual(core.resolveUrl("js/x.js"), null, "không có base → không đoán bừa");
assert.strictEqual(core.resolveUrl("data:image/png;base64,AAA"), null);

// ── 2. classify: bước nhúng KHÔNG bỏ gì; chỉ giữ nguyên thẻ mà convert() sẽ tự xử lý ──
// PlProtocol.js: GIỮ NGUYÊN THẺ, không nhúng mà cũng không xoá. Host chặn CORS nên không đọc nổi
// nội dung; xoá thẻ thì lớp vỏ Mintegral treo ở màn "Loading Playable Ads" vì mất cầu báo ready.
// Việc bỏ nó là của convert(), và chỉ khi mạng đích khác Mintegral.
assert.strictEqual(core.classify("https://play.rayjump.com/hyplug/PlProtocol.js").action, "keep", "không tải thứ mà convert sẽ xoá, và host này chặn CORS");
assert.strictEqual(core.classify("https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js").action, "keep", "configureGoogleExitApi() tìm theo thẻ src");
assert.strictEqual(core.classify("https://sf16-fe.byteoversea.com/pangle/sdk.js").action, "keep", "removeForeignNetworkSdks() tìm theo thẻ src");
assert.strictEqual(core.classify("https://x.com/dapi.js").action, "keep");
assert.strictEqual(core.classify("mraid.js").action, "keep", "mraid.js do mạng chèn lúc serve");
assert.strictEqual(core.classify("js/x.js").action, "skip");
assert.strictEqual(core.classify(CDN + "engine.js").action, "inline");
assert.strictEqual(core.classify("https://mrdoob.github.io/stats.js/build/stats.min.js").reason, "thư viện debug", "vẫn nhúng, chỉ nhắc");

// ── 3. scan + countPending trên cái vỏ kiểu SocialPeta ──
var SHELL = [
    "<html><head>",
    '<link rel="stylesheet" href="' + CDN + 'style.css">',
    '<link rel="icon" href="data:image/png;base64,AAA">',
    "</head><body>",
    '<script src="mraid.js"></script>',
    '<script src="' + CDN + 'engine.js"></script>',
    '<script src="' + CDN + 'game.js"></script>',
    '<script src="' + CDN + 'sdk.js"></script>',
    "<script>var inlineAlready = 1;</script>",
    "</body></html>"
].join("\n");

var refs = core.scan(SHELL);
assert.strictEqual(refs.filter(function (r) { return r.kind === "script"; }).length, 4, "4 thẻ script có src");
assert.strictEqual(refs.filter(function (r) { return r.kind === "style"; }).length, 1, "chỉ link rel=stylesheet, bỏ qua favicon");
assert.strictEqual(core.countPending(SHELL), 4, "mraid.js không tính vào việc cần làm");

// ── 4. looksLikeAdSdk: URL là hash nên phải nhận qua nội dung ──
assert.strictEqual(core.looksLikeAdSdk(FILES[CDN + "sdk.js"]), true);
assert.strictEqual(core.looksLikeAdSdk(FILES[CDN + "engine.js"]), false);

// ── 5. inline() phải có fetchText ──
assert.rejects(function () { return core.inline(SHELL, {}); }, /thiếu options.fetchText/);

(async function () {
    // ── 6. nhúng cái vỏ: script + css vào file, mraid giữ nguyên ──
    var out = await core.inline(SHELL, { fetchText: fetchText });
    assert.strictEqual(out.stats.inlined, 4, "3 script + 1 css");
    assert.strictEqual(out.stats.kept, 1, "mraid.js");
    assert.strictEqual(out.stats.failed, 0);
    assert.strictEqual(out.errors.length, 0);
    assert.ok(out.html.indexOf("window.PIXI = {}") >= 0, "code engine đã vào file");
    assert.ok(out.html.indexOf("body { margin: 0 }") >= 0, "css đã vào file");
    assert.ok(/<script src="mraid\.js"><\/script>/.test(out.html), "mraid.js còn nguyên thẻ src");
    assert.strictEqual(core.countPending(out.html), 0, "không còn gì để nhúng");

    // "</script>" trong code phải được escape, nếu không trình duyệt đóng thẻ sớm.
    assert.ok(out.html.indexOf("'<\\/script>'") >= 0, "</script> trong JS đã escape");
    assert.ok(out.html.indexOf("return '</script>'") < 0, "không để lọt </script> thô");

    // Nhúng phải giữ được dấu vết nguồn để người dùng đối chiếu.
    assert.ok(out.html.indexOf('data-inlined-from="' + CDN + 'engine.js"') >= 0);

    // sdk.js trông như SDK mạng → cảnh báo chứ không tự bỏ (URL là hash, không dám chắc).
    assert.ok(out.warnings.some(function (w) { return /SDK mạng/.test(w) && /sdk\.js/.test(w); }), "có cảnh báo SDK");

    // ── 7. detectBuild chỉ đọc được SAU khi nhúng ──
    var converter = require("../converter-core");
    assert.strictEqual(converter.analyze(SHELL, "x.html").build, "unknown", "cái vỏ thì không đoán được gì");

    // ── 8. iframe: đệ quy, resolve tương đối theo base của tài liệu CON ──
    var FRAMED = [
        "<html><body>",
        '<script src="' + CDN + 'sdk.js"></script>',
        '<iframe id="MW_PLFRAME" src="' + CDN + 'frame.html" frameborder="0" width="100%"></iframe>',
        "</body></html>"
    ].join("\n");

    var framed = await core.inline(FRAMED, { fetchText: fetchText });
    assert.strictEqual(framed.stats.failed, 0);
    assert.strictEqual(framed.stats.inlined, 4, "2 ở cha + 2 trong iframe; PlProtocol giữ nguyên thẻ");
    assert.strictEqual(framed.stats.failed, 0, "không thử tải PlProtocol nên không có lỗi CORS giả");
    // Thẻ nằm trong tài liệu con, mà trong srcdoc thì dấu nháy đã bị escape — kiểm ở bản chưa escape.
    assert.ok(/<script src="https:\/\/play\.rayjump\.com\/hyplug\/PlProtocol\.js"><\/script>/.test(framed.documents[0].html), "thẻ PlProtocol còn nguyên — xoá là lớp vỏ treo ở màn loading");
    assert.ok(framed.html.indexOf("play.rayjump.com/hyplug/PlProtocol.js") >= 0, "và nó cũng còn trong srcdoc của cha");
    assert.ok(framed.html.indexOf("srcdoc=") >= 0, "iframe chuyển sang srcdoc");
    assert.ok(framed.html.indexOf("src=\"" + CDN + "frame.html\"") < 0, "src cũ đã gỡ");
    assert.ok(framed.html.indexOf('id="MW_PLFRAME"') >= 0, "giữ các thuộc tính khác của iframe");
    assert.ok(framed.html.indexOf('frameborder="0"') >= 0);

    // Nội dung file con nằm trong srcdoc, đã escape dấu nháy kép.
    assert.ok(framed.html.indexOf("window.audioOK = true;") >= 0, "đường dẫn tương đối js/audio-check.js resolve đúng");
    assert.ok(framed.html.indexOf("LunaCompilerV") >= 0, "script của file con đã nhúng");
    assert.ok(framed.html.indexOf('&quot;') >= 0, "dấu nháy kép trong srcdoc đã escape");

    // Chính vì srcdoc bị escape mà regex của convert() trượt hết — phải trả tài liệu con
    // ở dạng HTML thật để ai cần convert thì lấy bản đó làm file chính.
    assert.strictEqual(framed.documents.length, 1, "trả về tài liệu con của iframe");
    assert.strictEqual(framed.documents[0].url, CDN + "frame.html");
    assert.ok(framed.documents[0].html.indexOf("&quot;") < 0, "tài liệu con KHÔNG bị escape");
    assert.ok(framed.documents[0].html.indexOf("window.audioOK = true;") >= 0, "tài liệu con đã nhúng xong phần của nó");
    assert.ok(framed.warnings.some(function (w) { return /HTML-escape/.test(w); }), "phải cảnh báo convert() không sửa được code trong srcdoc");
    assert.strictEqual(out.documents.length, 0, "không có iframe thì không có tài liệu con");

    // ── 9. fetch hỏng (CDN hết hạn) → giữ nguyên thẻ, báo lỗi, không nuốt ──
    var BROKEN = '<html><body><script src="' + CDN + 'mat-tieu.js"></script></body></html>';
    var broken = await core.inline(BROKEN, { fetchText: fetchText });
    assert.strictEqual(broken.stats.failed, 1);
    assert.strictEqual(broken.errors.length, 1);
    assert.ok(/mat-tieu\.js/.test(broken.errors[0]));
    assert.ok(broken.html.indexOf('src="' + CDN + 'mat-tieu.js"') >= 0, "thẻ hỏng phải giữ nguyên để người dùng thấy");

    // ── 10. defer/async: nhúng đổi thứ tự chạy → phải cảnh báo ──
    var DEFERRED = '<html><body><script defer src="' + CDN + 'engine.js"></script></body></html>';
    var deferred = await core.inline(DEFERRED, { fetchText: fetchText });
    assert.ok(deferred.warnings.some(function (w) { return /defer\/async/.test(w); }));

    // ── 11. remaining: ảnh/audio từ xa chưa xử lý thì phải báo, đừng để tưởng đã xong ──
    var WITHIMG = '<html><body><img src="https://cdn.example.com/a.png"><script src="' + CDN + 'engine.js"></script></body></html>';
    var withImg = await core.inline(WITHIMG, { fetchText: fetchText });
    assert.strictEqual(withImg.remaining.length, 1);
    assert.strictEqual(withImg.remaining[0].kind, "img");

    // ── 12. Vỏ AppLovin: playable là URL trong JSON #ad-context, không ở thẻ script nào ──
    // Thẻ <script src> trong vỏ là code template của AppLovin và thường đã 404 khi creative hết hạn.
    var PLAYABLE_HTML = "<!DOCTYPE html><html><head><title>Cocos Creator | X</title></head><body>super_load();</body></html>";
    FILES[CDN + "playable.js"] = "al_renderHtml(" + JSON.stringify({ html: PLAYABLE_HTML }) + ");";

    var AL_SHELL = [
        "<html><body>",
        '<script type="application/json" id="ad-context">' + JSON.stringify({
            ad: { template: "VIDEO_PLAYABLE_ENDCARD_V1" },
            open: { redirectUrl: "https://play.google.com/store/apps/details?id=com.old.game" },
            video: { url: "https://res1.applovin.com/x.webm" },
            playable: { url: CDN + "playable.js" }
        }) + "</script>",
        '<script src="' + CDN + 'da-chet.js"></script>',
        "</body></html>"
    ].join("\n");

    var context = core.readAdContext(AL_SHELL);
    assert.strictEqual(context.playableUrl, CDN + "playable.js");
    assert.strictEqual(context.template, "VIDEO_PLAYABLE_ENDCARD_V1");
    assert.ok(/com\.old\.game/.test(context.redirectUrl), "đọc được link store cũ trong vỏ");
    assert.strictEqual(core.unwrapRenderedHtml(FILES[CDN + "playable.js"]), PLAYABLE_HTML);
    assert.strictEqual(core.unwrapRenderedHtml("var a = 1;"), null, "không phải JSONP thì trả null");
    assert.strictEqual(core.countPending(AL_SHELL), 2, "1 thẻ script + 1 playable trong ad-context");

    var al = await core.inline(AL_SHELL, { fetchText: fetchText });
    assert.strictEqual(al.stats.failed, 1, "thẻ template không tồn tại trong bảng tra");
    assert.strictEqual(al.documents.length, 1, "vẫn lấy được playable dù thẻ script hỏng");

    // Vỏ phải tự chạy được sau khi nhúng, và không mời nhúng lại lần nữa.
    assert.ok(al.html.indexOf("al_renderHtml(") >= 0, "JSONP đã thành script tĩnh trong vỏ");
    assert.ok(/"url":\s*""/.test(al.html), "playable.url trong JSON đã bị xoá");
    assert.strictEqual(core.countPending(al.html), 1, "chỉ còn đúng thẻ template hỏng, ad-context đã xong");
    assert.strictEqual(al.documents[0].label, "playable trong #ad-context");
    assert.strictEqual(al.documents[0].html, PLAYABLE_HTML);
    assert.ok(al.warnings.some(function (w) { return /com\.old\.game/.test(w); }), "báo link store cũ để người dùng biết đang thay gì");
    assert.ok(!al.warnings.some(function (w) { return /srcdoc/.test(w); }), "không có iframe thì đừng cảnh báo srcdoc");

    /* ── 12b. Suy base URL khi thả file vào tool (không ai đưa URL gốc) ──
     * Template Cocos web-mobile có <script src="js/web-audio-check.js"> ngay trong <head>. Không
     * suy được base thì thẻ đó nằm lại và 404 lúc chạy — file trông như đã self-contained.
     */
    FILES[CDN + "js/web-audio-check.js"] = "window.audioChecked = true;";
    var COCOS_SHELL = [
        '<html><head><script src="js/web-audio-check.js"></script></head>',
        '<body mark="mobvista">',
        '<script src="' + CDN + 'engine.js"></script>',
        '<script src="' + CDN + 'game.js"></script>',
        "</body></html>"
    ].join("\n");

    assert.strictEqual(core.resolveUrl("js/web-audio-check.js"), null, "không có base thì chịu");
    assert.strictEqual(core.countPending(COCOS_SHELL), 3, "suy được base nên tính cả đường dẫn tương đối");

    var cocos = await core.inline(COCOS_SHELL, { fetchText: fetchText });
    assert.strictEqual(cocos.stats.inlined, 3, "nhúng cả 3, không bỏ sót thẻ tương đối");
    assert.strictEqual(cocos.stats.skipped, 0);
    assert.ok(cocos.html.indexOf("window.audioChecked") >= 0, "resolve js/… theo thư mục của các thẻ tuyệt đối");
    assert.ok(cocos.warnings.some(function (w) { return /suy base/.test(w); }), "phải nói rõ là đang suy đoán");
    assert.strictEqual(core.countPending(cocos.html), 0);

    // Một link lạ đơn độc thì không đủ để đoán — thà bỏ qua còn hơn tải nhầm chỗ.
    var LONE = '<html><body><img src="https://tracking.example.com/pixel.gif"><script src="js/a.js"></script></body></html>';
    assert.strictEqual(core.countPending(LONE), 0, "1 tham chiếu tuyệt đối thì không suy");

    /* ── 12c. HỒI QUY: $& $` $' trong payload làm String.replace phồng file ──
     * JS thật có đầy các chuỗi đó (bản Race Master: 157 lần `` $` ``, 140 lần $'). Nếu chèn payload
     * bằng chuỗi thay thế thay vì hàm, $' chèn lại toàn bộ phần đuôi chuỗi đích — file 3,8 MB
     * phồng thành 164 MB mà không báo lỗi gì.
     */
    var DOLLAR = "var re = /x/; s.replace(re, \"$&\"); t.replace(re, \"$`\"); u.replace(re, \"$'\"); v.replace(re, \"$1\");";
    FILES[CDN + "dollar.js"] = "al_renderHtml(" + JSON.stringify({ html: "<html><body>" + DOLLAR + "</body></html>" }) + ");";
    var DOLLAR_SHELL = [
        "<html><body>",
        '<script type="application/json" id="ad-context">' + JSON.stringify({
            ad: { template: "VIDEO_PLAYABLE_ENDCARD_V1" },
            playable: { url: CDN + "dollar.js" }
        }) + "</script>",
        "</body></html>"
    ].join("\n");

    var dollar = await core.inline(DOLLAR_SHELL, { fetchText: fetchText });
    // Vỏ gốc + JSONP nhúng vào: chênh lệch phải xấp xỉ độ dài payload, không được gấp bội.
    var payloadLen = FILES[CDN + "dollar.js"].length;
    assert.ok(dollar.html.length < DOLLAR_SHELL.length + payloadLen + 500,
        "payload có $& $` $' không được làm phồng file (thực tế " + dollar.html.length + " ký tự)");
    assert.strictEqual(dollar.html.split("al_renderHtml(").length - 1, 1, "JSONP chỉ xuất hiện đúng một lần");
    // Số lần xuất hiện của từng ký hiệu phải y hệt payload gốc — nhiều hơn là đã bị diễn giải.
    ["$&", "$`", "$'", "$1"].forEach(function (sign) {
        assert.strictEqual(dollar.html.split(sign).length - 1, payloadLen && FILES[CDN + "dollar.js"].split(sign).length - 1,
            "giữ nguyên số lần xuất hiện của " + sign);
    });
    assert.strictEqual(dollar.documents[0].html.indexOf("<html><body>var re"), 0, "tài liệu con vẫn đúng");

    // ── 13. onProgress báo đủ số lần tải ──
    var ticks = [];
    await core.inline(SHELL, { fetchText: fetchText, onProgress: function (p) { ticks.push(p.url); } });
    assert.strictEqual(ticks.length, 4, "4 lần tải thật");

    console.log("inline-core.test.js: OK");
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
