/* Static server cho Asset Optimizer — KHÔNG bắt buộc.
 *
 * Mở thẳng index.html bằng file:// là dùng được rồi. Server này chỉ giải quyết
 * một hạn chế: Chrome CHẶN đọc thư mục qua kéo thả khi trang mở bằng file://.
 * Chạy qua http:// thì kéo cả thư mục assets vào được.
 * (Nút "Chọn thư mục…" thì chạy ở cả hai môi trường.)
 *
 * Không xử lý gì cả — mọi việc mã hoá vẫn nằm trong trình duyệt.
 *
 *   node serve.js [port]
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8090;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);

    // chặn thoát ra ngoài thư mục app
    if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Không tìm thấy: ' + url);
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT, '127.0.0.1', () => {
    const url = 'http://localhost:' + PORT;
    console.log('Asset Optimizer: ' + url);
    console.log('  (chỉ để kéo thả được cả thư mục — mở thẳng index.html cũng dùng được)');
    console.log('  Ctrl+C để dừng.');
    if (process.env.AO_NO_OPEN === '1') return;
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').exec(cmd + ' ' + url);
});
