#!/usr/bin/env node
/**
 * tools/media-zst.js tests.
 *
 * The tool exists so that media/*.zst is produced the way the emulator can read
 * it back: a real zstd frame, decoded by the very fzstd build the browser loads
 * (assets/vendor/fzstd.js). These tests hold that promise on the pure helpers
 * (frame check, naming, overwrite decision), on a round trip, and on a real
 * committed image.
 *
 * Run with:  node tests/media-zst.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const TOOL = path.join(ROOT, "tools", "media-zst.js");
const MediaZst = require(TOOL);

// A small, structured buffer: disk-like sectors with a bit of variety, so the
// compressor has something to chew on and a corrupted byte would show.
function sampleBytes() {
    const buf = Buffer.alloc(64 * 1024);
    for (let i = 0; i < buf.length; i += 4) {
        buf.writeUInt32LE((i / 4) % 251, i);
    }
    buf.write("yaPDP media image\n", 512, "utf8");
    return buf;
}

// The smallest committed .zst — decoded in full, so the test proves the tool
// can read the repo's own artefacts, not just its own output.
function smallestCommittedZst() {
    const zsts = fs.readdirSync(MEDIA)
        .filter((f) => f.endsWith(".zst"))
        .map((f) => ({ file: path.join(MEDIA, f), size: fs.statSync(path.join(MEDIA, f)).size }))
        .sort((a, b) => a.size - b.size);
    assert.ok(zsts.length > 0, "media/ should hold at least one .zst image");
    return zsts[0];
}

function run() {
    // ---- naming: the .zst keeps the whole original name ----------------
    {
        assert.strictEqual(MediaZst.zstName("media/ra0.tap"), "media/ra0.tap.zst");
        assert.strictEqual(MediaZst.zstName("media/rk5.dsk"), "media/rk5.dsk.zst");
        assert.throws(() => MediaZst.zstName("media/ra0.tap.zst"),
            /already compressed/, "a .zst must not be compressed twice");
        assert.strictEqual(MediaZst.rawName("media/ra0.tap.zst"), "media/ra0.tap");
        assert.strictEqual(MediaZst.rawName("media/ra0.tap"), null,
            "a raw image has no .zst to strip");
    }

    // ---- the frame check is what keeps a gzip file out of media/ -------
    {
        const gzip = zlib.gzipSync(sampleBytes());
        assert.strictEqual(MediaZst.isZstdFrame(gzip), false,
            "gzip output must not pass as a zstd frame");
        assert.throws(() => MediaZst.decompressBytes(gzip),
            /not a zstd frame/, "the tool must refuse a foreign container");
        assert.strictEqual(MediaZst.isZstdFrame(Buffer.alloc(0)), false);
        assert.strictEqual(MediaZst.isZstdFrame(undefined), false);
    }

    // ---- round trip: Node compresses, fzstd decodes --------------------
    {
        const raw = sampleBytes();
        const frame = MediaZst.compressBytes(raw, 19);
        assert.ok(MediaZst.isZstdFrame(frame), "output must be a zstd frame");
        assert.ok(frame.length < raw.length, "the sample should actually shrink");
        assert.ok(MediaZst.decompressBytes(frame).equals(raw),
            "fzstd must return exactly what went in");
        // The default level is the repo's own: 19.
        assert.strictEqual(MediaZst.DEFAULT_LEVEL, 19);
        assert.ok(MediaZst.compressBytes(raw).equals(
            MediaZst.compressBytes(raw, MediaZst.DEFAULT_LEVEL)),
            "an omitted level must mean the default level");
    }

    // ---- a real committed image survives the same path -----------------
    {
        const shot = smallestCommittedZst();
        const bytes = MediaZst.decompressBytes(fs.readFileSync(shot.file));
        assert.ok(bytes.length > 0, shot.file + " should decode to something");
        const repacked = MediaZst.compressBytes(bytes, 19);
        assert.ok(MediaZst.decompressBytes(repacked).equals(bytes),
            "a repacked image must decode to the same bytes");
    }

    // ---- overwrite decision: never clobber by accident -----------------
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-mediazst-"));
        try {
            const newTarget = path.join(tmp, "new.zst");
            assert.deepStrictEqual(MediaZst.decideWrite(newTarget, false),
                { write: true, reason: "new" });

            const existing = path.join(tmp, "there.zst");
            fs.writeFileSync(existing, "x");
            assert.deepStrictEqual(MediaZst.decideWrite(existing, false),
                { write: false, reason: "exists" });
            assert.deepStrictEqual(MediaZst.decideWrite(existing, true),
                { write: true, reason: "forced" });
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // ---- the CLI itself: `check` on a committed image, exit 0 ----------
    {
        const shot = smallestCommittedZst();
        const r = spawnSync(process.execPath, [TOOL, "check", path.relative(ROOT, shot.file)],
            { cwd: ROOT, encoding: "utf8" });
        assert.strictEqual(r.status, 0, "check should exit 0: " + r.stderr);
        assert.ok(/ok\s+.*\(fzstd\)/.test(r.stdout),
            "check should report the fzstd decode: " + r.stdout);

        // and an existing target is left alone rather than clobbered
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-mediazst-cli-"));
        try {
            const zst = path.join(tmp, "img.tap.zst");
            const raw = path.join(tmp, "img.tap");
            fs.copyFileSync(shot.file, zst);
            fs.writeFileSync(raw, "already here");
            const keep = spawnSync(process.execPath,
                [TOOL, "decompress", path.relative(ROOT, zst)],
                { cwd: ROOT, encoding: "utf8" });
            assert.strictEqual(keep.status, 0,
                "a skip is not a failure: " + keep.stderr);
            assert.ok(/already there/.test(keep.stdout + keep.stderr),
                "the skip should say why: " + keep.stdout + keep.stderr);
            assert.strictEqual(fs.readFileSync(raw, "utf8"), "already here",
                "the existing file must not be overwritten");

            // --force is the only way through
            const forced = spawnSync(process.execPath,
                [TOOL, "decompress", path.relative(ROOT, zst), "--force"],
                { cwd: ROOT, encoding: "utf8" });
            assert.strictEqual(forced.status, 0, forced.stderr);
            assert.ok(fs.readFileSync(raw).length > 10,
                "with --force the image is really unpacked");
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    console.log("media-zst tests passed");
}

run();
