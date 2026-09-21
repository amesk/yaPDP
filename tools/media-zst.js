#!/usr/bin/env node
/**
 * yaPDP media .zst packer/unpacker.
 *
 * The big disk and tape images in media/ are committed as <name>.<ext>.zst so
 * they fit GitHub's file limits, and the browser gets them back with fzstd
 * (assets/vendor/fzstd.js). This tool is the repo-side half of that contract:
 *
 *   node tools/media-zst.js compress   media/ra0.tap [more...] [--level 19] [--force]
 *   node tools/media-zst.js decompress media/ra0.tap.zst [--out media/ra0.tap] [--force]
 *   node tools/media-zst.js check      media/ra0.tap.zst [more...]
 *
 * npm scripts: `npm run media:compress -- media/ra0.tap`, `npm run media:unpack -- media/ra0.tap.zst`
 * (`unpack` is accepted as a name for `decompress`, so the script and the CLI agree).
 *
 * No external compressor is needed: Node 22.15+/23+ ships zstd in zlib (the
 * dev box runs 24). Node 20 — the floor of the CI matrix — does not, so there
 * the tool falls back to a legal zstd frame made of raw blocks: it buys no
 * size at all, but it is a frame the emulator reads, and the tool says so
 * rather than failing. Nothing is written that cannot be read back either way:
 * every frame is decoded again with the very same fzstd build the emulator
 * loads, byte for byte, and a container that is not a zstd frame (a gzip file
 * named .zst, say) is refused up front — the guest would load garbage, and
 * that failure surfaces much later than here.
 *
 * The file name is part of the contract: src/dragdrop.js and DataLoader strip
 * the trailing `.zst`, so the compressed file keeps the whole original name
 * (rk5.dsk -> rk5.dsk.zst, never rk5.zst).
 *
 * After adding or replacing anything in media/, run `npm run manifest`.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const FZSTD_PATH = path.join(ROOT, "assets", "vendor", "fzstd.js");

// zstd frame magic. fzstd reads frame headers strictly, so this is the one
// thing to check before handing a file to a guest.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const DEFAULT_LEVEL = 19;   // zstd's "high" preset: the repo's own images use it
const IMAGE_RE = /\.(dsk|tap|ptap)$/;

// --- pure helpers (unit-tested in tests/media-zst.test.js) -----------------

function isZstdFrame(buf) {
    return !!buf && buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

function zstName(file) {
    if (file.endsWith(".zst")) {
        throw new Error(file + " is already compressed");
    }
    return file + ".zst";
}

function rawName(file) {
    return file.endsWith(".zst") ? file.slice(0, -4) : null;
}

// What the caller wants to happen to one file, decided before anything is
// touched: `write`, or `skip` with a reason the CLI prints.
function decideWrite(target, force) {
    if (force) return { write: true, reason: "forced" };
    if (fs.existsSync(target)) {
        return { write: false, reason: "exists" };
    }
    return { write: true, reason: "new" };
}

// --- fzstd, the decoder the emulator itself uses ---------------------------

function loadFzstd() {
    const mod = require(FZSTD_PATH);
    if (!mod || typeof mod.decompress !== "function") {
        throw new Error("assets/vendor/fzstd.js does not export decompress()");
    }
    return mod;
}

// Decode a zstd frame exactly the way the browser does.
function decompressBytes(zst) {
    if (!isZstdFrame(zst)) {
        throw new Error("not a zstd frame (magic 28 b5 2f fd) — " +
            "a .zst made with gzip or another container will not load");
    }
    const out = loadFzstd().decompress(new Uint8Array(zst));
    return Buffer.from(out);
}

// Does this Node compress zstd itself? (zlib gained it in 22.15/23.)
function hasZstd() {
    return typeof zlib.zstdCompressSync === "function";
}

// A zstd frame written entirely of raw (uncompressed) blocks — what the tool
// falls back to where zlib has no zstd. The frame is ordinary: magic, a frame
// header without a checksum or content size, a 256 KB window descriptor, then
// 128 KB blocks whose three-byte header carries "last" and "raw". fzstd and
// every other decoder read it; only the compression is missing.
const RAW_BLOCK_MAX = 131072;

function rawFrame(bytes) {
    const parts = [ZSTD_MAGIC, Buffer.from([0x00, 0x40])];
    if (!bytes.length) {
        parts.push(Buffer.from([0x01, 0x00, 0x00]));   // last, raw, empty
        return Buffer.concat(parts);
    }
    for (let at = 0; at < bytes.length; at += RAW_BLOCK_MAX) {
        const size = Math.min(RAW_BLOCK_MAX, bytes.length - at);
        const last = (at + size >= bytes.length) ? 1 : 0;
        const header = Buffer.alloc(3);
        header.writeUIntLE((size << 3) | last, 0, 3);
        parts.push(header, Buffer.from(bytes.subarray(at, at + size)));
    }
    return Buffer.concat(parts);
}

// Compress, then prove the result: the frame must be a zstd frame and must
// decode back to the input through fzstd before it is allowed to disk.
function compressBytes(bytes, level) {
    const lvl = (typeof level === "number") ? level : DEFAULT_LEVEL;
    const frame = hasZstd()
        ? zlib.zstdCompressSync(bytes, {
            params: { [zlib.constants.ZSTD_c_compressionLevel]: lvl }
        })
        : rawFrame(bytes);
    if (!isZstdFrame(frame)) {
        throw new Error("the compressor returned a non-zstd frame");
    }
    const back = decompressBytes(frame);
    if (!back.equals(bytes)) {
        throw new Error("fzstd did not decode the new frame back to the input");
    }
    return frame;
}

// --- CLI -------------------------------------------------------------------

const USAGE = [
    "usage:",
    "  node tools/media-zst.js compress   <image> [more...] [--level N] [--force]",
    "  node tools/media-zst.js decompress <image.zst> [--out <file>] [--force]",
    "  node tools/media-zst.js unpack     <image.zst> [--out <file>] [--force]",
    "  node tools/media-zst.js check      <image.zst> [more...]",
    "",
    "  compress    writes <image>.zst (skips an existing one unless --force)",
    "  decompress  writes <image> (refuses to overwrite unless --force)",
    "  check       decodes and reports, writes nothing",
    "",
    "  Images are .dsk/.tap/.ptap; the .zst keeps the whole original name.",
].join("\n");

function parseArgs(argv) {
    const opts = { level: DEFAULT_LEVEL, force: false, out: null, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") opts.force = true;
        else if (a === "--level") opts.level = Number(argv[++i]);
        else if (a === "--out") opts.out = argv[++i];
        else if (a.startsWith("-")) throw new Error("unknown option " + a);
        else opts.files.push(a);
    }
    if (!Number.isFinite(opts.level) || opts.level < 1 || opts.level > 22) {
        throw new Error("--level must be 1..22");
    }
    return opts;
}

function kb(n) {
    return (n / 1024).toFixed(1) + " kB";
}

function compressOne(file, opts) {
    if (!fs.existsSync(file)) throw new Error("no such file: " + file);
    if (!IMAGE_RE.test(file)) {
        throw new Error(file + " is not a disk/tape image (.dsk/.tap/.ptap)");
    }
    const target = zstName(file);
    const decision = decideWrite(target, opts.force);
    if (!decision.write) {
        console.log("  skip  " + target + " (already there; --force to replace)");
        return "skipped";
    }
    const bytes = fs.readFileSync(file);
    const frame = compressBytes(bytes, opts.level);
    fs.writeFileSync(target, frame);
    if (!hasZstd()) {
        console.log("  note  this Node has no zstd in zlib (22.15+ has it): " +
            "the frame is valid but uncompressed");
    }
    const ratio = bytes.length ? Math.round(100 - (frame.length * 100) / bytes.length) : 0;
    console.log("  write " + target + "  " + kb(bytes.length) + " -> " +
        kb(frame.length) + "  (-" + ratio + "%, level " + opts.level + ")");
    return "written";
}

function decompressOne(file, opts) {
    if (!fs.existsSync(file)) throw new Error("no such file: " + file);
    const stripped = rawName(file);
    if (!stripped) throw new Error(file + " is not a .zst");
    const target = opts.out || stripped;
    const decision = decideWrite(target, opts.force);
    if (!decision.write) {
        console.log("  skip  " + target + " (already there; --force to replace)");
        return "skipped";
    }
    const zst = fs.readFileSync(file);
    const bytes = decompressBytes(zst);
    fs.writeFileSync(target, bytes);
    console.log("  write " + target + "  " + kb(zst.length) + " -> " +
        kb(bytes.length));
    return "written";
}

function checkOne(file) {
    const zst = fs.readFileSync(file);
    const bytes = decompressBytes(zst);
    console.log("  ok    " + file + "  " + kb(zst.length) + " -> " +
        kb(bytes.length) + " (fzstd)");
    return "checked";
}

function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
        console.log(USAGE);
        return;
    }
    // `unpack` is what the npm script is called, `decompress` is what the code
    // calls it: accept both instead of making the caller remember which is which.
    const command = argv[0] === "unpack" ? "decompress" : argv[0];
    if (command !== "compress" && command !== "decompress" && command !== "check") {
        throw new Error("unknown command " + argv[0] + "\n\n" + USAGE);
    }
    const opts = parseArgs(argv.slice(1));
    if (!opts.files.length) throw new Error("no files given\n\n" + USAGE);
    if (opts.out && opts.files.length > 1) {
        throw new Error("--out works with one file at a time");
    }

    console.log("media-zst: " + command);
    let skipped = 0;
    for (const file of opts.files) {
        if (command === "compress") {
            if (compressOne(file, opts) === "skipped") skipped++;
        } else if (command === "decompress") {
            if (decompressOne(file, opts) === "skipped") skipped++;
        } else {
            checkOne(file);
        }
    }
    if (skipped) console.log("  (" + skipped + " skipped)");
    console.log("media-zst: done");
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error("media-zst: " + (err && err.message ? err.message : err));
        process.exit(1);
    }
}

module.exports = {
    ZSTD_MAGIC: ZSTD_MAGIC,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    RAW_BLOCK_MAX: RAW_BLOCK_MAX,
    hasZstd: hasZstd,
    rawFrame: rawFrame,
    isZstdFrame: isZstdFrame,
    zstName: zstName,
    rawName: rawName,
    decideWrite: decideWrite,
    compressBytes: compressBytes,
    decompressBytes: decompressBytes
};
