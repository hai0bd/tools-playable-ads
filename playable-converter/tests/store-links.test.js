"use strict";

// Reusing a batch of playables for a cloned game means swapping the store link in every file. A link
// that survives opens the OLD game from the new game's ad, so each leak found on a real build is pinned here.
var assert = require("assert");
var core = require("../converter-core");

var OLD_ANDROID = "https://play.google.com/store/apps/details?id=com.old.game";
var OLD_IOS = "https://apps.apple.com/us/app/old-game/id111";
var NEW = { androidUrl: "https://play.google.com/store/apps/details?id=com.new.game", iosUrl: "https://apps.apple.com/app/id999" };

function staleWarnings(result) { return result.warnings.filter(function (w) { return /link store cũ/.test(w); }); }

assert.deepStrictEqual(
    core.findStoreLinks('a="' + OLD_ANDROID + '";b="https:\\/\\/apps.apple.com\\/app\\/id5";c="market://details?id=x.y";d="https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dz.w%22";e="' + OLD_ANDROID + '"'),
    [OLD_ANDROID, "https://apps.apple.com/app/id5", "market://details?id=x.y", "https://play.google.com/store/apps/details?id=z.w"]
);

// Luna writes packageConfig keys either bare (iosLink:"…") or JSON-quoted ("iosLink": "…").
["iosLink:\"" + OLD_IOS + "\",androidLink:\"" + OLD_ANDROID + "\"", "\"iosLink\": \"" + OLD_IOS + "\",\"androidLink\": \"" + OLD_ANDROID + "\""].forEach(function (config) {
    var luna = "<!doctype html><html><body><script>window.$environment={packageConfig:{" + config + "}};window.Luna = Luna;</script></body></html>";
    var both = core.convert(luna, "luna", "applovin", NEW);
    assert.deepStrictEqual(core.findStoreLinks(both.html).sort(), [NEW.androidUrl, NEW.iosUrl].sort(), "both Luna links replaced: " + config.slice(0, 12));
    assert.strictEqual(staleWarnings(both).length, 0);

    var androidOnly = core.convert(luna, "luna", "applovin", { androidUrl: NEW.androidUrl });
    assert.strictEqual(staleWarnings(androidOnly).length, 1, "the untouched iOS link is reported");
    assert.ok(staleWarnings(androidOnly)[0].indexOf(OLD_IOS) >= 0);

    assert.strictEqual(staleWarnings(core.convert(luna, "luna", "applovin", {})).length, 0, "no new link given, nothing to report");
});

// Super HTML loader config: the adapter falls back to it when one platform is left empty.
var superHtml = '<!doctype html><html><body><script>(function(cfg){})({"version":"1.0","channel":"AppLovin","android":"' + OLD_ANDROID + '","ios":"","scripts":[]});' +
    'window.super_html = { download: function () {} };window.__zip = "UEsDBA";</script></body></html>';
var superBoth = core.convert(superHtml, "super-html", "applovin", NEW);
assert.ok(superBoth.html.indexOf('"android":"' + NEW.androidUrl + '","ios":"' + NEW.iosUrl + '"') >= 0, "loader config carries the new links");
assert.strictEqual(superBoth.html.indexOf("com.old.game"), -1);
assert.strictEqual(staleWarnings(superBoth).length, 0);
var superAndroid = core.convert(superHtml, "super-html", "applovin", { androidUrl: NEW.androidUrl });
assert.ok(superAndroid.html.indexOf('"android":"' + NEW.androidUrl + '","ios":""') >= 0, "an empty field keeps the file's value");

// MW_CONFIG.store_url rides along on builds other than MindWorks (seen on a PlaySmart creative).
var withMwConfig = '<!doctype html><html><body><script>window.MW_CONFIG = {\n  store_url: {\n    ios: "' + OLD_ANDROID + '",\n    android: "' + OLD_ANDROID + '"\n  }\n};</script><script>window.Luna = Luna;</script></body></html>';
var mw = core.convert(withMwConfig, "luna", "google", NEW);
assert.ok(/ios: "https:\/\/apps\.apple\.com\/app\/id999"/.test(mw.html) && /android: "https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.new\.game"/.test(mw.html));
assert.strictEqual(staleWarnings(mw).length, 0);

// Config.linkAndroid / Config.linkiOS (ONESOFT build) are the LIVE CTA slots, and they ride along on a
// file converted under any build type, so they are replaced for every build like MW_CONFIG.store_url.
var withConfigLinks = '<!doctype html><html><body><script>var s=function(){this.linkAndroid="' + OLD_ANDROID + '",this.linkiOS="' + OLD_IOS + '"};window.Luna = Luna;</script></body></html>';
var configLinks = core.convert(withConfigLinks, "luna", "unity", NEW);
assert.ok(configLinks.html.indexOf('this.linkAndroid="' + NEW.androidUrl + '"') >= 0);
assert.ok(configLinks.html.indexOf('this.linkiOS="' + NEW.iosUrl + '"') >= 0);
assert.strictEqual(staleWarnings(configLinks).length, 0);

// OMG.ins_url / OMG.clickUrl are the Zingfront serve-time slots. They sit on the outer shell of a
// MW_PLFRAME creative too, where no build rule used to touch them — the leak reported on a real file.
var omg = 'var OMG = { imp_url: "", ins_url: "' + OLD_IOS + '", clickUrl: "' + OLD_IOS + '", config: "" }';
var serve = core.convert('<!doctype html><html><body><script>' + omg + '</script><script>window.Luna = Luna;</script></body></html>', "luna", "applovin", NEW);
assert.ok(serve.html.indexOf('ins_url: "' + NEW.iosUrl + '"') >= 0, "an App Store slot takes the new iOS link");
assert.ok(serve.html.indexOf('clickUrl: "' + NEW.iosUrl + '"') >= 0);
assert.strictEqual(staleWarnings(serve).length, 0);

// A Play Store value in the same slot takes the Android link instead; an empty slot stays empty
// because the network fills it at serve time.
var serveAndroid = core.convert('<!doctype html><html><body><script>var OMG = { imp_url: "", ins_url: "' + OLD_ANDROID + '", clickUrl: "" }</script><script>window.Luna = Luna;</script></body></html>', "luna", "applovin", NEW);
assert.ok(serveAndroid.html.indexOf('ins_url: "' + NEW.androidUrl + '"') >= 0);
assert.ok(serveAndroid.html.indexOf('clickUrl: ""') >= 0, "an empty serve-time slot is left alone");

// A slot holding a tracking macro or a measurement URL is not a store link: writing one in would
// break click reporting, so only a value that already IS a store link gets replaced.
var macro = core.convert('<!doctype html><html><body><script>var OMG = { ins_url: "{CLICK_URL}", clickUrl: "https://e.axon.ai/1.0/event/gi?clcode=X" }</script><script>window.Luna = Luna;</script></body></html>', "luna", "applovin", NEW);
assert.ok(macro.html.indexOf('ins_url: "{CLICK_URL}"') >= 0 && macro.html.indexOf("clcode=X") >= 0, "non-store values are left alone");

console.log("store link replacement tests passed");
