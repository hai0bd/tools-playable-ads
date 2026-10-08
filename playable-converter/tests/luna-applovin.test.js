"use strict";

var assert = require("assert");
var vm = require("vm");
var core = require("../converter-core");

var source = "<!doctype html><html><body><script>window.Luna = Luna;</script></body></html>";
var mintegral = core.convert(source, "luna", "mintegral", {}).html;
var applovin = core.convert(mintegral, "luna", "applovin", {}).html;

assert.strictEqual(applovin.indexOf('window.gameReady && window.gameReady()'), -1, "Old Mintegral Luna adapter must be removed");
assert.ok(applovin.indexOf('new Event("luna:unsafe:resume")') >= 0);
assert.ok(applovin.indexOf("_pcBindInstall();") >= 0, "Install binding must also run immediately");

var listeners = {};
var context = {
    navigator: { userAgent: "desktop browser" },
    document: { readyState: "complete" },
    Event: function (type) { this.type = type; },
    Luna: { Unity: { Playable: {} } },
    $environment: { packageConfig: { androidLink: "https://example.com/android" } },
    openCount: 0,
    resumeCount: 0,
    startCount: 0,
    addEventListener: function (name, callback) { (listeners[name] || (listeners[name] = [])).push(callback); },
    dispatchEvent: function (event) {
        if (event.type === "luna:unsafe:resume") this.resumeCount++;
        if (event.type === "luna:start") this.startCount++;
        (listeners[event.type] || []).forEach(function (callback) { callback(event); });
    },
    setTimeout: function (callback) { callback(); return 1; },
    clearTimeout: function () {},
    setInterval: setInterval,
    clearInterval: clearInterval,
    open: function () { this.openCount++; }
};
context.window = context;
vm.createContext(context);

var scripts = [], regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi, match;
while ((match = regex.exec(applovin))) scripts.push(match[1]);
scripts.forEach(function (script) { vm.runInContext(script, context); });

assert.ok(context.resumeCount >= 1, "Browser preview without MRAID must resume Luna");
assert.strictEqual(typeof context.Luna.Unity.Playable.InstallFullGame, "function");
context.Luna.Unity.Playable.InstallFullGame();
assert.strictEqual(context.openCount, 1);

var externalMintegral = source.replace("</body>", [
    '<script>window.gameClose=function(){window.dispatchEvent(new Event("luna:pause"))};window.addEventListener("luna:build",function(){Luna.Unity.Playable.InstallFullGame=function(){window.install&&window.install()}});window.addEventListener("luna:ended",function(){window.gameEnd&&window.gameEnd()});</script>',
    '<script>window.addEventListener("luna:build",function(){window.dispatchEvent(new Event("luna:unsafe:pause"));window.dispatchEvent(new Event("luna:start"))});window.addEventListener("luna:started",function(){window.gameReady&&window.gameReady()});window.gameStart=function(){window.dispatchEvent(new Event("luna:unsafe:resume"))};</script>',
    "</body>"
].join(""));
var cleaned = core.convert(externalMintegral, "luna", "applovin", {}).html;
assert.strictEqual(cleaned.indexOf("window.install&&window.install"), -1);
assert.strictEqual(cleaned.indexOf("window.gameReady&&window.gameReady"), -1);
assert.strictEqual(cleaned.indexOf('new Event("luna:unsafe:pause")'), -1, "Mintegral pause gate must be removed");
assert.ok(cleaned.indexOf("removed Luna Mintegral pause gate") >= 0);

var google = core.convert(externalMintegral, "luna", "google", {}).html;
assert.strictEqual(google.indexOf('new Event("luna:unsafe:pause")'), -1);
assert.ok(google.indexOf('new Event("luna:start")') >= 0);
assert.ok(google.indexOf('new Event("luna:unsafe:resume")') >= 0);

var googleListeners = {};
var googleContext = {
    navigator: { userAgent: "desktop browser" },
    document: { readyState: "complete" },
    Event: function (type) { this.type = type; },
    Luna: { Unity: { Playable: {} } },
    $environment: { packageConfig: {} },
    ExitApi: { exits: 0, exit: function () { this.exits++; } },
    startCount: 0,
    resumeCount: 0,
    addEventListener: function (name, callback) { (googleListeners[name] || (googleListeners[name] = [])).push(callback); },
    dispatchEvent: function (event) {
        if (event.type === "luna:start") this.startCount++;
        if (event.type === "luna:unsafe:resume") this.resumeCount++;
        (googleListeners[event.type] || []).forEach(function (callback) { callback(event); });
    },
    setTimeout: function (callback) { callback(); return 1; },
    clearTimeout: function () {},
    setInterval: setInterval,
    clearInterval: clearInterval,
    open: function () {}
};
googleContext.window = googleContext;
vm.createContext(googleContext);
var googleScripts = [];
regex.lastIndex = 0;
while ((match = regex.exec(google))) { if (!/\bsrc\s*=/.test(match[0])) googleScripts.push(match[1]); }
googleScripts.forEach(function (script) { vm.runInContext(script, googleContext); });
googleContext.dispatchEvent(new googleContext.Event("luna:build"));
assert.strictEqual(googleContext.startCount, 1, "Google must start Luna after luna:build");
assert.ok(googleContext.resumeCount >= 1, "Google browser preview must resume Luna");
googleContext.Luna.Unity.Playable.InstallFullGame();
assert.strictEqual(googleContext.ExitApi.exits, 1);

