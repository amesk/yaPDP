/**
 * state-io.js — Node's side of the state FRAME contract.
 *
 * src/state-frame.js knows the frames and the policy but stays platform-free:
 * it asks for codecs. This is Node's answer — zlib, with an fzstd fallback for
 * a Node whose zlib has no zstd (the CI matrix still runs 20) — plus the two
 * calls every tool actually makes: read a `.state.zst` down to its container,
 * and write a container back out as one.
 *
 * Why a module. Before it, four tools each carried their own
 * `typeof zlib.zstdCompressSync` branch and their own idea of what a frame may
 * be; three of them silently rejected gzip, i.e. every state exported from the
 * browser. The frames and the policy live in src/state-frame.js, the codecs
 * live here, and the tools just call.
 *
 * Usage:
 *   const StateIO = require("./state-io.js");
 *   const { container, frame } = StateIO.readBytes("states/rk1-ready.state.zst");
 *   const written = StateIO.writeBytes("out.state.zst", container);   // "zstd"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const { StateFrame } = require(path.join(ROOT, "src", "state-frame.js"));

// zstd, decoded the way the browser decodes it: zlib where this Node has it,
// fzstd where it does not. A .state.zst written on 22.15+ must still open on
// the CI floor, and vice versa.
let fzstd = null;
function zstdDecode(buf) {
    if (typeof zlib.zstdDecompressSync === "function") {
        return new Uint8Array(zlib.zstdDecompressSync(buf));
    }
    if (!fzstd) fzstd = require(path.join(ROOT, "assets", "vendor", "fzstd.js"));
    return Uint8Array.from(fzstd.decompress(new Uint8Array(buf)));
}

function gzipDecode(buf) {
    return new Uint8Array(zlib.gunzipSync(buf));
}

// null when this Node cannot compress zstd: wrap() reads that as "use gzip",
// which is always there.
function zstdEncode(buf) {
    return (typeof zlib.zstdCompressSync === "function")
        ? zlib.zstdCompressSync(buf, { level: 19 }) : null;
}

function gzipEncode(buf) {
    return zlib.gzipSync(buf, { level: 9 });
}

const codecs = {
    isContainer: StateFormat.isContainer,
    zstdEncode: zstdEncode,
    gzipEncode: gzipEncode,
    zstdDecode: zstdDecode,
    gzipDecode: gzipDecode,
};

// file -> { container, frame, size }. The frame is "zstd" | "gzip" | "none", so
// a caller can report what it found. Throws, naming the file, when the bytes
// are not a state in any of the three.
function readBytes(file) {
    const raw = fs.readFileSync(file);
    const frame = StateFrame.detect(raw) || "none";
    try {
        return { container: StateFrame.unwrap(raw, codecs), frame: frame,
                 size: raw.length };
    } catch (e) {
        throw new Error(file + ": " + (e && e.message ? e.message : e));
    }
}

// container -> written file; returns the frame that was used.
function writeBytes(file, container) {
    const out = StateFrame.wrap(container, codecs);
    fs.writeFileSync(file, out.bytes);
    return out.frame;
}

module.exports = {
    codecs: codecs,
    zstdEncode: zstdEncode,
    gzipEncode: gzipEncode,
    zstdDecode: zstdDecode,
    gzipDecode: gzipDecode,
    readBytes: readBytes,
    writeBytes: writeBytes,
};
