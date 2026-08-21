"use strict";

var assert = require("assert");
var core = require("../converter-core");

var source = [
    "<!doctype html><html><body><script>",
    "var spNetwork = 'mintegral';",
    "var spVars = {};",
    "var _spSequence = [];",
    "function LAUNCH() {}",
    "function spStoreUrl() { return ''; }",
    "function spResumeGame() {}",
    "function spPauseGame() {}",
    "<!-- MACROS_CURSOR -->",
    "</script></body></html>"
].join("\n");

var mintegral = core.convert(source, "saygames", "mintegral", {}).html;
assert.ok(mintegral.indexOf("window._mintegralStarted = false") >= 0);
assert.strictEqual((mintegral.match(/function _pcLaunchPlayable/g) || []).length, 1);

var applovin = core.convert(mintegral, "saygames", "applovin", {}).html;
assert.strictEqual(applovin.indexOf("window._mintegralStarted"), -1, "Old Mintegral lifecycle must be removed");
assert.strictEqual(applovin.indexOf("if (!window._mintegralStarted) spPauseGame()"), -1, "Old pause gate must be removed");
assert.strictEqual((applovin.match(/function _pcLaunchPlayable/g) || []).length, 1);
assert.strictEqual((applovin.match(/playable-converter:saygames-adapter:start/g) || []).length, 1);
assert.ok(applovin.indexOf("ALPlayableAnalytics") >= 0);
assert.ok(applovin.indexOf("window.setTimeout(_pcLaunchPlayable, 2000)") >= 0);

console.log("saygames reconvert tests passed");
