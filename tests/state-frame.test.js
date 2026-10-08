#!/usr/bin/env node
/**
 * src/state-frame.js tests.
 *
 * The module owns ONE question — which frame wraps a .state container — and
 * one policy: write zstd when the caller can, else gzip, else bare. It has to
 * answer for the three writers that really exist (the Node tools, the browser's
 * own export, a runtime with no compressor at all), it must never answer for a
 * media IMAGE (fzstd-only), and it must not care where the codecs come from —
 * that is what makes it usable from a CLI and from a page alike.
 *
 * Run with:  node tests/state-frame.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const zlib = require("zlib");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const { StateFrame } = require(path.join(ROOT, "src", "state-frame.js"));
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));

// A container built by the real packer, so the bytes under test are the bytes
// a state really has.
function container() {
    const words = new Uint16Array(1024);
    for (let i = 0; i < words.length; i++) words[i] = (i * 3) & 0xffff;
    return Buffer.from(StateFormat.pack(
        { schemaVersion: StateFormat.SCHEMA_VERSION, label: "frame", device: "rk1" }, words));
}

// Node's codecs, written out here rather than imported, so the module is
// exercised the way an injected-codec caller exercises it.
function nodeCodecs() {
    return {
        isContainer: StateFormat.isContainer,
        zstdEncode: (typeof zlib.zstdCompressSync === "function")
            ? function (b) { return zlib.zstdCompressSync(b, { level: 19 }); }
            : null,   // a Node whose zlib has no zstd: the CI floor
        gzipEncode: function (b) { return zlib.gzipSync(b); },
        zstdDecode: function (b) {
            return new Uint8Array(zlib.zstdDecompressSync(b));
        },
        gzipDecode: function (b) { return new Uint8Array(zlib.gunzipSync(b)); },
    };
}

async function run() {
    const bytes = container();

    // ---- detect: magic only, and "no frame" is a real answer -----------
    {
        assert.strictEqual(StateFrame.detect(zlib.gzipSync(bytes)), "gzip");
        if (typeof zlib.zstdCompressSync === "function") {
            assert.strictEqual(StateFrame.detect(zlib.zstdCompressSync(bytes)),
                "zstd");
        }
        assert.strictEqual(StateFrame.detect(bytes), null,
            "a bare container carries no frame");
        assert.strictEqual(StateFrame.detect(Buffer.from("nothing here")), null);
        assert.strictEqual(StateFrame.detect(Buffer.alloc(0)), null);
        assert.strictEqual(StateFrame.detect(undefined), null);
        assert.deepStrictEqual(StateFrame.ZSTD_MAGIC, [0x28, 0xb5, 0x2f, 0xfd]);
        assert.deepStrictEqual(StateFrame.GZIP_MAGIC, [0x1f, 0x8b]);
    }

    // ---- unwrap: all three writers, and a refusal that names the frame --
    {
        const codecs = nodeCodecs();
        assert.ok(Buffer.from(StateFrame.unwrap(zlib.gzipSync(bytes), codecs))
            .equals(bytes),
            "gzip must unwrap: that is every state the browser ever exported");
        assert.ok(Buffer.from(StateFrame.unwrap(bytes, codecs)).equals(bytes),
            "a bare container must unwrap: a writer with no compressor");
        if (typeof zlib.zstdCompressSync === "function") {
            assert.ok(Buffer.from(StateFrame.unwrap(zlib.zstdCompressSync(bytes),
                codecs)).equals(bytes),
                "zstd must unwrap: that is what the tools write");
        }
        assert.throws(() => StateFrame.unwrap(Buffer.from("dsk bytes"), codecs),
            /not a \.state container \(frame: none\)/,
            "bytes that are not a container are refused, and the reason is named");

        // A frame is not enough on its own: a gzip blob that is NOT a state
        // container must not be handed on as one.
        assert.throws(() => StateFrame.unwrap(zlib.gzipSync(Buffer.from("x")), codecs),
            /frame: gzip/,
            "a gzip of something else is not a state");
    }

    // ---- unwrap with the page's ASYNC gzip codec ------------------------
    {
        const codecs = nodeCodecs();
        codecs.gzipDecode = function (b) {
            return Promise.resolve(new Uint8Array(zlib.gunzipSync(b)));
        };
        const out = StateFrame.unwrap(zlib.gzipSync(bytes), codecs);
        assert.ok(out && typeof out.then === "function",
            "DecompressionStream is async, so unwrap() must surface the Promise");
        assert.ok(Buffer.from(await out).equals(bytes));
    }

    // ---- wrap: zstd -> gzip -> bare, and the policy is the point --------
    {
        const zstdAvailable = typeof zlib.zstdCompressSync === "function";

        const full = StateFrame.wrap(bytes, nodeCodecs());
        assert.strictEqual(full.frame, zstdAvailable ? "zstd" : "gzip",
            "the encoder that exists wins; gzip is the floor, never bare");
        assert.ok(Buffer.from(StateFrame.unwrap(full.bytes, nodeCodecs()))
            .equals(bytes), "the framed container must decode back unchanged");

        // A Node without zstd: the encoder DECLINES (returns null), and the
        // policy has to fall through to gzip instead of writing a bare file.
        const declined = StateFrame.wrap(bytes, {
            isContainer: StateFormat.isContainer,
            zstdEncode: function () { return null; },
            gzipEncode: function (b) { return zlib.gzipSync(b); },
        });
        assert.strictEqual(declined.frame, "gzip",
            "a declining zstd encoder must fall through to gzip");
        assert.ok(Buffer.from(zlib.gunzipSync(declined.bytes)).equals(bytes));

        // No codecs at all (a runtime with neither): the container as it is.
        const none = StateFrame.wrap(bytes, {});
        assert.strictEqual(none.frame, "none");
        assert.strictEqual(none.bytes, bytes);
    }

    // ---- round trip through the real Node codecs ------------------------
    {
        const StateIO = require(path.join(ROOT, "tools", "state-io.js"));
        const fs = require("fs");
        const os = require("os");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-frame-"));
        try {
            const out = path.join(tmp, "round.state.zst");
            const frame = StateIO.writeBytes(out, bytes);
            assert.notStrictEqual(frame, "none",
                "Node always has a compressor: gzip at the very least");
            const read = StateIO.readBytes(out);
            assert.strictEqual(read.frame, frame);
            assert.ok(Buffer.from(read.container).equals(bytes));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
}

run().then(function () {
    console.log("state-frame tests passed");
}, function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
