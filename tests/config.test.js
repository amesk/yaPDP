#!/usr/bin/env node
/**
 * Config module modular tests.
 *
 * Loads the real production module (src/config.js) in an isolated VM context
 * and exercises its DOM-free helpers: validate() normalization, load()/save()
 * round-trip, reset() and the in-memory snapshot used by iopage.js.
 *
 * The config covers the CONFIG page settings:
 *   consoleType (teletype/vt52), userTerminals (0-2), printer (bool),
 *   printWidth (72/80, ASR 33 teletype), printerWidth (72/80/100/132, LP11),
 *   keyClick (bool), photoBackdrop (bool).
 *
 * Run with:  node tests/config.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "config.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var Config = ...` at top level becomes a property of the sandbox.
    return sandbox.Config;
}

// Objects/arrays produced inside the VM context belong to a different realm,
// so deepStrictEqual on them fails on prototype identity. JSON round-trip
// gives plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// Minimal localStorage-like mock backed by a Map.
function makeStorage(init) {
    const map = new Map(Object.entries(init || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

function run() {
    const C = loadModule();
    assert.ok(C, "module should expose Config");

    // ---- DEFAULTS ---------------------------------------------------
    {
        assert.deepStrictEqual(plain(C.DEFAULTS), {
            consoleType: "teletype",
            userTerminals: 0,
            printer: false,
            printWidth: 72,
            printerWidth: 132,
            keyClick: false,
            photoBackdrop: true,
        }, "defaults should match the documented values");
    }

    // ---- validate: normalization of every field --------------------
    {
        // Empty/invalid input falls back to defaults.
        assert.deepStrictEqual(plain(C.validate(null)), plain(C.DEFAULTS),
            "null -> defaults");
        assert.deepStrictEqual(plain(C.validate({})), plain(C.DEFAULTS),
            "{} -> defaults");

        // consoleType only teletype|vt52.
        assert.strictEqual(C.validate({ consoleType: "vt52" }).consoleType, "vt52");
        assert.strictEqual(C.validate({ consoleType: "garbage" }).consoleType, "teletype");

        // userTerminals clamped to 0..2.
        assert.strictEqual(C.validate({ userTerminals: 2 }).userTerminals, 2);
        assert.strictEqual(C.validate({ userTerminals: 5 }).userTerminals, 0);
        assert.strictEqual(C.validate({ userTerminals: -1 }).userTerminals, 0);

        // Teletype printWidth restricted to the ASR 33 widths (72/80);
        // the wider 100/132 values are LP11-only and must fall back to 72.
        assert.strictEqual(C.validate({ printWidth: 72 }).printWidth, 72);
        assert.strictEqual(C.validate({ printWidth: 80 }).printWidth, 80);
        assert.strictEqual(C.validate({ printWidth: 100 }).printWidth, 72);
        assert.strictEqual(C.validate({ printWidth: 132 }).printWidth, 72);
        assert.strictEqual(C.validate({ printWidth: 55 }).printWidth, 72);
        // Printer width keeps the full LP11 list (72/80/100/132).
        assert.strictEqual(C.validate({ printerWidth: 80 }).printerWidth, 80);
        assert.strictEqual(C.validate({ printerWidth: 100 }).printerWidth, 100);
        assert.strictEqual(C.validate({ printerWidth: 132 }).printerWidth, 132);
        assert.strictEqual(C.validate({ printerWidth: 999 }).printerWidth, C.DEFAULTS.printerWidth);
        // Exported width lists.
        assert.deepStrictEqual(plain(C.PRINT_WIDTHS), [72, 80, 100, 132], "LP11 width list");
        assert.deepStrictEqual(plain(C.PRINT_WIDTHS_TTY), [72, 80], "teletype width list");

        // booleans coerced.
        assert.strictEqual(C.validate({ printer: 1 }).printer, true);
        assert.strictEqual(C.validate({ printer: 0 }).printer, false);
        assert.strictEqual(C.validate({ keyClick: 1 }).keyClick, true);
        assert.strictEqual(C.validate({ keyClick: 0 }).keyClick, false);

        // photoBackdrop: absent -> true (keeps the photo for old configs),
        // otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).photoBackdrop, true);
        assert.strictEqual(C.validate({ photoBackdrop: 1 }).photoBackdrop, true);
        assert.strictEqual(C.validate({ photoBackdrop: 0 }).photoBackdrop, false);
    }

    // ---- load / save round-trip ------------------------------------
    {
        const s = makeStorage();
        const cfg = {
            consoleType: "vt52",
            userTerminals: 2,
            printer: true,
            printWidth: 80,
            printerWidth: 80,
            keyClick: true,
            photoBackdrop: false,
        };
        C.save(cfg, s);
        assert.deepStrictEqual(plain(C.load(s)), cfg,
            "load should restore a saved config");

        // Empty storage -> defaults.
        assert.deepStrictEqual(plain(C.load(makeStorage())), plain(C.DEFAULTS),
            "empty storage -> defaults");

        // Corrupt JSON -> defaults (no throw).
        const corrupt = makeStorage({ "pdp11.config.v1": "{not json" });
        assert.deepStrictEqual(plain(C.load(corrupt)), plain(C.DEFAULTS),
            "corrupt storage -> defaults");
    }

    // ---- reset ------------------------------------------------------
    {
        const s = makeStorage();
        C.save({
            consoleType: "vt52",
            userTerminals: 1,
            printer: true,
            printWidth: 80,
            printerWidth: 100,
            keyClick: true,
            photoBackdrop: true,
        }, s);
        const resetCfg = C.reset(s);
        assert.deepStrictEqual(plain(resetCfg), plain(C.DEFAULTS),
            "reset returns defaults");
        assert.strictEqual(s.getItem("pdp11.config.v1"), null,
            "reset clears the stored key");
        assert.deepStrictEqual(plain(C.load(s)), plain(C.DEFAULTS),
            "after reset, load yields defaults");
    }

    // ---- in-memory snapshot (used by iopage.js at load time) -------
    {
        // In a fresh sandbox with no window/localStorage, get() must equal
        // DEFAULTS and the snapshot object must be stable across calls.
        const C2 = loadModule();
        assert.deepStrictEqual(plain(C2.get()), plain(C2.DEFAULTS),
            "snapshot defaults when storage unavailable");
        assert.strictEqual(C2.get(), C2.get(), "snapshot reference is stable");

        const next = C2.set({ consoleType: "vt52", keyClick: true });
        assert.strictEqual(next.consoleType, "vt52", "set returns merged config");
        assert.strictEqual(C2.get().keyClick, true, "set refreshes the snapshot");
    }

    console.log("\nAll Config tests passed.");
}

run();
