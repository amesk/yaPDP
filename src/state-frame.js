/**
 * yaPDP — the state FRAME: which compression wrapper carries a .state container.
 *
 * A `.state` file (`*.state.zst`) is a CONTAINER (src/state-format.js) wrapped
 * in a frame. The frame depends on WHO wrote the file, not on what the file is:
 *
 *   zstd    the Node tools and the repo's own states/ — zlib.zstdCompressSync,
 *           or fzstd on a runtime whose zlib has no zstd;
 *   gzip    the browser's own export — CompressionStream("gzip") is the one
 *           compressor every browser ships, and bundling a zstd ENCODER for a
 *           button nobody presses daily is not worth the megabytes;
 *   none    a writer with no compressor at all (Node 20, a browser without
 *           CompressionStream) leaves the container bare. Readers must still
 *           accept it — which is exactly why this module exists instead of
 *           every caller testing three magics by hand and getting one wrong.
 *
 * Platforms differ (zlib vs CompressionStream), so the codecs are INJECTED:
 * this module owns the frames and the policy, the caller supplies the
 * compressor/decompressor. A codec may return a Promise — the browser's gzip
 * decoder is DecompressionStream — and unwrap() then returns that Promise;
 * src/snapshots.js is written for both shapes already.
 *
 * ## The policy
 *
 *   wrap():   zstd -> gzip -> bare     (bare only when no compressor exists)
 *   unwrap(): detect the frame, decode with the matching codec, accept a bare
 *             container; anything else is refused by name
 *
 * Images are NOT part of this contract. A media image (media/*.dsk.zst) is
 * read by fzstd in the browser and must be a real zstd frame, so
 * tools/media-zst.js keeps that stricter rule for itself and only borrows
 * detect() from here.
 *
 * Public surface: window.__yapdpStateFrame (browser) and
 * module.exports { StateFrame } (Node tools and tests). Pure.
 */
"use strict";

var StateFrame = (function () {
    "use strict";

    var ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
    var GZIP_MAGIC = [0x1f, 0x8b];

    function startsWith(bytes, magic) {
        if (!bytes || bytes.length < magic.length) return false;
        for (var i = 0; i < magic.length; i++) {
            if (bytes[i] !== magic[i]) return false;
        }
        return true;
    }

    // Which frame wraps these bytes: "zstd", "gzip", or null when there is
    // none (a bare container, or something that is not a state at all). Magic
    // only — cheap enough for the browser and for a CLI to both afford.
    function detect(bytes) {
        if (startsWith(bytes, ZSTD_MAGIC)) return "zstd";
        if (startsWith(bytes, GZIP_MAGIC)) return "gzip";
        return null;
    }

    // A decoded frame must BE a container: the frame says nothing about what
    // is inside it, and a caller that trusted it would hand a guest garbage —
    // or overwrite a state file with it. Checked here, once, instead of in
    // every reader. A caller that cannot judge (no isContainer codec) gets the
    // bytes unchecked, which is the only honest answer it could act on.
    function checked(decoded, kind, codecs) {
        if (decoded && typeof decoded.then === "function") {
            return decoded.then(function (raw) {
                return checked(raw, kind, codecs);
            });
        }
        if (!codecs || typeof codecs.isContainer !== "function") return decoded;
        if (!codecs.isContainer(decoded)) {
            throw new Error("not a .state container (frame: " + kind + ")");
        }
        return decoded;
    }

    // The container bytes under the frame.
    //
    // `codecs.isContainer` (StateFormat's own predicate) is what tells a bare
    // container from a foreign file — a frame alone is not enough to call
    // something a state. Returns the container bytes, or a Promise when the
    // codec that had to run is asynchronous.
    function unwrap(bytes, codecs) {
        var kind = detect(bytes);
        if (kind === "zstd" && codecs && codecs.zstdDecode) {
            return checked(codecs.zstdDecode(bytes), "zstd", codecs);
        }
        if (kind === "gzip" && codecs && codecs.gzipDecode) {
            return checked(codecs.gzipDecode(bytes), "gzip", codecs);
        }
        if (kind === null && codecs && codecs.isContainer &&
            codecs.isContainer(bytes)) {
            return bytes;   // bare: the writer had no compressor at all
        }
        throw new Error("not a .state container (frame: " + (kind || "none") + ")");
    }

    // Put a frame on container bytes. This is the POLICY and this is its only
    // home: zstd when the caller has an encoder, else gzip, else bare.
    //
    // An encoder that DECLINES — returns nothing, which is how a Node without
    // zstd in zlib reports "I cannot do this" — falls through to the next one
    // rather than producing a frame-less result. Returns { bytes, frame } with
    // frame "zstd" | "gzip" | "none".
    function wrap(container, codecs) {
        if (codecs && codecs.zstdEncode) {
            var framed = codecs.zstdEncode(container);
            if (framed) return { bytes: framed, frame: "zstd" };
        }
        if (codecs && codecs.gzipEncode) {
            var gzipped = codecs.gzipEncode(container);
            if (gzipped) return { bytes: gzipped, frame: "gzip" };
        }
        return { bytes: container, frame: "none" };
    }

    return {
        ZSTD_MAGIC: ZSTD_MAGIC,
        GZIP_MAGIC: GZIP_MAGIC,
        detect: detect,
        unwrap: unwrap,
        wrap: wrap,
    };
})();

if (typeof window !== "undefined") window.__yapdpStateFrame = StateFrame;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { StateFrame: StateFrame };
}
