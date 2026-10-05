'use strict';
// Project scaffolding: package.json, tsconfig.json, .gitignore, settings/v2/packages/*.json
const fs = require('fs');
const path = require('path');
const { stableUuid } = require('../util/uuid');

const { readTemplate: readTpl } = require('./templates');

const TSCONFIG = `{
  /* Base configuration. Do not edit this field. */
  "extends": "./temp/tsconfig.cocos.json",

  /* Add your custom configuration here. */
  "compilerOptions": {
    "strict": false
  }
}
`;

// Convert build settings.json -> editor settings/v2/packages/project.json
function projectSettings(settings) {
  const out = { __version__: '1.0.6' };
  const screen = settings && settings.screen;
  if (screen && screen.designResolution) {
    const { width, height, policy } = screen.designResolution;
    // ResolutionPolicy: 0 EXACT_FIT, 1 NO_BORDER, 2 SHOW_ALL, 3 FIXED_HEIGHT, 4 FIXED_WIDTH
    const fit = { 0: [true, true], 1: [false, false], 2: [true, true], 3: [false, true], 4: [true, false] }[policy] || [false, true];
    out.general = { designResolution: { width, height, fitWidth: fit[0], fitHeight: fit[1] } };
  }
  const phys = settings && settings.physics;
  if (phys) {
    const p = {};
    if (phys.gravity && (phys.gravity.x !== 0 || phys.gravity.y !== -10 || phys.gravity.z !== 0)) p.gravity = phys.gravity;
    if (phys.allowSleep === false) p.allowSleep = false;
    if (typeof phys.sleepThreshold === 'number' && phys.sleepThreshold !== 0.1) p.sleepThreshold = phys.sleepThreshold;
    if (phys.autoSimulation === false) p.autoSimulation = false;
    if (typeof phys.fixedTimeStep === 'number' && Math.abs(phys.fixedTimeStep - 0.0166667) > 1e-7) p.fixedTimeStep = phys.fixedTimeStep;
    if (typeof phys.maxSubSteps === 'number' && phys.maxSubSteps !== 1) p.maxSubSteps = phys.maxSubSteps;
    if (phys.collisionGroups && phys.collisionGroups.length) p.collisionGroups = phys.collisionGroups;
    if (phys.collisionMatrix) p.collisionMatrix = phys.collisionMatrix;
    if (Object.keys(p).length) out.physics = p;
  }
  const eng = settings && settings.engine;
  if (eng && eng.customLayers && eng.customLayers.length) {
    // build: [{ name, bit }]  editor: [{ name, value: 1 << bit }]
    out.layer = eng.customLayers.map((l) => ({ name: l.name, value: l.value !== undefined ? l.value : 1 << l.bit }));
  }
  if (eng && eng.sortingLayers && eng.sortingLayers.length) {
    out['sorting-layer'] = { layers: eng.sortingLayers };
  }
  return out;
}

function writeSkeleton(writer, { name, creatorVersion, settings, engineJson, superHtml }) {
  const pkgPath = writer.abs('package.json');
  if (!fs.existsSync(pkgPath)) {
    writer.writeJSON('package.json', { name, uuid: stableUuid('project:' + name), creator: { version: creatorVersion } });
  }
  if (!fs.existsSync(writer.abs('tsconfig.json'))) writer.write('tsconfig.json', TSCONFIG);
  if (!fs.existsSync(writer.abs('.gitignore'))) writer.write('.gitignore', readTpl('gitignore.txt'));
  if (!fs.existsSync(writer.abs('.creator/default-meta.json'))) writer.writeJSON('.creator/default-meta.json', { image: { type: 'sprite-frame' } });

  const pk = 'settings/v2/packages/';
  for (const f of ['builder.json', 'device.json', 'program.json', 'information.json']) {
    if (!fs.existsSync(writer.abs(pk + f))) writer.write(pk + f, readTpl(f));
  }
  writer.writeJSON(pk + 'project.json', projectSettings(settings));
  if (engineJson) writer.writeJSON(pk + 'engine.json', engineJson);

  // Per-user build profile: super-html needs asm.js (it rejects .wasm files)
  const prof = 'profiles/v2/packages/builder.json';
  if (!fs.existsSync(writer.abs(prof))) {
    writer.writeJSON(prof, {
      __version__: '1.3.9',
      common: {
        platform: 'web-mobile', buildPath: 'project://build', outputName: 'web-mobile',
        nativeCodeBundleMode: superHtml ? 'asmjs' : 'both', mainBundleCompressionType: 'merge_dep', md5Cache: false,
      },
    });
  }
}

module.exports = { writeSkeleton, projectSettings };
