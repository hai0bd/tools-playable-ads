/* Static server cho cả bộ tool — KHÔNG bắt buộc.
 *
 * Mở thẳng index.html bằng file:// là xem được trang chủ rồi. Server này giải
 * quyết một hạn chế: Chrome CHẶN đọc thư mục qua kéo thả khi trang mở bằng
 * file://, mà vài tool cần kéo cả thư mục vào.
 *
 * Khác với serve.js của từng tool: bản này phục vụ index.html cho MỌI đường dẫn
 * thư mục, nên bấm card ở trang chủ sang tool nào cũng chạy.
 *
 * Không xử lý gì cả — mọi việc vẫn nằm trong trình duyệt.
 *
 *   node serve.js [port]
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
};

/* Dựng lại danh sách tool mỗi lần khởi động, để vừa thêm thư mục là thấy ngay. */
try {
    require('./scripts/build-manifest.js');
} catch (e) {
    console.warn('Khong dung duoc tools-data.js: ' + e.message);
}

http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, url);

    /* chặn thoát ra ngoài thư mục repo */
    if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    /* /asset-optimizer/ và /asset-optimizer đều ra index.html của tool đó */
    try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch { /* không tồn tại thì để readFile báo 404 */ }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Khong tim thay: ' + url);
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}).listen(PORT, () => {
    const url = 'http://localhost:' + PORT;
    console.log('Playable Ads Tools: ' + url);
    console.log('Ctrl+C de dung.');
    /* NO_OPEN=1 thì không bung trình duyệt — tiện khi chạy từ IDE hoặc script. */
    if (process.env.NO_OPEN) return;
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').exec(cmd + ' ' + url);
});
