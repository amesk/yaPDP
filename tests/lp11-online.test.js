#!/usr/bin/env node
/**
 * LP11 ON LINE operator-key modular tests.
 *
 * Extracts the pure lp11OnlineToggle() helper straight from the real source
 * (src/iopage.js) so the test exercises the production logic rather than a
 * copy, then runs it in an isolated VM context. Also does light source-level
 * checks that the OFF LINE behaviour is wired up: the LPDB print path is gated
 * on lp11Online and the state starts ON LINE.
 *
 * Run with:  node tests/lp11-online.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "iopage.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) {
        throw new Error("marker not found: " + startMarker);
    }
    const braceOpen = src.indexOf("{", start);
    if (braceOpen === -1) {
        throw new Error("no opening brace for: " + startMarker);
    }
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

function loadToggle() {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    const fn = extractBlock(src, "function lp11OnlineToggle");
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(fn + "\n; this.toggle = lp11OnlineToggle;", sandbox);
    return sandbox.toggle;
}

function run() {
    const toggle = loadToggle();
    const src = fs.readFileSync(SOURCE_PATH, "utf8");

    // --- Pure toggle behaviour: flips the state ------------------------------
    assert.strictEqual(toggle(true), false, "ON LINE → OFF LINE");
    assert.strictEqual(toggle(false), true, "OFF LINE → ON LINE");

    // --- The ON LINE state starts enabled ------------------------------------
    assert.ok(/let\s+lp11Online\s*=\s*true\s*;/.test(src),
        "lp11Online must start true (printer on line at power-on)");

    // --- The LPDB print path is gated on lp11Online --------------------------
    assert.ok(/if\s*\(\s*lp11Online\s*\)\s*\{/.test(src),
        "LPDB print path must be gated on lp11Online (no output when OFF LINE)");

    // --- The operator key is exported and syncs LED + key via ".off" ---------
    assert.ok(/window\.lp11OnLine\s*=\s*lp11OnLine\s*;/.test(src),
        "lp11OnLine must be exported on window");
    assert.ok(/classList\.toggle\("off",\s*!lp11Online\)/.test(src),
        "ON LINE toggle must sync the LED/key .off class");
    assert.ok(/wasOnline\s*=\s*lp11Online/.test(src) && /lp11Printer\.stop\(\)/.test(src),
        "going OFF LINE mid-print must stop the current print cycle (lp11Printer.stop())");

    // --- READY LED is driven from the printer's busy state ------------------
    const g60 = fs.readFileSync(path.join(__dirname, "..", "src", "g60printer.js"), "utf8");
    assert.ok(/this\.isBusy\s*=\s*function\s*\(\)/.test(g60),
        "G60Printer must expose isBusy() so the READY LED can track printing");
    assert.ok(/lp11Printer\.isBusy/.test(src),
        "LP11 ready ticker must poll lp11Printer.isBusy()");
    assert.ok(/setInterval\(lp11ReadyTick/.test(src),
        "LP11 ready ticker must poll on an interval to sync the READY LED");
    assert.ok(/classList\.toggle\("busy",\s*busy\)/.test(src),
        "READY LED must get the .busy class while the printer is printing");

    console.log("lp11-online.test.js: all tests passed");
}

run();
