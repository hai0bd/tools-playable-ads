'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Claim a fresh project folder "<root>/<name>" (name_2, name_3 ... when taken). mkdir is atomic, so parallel
 * jobs can never pick the same folder.
 */
function claimOutDir(root, name) {
  fs.mkdirSync(root, { recursive: true });
  for (let k = 1; k < 1000; k++) {
    const d = path.join(root, k === 1 ? name : `${name}_${k}`);
    try { fs.mkdirSync(d); return d; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`Không tạo được thư mục project trong ${root}`);
}

module.exports = { claimOutDir };
