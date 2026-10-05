'use strict';
// Locate installed Cocos Creator editors and pick the best one for a given build engine version.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CANDIDATE_ROOTS = [
  'C:/ProgramData/cocos/editors/Creator',
  path.join(os.homedir(), 'AppData/Local/CocosDashboard/editors/Creator'),
  '/Applications/Cocos/Creator',
];

function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

function findEditors(extraRoots = []) {
  const found = [];
  for (const root of [...extraRoots, ...CANDIDATE_ROOTS]) {
    if (!root || !fs.existsSync(root)) continue;
    for (const v of fs.readdirSync(root)) {
      if (!/^\d+\.\d+\.\d+/.test(v)) continue;
      const dir = path.join(root, v);
      const engine = [path.join(dir, 'resources/resources/3d/engine'), path.join(dir, 'CocosCreator.app/Contents/Resources/resources/3d/engine')].find((p) => fs.existsSync(p));
      const exe = [path.join(dir, 'CocosCreator.exe'), path.join(dir, 'CocosCreator.app/Contents/MacOS/CocosCreator')].find((p) => fs.existsSync(p));
      found.push({ version: v, dir, engine: engine || null, exe: exe || null });
    }
  }
  return found.sort((a, b) => cmpVer(a.version, b.version));
}

/** Prefer exact match, then the lowest installed 3.x >= build version, then the highest 3.x. */
function pickEditor(buildVersion, editors) {
  const v3 = editors.filter((e) => e.version.startsWith('3.'));
  if (!v3.length) return null;
  if (buildVersion) {
    const exact = v3.find((e) => e.version === buildVersion);
    if (exact) return exact;
    const newer = v3.filter((e) => cmpVer(e.version, buildVersion) >= 0);
    if (newer.length) return newer[0];
  }
  return v3[v3.length - 1];
}

module.exports = { findEditors, pickEditor, cmpVer };
