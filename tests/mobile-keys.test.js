#!/usr/bin/env node
/**
 * MobileKeys modular tests.
 *
 * Loads the real production module (src/mobile-keys.js) in an isolated VM context
 * and checks the two things that are decisions rather than DOM work:
 *   • the key table — the PDP-11 keys a phone's own keyboard cannot produce;
 *   • WHICH PAGES the bar belongs to. It exists for the terminals that have no
 *     keyboard drawn on the glass (the VT52 and the VT100); the Model 33 ASR
 *     carries its own keycaps (CTRL/SHIFT/REPT/BREAK/HERE IS on the punch
 *     keyboard), and the Panel/Printer/Config pages have nothing to type into.
 *
 * The DOM behaviour (docking, hiding, routing) is covered end to end in
 * tests/e2e-mobile-input.js.
 *
 * Run with:  node tests/mobile-keys.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "mobile-keys.js");

// Arrays built inside the VM belong to another realm; a JSON round-trip gives
// plain main-realm values that deepStrictEqual compares reliably (the same trick
// tests/mobile-input.test.js uses).
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.MobileKeys;
}

function run() {
    const K = loadModule();
    assert.ok(K, "module should expose MobileKeys");
    for (const fn of ["install", "destroy", "press", "resolveTarget", "setPage", "showsOn"]) {
        assert.strictEqual(typeof K[fn], "function", fn + " must be exported");
    }

    // ---- the key table ---------------------------------------------------
    {
        const ids = K.KEYS.map((k) => k.id);
        for (const id of ["cr", "esc", "tab", "bs", "rub", "ctrl", "c", "d", "z", "s", "q"]) {
            assert.ok(ids.indexOf(id) !== -1, "the bar must offer the key " + id);
        }
        const byId = (id) => K.KEYS.filter((k) => k.id === id)[0];
        assert.deepStrictEqual(plain(byId("cr").bytes), [13], "Return is CR");
        assert.deepStrictEqual(plain(byId("esc").bytes), [27], "Escape is 0x1B");
        assert.deepStrictEqual(plain(byId("rub").bytes), [127], "Rubout is DEL");
        assert.deepStrictEqual(plain(byId("c").bytes), [3], "^C interrupts");
        assert.strictEqual(byId("ctrl").latch, true, "CTRL is a latch, not a byte");
        assert.strictEqual(byId("ctrl").bytes, undefined,
            "the latch key sends nothing of its own");
        for (const key of K.KEYS) {
            if (key.latch) continue;
            assert.ok(Array.isArray(key.bytes) && key.bytes.length,
                "every non-latch key carries bytes (" + key.id + ")");
            assert.ok(key.label && key.title, "every key is labelled and explained (" + key.id + ")");
        }
    }

    // ---- which pages the bar belongs to ----------------------------------
    {
        assert.deepStrictEqual(plain(K.TERMINAL_PAGES).sort(),
            ["vt52", "vt52-2", "vt52-console"],
            "the bar belongs to the VT52/VT100 pages, and only to them");
        for (const page of K.TERMINAL_PAGES) {
            assert.strictEqual(K.showsOn(page), true, "the bar shows on " + page);
        }
        for (const page of ["teletype", "printer", "panel", "config", "storage",
                            "instructions", "vt11", ""]) {
            assert.strictEqual(K.showsOn(page), false, "the bar stays off " + JSON.stringify(page));
        }
        assert.strictEqual(K.showsOn(undefined), false, "an unknown page gets no bar");
        assert.strictEqual(K.showsOn("page-vt52"), false,
            "the slug is without the page- prefix (what switchPage announces)");
    }

    // ---- install is a no-op without a DOM, and setPage tolerates no bar ---
    {
        assert.strictEqual(K.install({}), null, "install without a DOM does nothing");
        assert.strictEqual(K.install({ document: null }), null, "…and without a document");
        K.setPage("vt52");           // must not throw before the bar exists
        K.destroy();
    }

    console.log("mobile-keys.test.js: all tests passed");
}

run();
