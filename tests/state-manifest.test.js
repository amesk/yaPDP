#!/usr/bin/env node
/**
 * tools/state-manifest.js tests.
 *
 * The tool edits the manifest inside a .state.zst, and the FRAME around the
 * container depends on who wrote the file: the Node tools and the repo's own
 * states/ are zstd, an export from the browser is gzip (the page has only
 * CompressionStream, no zstd compressor), and a Node without zstd leaves the
 * container bare. All three have to open — the browser-made state is the
 * artefact a user actually holds — so this test builds one fixture of each
 * kind and drives the real CLI over it, the way tests/e2e-share.js drives it
 * over a committed state. `replace` is held to the policy too: zstd where
 * available, gzip otherwise, never bare.
 *
 * Run with:  node tests/state-manifest.test.js
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
const TOOL = path.join(ROOT, "tools", "state-manifest.js");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const { StateFrame } = require(path.join(ROOT, "src", "state-frame.js"));

const MANIFEST = {
    schemaVersion: 1,
    label: "fixture",
    device: "rk1",
    createdAt: "2026-01-01T00:00:00.000Z",
};

// Memory travels as raw little-endian words; a couple of sectors are enough to
// prove the bytes survive the round trip.
function sampleMemory() {
    const words = new Uint16Array(2048);
    for (let i = 0; i < words.length; i++) words[i] = (i * 7) & 0xffff;
    return words;
}

function containerBytes() {
    return Buffer.from(StateFormat.pack(MANIFEST, sampleMemory()));
}

// The three frames a .state.zst really arrives in.
function frames() {
    const bare = containerBytes();
    const out = [{ name: "bare", bytes: bare, why: "no compressor on the writer" }];
    out.push({ name: "gzip", bytes: zlib.gzipSync(bare),
        why: "what the browser writes (CompressionStream)" });
    if (typeof zlib.zstdCompressSync === "function") {
        out.push({ name: "zstd", bytes: zlib.zstdCompressSync(bare),
            why: "what the Node tools write" });
    }
    return out;
}

function cli(args) {
    return spawnSync(process.execPath, [TOOL].concat(args),
        { cwd: ROOT, encoding: "utf8" });
}

function run() {
    // ---- extract opens every frame the emulator itself accepts ----------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-state-manifest-"));
    try {
        const kinds = frames();
        assert.ok(kinds.some((f) => f.name === "gzip"),
            "the gzip fixture is the regression this file exists for");

        for (const frame of kinds) {
            const file = path.join(tmp, frame.name + ".state.zst");
            const json = path.join(tmp, frame.name + ".json");
            fs.writeFileSync(file, frame.bytes);

            const r = cli(["extract", file, json]);
            assert.strictEqual(r.status, 0, "extract must open a " + frame.name +
                " state (" + frame.why + "): " + r.stderr);
            const manifest = JSON.parse(fs.readFileSync(json, "utf8"));
            assert.strictEqual(manifest.label, MANIFEST.label,
                "the manifest must come back intact from a " + frame.name + " frame");
            assert.ok(/memoryWords:\s*2048 words/.test(r.stdout),
                "extract must report the memory it found: " + r.stdout);
        }

        // ---- replace keeps the memory and writes a readable frame --------
        const gzip = kinds.find((f) => f.name === "gzip");
        const gzipFile = path.join(tmp, "gzip.state.zst");
        fs.writeFileSync(gzipFile, gzip.bytes);
        const editPath = path.join(tmp, "edit.json");
        const edited = Object.assign({}, MANIFEST, { stepsMessage: "from the CLI" });
        fs.writeFileSync(editPath, JSON.stringify(edited, null, 2));
        const outFile = path.join(tmp, "out.state.zst");

        const rep = cli(["replace", gzipFile, editPath, outFile]);
        assert.strictEqual(rep.status, 0,
            "replace must accept a gzip state: " + rep.stderr);
        const written = fs.readFileSync(outFile);
        // The rewrite stays COMPRESSED — zstd where this Node has it, gzip
        // otherwise. A bare container would put the file back at its raw size,
        // which is the failure src/state-frame.js's policy exists to prevent.
        const frame = StateFrame.detect(written) || "none";
        assert.notStrictEqual(frame, "none", "replace must frame its output");
        assert.ok(new RegExp("\\(" + frame + "\\)").test(rep.stdout),
            "replace should name the frame it wrote: " + rep.stdout);

        let container = written;
        if (frame === "zstd" && typeof zlib.zstdDecompressSync === "function") {
            container = zlib.zstdDecompressSync(written);
        } else if (frame === "gzip") {
            container = zlib.gunzipSync(written);
        }
        const parsed = StateFormat.unpack(container);
        assert.ok(parsed, "the rewritten state must be a valid container");
        assert.strictEqual(parsed.manifest.stepsMessage, "from the CLI");
        assert.deepStrictEqual(Array.from(parsed.memoryWords),
            Array.from(sampleMemory()), "memory must survive the edit");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    // ---- a file that is neither zstd, gzip nor a container --------------
    const tmpBad = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-state-manifest-bad-"));
    try {
        const junk = path.join(tmpBad, "junk.state.zst");
        fs.writeFileSync(junk, Buffer.from("definitely not a state"));
        const r = cli(["extract", junk, path.join(tmpBad, "junk.json")]);
        assert.notStrictEqual(r.status, 0, "a foreign file must fail");
        assert.ok(/not a \.state container/.test(r.stdout + r.stderr),
            "and say what it expected: " + r.stdout + r.stderr);
    } finally {
        fs.rmSync(tmpBad, { recursive: true, force: true });
    }

    console.log("state-manifest tests passed");
}

run();
