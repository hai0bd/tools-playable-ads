/* Static server tối giản cho Build Size Analyzer.
   Mở bằng file:// thì Chrome chặn API đọc thư mục qua kéo thả; chạy qua http:// thì hết chặn.
   Không cần cài package nào. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, url === '/' ? 'index.html' : url);

    // chặn thoát ra ngoài thư mục app
    if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy: ' + url);
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT, () => {
    const url = 'http://localhost:' + PORT;
    console.log('Build Size Analyzer: ' + url);
    console.log('Ctrl+C de dung.');
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').exec(cmd + ' ' + url);
});
