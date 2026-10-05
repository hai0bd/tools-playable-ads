'use strict';
// Writes files into the output project and keeps track of what was produced.
const fs = require('fs');
const path = require('path');
const { stableUuid } = require('../util/uuid');

const INVALID = /[\\/:*?"<>|\x00-\x1f]/g;

function sanitizeName(n) {
  let s = String(n || '').replace(INVALID, '_').replace(/\s+$/g, '').replace(/^\s+/g, '').replace(/\.+$/, '');
  if (!s) s = 'unnamed';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

class ProjectWriter {
  constructor(outDir) {
    this.outDir = path.resolve(outDir);
    this.taken = new Set();       // lowercase relative paths already used
    this.written = [];            // relative paths
    this.uuids = new Set();       // uuids that have a meta (incl. sub assets)
  }

  abs(rel) { return path.join(this.outDir, rel); }

  /** Reserve a unique path "dir/name.ext" (relative to project root, forward slashes). */
  claim(dir, name, ext) {
    const base = sanitizeName(name);
    let candidate = `${dir}/${base}${ext}`, i = 1;
    while (this.taken.has(candidate.toLowerCase())) candidate = `${dir}/${base}_${i++}${ext}`;
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }

  /** Reserve an exact path (e.g. from bundle paths / scene urls). Falls back to a suffixed name on collision. */
  claimExact(rel) {
    if (!this.taken.has(rel.toLowerCase())) { this.taken.add(rel.toLowerCase()); return rel; }
    const ext = path.posix.extname(rel);
    return this.claim(path.posix.dirname(rel), path.posix.basename(rel, ext), ext);
  }

  write(rel, data) {
    const f = this.abs(rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    this.written.push(rel);
  }

  writeJSON(rel, obj) { this.write(rel, JSON.stringify(obj, null, 2)); }

  writeMeta(rel, m) {
    this.writeJSON(rel + '.meta', m);
    this.uuids.add(m.uuid);
    for (const s of Object.values(m.subMetas || {})) this.uuids.add(s.uuid);
  }

  /** Create directory metas for every folder under assets/ that has none yet. */
  writeFolderMetas(special = {}) {
    const assetsDir = this.abs('assets');
    if (!fs.existsSync(assetsDir)) return;
    const { meta } = require('./metas');
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(d, e.name);
        const rel = path.relative(this.outDir, p).replace(/\\/g, '/');
        if (!fs.existsSync(p + '.meta')) {
          const userData = special[rel] || {};
          this.writeJSON(rel + '.meta', meta('directory', stableUuid('dir:' + rel), { userData }));
        }
        walk(p);
      }
    };
    walk(assetsDir);
  }
}

module.exports = { ProjectWriter, sanitizeName };
