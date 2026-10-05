'use strict';
/* fs trong bộ nhớ cho trình duyệt. Lõi khôi phục viết cho Node (đọc build từ đĩa, ghi project ra
 * đĩa); giả lập đúng phần API nó dùng để chạy nguyên xi trong worker:
 *   /in/...   file build người dùng thả vào
 *   /ref/...  script .ts của project tham chiếu (tuỳ chọn)
 *   /out/...  project dựng lại — worker gom rồi gửi về trang chính
 * `__vfs` là cửa riêng cho worker: nạp file, lấy kết quả, dọn sạch giữa hai job.
 */
const path = require('./path');
const { Buffer } = require('./buffer');

const files = new Map();                      // đường dẫn tuyệt đối → Uint8Array
const dirs = new Map([['/', new Set()]]);     // thư mục → tên con

const norm = (p) => path.resolve('/', String(p));
function fsError(code, syscall, p) {
  const e = new Error(`${code}: ${syscall} '${p}'`);
  e.code = code; e.syscall = syscall; e.path = p;
  return e;
}
function link(p) {
  const parent = path.dirname(p);
  if (!dirs.has(parent)) mkdirp(parent);
  dirs.get(parent).add(path.basename(p));
}
function mkdirp(p) {
  if (dirs.has(p)) return;
  if (files.has(p)) throw fsError('EEXIST', 'mkdir', p);
  if (p !== '/') link(p);
  dirs.set(p, new Set());
}
function unlink(p) {
  const parent = dirs.get(path.dirname(p));
  if (parent) parent.delete(path.basename(p));
}
const encodingOf = (opt) => (typeof opt === 'string' ? opt : opt && opt.encoding) || null;

class Dirent {
  constructor(name, dir) { this.name = name; this._dir = dir; }
  isDirectory() { return this._dir; }
  isFile() { return !this._dir; }
  isSymbolicLink() { return false; }
}
class Stats {
  constructor(size, dir) { this.size = size; this._dir = dir; this.mtimeMs = 0; this.mtime = new Date(0); this.birthtime = this.mtime; this.ctime = this.mtime; }
  isDirectory() { return this._dir; }
  isFile() { return !this._dir; }
  isSymbolicLink() { return false; }
}

const fs = {
  existsSync(p) { p = norm(p); return files.has(p) || dirs.has(p); },
  readFileSync(p, opt) {
    p = norm(p);
    const d = files.get(p);
    if (!d) throw fsError(dirs.has(p) ? 'EISDIR' : 'ENOENT', 'open', p);
    const b = Buffer.view(d), enc = encodingOf(opt);
    return enc ? b.toString(enc) : b;
  },
  writeFileSync(p, data, opt) {
    p = norm(p);
    if (dirs.has(p)) throw fsError('EISDIR', 'open', p);
    let bytes;
    if (typeof data === 'string') bytes = Buffer.from(data, encodingOf(opt) || 'utf8');
    else if (data instanceof Uint8Array) bytes = data;
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = Buffer.from(String(data), 'utf8');
    link(p);
    files.set(p, bytes);
  },
  appendFileSync(p, data, opt) {
    const old = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
    fs.writeFileSync(p, Buffer.concat([old, typeof data === 'string' ? Buffer.from(data, encodingOf(opt) || 'utf8') : data]));
  },
  mkdirSync(p, opt) {
    p = norm(p);
    if (opt === true || (opt && opt.recursive)) { mkdirp(p); return undefined; }
    if (dirs.has(p) || files.has(p)) throw fsError('EEXIST', 'mkdir', p);
    if (!dirs.has(path.dirname(p))) throw fsError('ENOENT', 'mkdir', p);
    mkdirp(p);
    return undefined;
  },
  readdirSync(p, opt) {
    p = norm(p);
    const kids = dirs.get(p);
    if (!kids) throw fsError(files.has(p) ? 'ENOTDIR' : 'ENOENT', 'scandir', p);
    const names = [...kids].sort();
    if (!(opt && opt.withFileTypes)) return names;
    return names.map((n) => new Dirent(n, dirs.has(p === '/' ? '/' + n : p + '/' + n)));
  },
  statSync(p, opt) {
    p = norm(p);
    if (dirs.has(p)) return new Stats(0, true);
    const d = files.get(p);
    if (d) return new Stats(d.length, false);
    if (opt && opt.throwIfNoEntry === false) return undefined;
    throw fsError('ENOENT', 'stat', p);
  },
  lstatSync(p, opt) { return fs.statSync(p, opt); },
  unlinkSync(p) {
    p = norm(p);
    if (!files.has(p)) throw fsError('ENOENT', 'unlink', p);
    files.delete(p); unlink(p);
  },
  rmSync(p, opt = {}) {
    p = norm(p);
    if (files.has(p)) { files.delete(p); unlink(p); return; }
    if (!dirs.has(p)) { if (opt.force) return; throw fsError('ENOENT', 'rm', p); }
    if (!opt.recursive && dirs.get(p).size) throw fsError('ENOTEMPTY', 'rm', p);
    const prefix = p === '/' ? '/' : p + '/';
    for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
    for (const d of [...dirs.keys()]) if (d.startsWith(prefix)) dirs.delete(d);
    if (p === '/') dirs.set('/', new Set()); else { dirs.delete(p); unlink(p); }
  },
  rmdirSync(p, opt) { fs.rmSync(p, { recursive: !!(opt && opt.recursive) }); },
  copyFileSync(a, b) { fs.writeFileSync(b, Uint8Array.prototype.slice.call(fs.readFileSync(a))); },
  renameSync(a, b) {
    a = norm(a); b = norm(b);
    if (files.has(a)) { const d = files.get(a); files.delete(a); unlink(a); link(b); files.set(b, d); return; }
    throw fsError('ENOENT', 'rename', a);
  },
  // scan.js đọc 8 KB đầu file để lấy <title>
  openSync(p) { p = norm(p); if (!files.has(p)) throw fsError('ENOENT', 'open', p); return fds.push(p) - 1; },
  readSync(fd, buf, off, len, pos) {
    const d = files.get(fds[fd]);
    const n = Math.max(0, Math.min(len, d.length - (pos || 0)));
    buf.set(d.subarray(pos || 0, (pos || 0) + n), off);
    return n;
  },
  closeSync(fd) { fds[fd] = null; },
};
const fds = [];
fs.promises = {
  readdir: async (p, opt) => fs.readdirSync(p, opt),
  stat: async (p) => fs.statSync(p),
  readFile: async (p, opt) => fs.readFileSync(p, opt),
  writeFile: async (p, d, opt) => fs.writeFileSync(p, d, opt),
  mkdir: async (p, opt) => fs.mkdirSync(p, opt),
  rm: async (p, opt) => fs.rmSync(p, opt),
};

fs.__vfs = {
  reset() { files.clear(); dirs.clear(); dirs.set('/', new Set()); },
  put(p, bytes) { fs.writeFileSync(p, bytes); },
  /** Mọi file dưới `root`: [[đường dẫn tương đối, Uint8Array]] */
  list(root) {
    root = norm(root);
    const prefix = root === '/' ? '/' : root + '/', out = [];
    for (const [p, d] of files) if (p.startsWith(prefix)) out.push([p.slice(prefix.length), d]);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  },
  get size() { let n = 0; for (const d of files.values()) n += d.length; return n; },
};

module.exports = fs;
