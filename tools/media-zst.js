#!/usr/bin/env node
/**
 * yaPDP media .zst packer/unpacker.
 *
 * The big disk and tape images in media/ are committed as <name>.<ext>.zst so
 * they fit GitHub's file limits, and the browser gets them back with fzstd
 * (assets/vendor/fzstd.js). Machine states (states/<name>.state.zst) are the
 * same kind of artefact with one twist: the page has no zstd COMPRESSOR, so a
 * snapshot exported in the browser is a gzip frame (CompressionStream), and
 * src/snapshots.js accepts either container. This tool is the repo-side half
 * of that contract for both of them:
 *
 *   node tools/media-zst.js compress   media/ra0.tap [more...] [--level 19] [--force]
 *   node tools/media-zst.js decompress media/ra0.tap.zst [--out media/ra0.tap] [--force]
 *   node tools/media-zst.js check      media/ra0.tap.zst [more...] [--canonical]
 *   node tools/media-zst.js repack     states/unix-v5.state.zst [--out <file>] [--force]
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
 * loads, byte for byte. A media image must be a real zstd frame — the image
 * loader is fzstd — so a gzip file named .dsk.zst is refused up front rather
 * than handed to the guest as garbage, a failure that would surface much later
 * than here. A .state.zst is judged by the rule its own loader uses and may be
 * either container, gzip included — the frames themselves are
 * src/state-frame.js's business, shared with every other reader.
 *
 * The repo still keeps its states in ONE frame, zstd: a browser export is gzip
 * (the page ships no zstd encoder) and gzip is the larger of the two, and one
 * artefact per kind is what makes `check`, a diff of two states and a CI guard
 * simple. `repack` is that canonicalisation — read the container out of
 * whatever frame arrived and write it back as zstd — and `check --canonical`
 * is the gate that keeps it true.
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
const { StateFrame } = require(path.join(ROOT, "src", "state-frame.js"));
const StateIO = require("./state-io.js");

// The frame magics and the "which container is this" answer live in
// src/state-frame.js — one home for every reader of a .zst in the repo, since
// the same question (zstd, gzip, or bare) is asked by the browser store, the
// state tools and this CLI. What stays HERE is this tool's own, stricter rule:
// a media IMAGE may only be zstd, because the browser reads images with fzstd.
const ZSTD_MAGIC = Buffer.from(StateFrame.ZSTD_MAGIC);
const GZIP_MAGIC = Buffer.from(StateFrame.GZIP_MAGIC);

const DEFAULT_LEVEL = 19;   // zstd's "high" preset: the repo's own images use it
const IMAGE_RE = /\.(dsk|tap|ptap|state)$/;

// --- pure helpers (unit-tested in tests/media-zst.test.js) -----------------

function isZstdFrame(buf) {
    return StateFrame.detect(buf) === "zstd";
}

function isGzipFrame(buf) {
    return StateFrame.detect(buf) === "gzip";
}

// Which container a buffer is, by magic alone: "zstd", "gzip", or null for
// anything else. Pure, so the CLI label and the tests share one answer.
function containerOf(buf) {
    return StateFrame.detect(buf);
}

// gzip is legal in a snapshot (src/snapshots.js decompresses it) and never in
// a media image (the image loader is fzstd). The file name says which it is.
function allowsGzip(file) {
    return /\.state\.zst$/i.test(String(file || ""));
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

// Decode a frame exactly the way the browser does: zstd through the very fzstd
// build the page loads, or — when the caller says the file is a snapshot —
// gzip through zlib, the same frame src/snapshots.js reads with
// DecompressionStream. `allowGzip` defaults to the media-image rule, because a
// gzip image would reach the guest as garbage instead of failing here.
function decompressBytes(zst, allowGzip) {
    const kind = containerOf(zst);
    if (kind === "zstd") {
        return Buffer.from(loadFzstd().decompress(new Uint8Array(zst)));
    }
    if (kind === "gzip" && allowGzip) {
        return zlib.gunzipSync(zst);
    }
    if (kind === "gzip") {
        throw new Error("gzip frame: only a .state.zst snapshot may carry one " +
            "(the browser exports states through CompressionStream); a media " +
            "image must be a zstd frame (magic 28 b5 2f fd)");
    }
    throw new Error("not a zstd frame (magic 28 b5 2f fd) — " +
        "a .zst made with another container will not load");
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
    "  node tools/media-zst.js check      <image.zst> [more...] [--canonical]",
    "  node tools/media-zst.js repack     <file.zst> [--out <file>] [--force]",
    "",
    "  compress    writes <image>.zst (skips an existing one unless --force)",
    "  decompress  writes <image> (refuses to overwrite unless --force)",
    "  check       decodes and reports, writes nothing (--canonical also fails",
    "              on a state whose frame is not the repo's zstd)",
    "  repack      rewrites a .state.zst in the canonical zstd frame — in place",
    "              by default, which is what a snapshot from the browser needs",
    "",
    "  Inputs are .dsk/.tap/.ptap/.state; the .zst keeps the whole original name.",
    "  A media image must be a zstd frame. A .state.zst may also be gzip,",
    "  which is what the browser writes when it exports a snapshot.",
].join("\n");

function parseArgs(argv) {
    const opts = { level: DEFAULT_LEVEL, force: false, out: null,
                   canonical: false, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") opts.force = true;
        else if (a === "--canonical") opts.canonical = true;
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
        throw new Error(file + " is not a disk/tape image or a state " +
            "(.dsk/.tap/.ptap/.state)");
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
    const bytes = decompressBytes(zst, allowsGzip(file));
    fs.writeFileSync(target, bytes);
    console.log("  write " + target + "  " + kb(zst.length) + " -> " +
        kb(bytes.length));
    return "written";
}

function checkOne(file, opts) {
    const zst = fs.readFileSync(file);
    const kind = containerOf(zst);
    const bytes = decompressBytes(zst, allowsGzip(file));
    console.log("  ok    " + file + "  " + kb(zst.length) + " -> " +
        kb(bytes.length) + " (" + (kind === "gzip" ? "gzip" : "fzstd") + ")");
    // A state read fine but kept in the WRONG frame: the browser's own export
    // is gzip, and the repo keeps its states as zstd. Reported always; with
    // --canonical it is also a failure, which is what CI wants.
    if (allowsGzip(file) && kind !== "zstd") {
        console.log("  note  " + file + " is " + (kind || "bare") +
            ", not the repo's canonical zstd — run: media-zst repack " + file);
        return opts.canonical ? "noncanonical" : "checked";
    }
    return "checked";
}

// Rewrite a .state.zst in the frame the repo keeps (zstd). IN PLACE by default:
// the input itself is the artefact being canonicalised, so the usual "skip an
// existing target" rule would make the command a no-op. `--out` writes
// elsewhere and then honours that rule.
function repackOne(file, opts) {
    if (!fs.existsSync(file)) throw new Error("no such file: " + file);
    if (!rawName(file)) throw new Error(file + " is not a .zst");
    if (!hasZstd()) {
        throw new Error("this Node has no zstd in zlib (22.15+ has it), so it " +
            "cannot write the canonical frame — repacking would only re-gzip");
    }
    const zst = fs.readFileSync(file);
    const frame = containerOf(zst);
    if (frame === "zstd") {
        console.log("  skip  " + file + " (already zstd)");
        return "skipped";
    }
    const target = opts.out || file;
    if (target !== file) {
        const decision = decideWrite(target, opts.force);
        if (!decision.write) {
            console.log("  skip  " + target + " (already there; --force to replace)");
            return "skipped";
        }
    }
    // The container under either frame, read and written through the shared
    // state modules — so a gzip export AND a bare container both repack, and
    // the writer's zstd -> gzip -> bare policy applies here like everywhere.
    const container = StateIO.readBytes(file).container;
    const written = StateIO.writeBytes(target, container);
    const size = fs.statSync(target).size;
    const saved = zst.length ? Math.round(100 - (size * 100) / zst.length) : 0;
    console.log("  write " + target + "  " + kb(zst.length) + " -> " + kb(size) +
        "  (" + (frame || "bare") + " -> " + written + ", " +
        (saved >= 0 ? "-" : "+") + Math.abs(saved) + "%)");
    return "written";
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
    if (command !== "compress" && command !== "decompress" &&
        command !== "check" && command !== "repack") {
        throw new Error("unknown command " + argv[0] + "\n\n" + USAGE);
    }
    const opts = parseArgs(argv.slice(1));
    if (!opts.files.length) throw new Error("no files given\n\n" + USAGE);
    if (opts.out && opts.files.length > 1) {
        throw new Error("--out works with one file at a time");
    }

    console.log("media-zst: " + command);
    let skipped = 0;
    let nonCanonical = 0;
    for (const file of opts.files) {
        if (command === "compress") {
            if (compressOne(file, opts) === "skipped") skipped++;
        } else if (command === "decompress") {
            if (decompressOne(file, opts) === "skipped") skipped++;
        } else if (command === "repack") {
            if (repackOne(file, opts) === "skipped") skipped++;
        } else if (checkOne(file, opts) === "noncanonical") {
            nonCanonical++;
        }
    }
    if (skipped) console.log("  (" + skipped + " skipped)");
    if (nonCanonical) {
        console.log("  (" + nonCanonical + " not canonical — run: media-zst repack)");
        process.exitCode = 1;   // --canonical is a CI gate, not a report
    }
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
    GZIP_MAGIC: GZIP_MAGIC,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    RAW_BLOCK_MAX: RAW_BLOCK_MAX,
    hasZstd: hasZstd,
    rawFrame: rawFrame,
    isZstdFrame: isZstdFrame,
    isGzipFrame: isGzipFrame,
    containerOf: containerOf,
    allowsGzip: allowsGzip,
    zstName: zstName,
    rawName: rawName,
    decideWrite: decideWrite,
    compressBytes: compressBytes,
    decompressBytes: decompressBytes
};
