#!/usr/bin/env node
/**
 * FsBundle tests — the file:// fetch shim.
 *
 * A page opened from disk cannot fetch() anything (origin "null"), which is the
 * CORS wall the manual describes: no manifests, no artwork, no disk images.
 * src/fsbundle.js answers those requests from assets/fs-bundle/bundle.js, a
 * base64 payload built by tools/build-fs-bundle.js. This suite pins the contract
 * the emulator depends on:
 *
 *   1. `relFromUrl()` maps a relative request to a bundle key and refuses
 *      anything that is not this document's own file (http:, data:, "..");
 *   2. `parseRange()` understands the single-range form the RK11 streaming path
 *      asks for and nothing else;
 *   3. `install()` does nothing over HTTP — the served page and the desktop
 *      build keep the real fetch;
 *   4. on file:// the shim serves JSON, artwork text and image bytes, honours
 *      Range, answers an unknown file with 404 instead of throwing, and lets an
 *      absolute http request through to the original fetch;
 *   5. a logical image name (media/rk1.dsk) is answered from its compressed
 *      twin (media/rk1.dsk.zst) — the same fallback the HTTP path performs.
 *
 * Run with:  node tests/fsbundle.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "fsbundle.js");
const src = fs.readFileSync(SOURCE, "utf8");

// Builds a fresh sandbox around src/fsbundle.js. `files` are bundle payloads as
// base64; `protocol` decides whether the shim installs at all.
function load(options) {
    const opts = options || {};
    const calls = [];
    const bundle = {};
    Object.keys(opts.files || {}).forEach((rel) => {
        bundle[rel] = Buffer.from(opts.files[rel]).toString("base64");
    });

    const sandbox = {
        console,
        setTimeout,
        atob,
        TextDecoder,
        Uint8Array,
        Promise,
        Buffer,
        // The real thing when the sandbox runs on Node 18+.
        Response: opts.Response === undefined ? Response : opts.Response,
        location: { protocol: opts.protocol || "file:", href: opts.href || "file:///project/pdp11.html" },
        fetch(url) {
            calls.push(url);
            // A locked-down file:// page (no --allow-file-access-from-files)
            // rejects exactly like this; with the flag it returns the bytes.
            if (opts.fetchFails) return Promise.reject(new TypeError("Failed to fetch"));
            return Promise.resolve(new Response("from-network", { status: 200 }));
        },
        __yapdpFsBundle: opts.files ? { version: 1, files: bundle } : undefined,
        // fzstd ships in the browser; the test uses a marker-prefixed stub so
        // that "raw name served from the .zst twin" is observable.
        fzstd: {
            decompress(bytes) {
                const text = Buffer.from(bytes).toString("utf8");
                if (text.indexOf("ZST:") !== 0) throw new Error("not zstd");
                return new Uint8Array(Buffer.from(text.slice(4), "utf8"));
            }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "fsbundle.js" });
    return { FsBundle: sandbox.FsBundle, sandbox, calls };
}

// --- 1. request url -> bundle key -------------------------------------------

{
    const { FsBundle } = load({ files: { "media/manifest.json": "{}" } });

    assert.strictEqual(FsBundle.relFromUrl("media/manifest.json"), "media/manifest.json");
    assert.strictEqual(FsBundle.relFromUrl("./media/manifest.json"), "media/manifest.json");
    assert.strictEqual(FsBundle.relFromUrl("media/manifest.json?v=2"), "media/manifest.json");
    assert.strictEqual(FsBundle.relFromUrl("assets/vt52.svg#marker"), "assets/vt52.svg");
    assert.strictEqual(FsBundle.relFromUrl("media\\rk1.dsk.zst"), "media/rk1.dsk.zst",
        "a Windows-style separator still maps into the bundle");

    assert.strictEqual(FsBundle.relFromUrl("http://localhost:1170/media/manifest.json"), null,
        "an absolute url is not ours");
    assert.strictEqual(FsBundle.relFromUrl("data:text/plain,hi"), null);
    assert.strictEqual(FsBundle.relFromUrl("../outside.png"), null,
        "escaping the project directory is refused");
    assert.strictEqual(FsBundle.relFromUrl(""), null);
}

// --- 2. Range parsing -------------------------------------------------------

{
    const { FsBundle } = load({ files: {} });
    // The shim runs in its own VM context, so its objects carry that realm's
    // prototypes: compare plain copies, not the objects themselves.
    const range = (value, size) => {
        const parsed = FsBundle.parseRange(value, size);
        return parsed ? { start: parsed.start, end: parsed.end } : null;
    };

    assert.deepStrictEqual(range("bytes=0-1023", 4096), { start: 0, end: 1023 });
    assert.deepStrictEqual(range("bytes=1024-", 4096), { start: 1024, end: 4095 });
    assert.deepStrictEqual(range("bytes=-512", 4096), { start: 3584, end: 4095 });
    assert.deepStrictEqual(range("bytes=4090-99999", 4096), { start: 4090, end: 4095 },
        "an end past the payload is clamped, not an error");
    assert.strictEqual(FsBundle.parseRange("bytes=9000-9100", 4096), null);
    assert.strictEqual(FsBundle.parseRange("items=0-1", 4096), null);
    assert.strictEqual(FsBundle.parseRange(null, 4096), null);
}

// --- 3. inert over http -----------------------------------------------------

{
    const { FsBundle, sandbox } = load({ protocol: "http:", files: { "media/manifest.json": "{}" } });
    const original = sandbox.fetch;

    assert.strictEqual(FsBundle.install(), false, "a served page is left alone");
    assert.strictEqual(sandbox.fetch, original, "fetch must not be replaced over http");
}

// --- 4. file:// responses ---------------------------------------------------

(async () => {
    const { FsBundle, sandbox, calls } = load({
        fetchFails: true,             // what a stock file:// page does
        files: {
            "media/manifest.json": JSON.stringify({ media: ["rk1.dsk"] }),
            "assets/vt52.svg": "<svg id='screen'/>",
            "media/rk1.dsk.zst": "ZST:" + "0123456789"
        }
    });

    assert.strictEqual(FsBundle.install(), true);

    // JSON: the manifests are what the wizard and the media registry read.
    const manifest = await sandbox.fetch("media/manifest.json");
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual(manifest.headers.get("content-type"), "application/json");
    assert.deepStrictEqual(await manifest.json(), { media: ["rk1.dsk"] });

    // Artwork: text of an inlined SVG.
    const svg = await sandbox.fetch("assets/vt52.svg");
    assert.strictEqual(svg.headers.get("content-type"), "image/svg+xml");
    assert.strictEqual(await svg.text(), "<svg id='screen'/>");

    // A logical name is answered from its compressed twin.
    const whole = await sandbox.fetch("media/rk1.dsk");
    assert.strictEqual(whole.status, 200);
    assert.strictEqual(await whole.text(), "0123456789");

    // ... and honours the RK11 streaming path's Range request.
    const sliced = await sandbox.fetch("media/rk1.dsk", { headers: { Range: "bytes=2-5" } });
    assert.strictEqual(sliced.status, 206);
    assert.strictEqual(sliced.headers.get("content-range"), "bytes 2-5/10");
    assert.strictEqual(await sliced.text(), "2345");

    // An image the bundle does not carry falls through to the real fetch, and
    // that one rejects on a locked-down file:// page: the emulator's own
    // "cannot load the image" dialog needs a 404, not a TypeError.
    const missing = await sandbox.fetch("media/rp1.dsk");
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(calls, ["media/rp1.dsk"],
        "the bundle miss was handed to the real fetch first");

    // An absolute url still belongs to the network.
    await assert.rejects(
        () => sandbox.fetch("http://localhost:1170/media/manifest.json"),
        /Failed to fetch/);
    assert.deepStrictEqual(calls,
        ["media/rp1.dsk", "http://localhost:1170/media/manifest.json"]);

    // With --allow-file-access-from-files the real fetch does answer: the shim
    // must leave a bundle miss to it instead of inventing a 404.
    {
        const allowed = load({
            files: { "media/manifest.json": JSON.stringify({ media: [] }) }
        });
        assert.strictEqual(allowed.FsBundle.install(), true);
        const external = await allowed.sandbox.fetch("media/rp1.dsk");
        assert.strictEqual(external.status, 200);
        assert.strictEqual(await external.text(), "from-network");
    }

    // The shim is installed once.
    assert.strictEqual(FsBundle.install(), true);
    assert.strictEqual(typeof FsBundle.available, "function");
    assert.strictEqual(FsBundle.has("assets/vt52.svg"), true);
    assert.strictEqual(FsBundle.has("assets/vt100.svg"), false);
    assert.strictEqual(FsBundle.textOf("assets/vt52.svg"), "<svg id='screen'/>");
    assert.strictEqual(FsBundle.bytesOf("assets/vt100.svg"), null);

    console.log("fsbundle.test.js: all assertions passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