var unity = core.convert(externalMintegral, "luna", "unity", {
    androidUrl: "https://example.com/android",
    iosUrl: "https://example.com/ios"
}).html;
assert.strictEqual(unity.indexOf('new Event("luna:unsafe:pause")'), -1);
var unityListeners = {}, openedUrl = "";
var unityContext = {
    navigator: { userAgent: "android" },
    document: { readyState: "complete" },
    Event: function (type) { this.type = type; },
    Luna: { Unity: { Playable: {} } },
    $environment: { packageConfig: {} },
    startCount: 0,
    resumeCount: 0,
    addEventListener: function (name, callback) { (unityListeners[name] || (unityListeners[name] = [])).push(callback); },
    dispatchEvent: function (event) {
        if (event.type === "luna:start") this.startCount++;
        if (event.type === "luna:unsafe:resume") this.resumeCount++;
        (unityListeners[event.type] || []).forEach(function (callback) { callback(event); });
    },
    setTimeout: function (callback) { callback(); return 1; },
    clearTimeout: function () {},
    setInterval: setInterval,
    clearInterval: clearInterval,
    open: function (url) { openedUrl = url; }
};
unityContext.window = unityContext;
unityContext.mraid = {
    getState: function () { return "default"; },
    isViewable: function () { return true; },
    addEventListener: function (name, callback) { (unityListeners["mraid:" + name] || (unityListeners["mraid:" + name] = [])).push(callback); },
    open: function (url) { openedUrl = url; }
};
vm.createContext(unityContext);
var unityScripts = [];
regex.lastIndex = 0;
while ((match = regex.exec(unity))) { if (!/\bsrc\s*=/.test(match[0])) unityScripts.push(match[1]); }
unityScripts.forEach(function (script) { vm.runInContext(script, unityContext); });
unityContext.dispatchEvent(new unityContext.Event("luna:build"));
assert.strictEqual(unityContext.startCount, 1, "Unity must start Luna after luna:build");
assert.ok(unityContext.resumeCount >= 1, "Viewable Unity MRAID must resume Luna");
unityContext.Luna.Unity.Playable.InstallFullGame();
assert.strictEqual(openedUrl, "https://example.com/android");

console.log("luna AppLovin/Google/Unity tests passed");

// PlProtocol.js (play.rayjump.com/hyplug) is Mintegral's serving-time iframe bridge. In a flat file it
// runs in "inner" mode and replaces window.gameReady/install/gameEnd with postMessage-to-parent stubs.
// Dropped for EVERY target, Mintegral included: the Mindworks review tool runs the game in its own
// page (preview_util.js, no MW_PLFRAME), so the stub swallowed gameReady and the test hung on its
// black loading layer (measured with the real preview_util.js).
var withBridge = '<!doctype html><html><body><script src="https://play.rayjump.com/hyplug/PlProtocol.js"></script><script>window.Luna = Luna;</script></body></html>';
["applovin", "unity", "google", "pangle", "mintegral"].forEach(function (target) {
    var converted = core.convert(withBridge, "luna", target, {});
    assert.strictEqual(converted.html.indexOf("PlProtocol.js\"></script>"), -1, "Mintegral bridge must be dropped for " + target);
    assert.ok(converted.html.indexOf("removed Mintegral serving layer: PlProtocol.js") >= 0, "removal must leave a trace for " + target);
    assert.strictEqual(converted.html.indexOf("rayjump.com"), -1, "the trace must not carry the URL (Mindworks scans comments for outer links)");
    assert.ok(/PlProtocol\.js/.test(converted.notes.join(" ")), "the UI note names what was removed for " + target);
});

