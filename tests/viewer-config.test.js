#!/usr/bin/env node
/**
 * ViewerConfig module tests.
 *
 * Loads the real src/config.js + src/viewer-config.js in one VM context and
 * exercises the DOM-free helpers against a Map-backed storage mock:
 * remember()/get()/clear() and the normalisation through Config.validate that
 * keeps a corrupt store from ever reaching the live configuration.
 *
 * Run with:  node tests/viewer-config.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const CONFIG_PATH = path.join(__dirname, "..", "src", "config.js");
const VIEWER_PATH = path.join(__dirname, "..", "src", "viewer-config.js");

function load() {
    const sb = { console };
    vm.createContext(sb);
    // ViewerConfig validates through Config, so config.js loads first.
    vm.runInContext(fs.readFileSync(CONFIG_PATH, "utf8"), sb);
    vm.runInContext(fs.readFileSync(VIEWER_PATH, "utf8"), sb);
    return sb.ViewerConfig;
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

// Objects produced inside the VM realm compare unreliably with deepStrictEqual.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function run() {
    const VC = load();
    assert.ok(VC, "module should expose ViewerConfig");
    assert.strictEqual(VC.STORAGE_KEY, "yapdp.origconfig.v1");

    // ---- empty store ------------------------------------------------
    {
        const s = makeStorage();
        assert.strictEqual(VC.get(s), null, "nothing remembered yet");
    }

    // ---- remember / get round-trip through Config.validate ----------
    {
        const s = makeStorage();
        const stored = VC.remember({ consoleType: "vt52", printerWidth: 80 }, s);
        assert.strictEqual(stored.consoleType, "vt52");
        assert.strictEqual(stored.printerWidth, 80);
        // Missing keys fall back to defaults: a FULL validated config comes back.
        assert.strictEqual(stored.printer, false);
        const got = VC.get(s);
        assert.strictEqual(got.consoleType, "vt52");
        assert.strictEqual(got.printerWidth, 80);
        assert.deepStrictEqual(plain(got.vt52Zoom), [false, false, false]);
        // Stored as JSON under the documented key.
        assert.ok(s.getItem("yapdp.origconfig.v1").indexOf("vt52") !== -1);
    }

    // ---- garbage input is refused -----------------------------------
    {
        assert.strictEqual(VC.remember(null, makeStorage()), null);
        assert.strictEqual(VC.remember("nope", makeStorage()), null);
        // A corrupt stored value reads back as null.
        const bad = makeStorage({ "yapdp.origconfig.v1": "{not json" });
        assert.strictEqual(VC.get(bad), null, "corrupt store -> null");
    }

    // ---- clear ------------------------------------------------------
    {
        const s = makeStorage();
        VC.remember({ consoleType: "vt100" }, s);
        VC.clear(s);
        assert.strictEqual(VC.get(s), null, "cleared store -> null");
        assert.strictEqual(s.getItem("yapdp.origconfig.v1"), null, "key removed");
    }

    // ---- no storage (headless): safe no-ops -------------------------
    {
        const dead = {
            getItem: () => { throw new Error("no storage"); },
            setItem: () => { throw new Error("no storage"); },
            removeItem: () => { throw new Error("no storage"); },
        };
        assert.strictEqual(VC.get(dead), null);
        const r = VC.remember({ consoleType: "vt52" }, dead);
        assert.strictEqual(r.consoleType, "vt52", "validated value still returned");
        VC.clear(dead);   // must not throw
    }

    console.log("viewer-config.test.js: all tests passed");
}

run();
