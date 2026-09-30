#!/usr/bin/env node
/**
 * Media download progress tests.
 *
 * media-progress.js is the single channel through which disk/tape image fetches
 * report how much of their body has arrived. Its contract is:
 *   - start/tick/finish aggregate over concurrent jobs and expose a sane
 *     percentage (clamped to 0..100, null when any job is indeterminate);
 *   - fetchBytes() streams a response body, publishes progress, and returns
 *     { bytes, response } for the caller's own completeness check;
 *   - a content-encoded transfer or a missing Content-Length is indeterminate
 *     (never a percentage that can exceed 100%);
 *   - a non-OK response is returned as-is (empty bytes) and never "downloads".
 *
 * The module is DOM-bound for its UI, but the API is pure Node: nothing here
 * touches document. Run with:  node tests/media-progress.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "src", "media-progress.js");

function loadModule() {
    // Fresh instance per load so the jobs map starts empty.
    delete require.cache[require.resolve(MODULE)];
    return require(MODULE).MediaProgress;
}

// ------------------------------------------------------------------
// Pure aggregation tests
// ------------------------------------------------------------------
function testAggregation() {
    const mp = loadModule();

    mp.start("a", 100);
    mp.tick("a", 50);
    assert.strictEqual(mp.percent(), 50, "half of a 100-byte job is 50%");
    assert.deepStrictEqual(mp.totals(), { loaded: 50, total: 100, indeterminate: false });

    mp.finish("a");
    assert.deepStrictEqual(mp.active(), [], "finish removes the job");

    // Concurrent jobs aggregate by total bytes, not by average of percents.
    mp.start("b", 100);
    mp.tick("b", 25);
    mp.start("c", 300);
    mp.tick("c", 75);
    assert.strictEqual(mp.percent(), 25, "25+75 of 400 bytes is 25%");

    // Clamping: a transport that briefly over-reports cannot exceed 100%.
    mp.tick("c", 999);
    assert.strictEqual(mp.percent(), 100, "over-reporting is clamped to 100%");

    // Indeterminate: any job without a known total hides the percentage.
    mp.finish("b");
    mp.finish("c");
    mp.start("d", -1);
    mp.tick("d", 123);
    assert.strictEqual(mp.percent(), null, "an indeterminate job has no percentage");
    mp.fail("d");
    assert.deepStrictEqual(mp.active(), [], "fail removes the job too");
}

// ------------------------------------------------------------------
// fetchBytes streaming tests
// ------------------------------------------------------------------
function buildResponse(totalBytes, opts) {
    opts = opts || {};
    let sent = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (sent >= totalBytes) { controller.close(); return; }
            const n = Math.min(16, totalBytes - sent);
            const piece = new Uint8Array(n);
            for (let i = 0; i < n; i++) piece[i] = (sent + i) % 251;
            sent += n;
            controller.enqueue(piece);
        }
    });
    const headers = {
        get(name) {
            if (name === "content-encoding") return opts.encoding || null;
            if (name === "content-length") return String(totalBytes);
            return null;
        }
    };
    return {
        ok: opts.ok !== false,
        status: opts.ok === false ? 404 : 200,
        headers: headers,
        body: body
    };
}

async function testFetchBytes() {
    const mp = loadModule();
    const originalFetch = global.fetch;

    try {
        // Streamed success: 64 bytes in 16-byte chunks arrive as one buffer,
        // and the job is cleaned up afterwards.
        global.fetch = async function () { return buildResponse(64); };
        const got = await mp.fetchBytes("rk0.dsk");
        assert.strictEqual(got.bytes.length, 64, "all streamed bytes are returned");
        assert.strictEqual(got.response.ok, true);
        assert.deepStrictEqual(mp.active(), [], "a finished fetch leaves no active job");
        assert.strictEqual(got.bytes[0], 0, "first byte is intact");
        assert.strictEqual(got.bytes[63], 63 % 251, "last byte is intact");

        // A non-OK response is not a download: empty bytes, no job, no progress.
        global.fetch = async function () { return buildResponse(64, { ok: false }); };
        const bad = await mp.fetchBytes("missing.dsk");
        assert.strictEqual(bad.response.ok, false);
        assert.strictEqual(bad.bytes.length, 0, "a 404 body is not measured");
        assert.deepStrictEqual(mp.active(), [], "a 404 never registers a job");

        // Content-encoded transfer: the decoded body length cannot be compared
        // to Content-Length, so progress must be indeterminate (no percent).
        global.fetch = async function () { return buildResponse(64, { encoding: "gzip" }); };
        const encoded = await mp.fetchBytes("enc.dsk");
        assert.strictEqual(encoded.bytes.length, 64, "encoded body still arrives whole");

        // A network failure rejects and cleans the job up.
        global.fetch = async function () { throw new Error("network down"); };
        let rejected = false;
        try {
            await mp.fetchBytes("dead.dsk");
        } catch (err) {
            rejected = true;
            assert.strictEqual(err.message, "network down");
        }
        assert.ok(rejected, "a network error must reject");
        assert.deepStrictEqual(mp.active(), [], "a network error leaves no active job");
    } finally {
        global.fetch = originalFetch;
    }
}

async function main() {
    testAggregation();
    await testFetchBytes();
    console.log("OK  media-progress: all tests passed");
}

main().catch(function (err) {
    console.error(err);
    process.exit(1);
});
