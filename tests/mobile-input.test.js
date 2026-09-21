#!/usr/bin/env node
/**
 * MobileInput modular tests.
 *
 * Loads the real production module (src/mobile-input.js) in an isolated VM
 * context and exercises the DOM-free helpers that bridge the system on-screen
 * keyboard into the VT52/VT100 terminals and the Model 33 teletype:
 *   • isCoarse()          — coarse-pointer / touch detection (window injectable)
 *   • translateKeydown()  — Enter/Backspace/Tab/Escape and Ctrl+letter -> bytes
 *   • translateInputData()— character stream -> 7-bit bytes (CRLF folded to CR)
 *   • create()            — returns a harmless no-op object without a DOM
 *
 * Run with:  node tests/mobile-input.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "mobile-input.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var MobileInput = ...` at top level becomes a property of the sandbox.
    return sandbox.MobileInput;
}

// Arrays produced inside the VM context belong to a different realm, so
// deepStrictEqual on them fails on prototype identity. JSON round-trip gives
// plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// A fake window with the two signals isCoarse() looks at.
function fakeWin(coarse, touchPoints) {
    return {
        matchMedia: function (query) { return { matches: !!coarse, media: query }; },
        navigator: { maxTouchPoints: touchPoints || 0 }
    };
}

function run() {
    const M = loadModule();
    assert.ok(M, "module should expose MobileInput");
    assert.strictEqual(typeof M.isCoarse, "function", "isCoarse must be exported");
    assert.strictEqual(typeof M.translateKeydown, "function", "translateKeydown must be exported");
    assert.strictEqual(typeof M.translateInputData, "function", "translateInputData must be exported");
    assert.strictEqual(typeof M.create, "function", "create must be exported");

    // ---- isCoarse: coarse pointer, touch points, neither ----------------
    {
        assert.strictEqual(M.isCoarse(fakeWin(true, 0)), true,
            "a coarse pointer device is mobile");
        assert.strictEqual(M.isCoarse(fakeWin(false, 5)), true,
            "touch points imply a touch device");
        assert.strictEqual(M.isCoarse(fakeWin(false, 0)), false,
            "a fine pointer with no touch points is a desktop");
        assert.strictEqual(M.isCoarse({}), false,
            "an object without matchMedia/navigator is not mobile");
        assert.strictEqual(M.isCoarse(null), false,
            "a missing window is not mobile");
    }

    // ---- translateInputData: characters, 7-bit masking, line breaks -----
    {
        assert.deepStrictEqual(plain(M.translateInputData("abc")), [97, 98, 99],
            "printable characters pass through as ASCII");
        assert.deepStrictEqual(plain(M.translateInputData("A\r\nB")), [65, 13, 66],
            "CRLF folds to a single CR");
        assert.deepStrictEqual(plain(M.translateInputData("a\nb")), [97, 13, 98],
            "a lone LF becomes CR");
        assert.deepStrictEqual(plain(M.translateInputData("a\rb")), [97, 13, 98],
            "a lone CR is already CR");
        assert.deepStrictEqual(plain(M.translateInputData("\u00e9")), [0x69],
            "a high character is masked to 7 bits");
        assert.deepStrictEqual(plain(M.translateInputData("")), [],
            "an empty string yields no bytes");
        assert.deepStrictEqual(plain(M.translateInputData(null)), [],
            "null yields no bytes");
    }

    // ---- translateKeydown: special keys ---------------------------------
    {
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Enter" })), [13],
            "Enter -> CR");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Backspace" })), [8],
            "Backspace -> BS");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Tab" })), [9],
            "Tab -> HT");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "Escape" })), [27],
            "Escape -> ESC");
        assert.deepStrictEqual(plain(M.translateKeydown({ keyCode: 13 })), [13],
            "a bare keyCode 13 still maps to CR");
        assert.deepStrictEqual(plain(M.translateKeydown({ keyCode: 8 })), [8],
            "a bare keyCode 8 still maps to BS");

        assert.deepStrictEqual(plain(M.translateKeydown({ key: "a", ctrlKey: true })), [1],
            "Ctrl+A -> 0x01");
        assert.deepStrictEqual(plain(M.translateKeydown({ key: "z", ctrlKey: true })), [26],
            "Ctrl+Z -> 0x1A");

        assert.strictEqual(M.translateKeydown({ key: "a" }), null,
            "a printable key is left to the input path");
        assert.strictEqual(M.translateKeydown({ key: "ArrowUp" }), null,
            "arrow keys carry no terminal byte here");
        assert.strictEqual(M.translateKeydown(null), null,
            "a null event is ignored");
    }

    // ---- create: harmless no-op without a DOM ---------------------------
    {
        const noop = M.create({ onBytes: function () { } });
        assert.ok(noop && typeof noop.focus === "function", "create always returns a bridge object");
        assert.strictEqual(noop.element, null, "the no-DOM bridge has no element");
        noop.focus();
        noop.blur();
        noop.destroy();
    }

    console.log("mobile-input.test.js: all tests passed");
}

run();
