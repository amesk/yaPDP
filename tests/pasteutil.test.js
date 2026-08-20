#!/usr/bin/env node
/**
 * PasteUtil modular tests.
 *
 * Loads the real production module (src/pasteutil.js) in an isolated VM
 * context and exercises the DOM-free helpers used by every terminal paste
 * path (pdp11-app.js VT52 pages and iopage.js user TTYs):
 *   • textToBytes()  — CR/LF normalization + 7-bit masking
 *   • sendToUnit()   — DL11 receive-queue routing (unit 0 / unit N)
 *   • pasteIntoUnit()— normalization + routing in one call
 *
 * Run with:  node tests/pasteutil.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pasteutil.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var PasteUtil = ...` at top level becomes a property of the sandbox.
    return sandbox.PasteUtil;
}

// Objects/arrays produced inside the VM context belong to a different realm,
// so deepStrictEqual on them fails on prototype identity. JSON round-trip
// gives plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// A fake runtime object with the same receive-queue shape as the browser
// globals window.dlReceiveQueue / window.dlReceiveQueueN.
function makeWin() {
    const calls = [];
    return {
        calls,
        dlReceiveQueue: function (unit, bytes) { calls.push({ unit: unit, bytes: bytes.slice() }); },
        dlReceiveQueue1: function (unit, bytes) { calls.push({ unit: unit, bytes: bytes.slice() }); },
        dlReceiveQueue2: function (unit, bytes) { calls.push({ unit: unit, bytes: bytes.slice() }); },
    };
}

function run() {
    const P = loadModule();
    assert.ok(P, "module should expose PasteUtil");

    // ---- textToBytes: CR/LF normalization ---------------------------
    {
        assert.deepStrictEqual(
            plain(P.textToBytes("a\r\nb\rc\nd")),
            [97, 13, 98, 13, 99, 13, 100],
            "CRLF / CR / LF all fold to a single CR"
        );
        assert.deepStrictEqual(
            plain(P.textToBytes("hello")),
            [104, 101, 108, 108, 111],
            "plain text passes through unchanged"
        );
        assert.deepStrictEqual(
            plain(P.textToBytes("a\nb", false)),
            [97, 10, 98],
            "normalize=false keeps LF as-is"
        );
        assert.deepStrictEqual(plain(P.textToBytes("")), [], "empty text -> no bytes");
    }

    // ---- textToBytes: 7-bit cleanliness ----------------------------
    {
        // 'À' is U+00C0 (192); masked to 7 bits it becomes 64.
        assert.deepStrictEqual(plain(P.textToBytes("\u00C0")), [64],
            "bytes above 0x7F are masked to 7 bits");
    }

    // ---- sendToUnit: receive-queue routing --------------------------
    {
        const win = makeWin();
        P.sendToUnit(0, [65], win);
        assert.strictEqual(win.calls.length, 1, "unit 0 routes to dlReceiveQueue");
        assert.deepStrictEqual(plain(win.calls[0]), { unit: 0, bytes: [65] }, "unit 0 bytes delivered");

        P.sendToUnit(2, [66, 67], win);
        assert.strictEqual(win.calls.length, 2, "unit N routes to dlReceiveQueueN");
        assert.deepStrictEqual(plain(win.calls[1]), { unit: 2, bytes: [66, 67] }, "unit N bytes delivered");

        // Missing queue is a silent no-op.
        const win2 = makeWin();
        delete win2.dlReceiveQueue2;
        P.sendToUnit(2, [68], win2);
        assert.strictEqual(win2.calls.length, 0, "missing queue -> no-op");
    }

    // ---- pasteIntoUnit: normalization + routing ---------------------
    {
        const win = makeWin();
        P.pasteIntoUnit(1, "LINE1\nLINE2\r\nLINE3", win);
        assert.strictEqual(win.calls.length, 1, "one delivery");
        assert.strictEqual(win.calls[0].unit, 1, "routes to the requested unit");
        assert.deepStrictEqual(
            plain(win.calls[0].bytes),
            [76, 73, 78, 69, 49, 13, 76, 73, 78, 69, 50, 13, 76, 73, 78, 69, 51],
            "CRLF/LF folded to CR before delivery"
        );
    }

    console.log("\nAll PasteUtil tests passed.");
}

run();
