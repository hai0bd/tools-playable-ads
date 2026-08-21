"use strict";

var assert = require("assert");
var core = require("../converter-core");

var source = [
    "<!doctype html><html><body><script>",
    "function super_log() {}",
    "function super_boot_engine() { window.__bootCount = (window.__bootCount || 0) + 1; }",
    "function super_check_channel(channel) { if (!channel) throw new Error('missing channel'); }",
    "window.gameStart = function () { super_boot_engine(); };",
    "window.gameClose = function () {};",
    "window.super_html = {",
    "  download: function () { window.install && window.install(); },",
    "  game_ready: function () { window.gameReady && window.gameReady(); },",
    "  game_end: function () { window.gameEnd && window.gameEnd(); }",
    "};",
    "window.__zip = 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==';",
    "</script></body></html>"
].join("\n");

var converted = core.convert(source, "super-html", "applovin", {}).html;
assert.ok(converted.indexOf("_pcSuperBoot") >= 0);
assert.ok(converted.indexOf('if (!window.mraid || typeof window.mraid.getState !== "function") return _pcSuperBoot()') >= 0);
assert.strictEqual((converted.match(/window\.super_html\s*=\s*\{/g) || []).length, 1);

var script = converted.match(/<script>([\s\S]*?)<\/script>/i)[1];
var fakeWindow = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    open: function () {}
};
new Function("window", script)(fakeWindow);
fakeWindow.super_html.game_ready();
assert.strictEqual(fakeWindow.__bootCount, 1, "Browser preview without MRAID must boot the engine");

var windowZipVariant = core.convert(source.replace("window.__zip", "window.zip"), "super-html", "applovin", {}).html;
assert.strictEqual((windowZipVariant.match(/window\.super_html\s*=\s*\{/g) || []).length, 1, "window.zip wrapper must also be replaced");
assert.ok(windowZipVariant.indexOf("window.zip = 'UEsFBg") >= 0);

console.log("super-html AppLovin tests passed");
