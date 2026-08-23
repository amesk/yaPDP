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
 *   vt11 (bool, VT11 graphics display), printWidth (72/80, Model 33 ASR
 *   teletype), printerWidth (72/80/100/132, LP11),
 *   teletypeSpeed (authentic/fast),
 *   upperCaseOnly (bool, physical-keyboard upper-case normalisation),
 *   keyClick (bool),
 *   vt52ReverseVideo (bool, historical VT52 reverse-video mode),
 *   crtEffects (bool, pure-CSS CRT flicker/roll simulation),
 *   hum (bool, ambient power-supply hum), mute (bool, global all-sounds
 *   mute), photoBackdrop (bool),
 *   confirmReboot (bool, reboot confirmation dialog),
 *   panelSticker (bool, Help Me! sticky note on the Panel page),
 *   powerOn (bool, machine powered on at startup), autoBoot (bool, start the
 *   default bootstrap on power-on).
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
            vt11: false,
            printWidth: 72,
            printerWidth: 132,
            teletypeSpeed: "authentic",
            upperCaseOnly: false,
            keyClick: false,
            vt52ReverseVideo: false,
            vt52TextMode: false,
            crtEffects: true,
            hum: true,
            mute: false,
            photoBackdrop: true,
            confirmReboot: true,
            panelSticker: false,
            powerOn: false,
            autoBoot: false,
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

        // Teletype printWidth restricted to the Model 33 ASR widths (72/80);
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

        // teletypeSpeed only authentic|fast; absent/garbage -> authentic.
        assert.strictEqual(C.validate({}).teletypeSpeed, "authentic");
        assert.strictEqual(C.validate({ teletypeSpeed: "fast" }).teletypeSpeed, "fast");
        assert.strictEqual(C.validate({ teletypeSpeed: "authentic" }).teletypeSpeed, "authentic");
        assert.strictEqual(C.validate({ teletypeSpeed: "garbage" }).teletypeSpeed, "authentic");
        assert.deepStrictEqual(plain(C.TELETYPE_SPEEDS), ["authentic", "fast"], "teletype speed list");

        // booleans coerced.
        assert.strictEqual(C.validate({ printer: 1 }).printer, true);
        assert.strictEqual(C.validate({ printer: 0 }).printer, false);
        // vt11 (VT11 graphics display) absent/garbage -> false.
        assert.strictEqual(C.validate({}).vt11, false);
        assert.strictEqual(C.validate({ vt11: 1 }).vt11, true);
        assert.strictEqual(C.validate({ vt11: "yes" }).vt11, true);
        assert.strictEqual(C.validate({ vt11: 0 }).vt11, false);
        assert.strictEqual(C.validate({ keyClick: 1 }).keyClick, true);
        assert.strictEqual(C.validate({ keyClick: 0 }).keyClick, false);
        // upperCaseOnly (physical keyboard upper-case normalisation) coerced.
        assert.strictEqual(C.validate({}).upperCaseOnly, false);
        assert.strictEqual(C.validate({ upperCaseOnly: 1 }).upperCaseOnly, true);
        assert.strictEqual(C.validate({ upperCaseOnly: 0 }).upperCaseOnly, false);
        // vt52ReverseVideo (historical VT52 reverse video) coerced to boolean.
        assert.strictEqual(C.validate({ vt52ReverseVideo: 1 }).vt52ReverseVideo, true);
        assert.strictEqual(C.validate({ vt52ReverseVideo: 0 }).vt52ReverseVideo, false);

        // vt52TextMode: absent -> default (false, keeps the authentic canvas
        // CRT for old configs saved before the option existed), otherwise bool.
        assert.strictEqual(C.validate({}).vt52TextMode, false);
        assert.strictEqual(C.validate({ vt52TextMode: 1 }).vt52TextMode, true);
        assert.strictEqual(C.validate({ vt52TextMode: "yes" }).vt52TextMode, true);
        assert.strictEqual(C.validate({ vt52TextMode: 0 }).vt52TextMode, false);

        // crtEffects: absent -> default (true, keeps the CRT effects on for
        // old configs saved before the option existed), otherwise boolean.
        assert.strictEqual(C.validate({}).crtEffects, true);
        assert.strictEqual(C.validate({ crtEffects: 1 }).crtEffects, true);
        assert.strictEqual(C.validate({ crtEffects: 0 }).crtEffects, false);

        // hum: absent -> default (true, keeps the ambient hum on for old
        // configs), otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).hum, true);
        assert.strictEqual(C.validate({ hum: 1 }).hum, true);
        assert.strictEqual(C.validate({ hum: 0 }).hum, false);

        // mute: absent -> false (keeps the sounds on for old configs),
        // otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).mute, false);
        assert.strictEqual(C.validate({ mute: 1 }).mute, true);
        assert.strictEqual(C.validate({ mute: 0 }).mute, false);

        // photoBackdrop: absent -> true (keeps the photo for old configs),
        // otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).photoBackdrop, true);
        assert.strictEqual(C.validate({ photoBackdrop: 1 }).photoBackdrop, true);
        assert.strictEqual(C.validate({ photoBackdrop: 0 }).photoBackdrop, false);

        // confirmReboot: absent -> true (keeps the confirmation on for old
        // configs), otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).confirmReboot, true);
        assert.strictEqual(C.validate({ confirmReboot: 1 }).confirmReboot, true);
        assert.strictEqual(C.validate({ confirmReboot: 0 }).confirmReboot, false);

        // panelSticker: absent -> false (the sticker stays hidden on the very
        // first start), otherwise coerced to boolean.
        assert.strictEqual(C.validate({}).panelSticker, false);
        assert.strictEqual(C.validate({ panelSticker: 1 }).panelSticker, true);
        assert.strictEqual(C.validate({ panelSticker: 0 }).panelSticker, false);

        // powerOn: absent -> false (the machine powers up off), otherwise
        // coerced to boolean.
        assert.strictEqual(C.validate({}).powerOn, false);
        assert.strictEqual(C.validate({ powerOn: 1 }).powerOn, true);
        assert.strictEqual(C.validate({ powerOn: 0 }).powerOn, false);

        // autoBoot: absent -> false (no automatic bootstrap), otherwise
        // coerced to boolean.
        assert.strictEqual(C.validate({}).autoBoot, false);
        assert.strictEqual(C.validate({ autoBoot: 1 }).autoBoot, true);
        assert.strictEqual(C.validate({ autoBoot: 0 }).autoBoot, false);
    }

    // ---- load / save round-trip ------------------------------------
    {
        const s = makeStorage();
        const cfg = {
            consoleType: "vt52",
            userTerminals: 2,
            printer: true,
            vt11: true,
            printWidth: 80,
            printerWidth: 80,
            teletypeSpeed: "fast",
            upperCaseOnly: true,
            keyClick: true,
            vt52ReverseVideo: true,
            vt52TextMode: true,
            crtEffects: false,
            hum: true,
            mute: true,
            photoBackdrop: false,
            confirmReboot: false,
            panelSticker: true,
            powerOn: true,
            autoBoot: true,
        };
        C.save(cfg, s);
        assert.deepStrictEqual(plain(C.load(s)), cfg,
            "load should restore a saved config");

        // Empty storage -> defaults.
        assert.deepStrictEqual(plain(C.load(makeStorage())), plain(C.DEFAULTS),
            "empty storage -> defaults");

        // Corrupt JSON -> defaults (no throw).
        const corrupt = makeStorage({ "yapdp.config.v1": "{not json" });
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
            vt11: true,
            printWidth: 80,
            printerWidth: 100,
            teletypeSpeed: "fast",
            keyClick: true,
            vt52ReverseVideo: true,
            vt52TextMode: true,
            crtEffects: true,
            hum: false,
            mute: true,
            photoBackdrop: true,
        }, s);
        const resetCfg = C.reset(s);
        assert.deepStrictEqual(plain(resetCfg), plain(C.DEFAULTS),
            "reset returns defaults");
        assert.strictEqual(s.getItem("yapdp.config.v1"), null,
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
