#!/usr/bin/env node
/**
 * tools/tape-archive.js tests.
 *
 * Two layers are pinned here, because a guest depends on both byte for byte.
 *
 * The container is what the emulated TM11 walks: every record is
 * [length][data][length] with the trailing copy acting as the next record's
 * length field — the arithmetic in src/devices/tm11.js (`position + 4 +
 * address`, rounded to even) lands exactly on that shared field — and a zero
 * length is a tape mark, which is how iopage.js reads EOF.
 *
 * The payloads are the Unix V5 tp directory (twelve 40-byte entries in block
 * 0, files addressed by block) and a v7 tar stream (512-byte headers with the
 * checksum rule, two zero blocks at the end).
 *
 * Run with:  node tests/tape-archive.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "tape-archive.js");
const Tape = require(TOOL);

function bytes(n, seed) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 7 + (seed || 0)) & 0xff;
    return b;
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-tape-"));
}

const SAMPLES = [
    { name: "one.c", bytes: bytes(1, 3) },
    { name: "block.c", bytes: bytes(Tape.BSIZE, 4) },
    { name: "big.c", bytes: bytes(1500, 5) }
];

function run() {
    // ---- the container: shared length fields, one per block ------------
    {
        const rec = Tape.record(bytes(Tape.BSIZE, 1));
        assert.strictEqual(rec.length, Tape.BSIZE + 8);
        assert.strictEqual(rec.readUInt32LE(0), Tape.BSIZE);
        assert.strictEqual(rec.readUInt32LE(4 + Tape.BSIZE), Tape.BSIZE,
            "the trailing length must repeat the record length");

        const tape = Tape.buildTape(bytes(Tape.BSIZE * 2, 2));
        assert.strictEqual(tape.readUInt32LE(0), Tape.BSIZE);
        // The TM11 walk: position + 4 + address lands on the next length.
        assert.strictEqual(tape.readUInt32LE(4 + Tape.BSIZE), Tape.BSIZE);
    }

    // ---- tp: round trip through the directory --------------------------
    {
        const tape = Tape.buildArchive(SAMPLES, "tp");
        const parsed = Tape.parseTape(tape);
        assert.ok(parsed.endedByTapeMark, "the tape must end with a tape mark");
        // One directory record + 1 + 1 + 3 data blocks.
        assert.strictEqual(parsed.records.length, 6);
        assert.strictEqual(parsed.blocks.length, 6, "one block per record");
        const last = parsed.records[parsed.records.length - 1];
        const mark = last.offset + 4 + last.length + 4;
        assert.strictEqual(tape.readUInt32LE(mark), 0,
            "the tape mark must follow the last record");
        assert.strictEqual(tape.readUInt32LE(mark + 4), 0,
            "and a second one ends the medium, as SIMH writes it");

        const archive = Tape.readArchive(parsed.blocks);
        assert.strictEqual(archive.format, "tp", "a tp tape must be detected");
        assert.deepStrictEqual(archive.files.map((f) => f.name),
            ["one.c", "block.c", "big.c"]);
        for (let i = 0; i < SAMPLES.length; i++) {
            assert.ok(archive.files[i].bytes.equals(SAMPLES[i].bytes),
                SAMPLES[i].name + " must come back byte for byte");
            assert.strictEqual(archive.files[i].size, SAMPLES[i].bytes.length);
        }
        const dir = Tape.parseDirectory(parsed.blocks[0]);
        assert.deepStrictEqual(dir.map((e) => e.startBlock), [1, 2, 3],
            "files are addressed by block, the directory owns block 0");
    }

    // ---- tp: a 32-character name has no terminator to hide behind ------
    {
        const name = "x".repeat(Tape.NAME_MAX_TP);
        const back = Tape.readArchive(Tape.parseTape(
            Tape.buildArchive([{ name: name, bytes: bytes(4) }], "tp")).blocks);
        assert.strictEqual(back.files[0].name, name);
        assert.throws(() => Tape.buildArchive(
            [{ name: name + "y", bytes: bytes(4) }], "tp"),
            /name too long/, "33 characters do not fit the tp directory");
    }

    // ---- tp: the directory is one block, so twelve files, no more ------
    {
        const twelve = [];
        for (let i = 0; i < Tape.DIR_MAX; i++) {
            twelve.push({ name: "f" + i + ".c", bytes: bytes(3, i) });
        }
        assert.strictEqual(Tape.readArchive(Tape.parseTape(
            Tape.buildArchive(twelve, "tp")).blocks).files.length, Tape.DIR_MAX);
        const thirteen = twelve.concat([{ name: "f12.c", bytes: bytes(3) }]);
        assert.throws(() => Tape.buildArchive(thirteen, "tp"),
            /holds 12 files/, "a thirteenth file must be refused");
    }

    // ---- tp: one record per file also reads ----------------------------
    {
        const raw = Buffer.concat([bytes(700, 6), bytes(300, 7)]);
        const dir = Buffer.alloc(Tape.BSIZE);
        dir.write("legacy.bin", 0, "ascii");
        dir.writeUInt16LE(Tape.MODE_FILE, 32);
        dir.writeUInt32LE(raw.length, 34);
        dir.writeUInt16LE(1, 38);
        const legacy = Buffer.concat([
            Tape.record(dir), Tape.record(Tape.padToBlock(raw)),
            Buffer.alloc(4), Buffer.alloc(4)
        ]);
        const back = Tape.readArchive(Tape.parseTape(legacy).blocks);
        assert.strictEqual(back.format, "tp");
        assert.ok(back.files[0].bytes.equals(raw),
            "a one-record-per-file tape must still read correctly");
    }

    // ---- tar: round trip, checksum and the closing zero blocks ---------
    {
        const files = SAMPLES.map((f, i) =>
            ({ name: f.name, bytes: f.bytes, mtime: 1000000 + i }));
        const tar = Tape.buildTar(files);
        assert.strictEqual(tar.length % Tape.BSIZE, 0, "tar is block aligned");
        assert.strictEqual(tar.subarray(148, 154).toString("ascii"),
            Tape.tarChecksum(tar.subarray(0, Tape.BSIZE)).toString(8).padStart(6, "0"),
            "the header must carry its own checksum");
        assert.strictEqual(tar[154], 0, "six digits, then NUL");
        assert.strictEqual(tar[155], 0x20, "and a space, as tar writes it");
        assert.ok(tar.subarray(tar.length - Tape.BSIZE).every((b) => b === 0),
            "the archive must end with zero blocks");

        const read = Tape.readTar(tar);
        assert.deepStrictEqual(read.files.map((f) => f.name),
            files.map((f) => f.name));
        for (let i = 0; i < files.length; i++) {
            assert.ok(read.files[i].bytes.equals(files[i].bytes),
                files[i].name + " must come back byte for byte");
            assert.strictEqual(read.files[i].mtime, files[i].mtime);
        }
        assert.ok(read.endedByZeroBlocks);

        // A corrupted header must be reported, not silently accepted.
        const broken = Buffer.from(tar);
        broken[0] = broken[0] === 0x41 ? 0x42 : 0x41;
        assert.throws(() => Tape.readTar(broken), /checksum mismatch/);
        assert.throws(() => Tape.buildTar([{ name: "n".repeat(101), bytes: bytes(1) }]),
            /name too long for tar/);
    }

    // ---- tar on a tape: detected, listed, extracted --------------------
    {
        const tape = Tape.buildArchive(SAMPLES, "tar");
        const parsed = Tape.parseTape(tape);
        assert.strictEqual(Tape.detectFormat(parsed.blocks), "tar",
            "the checksum must decide, not the first name");
        const archive = Tape.readArchive(parsed.blocks);
        assert.strictEqual(archive.format, "tar");
        assert.deepStrictEqual(archive.files.map((f) => f.name),
            SAMPLES.map((f) => f.name));
        assert.ok(archive.files[2].bytes.equals(SAMPLES[2].bytes));
        // The two payloads are told apart, not guessed at.
        assert.strictEqual(Tape.detectFormat(
            Tape.parseTape(Tape.buildArchive(SAMPLES, "tp")).blocks), "tp");
    }

    // ---- a truncated tape stops, and says what it lost -----------------
    {
        for (const format of ["tp", "tar"]) {
            const tape = Tape.buildArchive([{ name: "a.c", bytes: bytes(600) }],
                format);
            // The same damage to both tapes: the last record is cut in half.
            // What it costs depends on the layout, and so does the answer.
            const parsed = Tape.parseTape(tape.subarray(0, tape.length - 40));
            assert.ok(parsed.records.length > 0,
                format + ": the walk must stop, not hang");
            if (format === "tp") {
                assert.throws(() => Tape.readArchive(parsed.blocks), /short/,
                    "tp: the truncated record held data, so the read must fail");
            } else {
                const archived = Tape.readArchive(parsed.blocks);
                assert.ok(archived.files[0].bytes.equals(bytes(600)),
                    "tar: the file survives, only a closing block was lost");
                assert.strictEqual(archived.terminated, false,
                    "tar: and the archive must admit it has no closing blocks");
            }
        }
        assert.strictEqual(Tape.detectFormat([Buffer.alloc(Tape.BSIZE)]), null,
            "an empty block is neither format");
    }

    // ---- the CLI: pack, list, unpack for both formats ------------------
    {
        const dir = tmpdir();
        try {
            const src = path.join(dir, "src");
            fs.mkdirSync(src);
            fs.writeFileSync(path.join(src, "hello.c"), bytes(700, 8));
            for (const format of ["tp", "tar"]) {
                const tape = path.join(dir, format + ".tap");
                const packed = spawnSync(process.execPath,
                    [TOOL, "pack", tape, path.join(src, "hello.c"),
                        "--format", format],
                    { cwd: ROOT, encoding: "utf8" });
                assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);

                const listed = spawnSync(process.execPath,
                    [TOOL, "list", tape], { cwd: ROOT, encoding: "utf8" });
                assert.strictEqual(listed.status, 0, listed.stderr);
                assert.ok(/hello\.c/.test(listed.stdout), listed.stdout);
                assert.ok(/record\(s\)/.test(listed.stdout) &&
                    /block\(s\)/.test(listed.stdout), listed.stdout);

                const out = path.join(dir, "back-" + format);
                const unpacked = spawnSync(process.execPath,
                    [TOOL, "unpack", tape, "--dir", out],
                    { cwd: ROOT, encoding: "utf8" });
                assert.strictEqual(unpacked.status, 0, unpacked.stderr);
                assert.ok(fs.readFileSync(path.join(out, "hello.c"))
                    .equals(bytes(700, 8)), format + ": the CLI must reproduce the file");

                const again = spawnSync(process.execPath,
                    [TOOL, "pack", tape, path.join(src, "hello.c")],
                    { cwd: ROOT, encoding: "utf8" });
                assert.strictEqual(again.status, 1,
                    "an existing tape must not be clobbered");
                assert.ok(/use --force/.test(again.stdout + again.stderr),
                    again.stdout + again.stderr);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    console.log("tape-archive tests passed");
}

run();
