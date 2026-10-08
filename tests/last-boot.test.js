#!/usr/bin/env node
/**
 * LastBoot module tests.
 *
 * Loads the real production module (src/last-boot.js) in an isolated VM
 * context and exercises its DOM-free helpers against a Map-backed storage
 * mock: get()/remember()/clear() and the key normalisation that keeps a
 * corrupt store from ever reaching a boot command.
 *
 * Run with:  node tests/last-boot.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "last-boot.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var LastBoot = ...` at top level becomes a property of the sandbox.
    return sandbox.LastBoot;
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
    const LB = loadModule();
    assert.ok(LB, "module should expose LastBoot");
    assert.strictEqual(LB.STORAGE_KEY, "yapdp.lastboot");

    // ---- empty store ------------------------------------------------
    {
        const s = makeStorage();
        assert.strictEqual(LB.get(s), null, "nothing remembered yet");
    }

    // ---- remember / get round-trip ----------------------------------
    {
        const s = makeStorage();
        assert.strictEqual(LB.remember("rk0", s), "rk0");
        assert.strictEqual(LB.get(s), "rk0");
        // A second remember replaces the first.
        LB.remember("rp1", s);
        assert.strictEqual(LB.get(s), "rp1");
        // The value is plain in storage (the device key itself).
        assert.strictEqual(s.getItem("yapdp.lastboot"), "rp1");
    }

    // ---- normalisation: only plausible keys are stored --------------
    {
        const s = makeStorage();
        // Empty / whitespace / oversize / illegal characters are refused.
        assert.strictEqual(LB.remember("", s), null);
        assert.strictEqual(LB.remember("   ", s), null);
        assert.strictEqual(LB.remember("has space", s), null);
        assert.strictEqual(LB.remember("a/b", s), null);
        assert.strictEqual(LB.remember("x".repeat(80), s), null);
        assert.strictEqual(LB.remember(null, s), null);
        assert.strictEqual(LB.remember(42, s), null);
        assert.strictEqual(LB.get(s), null, "nothing legal was stored");
        // Legal tokens pass, including the scenario variants.
        assert.strictEqual(LB.remember("rk1vt52", s), "rk1vt52");
        assert.strictEqual(LB.get(s), "rk1vt52");
    }

    // ---- a corrupt stored value reads back as null ------------------
    {
        const s = makeStorage({ "yapdp.lastboot": "not a device!" });
        assert.strictEqual(LB.get(s), null, "corrupt store -> null");
    }

    // ---- clear ------------------------------------------------------
    {
        const s = makeStorage({ "yapdp.lastboot": "tm0" });
        assert.strictEqual(LB.get(s), "tm0");
        LB.clear(s);
        assert.strictEqual(LB.get(s), null, "cleared store -> null");
        assert.strictEqual(s.getItem("yapdp.lastboot"), null, "key removed");
    }

    // ---- no storage (headless): every call is a safe no-op ----------
    {
        const dead = {
            getItem: () => { throw new Error("no storage"); },
            setItem: () => { throw new Error("no storage"); },
            removeItem: () => { throw new Error("no storage"); }
        };
        assert.strictEqual(LB.get(dead), null);
        assert.strictEqual(LB.remember("rk0", dead), "rk0");
        LB.clear(dead);   // must not throw
    }

    console.log("last-boot.test.js: all tests passed");
}

run();
