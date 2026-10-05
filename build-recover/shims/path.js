'use strict';
/* path (posix) cho trình duyệt. Trong worker mọi đường dẫn nằm trên ổ ảo bắt đầu bằng "/". */

function normalizeString(p, allowAbove) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (allowAbove) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

const posix = {
  sep: '/',
  delimiter: ':',
  cwd: () => '/',
  isAbsolute: (p) => String(p).startsWith('/'),
  normalize(p) {
    p = String(p);
    if (!p) return '.';
    const abs = p.startsWith('/'), trailing = p.endsWith('/');
    let r = normalizeString(p, !abs);
    if (!r && !abs) r = '.';
    if (r && trailing) r += '/';
    return (abs ? '/' : '') + r;
  },
  join(...parts) {
    const s = parts.filter((x) => x !== '').map(String).join('/');
    return s ? posix.normalize(s) : '.';
  },
  resolve(...parts) {
    let r = '';
    for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
      const p = String(parts[i]);
      if (p) r = r ? p + '/' + r : p;
    }
    if (!r.startsWith('/')) r = '/' + r;
    return '/' + normalizeString(r, false);
  },
  relative(from, to) {
    const a = posix.resolve(from).split('/').filter(Boolean), b = posix.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
  },
  dirname(p) {
    p = String(p);
    if (!p) return '.';
    const abs = p.startsWith('/');
    const s = p.replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    if (i < 0) return abs ? '/' : '.';
    if (i === 0) return '/';
    return s.slice(0, i);
  },
  basename(p, ext) {
    let b = String(p).replace(/\/+$/, '');
    b = b.slice(b.lastIndexOf('/') + 1);
    if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
    return b;
  },
  extname(p) {
    const b = posix.basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  },
  parse(p) {
    const base = posix.basename(p), ext = posix.extname(p);
    const dir = String(p).includes('/') ? posix.dirname(p) : '';
    return { root: String(p).startsWith('/') ? '/' : '', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
  format(o) { const dir = o.dir || o.root || ''; const base = o.base || (o.name || '') + (o.ext || ''); return dir ? (dir.endsWith('/') ? dir + base : dir + '/' + base) : base; },
  toNamespacedPath: (p) => p,
};
posix.posix = posix;
posix.win32 = posix;   // lõi chỉ dùng win32 ở server Windows, không có trong bundle

module.exports = posix;
