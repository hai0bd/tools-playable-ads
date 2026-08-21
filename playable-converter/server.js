"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/plain; charset=utf-8"
};

http.createServer((request, response) => {
    const pathname = decodeURIComponent((request.url || "/").split("?")[0]);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep) && filename !== path.join(root, "index.html")) {
        response.writeHead(403).end("Forbidden");
        return;
    }
    fs.readFile(filename, (error, data) => {
        if (error) {
            response.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(error.code === "ENOENT" ? "Not found" : "Server error");
            return;
        }
        response.writeHead(200, {
            "Content-Type": types[path.extname(filename).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store"
        });
        response.end(data);
    });
}).listen(port, "127.0.0.1", () => {
    console.log(`Playable Converter: http://127.0.0.1:${port}`);
    console.log("Nhan Ctrl+C de dung server.");
});
