#!/usr/bin/env node
/**
 * yaPDP magnetic-tape archive packer/unpacker.
 *
 * Builds a tape image the emulated TM11 can mount, with either of the two
 * archive layouts a PDP-11 Unix guest expects to find on it:
 *
 *   node tools/tape-archive.js pack   <out.tap> <file...> [--format tp|tar] [--force]
 *   node tools/tape-archive.js unpack <in.tap> [--dir <dir>] [--format tp|tar] [--force]
 *   node tools/tape-archive.js list   <in.tap> [--format tp|tar]
 *
 * npm scripts: `npm run tape:pack -- out.tap a.c`, `npm run tape:unpack -- out.tap`.
 *
 * The tape has two layers, and both are written down here because a guest
 * depends on them byte for byte.
 *
 * 1. The container is a SIMH tape image: every record is stored as
 *
 *        [length: u32 LE][data][length: u32 LE]
 *
 *    and the trailing copy is the same field the next record starts with,
 *    which is what lets the TM11 walk a tape both ways (the position
 *    arithmetic in src/devices/tm11.js lands exactly on that shared field).
 *    A zero length is a tape mark — iopage.js reads EOF from it — and the end
 *    of the image carries a second zero, the end-of-medium mark SIMH writes.
 *    The payload is written one 512-byte record per block, which is what a
 *    guest asking for a 512-byte read expects to receive; the reader is
 *    tolerant the other way round and flattens whatever records it finds into
 *    blocks before looking at the payload.
 *
 * 2. The payload is one of two archives:
 *
 *    tp   block 0 holds the Unix V5 tp directory: up to twelve 40-byte
 *         entries of name[32], mode u16, size u32 (bytes) and first block u16,
 *         followed by the file contents, addressed by block.
 *
 *    tar  a v7 tar stream — 512-byte headers (name[100], mode, uid, gid,
 *         size, mtime, checksum, linkflag; no magic or version, so both the
 *         V7-era tar and GNU tar read it) with the data padded to 512 bytes
 *         per file and two zero blocks at the end.
 *
 * `unpack` and `list` detect which of the two a tape carries — the tar
 * checksum decides it, so a misdetection needs a corrupt header rather than an
 * unlucky name — and `--format` overrides the guess.
 *
 * The tp directory follows what the V5 tp utility documents. It has not been
 * checked against a tape written by a real V5 tp, and no guest has read one of
 * ours yet: the framing and both round trips are tested, the historical side
 * is not. The tar layout, by contrast, is the ordinary one.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const BSIZE = 512;                  // tape block size, archive block size
const TAPE_MARK = Buffer.alloc(4);  // a zero length field is a tape mark

// tp payload constants
const DIR_ENTRY = 40;               // one tp directory entry
const DIR_MAX = 12;                 // twelve 40-byte entries fit one block
const MODE_FILE = 0o100644;         // regular file, rw-r--r--

// tar payload constants (v7 layout)
const TAR_NAME_MAX = 100;
const TAR_MODE_FILE = 0o644;

// --- container -------------------------------------------------------------

function record(data) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length, 0);
    return Buffer.concat([len, data, len]);
}

function blockOf(buf, index) {
    const out = Buffer.alloc(BSIZE);
    buf.copy(out, 0, index * BSIZE, Math.min((index + 1) * BSIZE, buf.length));
    return out;
}

function padToBlock(bytes) {
    const padded = Buffer.alloc(Math.ceil(bytes.length / BSIZE) * BSIZE || BSIZE);
    bytes.copy(padded);
    return padded;
}

// Read a tape image into { records, blocks, endedByTapeMark }. Tolerant on
// purpose: a length is trusted only when the trailing copy agrees, and the
// walk stops at a tape mark or at the first byte that does not form a record.
function parseTape(buf) {
    const records = [];
    const blocks = [];
    let pos = 0;
    let endedByTapeMark = false;
    while (pos + 4 <= buf.length) {
        const len = buf.readUInt32LE(pos);
        if (len === 0) { endedByTapeMark = true; break; }
        if (len > buf.length - pos - 8) break;              // truncated record
        const data = buf.subarray(pos + 4, pos + 4 + len);
        records.push({ offset: pos, length: len, data });
        for (let i = 0; i < len; i += BSIZE) {
            blocks.push(blockOf(data, i / BSIZE));
        }
        const trailer = buf.readUInt32LE(pos + 4 + len);
        if (trailer !== len) break;                         // framing is broken
        pos += 4 + len + 4;
    }
    return { records, blocks, endedByTapeMark };
}

// Whole tape for a payload, one 512-byte record per block.
function buildTape(payload) {
    const parts = [];
    for (let i = 0; i < payload.length; i += BSIZE) {
        parts.push(record(blockOf(payload, i / BSIZE)));
    }
    parts.push(TAPE_MARK);      // end of data
    parts.push(TAPE_MARK);      // end of medium, the way SIMH writes it
    return Buffer.concat(parts);
}

// --- tp payload ------------------------------------------------------------

const NAME_MAX_TP = 32;             // NUL padded, no terminator when exactly 32

function parseDirectory(block) {
    const entries = [];
    for (let i = 0; i < DIR_MAX; i++) {
        const at = i * DIR_ENTRY;
        const raw = block.subarray(at, at + NAME_MAX_TP);
        const end = raw.indexOf(0);
        const name = raw.subarray(0, end === -1 ? NAME_MAX_TP : end).toString("ascii");
        const mode = block.readUInt16LE(at + 32);
        const size = block.readUInt32LE(at + 34);
        const startBlock = block.readUInt16LE(at + 38);
        if (!name) break;
        entries.push({ name, mode, size, startBlock });
    }
    return entries;
}

function buildTp(files) {
    if (files.length > DIR_MAX) {
        throw new Error("a tp tape holds " + DIR_MAX + " files, got " + files.length);
    }
    const dir = Buffer.alloc(BSIZE);
    let at = 0;
    let blockNo = 1;                // block 0 holds the directory itself
    const parts = [];
    for (const file of files) {
        if (file.name.length > NAME_MAX_TP) {
            throw new Error("name too long for tp (" + file.name.length + " > " +
                NAME_MAX_TP + "): " + file.name);
        }
        dir.write(file.name, at, "ascii");
        dir.writeUInt16LE(MODE_FILE, at + 32);
        dir.writeUInt32LE(file.bytes.length, at + 34);
        dir.writeUInt16LE(blockNo, at + 38);
        file.startBlock = blockNo;
        blockNo += Math.max(1, Math.ceil(file.bytes.length / BSIZE));
        at += DIR_ENTRY;
    }
    if (blockNo - 1 > 0xffff) {
        throw new Error("the tape would need " + (blockNo - 1) +
            " blocks; a tp directory addresses 16 bits of them");
    }
    parts.push(dir);
    for (const file of files) {
        parts.push(padToBlock(file.bytes));
    }
    return Buffer.concat(parts);
}

function readTp(blocks) {
    const dir = parseDirectory(blocks[0] || Buffer.alloc(BSIZE));
    const flat = Buffer.concat(blocks);
    return dir.map((entry) => {
        const from = entry.startBlock * BSIZE;
        const bytes = flat.subarray(from, from + entry.size);
        if (bytes.length !== entry.size) {
            throw new Error("tape is short for " + entry.name + ": expected " +
                entry.size + " bytes, found " + bytes.length);
        }
        return { name: entry.name, mode: entry.mode, size: entry.size,
            startBlock: entry.startBlock, bytes };
    });
}

// --- tar payload (v7 layout: no magic, no version) -------------------------

function writeOctal(buf, offset, length, value) {
    const digits = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
    buf.write(digits, offset, "ascii");
    buf[offset + length - 1] = 0;
}

function readOctal(buf, offset, length) {
    const text = buf.subarray(offset, offset + length).toString("ascii")
        .replace(/\0.*$/, "").trim();
    return text ? parseInt(text, 8) : 0;
}

// The checksum is taken with its own field read as spaces — that is the rule
// every tar implementation follows, and the reason detection can trust it.
function tarChecksum(header) {
    let sum = 0;
    for (let i = 0; i < BSIZE; i++) {
        sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    }
    return sum;
}

function tarHeader(file, mtime) {
    const h = Buffer.alloc(BSIZE);
    h.write(file.name, 0, "ascii");
    writeOctal(h, 100, 8, file.mode || TAR_MODE_FILE);
    writeOctal(h, 108, 8, 0);                  // uid
    writeOctal(h, 116, 8, 0);                  // gid
    writeOctal(h, 124, 12, file.bytes.length);
    writeOctal(h, 136, 12, mtime);
    h.fill(0x20, 148, 156);                    // checksum field: spaces while summing
    h[156] = 0;                                // v7 pipes tar: ordinary file
    writeOctal(h, 329, 8, 0);                  // devmajor
    writeOctal(h, 337, 8, 0);                  // devminor
    h.write(tarChecksum(h).toString(8).padStart(6, "0"), 148, "ascii");
    h[154] = 0;                                // six digits, NUL, space
    h[155] = 0x20;
    return h;
}

function buildTar(files) {
    const parts = [];
    for (const file of files) {
        if (file.name.length > TAR_NAME_MAX) {
            throw new Error("name too long for tar (" + file.name.length +
                " > " + TAR_NAME_MAX + "): " + file.name);
        }
        parts.push(tarHeader(file, file.mtime || 0));
        parts.push(padToBlock(file.bytes));
    }
    parts.push(Buffer.alloc(BSIZE * 2));       // two zero blocks end an archive
    return Buffer.concat(parts);
}

function readTar(bytes) {
    const files = [];
    let pos = 0;
    let zeroBlocks = 0;
    while (pos + BSIZE <= bytes.length) {
        const h = bytes.subarray(pos, pos + BSIZE);
        if (h.every((b) => b === 0)) {
            zeroBlocks++;
            pos += BSIZE;
            if (zeroBlocks >= 2) break;
            continue;
        }
        const stored = readOctal(h, 148, 8);
        if (stored !== tarChecksum(h)) {
            throw new Error("tar header checksum mismatch at block " +
                (pos / BSIZE) + ": stored " + stored + ", computed " +
                tarChecksum(h));
        }
        const name = h.subarray(0, TAR_NAME_MAX).toString("ascii")
            .replace(/\0.*$/, "");
        if (!name) {
            throw new Error("tar header without a name at block " + (pos / BSIZE));
        }
        const size = readOctal(h, 124, 12);
        pos += BSIZE;
        const data = bytes.subarray(pos, pos + size);
        if (data.length !== size) {
            throw new Error("tar is short for " + name + ": expected " +
                size + " bytes, found " + data.length);
        }
        files.push({
            name: name, mode: readOctal(h, 100, 8) || TAR_MODE_FILE,
            size: size, mtime: readOctal(h, 136, 12), bytes: data
        });
        pos += Math.ceil(size / BSIZE) * BSIZE;
    }
    return { files, endedByZeroBlocks: zeroBlocks >= 2 };
}

// --- payload detection -----------------------------------------------------

function looksLikeTar(block) {
    if (!block || block.length < BSIZE) return false;
    if (readOctal(block, 148, 8) !== tarChecksum(block)) return false;
    const name = block.subarray(0, TAR_NAME_MAX).toString("ascii")
        .replace(/\0.*$/, "");
    return name.length > 0 && /^[\x20-\x7e]+$/.test(name);
}

function looksLikeTp(block) {
    const entries = parseDirectory(block);
    if (!entries.length) return false;
    return entries.every((entry) =>
        /^[\x20-\x7e]+$/.test(entry.name) &&
        (entry.mode & 0o170000) === 0o100000 &&
        entry.startBlock >= 1 && entry.size < 0x7fffffff);
}

// The tar checksum decides first: a false positive would need a header that
// sums to its own checksum field, while tp entries are only plausible-looking.
function detectFormat(blocks) {
    if (!blocks.length) return null;
    if (looksLikeTar(blocks[0])) return "tar";
    if (looksLikeTp(blocks[0])) return "tp";
    return null;
}

// --- whole-archive helpers (used by the CLI and the tests) ------------------

function buildArchive(files, format) {
    const payload = (format === "tar") ? buildTar(files) : buildTp(files);
    return buildTape(payload);
}

function readArchive(blocks, format) {
    const kind = format || detectFormat(blocks);
    if (!kind) {
        throw new Error("this tape is neither a tp directory nor a tar archive");
    }
    if (kind === "tar") {
        const tar = readTar(Buffer.concat(blocks));
        return { format: "tar", files: tar.files, terminated: tar.endedByZeroBlocks };
    }
    return { format: "tp", files: readTp(blocks), terminated: true };
}

// --- CLI -------------------------------------------------------------------

const USAGE = [
    "usage:",
    "  node tools/tape-archive.js pack   <out.tap> <file...> [--format tp|tar] [--force]",
    "  node tools/tape-archive.js unpack <in.tap> [--dir <dir>] [--format tp|tar] [--force]",
    "  node tools/tape-archive.js list   <in.tap> [--format tp|tar]",
    "",
    "  pack    writes a SIMH tape with a tp directory (twelve files, names up",
    "          to 32 chars) or a v7 tar stream, one 512-byte record per block",
    "  unpack  extracts the files, detected by the tape itself unless --format says",
    "  list    prints the contents without writing anything",
].join("\n");

function parseArgs(argv) {
    const opts = { force: false, dir: null, format: null, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") opts.force = true;
        else if (a === "--dir") opts.dir = argv[++i];
        else if (a === "--format") opts.format = argv[++i];
        else if (a.startsWith("-")) throw new Error("unknown option " + a);
        else opts.files.push(a);
    }
    if (opts.format && opts.format !== "tp" && opts.format !== "tar") {
        throw new Error("--format takes tp or tar, not " + opts.format);
    }
    return opts;
}

function readTapeBytes(file) {
    if (!fs.existsSync(file)) throw new Error("no such file: " + file);
    return fs.readFileSync(file);
}

function packOne(out, inputs, opts) {
    if (fs.existsSync(out) && !opts.force) {
        throw new Error(out + " exists (use --force to replace)");
    }
    const format = opts.format || "tp";
    const files = inputs.map((file) => {
        if (!fs.existsSync(file)) throw new Error("no such file: " + file);
        const stats = fs.statSync(file);
        return {
            name: path.basename(file),
            bytes: fs.readFileSync(file),
            mtime: Math.floor(stats.mtimeMs / 1000)
        };
    });
    const tape = buildArchive(files, format);
    fs.writeFileSync(out, tape);
    console.log("  write " + out + "  " + format + ", " + files.length +
        " file(s), " + (tape.length / 1024).toFixed(1) + " kB");
    for (const file of files) {
        console.log("        " + file.name + "  " + file.bytes.length + " bytes" +
            (file.startBlock ? ", from block " + file.startBlock : ""));
    }
}

function unpackOne(input, opts) {
    const parsed = parseTape(readTapeBytes(input));
    if (!parsed.endedByTapeMark) {
        console.log("  note  " + input + " has no tape mark at the end");
    }
    const archive = readArchive(parsed.blocks, opts.format);
    if (!archive.files.length) {
        throw new Error(input + " has an empty " + archive.format + " archive");
    }
    console.log("  tape  " + input + " is " + archive.format);
    if (archive.terminated === false) {
        console.log("  note  the archive has no closing zero blocks " +
            "(the files above are complete)");
    }
    const dir = opts.dir || path.dirname(input);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of archive.files) {
        const out = path.join(dir, file.name);
        if (fs.existsSync(out) && !opts.force) {
            console.log("  skip  " + out + " (already there; --force to replace)");
            continue;
        }
        fs.writeFileSync(out, file.bytes);
        console.log("  write " + out + "  " + file.size + " bytes");
    }
}

function listOne(input, opts) {
    const parsed = parseTape(readTapeBytes(input));
    const archive = readArchive(parsed.blocks, opts.format);
    console.log("  " + input + ": " + archive.format + ", " +
        parsed.records.length + " record(s), " + parsed.blocks.length +
        " block(s), " + (parsed.endedByTapeMark ? "tape mark at the end"
            : "no tape mark"));
    if (archive.format === "tar") {
        console.log("  name                                       mode     size   date");
        for (const file of archive.files) {
            const date = file.mtime
                ? new Date(file.mtime * 1000).toISOString().slice(0, 10) : "-";
            console.log("  " + file.name.padEnd(40) + "  0" +
                file.mode.toString(8) + "  " + String(file.size).padStart(6) +
                "  " + date);
        }
        if (!archive.terminated) {
            console.log("  note: the archive has no closing zero blocks");
        }
    } else {
        console.log("  name                              mode      size   block");
        for (const file of archive.files) {
            console.log("  " + file.name.padEnd(32) + "  0" +
                file.mode.toString(8) + "  " + String(file.size).padStart(6) +
                "  " + String(file.startBlock).padStart(5));
        }
    }
    if (!archive.files.length) console.log("  (empty archive)");
}

function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
        console.log(USAGE);
        return;
    }
    const command = argv[0];
    if (command !== "pack" && command !== "unpack" && command !== "list") {
        throw new Error("unknown command " + command + "\n\n" + USAGE);
    }
    const opts = parseArgs(argv.slice(1));
    if (!opts.files.length) throw new Error("no tape given\n\n" + USAGE);

    console.log("tape-archive: " + command);
    if (command === "pack") {
        if (opts.files.length < 2) {
            throw new Error("pack needs at least one file to put on the tape");
        }
        packOne(opts.files[0], opts.files.slice(1), opts);
    } else {
        for (const file of opts.files) {
            if (command === "unpack") unpackOne(file, opts);
            else listOne(file, opts);
        }
    }
    console.log("tape-archive: done");
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error("tape-archive: " + (err && err.message ? err.message : err));
        process.exit(1);
    }
}

module.exports = {
    BSIZE: BSIZE,
    DIR_ENTRY: DIR_ENTRY,
    DIR_MAX: DIR_MAX,
    NAME_MAX_TP: NAME_MAX_TP,
    TAR_NAME_MAX: TAR_NAME_MAX,
    MODE_FILE: MODE_FILE,
    record: record,
    parseTape: parseTape,
    buildTape: buildTape,
    padToBlock: padToBlock,
    parseDirectory: parseDirectory,
    buildTp: buildTp,
    readTp: readTp,
    tarChecksum: tarChecksum,
    buildTar: buildTar,
    readTar: readTar,
    looksLikeTar: looksLikeTar,
    looksLikeTp: looksLikeTp,
    detectFormat: detectFormat,
    buildArchive: buildArchive,
    readArchive: readArchive
};
