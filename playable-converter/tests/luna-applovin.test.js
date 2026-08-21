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