// The mraid.js tag is a Unity-only convention (see the channel table in bingo-core.js); it is also
// how detectBingoNetwork tells AppLovin from Unity, so it must never be added for other targets.
var MRAID_TAG_RE = /<script\b[^>]*\ssrc\s*=\s*["']mraid\.js["']/;
["applovin", "unity", "mintegral", "google", "pangle"].forEach(function (target) {
    var html = core.convert(source, "luna", target, {}).html;
    assert.strictEqual(MRAID_TAG_RE.test(html), target === "unity", target + ": mraid.js tag");
});

// removeForeignNetworkSdks must match a real src attribute only: "\b" also matches data-src="…"
// because the hyphen is a word boundary, so an already-inlined tag would be mistaken for a remote one.
var dataSrc = '<!doctype html><html><body><script data-src="https://cdn.example.com/pangle-sdk.js"></script><script>window.Luna = Luna;</script></body></html>';
var keptDataSrc = core.convert(dataSrc, "luna", "applovin", {}).html;
assert.ok(keptDataSrc.indexOf('data-src="https://cdn.example.com/pangle-sdk.js"') >= 0, "data-src must not be treated as a remote SDK tag");

console.log("luna PlProtocol bridge + mraid tag tests passed");

// AppLovin rejects an asset that "makes external requests": Luna's own analytics (window.pi) posts to
// collector.lunalabs.io, and three debug helpers carry CDN URLs. Unity keeps them (Luna is Unity's).
var telemetrySource = '<!doctype html><html><body>' +
    '<script>let e="";if(e){o.setAttribute("src","https://console.re/connector.js")}var t=`see http://console.re/${e} or https://docs.lunalabs.io/docs/playable/ad-networks/remote-debugging`;</script>' +
    '<script>spectorScript.setAttribute("src","https://cdn.jsdelivr.net/npm/spectorjs@0.9.30/dist/spector.bundle.js");t.src="https://mrdoob.github.io/stats.js/build/stats.min.js";</script>' +
    '<script>window.pi.apply(window,["unityads",1,2,"hash","https://collector.lunalabs.io/api/v1/stats/collect",null,3000,500,null,"https://collector.lunalabs.io/api/v1/stats/errors/collect"]||[])</script>' +
    '<script>window.Luna = Luna;</script></body></html>';
["applovin", "google", "mintegral", "pangle"].forEach(function (target) {
    var converted = core.convert(telemetrySource, "luna", target, {});
    assert.ok(converted.html.indexOf('["unityads",1,2,"hash",null,null,3000,500,null,null]') >= 0, target + ": pi endpoints must become null");
    assert.strictEqual(/https?:\/\/[^"'`\s]*(lunalabs\.io|console\.re|jsdelivr\.net|mrdoob\.github\.io)/.test(converted.html), false, target + ": no Luna/debug URL may remain");
    assert.ok(/analytics của Luna/.test(converted.notes.join(" ")), target + ": the UI note says what was removed");
});
var unityTelemetry = core.convert(telemetrySource, "luna", "unity", {});
assert.ok(unityTelemetry.html.indexOf("https://collector.lunalabs.io/api/v1/stats/collect") >= 0, "Unity keeps Luna analytics");
assert.strictEqual(unityTelemetry.notes.length, 0);
assert.strictEqual(core.convert(source, "luna", "applovin", {}).notes.length, 0, "no note when there was nothing to remove");

// AppLovin events fire once each. Luna dispatches luna:postrender on every frame and luna:start arrives
// twice (Luna + the adapter), so forwarding them raw sent DISPLAYED ~60 times a second.
var alListeners = {}, alDocListeners = {}, alEvents = [];
var alContext = {
    navigator: { userAgent: "android" },
    document: { readyState: "complete", addEventListener: function (name, callback) { (alDocListeners[name] || (alDocListeners[name] = [])).push(callback); } },
    Event: function (type) { this.type = type; },
    Luna: { Unity: { Playable: {} } },
    $environment: { packageConfig: { androidLink: "https://example.com/android" } },
    ALPlayableAnalytics: { trackEvent: function (name) { alEvents.push(name); } },
    addEventListener: function (name, callback) { (alListeners[name] || (alListeners[name] = [])).push(callback); },
    dispatchEvent: function (event) { (alListeners[event.type] || []).forEach(function (callback) { callback(event); }); },
    setTimeout: function (callback) { callback(); return 1; },
    clearTimeout: function () {},
    setInterval: setInterval,
    clearInterval: clearInterval,
    open: function () {}
};
alContext.window = alContext;
vm.createContext(alContext);
regex.lastIndex = 0;
while ((match = regex.exec(core.convert(source, "luna", "applovin", {}).html))) vm.runInContext(match[1], alContext);
function alFire(type) { alContext.dispatchEvent(new alContext.Event(type)); }
function alTouch() { (alDocListeners.touchstart || []).forEach(function (callback) { callback({}); }); }
alTouch();
alFire("luna:build");
alFire("luna:start");
alFire("luna:started");
for (var frame = 0; frame < 50; frame++) alFire("luna:postrender");
alTouch();
alTouch();
alFire("luna:ended");
alFire("luna:ended");
alContext.Luna.Unity.Playable.InstallFullGame();
assert.deepStrictEqual(alEvents, ["LOADING", "LOADED", "DISPLAYED", "CHALLENGE_STARTED", "ENDCARD_SHOWN", "CTA_CLICKED"]);

console.log("luna telemetry removal + AppLovin event tests passed");
