'use strict';
// Find recoverable builds inside a folder tree (local disk or NAS share).
const fs = require('fs');
const path = require('path');

const CHANNELS = ['google', 'applovin', 'unity', 'mintegral', 'ironsource', 'pangle', 'facebook', 'tiktok', 'moloco', 'liftoff', 'vungle', 'adcolony', 'chartboost', 'snapchat'];
const channelOf = (s) => CHANNELS.find((c) => s.toLowerCase().includes(c)) || '';
const channelRank = (s) => { const i = CHANNELS.indexOf(channelOf(s)); return i < 0 ? 99 : i; };

/** Read just the <title> of an html build (the payload behind it can be several MB). */
function readTitle(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.subarray(0, n).toString('utf8').match(/<title>([^<]*)<\/title>/i);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/**
 * One entry per build version: channel variants of the same build (applovin/, google/, unity/ ...) share
 * the same payload, so they are grouped and the preferred channel is proposed.
 * Returns [{ file, rel, group, version, title, size, mtime, variants: [files] }]
 */
async function scanFolder(root, { onProgress, maxDepth = 9 } = {}) {
  const found = [];
  let dirs = 0;
  async function walk(d, depth) {
    if (depth > maxDepth) return;
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    dirs++;
    if (onProgress && dirs % 20 === 0) onProgress({ dirs, builds: found.length, current: d });
    // web-mobile build folder
    if (ents.some((e) => e.isFile() && e.name === 'index.html') && ents.some((e) => e.isDirectory() && e.name === 'src')) {
      found.push({ file: d, kind: 'folder' });
      return;
    }
    for (const e of ents) {
      if (e.isFile() && /\.(html?|zip)$/i.test(e.name)) found.push({ file: path.join(d, e.name), kind: /\.zip$/i.test(e.name) ? 'zip' : 'html' });
    }
    await Promise.all(ents.filter((e) => e.isDirectory() && !/^(node_modules|\.git|recovered|library|temp)$/i.test(e.name)).map((e) => walk(path.join(d, e.name), depth + 1)));
  }
  await walk(root, 0);

  // group channel variants: key = version folder (parent, or grandparent when the parent is a channel folder)
  const groups = new Map();
  for (const f of found) {
    const parent = f.kind === 'folder' ? path.dirname(f.file) : path.dirname(f.file);
    const key = channelOf(path.basename(parent)) && path.basename(parent).length <= 14 ? path.dirname(parent) : parent;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  }
  const out = [];
  for (const [key, list] of groups) {
    // html playables first (a zip next to them is usually the same build), then by channel preference
    list.sort((a, b) => (a.kind === 'html' ? 0 : 1) - (b.kind === 'html' ? 0 : 1) || channelRank(a.file) - channelRank(b.file));
    const best = list[0];
    let stat = null;
    try { stat = await fs.promises.stat(best.file); } catch { /* ignore */ }
    const rel = path.relative(root, key) || path.basename(key);
    out.push({
      file: best.file,
      kind: best.kind,
      rel,
      group: rel.split(/[\\/]/)[0] || rel,
      version: path.basename(key),
      title: best.kind === 'html' ? readTitle(best.file) : '',
      size: stat && stat.isFile() ? stat.size : 0,
      mtime: stat ? stat.mtimeMs : 0,
      channel: channelOf(best.file),
      variants: list.map((x) => x.file),
    });
  }
  out.sort((a, b) => a.group.localeCompare(b.group) || b.mtime - a.mtime);
  return out;
}

/** Synchronous variant kept for the CLI --batch mode: one build path per version folder. */
function findBuilds(dir) {
  const found = [];
  (function walk(d, depth) {
    if (depth > 8) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === 'index.html') && fs.existsSync(path.join(d, 'src'))) { found.push(d); return; }
    const htmls = ents.filter((e) => e.isFile() && /\.html?$/i.test(e.name)).map((e) => e.name);
    if (htmls.length) {
      htmls.sort((a, b) => channelRank(a) - channelRank(b));
      found.push(path.join(d, htmls[0]));
    }
    for (const e of ents) if (e.isDirectory() && !/^(node_modules|\.git)$/.test(e.name)) walk(path.join(d, e.name), depth + 1);
  })(dir, 0);
  return found;
}

module.exports = { scanFolder, findBuilds, readTitle, channelOf };
