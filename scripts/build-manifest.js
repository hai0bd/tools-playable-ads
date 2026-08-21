#!/usr/bin/env node
'use strict';

/* Quét các thư mục tool ở cấp 1 và sinh ra tools-data.js cho trang chủ.
 *
 * Thêm tool mới KHÔNG cần sửa gì ở đây: cứ tạo một thư mục có index.html dùng
 * đúng khối .topbar mà cả bốn tool đang dùng, script tự nhặt tên, mô tả và
 * badge từ đó. Muốn ghi đè thì đặt một tool.json cạnh index.html.
 *
 * Xuất ra .js chứ không phải .json là có chủ ý: Chrome chặn fetch() khi trang
 * mở bằng file://, còn <script src> thì không. Nhờ vậy double-click index.html
 * ở thư mục gốc vẫn xem được đủ tool, đúng kiểu các tool trong repo này.
 *
 *   node scripts/build-manifest.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools-data.js');

/* Thư mục hạ tầng, không phải tool. Ngoài danh sách này còn bỏ qua mọi tên bắt
   đầu bằng . hoặc _ — trùng luật với Jekyll của GitHub Pages. */
const SKIP = new Set(['scripts', 'node_modules']);

/* ---------------------------------------------------------------- tiện ích */

function read(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/* Lấy nội dung text của nhóm bắt đầu tiên: bỏ thẻ con, giải vài entity hay gặp,
   gộp khoảng trắng. Đủ dùng cho markup do chính mình viết. */
function pick(source, re) {
    const m = source.match(re);
    if (!m) return '';
    return m[1]
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function titleize(slug) {
    return slug.split(/[-_]+/).filter(Boolean)
        .map(w => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

function initials(text) {
    const words = String(text).split(/[\s\-_]+/).filter(Boolean);
    if (!words.length) return '??';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

/* Ngày commit cuối chạm vào thư mục. Trả null nếu chưa git init hoặc clone nông
   — trang chủ chỉ ẩn dòng "cập nhật", không vỡ. */
function lastCommit(dir) {
    try {
        const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', dir], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out || null;
    } catch { return null; }
}

/* ------------------------------------------------------- rút metadata 3 tầng */

/* Chỉ đọc BÊN TRONG <header class="topbar">, không bao giờ quét cả trang.
   Nới phạm vi ra toàn tài liệu nghe có vẻ rộng lượng hơn, nhưng thực tế là nhặt
   đại thẻ <p> đầu tiên trong thân trang làm mô tả — sai một cách khó hiểu. Không
   có topbar thì trả rỗng, để tầng <title> rồi tên thư mục lo. */
function fromTopbar(html) {
    const header = html.match(/<header[^>]*class="[^"]*\btopbar\b[^"]*"[^>]*>([\s\S]*?)<\/header>/i);
    if (!header) return { badge: '', name: '', desc: '' };
    const scope = header[1];
    return {
        badge: pick(scope, /<[^>]*\bclass="[^"]*\bbrand-mark\b[^"]*"[^>]*>([\s\S]*?)<\//i),
        name: pick(scope, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
        desc: pick(scope, /<p[^>]*>([\s\S]*?)<\/p>/i),
    };
}

/* Các trang .html khác cùng cấp — ví dụ playable-converter/decode.html. */
function secondaryPages(dir) {
    return fs.readdirSync(dir)
        .filter(f => /\.html?$/i.test(f) && f.toLowerCase() !== 'index.html')
        .sort()
        .map(f => ({
            file: f,
            label: pick(read(path.join(dir, f)), /<title[^>]*>([\s\S]*?)<\/title>/i) || f,
        }));
}

function describe(slug) {
    const dir = path.join(ROOT, slug);
    const html = read(path.join(dir, 'index.html'));
    const bar = fromTopbar(html);
    const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);

    /* Tầng 2 rồi tầng 3: topbar → <title> → tên thư mục. */
    const name = bar.name || title || titleize(slug);
    const tool = {
        slug,
        name,
        desc: bar.desc || '',
        badge: (bar.badge || initials(name)).slice(0, 3),
        entry: slug + '/',
        pages: secondaryPages(dir),
        hasTests: fs.existsSync(path.join(dir, 'tests')),
        hasReadme: fs.existsSync(path.join(dir, 'README.md')),
        updated: lastCommit(slug),
        tags: [],
        order: 0,
        hidden: false,
    };

    /* Tầng 1 đè lên tất cả. */
    const overridePath = path.join(dir, 'tool.json');
    if (fs.existsSync(overridePath)) {
        try {
            Object.assign(tool, JSON.parse(read(overridePath)));
        } catch (e) {
            console.warn('  ! tool.json hỏng ở ' + slug + ' — bỏ qua (' + e.message + ')');
        }
    }
    return tool;
}

/* -------------------------------------------------------------------- chạy */

const tools = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => !n.startsWith('.') && !n.startsWith('_') && !SKIP.has(n))
    /* Chỉ cấp 1 — thư mục con bên trong một tool (lib/, tests/, browser/…) không
       bị nhận nhầm thành tool riêng. */
    .filter(n => fs.existsSync(path.join(ROOT, n, 'index.html')))
    .map(describe)
    .filter(t => !t.hidden)
    .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'vi'));

const banner = [
    '/* File này do scripts/build-manifest.js sinh ra — ĐỪNG SỬA TAY.',
    ' * Sửa ở đây sẽ mất khi CI chạy lại. Muốn đổi tên hay mô tả một tool thì sửa',
    ' * khối .topbar trong index.html của tool đó, hoặc thêm tool.json cạnh nó.',
    ' */',
].join('\n');

const body = 'window.TOOLS = ' + JSON.stringify(tools, null, 2) + ';\n';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

/* Chỉ ghi khi danh sách thật sự đổi. Nếu lần nào cũng đóng dấu thời gian mới thì
   serve.js — vốn dựng lại manifest mỗi lần khởi động — sẽ làm bẩn working tree
   sau mỗi lần chạy serve.bat, dù không có gì thay đổi. */
const changed = !prev.includes(body);
if (changed) {
    fs.writeFileSync(OUT, banner + '\n' + body
        + 'window.TOOLS_BUILT_AT = ' + JSON.stringify(new Date().toISOString()) + ';\n', 'utf8');
}

console.log('tools-data.js: ' + tools.length + ' tool' + (changed ? '' : ' (không đổi)'));
for (const t of tools) {
    const extra = (t.pages || []).length;
    console.log('  [' + String(t.badge).padEnd(3) + '] ' + t.slug
        + (extra ? ' (+' + extra + ' trang phụ)' : ''));
}
