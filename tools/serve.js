#!/usr/bin/env node
/**
 * Minimal dependency-free static file server for the yaPDP emulator.
 *
 * Serves the repository root over HTTP so the emulator works without
 * installing a web server or disabling browser file-access restrictions
 * (browsers block local file:// reads of disk/tape images). The DataLoader in
 * src/iopage.js fetches media slices with HTTP Range requests, so this server
 * implements byte-range responses (206 / 416) in addition to plain GET/HEAD.
 *
 * Usage: node tools/serve.js [--port 1170] [--dir <root>]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// --- CLI args -----------------------------------------------------------

let port = 1170;
let root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
        port = parseInt(args[++i], 10);
    } else if (a.startsWith("--port=")) {
        port = parseInt(a.slice("--port=".length), 10);
    } else if (a === "--dir") {
        root = path.resolve(args[++i]);
    } else if (a.startsWith("--dir=")) {
        root = path.resolve(a.slice("--dir=".length));
    } else if (a === "-h" || a === "--help") {
        console.log("Usage: node tools/serve.js [--port 1170] [--dir <root>]");
        process.exit(0);
    } else {
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
}

if (Number.isNaN(port)) {
    console.error(`Invalid port: ${args.join(" ")}`);
    process.exit(1);
}

// --- MIME map -----------------------------------------------------------

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".zst": "application/octet-stream",
    ".dsk": "application/octet-stream",
    ".tap": "application/octet-stream",
    ".ptap": "application/octet-stream",
};

function contentType(filePath) {
    return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// --- Request handler ----------------------------------------------------

function sendFile(filePath, stat, req, res) {
    const type = contentType(filePath);
    const range = req.headers.range;

    if (range) {
        // --- Byte-range request (used by DataLoader for media slices) ---
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m) {
            const start = m[1] === "" ? undefined : parseInt(m[1], 10);
            const end = m[2] === "" ? undefined : parseInt(m[2], 10);
            const size = stat.size;

            let s = start === undefined ? (end === undefined ? 0 : size - end) : start;
            let e = end === undefined ? size - 1 : Math.min(end, size - 1);

            if (s >= size || s > e || s < 0) {
                res.writeHead(416, { "Content-Range": `bytes */${size}` });
                res.end();
                return;
            }

            res.writeHead(206, {
                "Content-Type": type,
                "Content-Range": `bytes ${s}-${e}/${size}`,
                "Content-Length": e - s + 1,
                "Accept-Ranges": "bytes",
            });

            if (req.method === "HEAD") {
                res.end();
                return;
            }
            fs.createReadStream(filePath, { start: s, end: e }).pipe(res);
            return;
        }
        // Malformed Range header: fall through to a full response.
    }

    res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
        // Development server: never let the browser serve stale JS/CSS/HTML
        // from its cache, otherwise code changes are invisible until a hard
        // refresh. The 206 range responses (media slices) stay cacheable.
        "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") {
        res.end();
        return;
    }
    fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
    }

    let urlPath;
    try {
        urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
        res.writeHead(400);
        res.end("Bad Request");
        return;
    }

    // Map "/" to the main emulator page.
    if (urlPath === "/") {
        urlPath = "/pdp11.html";
    }

    const filePath = path.join(root, path.normalize(urlPath));

    // Prevent path traversal outside the served root.
    if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        res.writeHead(404);
        res.end("Not Found");
        return;
    }

    if (stat.isDirectory()) {
        const index = path.join(filePath, "index.html");
        try {
            const istat = fs.statSync(index);
            sendFile(index, istat, req, res);
        } catch {
            res.writeHead(404);
            res.end("Not Found");
        }
        return;
    }

    sendFile(filePath, stat, req, res);
});

server.listen(port, () => {
    console.log(`yaPDP emulator server: http://localhost:${port}/pdp11.html`);
    console.log(`Serving: ${root}`);
});
