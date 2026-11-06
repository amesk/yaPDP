/*
 * fsbundle.js — let a page opened from disk read the project's own files.
 *
 * A browser refuses fetch() for a file:// document (its origin is "null"), so
 * pdp11.html double-clicked loses its manifests, its SVG artwork and every disk
 * image. A <script src> is the one request such a page may still make, so
 * assets/fs-bundle/bundle.js carries those payloads base64-encoded (built by
 * tools/build-fs-bundle.js, `npm run fs-bundle`) and this module installs a
 * fetch shim that answers the relative requests from it.
 *
 * The shim exists ONLY on a file:// page: served over HTTP, in the desktop build
 * or in Node, `install()` returns false and fetch is left untouched, so the
 * normal network path keeps its behaviour, its Range support and its cache
 * headers. A request the bundle does not carry resolves as 404 — exactly what
 * the missing file would have produced — so the emulator's existing "cannot
 * load the image" dialogs still fire.
 */
"use strict";

var FsBundle = (function (global) {
    "use strict";

    var data = null;                       // window.__yapdpFsBundle, when loaded
    var decoded = Object.create(null);     // rel -> Uint8Array (decoded payload)
    var installed = false;
    var originalFetch = null;

    function isFileProtocol() {
        return !!(global && global.location && global.location.protocol === "file:");
    }

    // The payload registers itself while the document is still parsing, which
    // can be after install(): read it lazily, never cache the first answer.
    function bundle() {
        if (!data && global && global.__yapdpFsBundle &&
            global.__yapdpFsBundle.files) {
            data = global.__yapdpFsBundle;
        }
        return data;
    }

    function available() {
        var b = bundle();
        return !!(b && b.files && typeof b.files === "object");
    }

    function has(rel) {
        return available() && Object.prototype.hasOwnProperty.call(data.files, rel);
    }

    function decodeBase64(base64) {
        if (typeof atob === "function") {
            var bin = atob(base64);
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        if (typeof Buffer !== "undefined") {
            var buf = Buffer.from(base64, "base64");
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        }
        throw new Error("No base64 decoder available");
    }

    function bytesOf(rel) {
        if (!has(rel)) return null;
        if (!decoded[rel]) decoded[rel] = decodeBase64(data.files[rel]);
        return decoded[rel];
    }

    function textOf(rel) {
        var bytes = bytesOf(rel);
        if (bytes == null) return null;
        if (typeof TextDecoder === "function") {
            return new TextDecoder("utf-8").decode(bytes);
        }
        if (typeof Buffer !== "undefined") {
            return Buffer.from(bytes).toString("utf8");
        }
        var s = "";
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    // Resolve a request url to a bundle key. Anything that is not a relative
    // path of this document's own directory is refused (null), so absolute
    // http(s)/data:/blob: requests keep going to the real fetch.
    function relFromUrl(url) {
        if (typeof url !== "string") return null;
        var s = url.trim();
        if (!s) return null;

        if (/^file:/i.test(s)) {
            // A page may build an absolute file url from location.href; keep it
            // only when it points inside this directory.
            if (!isFileProtocol() || !global.location || !global.location.href) {
                return null;
            }
            s = s.replace(/^file:\/\/\/?/i, "/");
            var base = String(global.location.href)
                .replace(/^file:\/\/\/?/i, "/")
                .replace(/[^/]*$/, "");
            if (s.indexOf(base) !== 0) return null;
            s = s.slice(base.length);
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
            return null;                    // http:, https:, data:, blob:, ...
        }

        var cut = s.search(/[?#]/);
        if (cut >= 0) s = s.slice(0, cut);
        s = s.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
        if (!s || s.indexOf("..") >= 0) return null;
        return s;
    }

    function headerValue(init, name) {
        var headers = init && init.headers;
        if (!headers) return null;
        if (typeof headers.get === "function") return headers.get(name);
        for (var key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key) &&
                key.toLowerCase() === name.toLowerCase()) {
                return headers[key];
            }
        }
        return null;
    }

    // "bytes=start-end" -> { start, end } | null. Only the single-range form the
    // emulator uses is understood; anything else is answered with the whole body.
    function parseRange(value, size) {
        var m = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
        if (!m) return null;
        var start = m[1] === "" ? null : parseInt(m[1], 10);
        var end = m[2] === "" ? null : parseInt(m[2], 10);
        if (start == null && end == null) return null;
        if (start == null) {                // suffix range: last N bytes
            var len = Math.min(end, size);
            return { start: size - len, end: size - 1 };
        }
        if (end == null || end >= size) end = size - 1;
        if (start > end || start >= size) return null;
        return { start: start, end: end };
    }

    function contentType(rel) {
        var lower = rel.toLowerCase();
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    function decompressZst(bytes) {
        if (typeof fzstd === "undefined" || !fzstd ||
            typeof fzstd.decompress !== "function") {
            return null;
        }
        try {
            return fzstd.decompress(bytes);
        } catch (err) {
            return null;
        }
    }

    // The bytes a bundle key answers with. A logical name (media/rk0.dsk) may be
    // carried compressed (media/rk0.dsk.zst), exactly like the HTTP path where
    // the raw file and its .zst twin are both tried.
    function payloadFor(rel) {
        var bytes = bytesOf(rel);
        if (bytes) return { bytes: bytes, rel: rel };
        var zstRel = rel + ".zst";
        if (has(zstRel)) {
            var raw = decompressZst(bytesOf(zstRel));
            if (raw) return { bytes: raw, rel: rel };
        }
        return null;
    }

    function notFound(rel) {
        return new Response(null, {
            status: 404,
            statusText: "Not Found (not in the offline bundle: " + rel + ")"
        });
    }

    function responseFor(rel, init) {
        var payload = payloadFor(rel);
        if (!payload) return null;
        var bytes = payload.bytes;
        var type = contentType(payload.rel);

        var range = parseRange(headerValue(init, "Range"), bytes.length);
        if (range) {
            var slice = bytes.subarray(range.start, range.end + 1);
            return new Response(slice.slice(), {
                status: 206,
                statusText: "Partial Content",
                headers: {
                    "Content-Type": type,
                    "Content-Range": "bytes " + range.start + "-" +
                        range.end + "/" + bytes.length,
                    "Content-Length": String(slice.length),
                    "Accept-Ranges": "bytes"
                }
            });
        }

        return new Response(bytes.slice(), {
            status: 200,
            statusText: "OK",
            headers: {
                "Content-Type": type,
                "Content-Length": String(bytes.length),
                "Accept-Ranges": "bytes"
            }
        });
    }

    function shim(input, init) {
        if (!installed) return originalFetch.call(global, input, init);
        var url = typeof input === "string"
            ? input
            : (input && input.url) || null;
        var rel = relFromUrl(url);
        if (rel == null) return originalFetch.call(global, input, init);
        try {
            var response = responseFor(rel, init);
            if (response) return Promise.resolve(response);
        } catch (err) {
            return Promise.reject(err);
        }
        // The bundle does not answer this one. Two very different pages reach
        // here: one launched with --allow-file-access-from-files, whose real
        // fetch works and must be tried first, and a locked-down one, where it
        // throws and the emulator needs a 404 (not a TypeError) to show its
        // own "cannot load the image" dialog.
        return originalFetch.call(global, input, init)
            .catch(function () { return notFound(rel); });
    }

    function install() {
        if (installed) return true;
        if (!isFileProtocol()) return false;
        if (typeof global.fetch !== "function") return false;
        if (typeof Response !== "function") return false;
        originalFetch = global.fetch;
        global.fetch = shim;
        installed = true;
        return true;
    }

    // A file:// page without the payload is the old broken state, and the only
    // thing it lacked was an explanation. Say it once, as soon as the toast
    // channel of src/pdp11-app.js exists (this module loads long before it).
    function announceMissing() {
        if (!isFileProtocol() || available()) return;
        if (typeof originalFetch !== "function") return;

        var tries = 0;
        function warn() {
            if (typeof global.__yapdpReportWarning === "function") {
                global.__yapdpReportWarning(
                    "Opened from disk (file://) without the offline bundle: " +
                    "disk images, saved states and cabinet artwork cannot be " +
                    "fetched. Run `npm run fs-bundle`, serve the folder with " +
                    "`npm run serve`, or launch the browser with " +
                    "--allow-file-access-from-files.",
                    "fsbundle-missing"
                );
                return;
            }
            if (++tries > 60) return;        // ~15 s: give up quietly
            setTimeout(warn, 250);
        }

        // A kiosk launched with --allow-file-access-from-files can read the
        // files itself, so a missing payload is not a problem there: ask the
        // real fetch before complaining about anything.
        originalFetch.call(global, "media/manifest.json", { cache: "no-store" })
            .then(function (response) {
                if (response && response.ok) return;
                warn();
            }, function () { warn(); });
    }

    return {
        isFileProtocol: isFileProtocol,
        available: available,
        has: has,
        bytesOf: bytesOf,
        textOf: textOf,
        relFromUrl: relFromUrl,
        parseRange: parseRange,
        install: install,
        shim: shim,
        announceMissing: announceMissing
    };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
    module.exports = FsBundle;
}

// On a file:// page the payload is pulled in through document.write: a served
// page must not download it (it is inert there and costs megabytes), and a
// missing payload must cost only one failed request.
(function bootFsBundle(global) {
    if (typeof document === "undefined") return;
    if (!FsBundle.isFileProtocol()) return;
    document.write("<script src='assets/fs-bundle/bundle.js'><\/script>");
    FsBundle.install();
    if (document.readyState === "complete") {
        setTimeout(FsBundle.announceMissing, 0);
    } else {
        global.addEventListener("load", function () {
            FsBundle.announceMissing();
        });
    }
})(typeof window !== "undefined" ? window : globalThis);
