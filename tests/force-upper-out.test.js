#!/usr/bin/env node
/**
 * "Force PDP Output Uppercase" (Config.forceUpperCaseOut) modular tests.
 *
 * The option fixes an authenticity gap: a real Model 33 ASR print mechanism
 * has no lower-case type, so a loader that writes lower case must not be able
 * to put those letters on the paper. The rule is implemented as a printed-GLYPH
 * fold in G60Printer (opts.foldGlyph), applied AFTER onChar() has recorded the
 * raw byte, so:
 *   - the paper shows A-Z even for lower-case machine output,
 *   - the punched tape keeps the code the machine really sent,
 *   - reading such a tape in LOCAL prints upper case while LINE sends the raw
 *     lower case to the machine.
 *
 * Three layers are covered:
 *   1. The fold rule itself, evaluated as PRODUCTION code: model33UpperOnly()
 *      and the foldGlyph option body are extracted straight from
 *      src/pdp11-app.js and run against a fake Config — including the
 *      "applied immediately" contract (the value is read per call).
 *   2. Ordering contracts in src/g60printer.js: every glyph fold is preceded by
 *      the onChar() punch of the same character (raw tape), in BOTH render
 *      paths (doPrintChar for the paced echo, getLine for the line-based path).
 *   3. Wiring contracts: the CONFIG checkbox exists, persists immediately, is
 *      dimmed for a VT52 console, and the QuickBoot profile key is a LIVE
 *      option (never part of the layout "dirty" check that reloads the page).
 *
 * Run with:  node tests/force-upper-out.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const APP_PATH = path.join(ROOT, "src", "pdp11-app.js");
const PRINTER_PATH = path.join(ROOT, "src", "g60printer.js");
const CONFIG_PATH = path.join(ROOT, "src", "config.js");
const QUICKBOOT_PATH = path.join(ROOT, "src", "quickboot.js");
const HTML_PATH = path.join(ROOT, "pdp11.html");

function read(p) {
    return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single block.
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

// Extract the production fold rule (model33UpperOnly + the foldGlyph option
// body) and bind it to a sandbox whose Config can be mutated between calls.
function loadFold(initial) {
    const src = read(APP_PATH);
    const sandbox = {
        // Mutable Config stub: the production code must read the flag per call.
        Config: { get: () => ({ forceUpperCaseOut: sandbox.__flag }) },
        __flag: initial
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractBlock(src, "function model33UpperOnly") +
        "\nthis.fold = ({" + extractBlock(src, "foldGlyph: function (ch)") +
        "}).foldGlyph;",
        sandbox);
    return sandbox;
}

function run() {
    // ---- 1. The fold rule (production code, fake Config) ----------------
    {
        const on = loadFold(true);
        assert.strictEqual(on.fold("a"), "A", "a -> A");
        assert.strictEqual(on.fold("m"), "M", "m -> M");
        assert.strictEqual(on.fold("z"), "Z", "z -> Z");
        assert.strictEqual(on.fold("A"), "A", "A stays A");
        assert.strictEqual(on.fold("5"), "5", "digit stays");
        assert.strictEqual(on.fold(" "), " ", "space stays");
        assert.strictEqual(on.fold(":"), ":", "punctuation stays");
        assert.strictEqual(on.fold("~"), "~", "~ (0x7E) stays");

        // Off: lower case passes through untouched (guest needs lower case).
        on.__flag = false;
        assert.strictEqual(on.fold("a"), "a", "flag off: a passes through");
        assert.strictEqual(on.fold("A"), "A", "flag off: A passes through");

        // Back on: the very NEXT character follows the new value, i.e. the
        // CONFIG toggle applies immediately, with no printer rebuild.
        on.__flag = true;
        assert.strictEqual(on.fold("b"), "B", "flag on again: b -> B");

        // A Config without the key (or without Config at all) must not throw
        // and must leave the glyph alone.
        const bare = {};
        vm.createContext(bare);
        vm.runInContext(
            extractBlock(read(APP_PATH), "function model33UpperOnly") +
            "\nthis.fold = ({" +
            extractBlock(read(APP_PATH), "foldGlyph: function (ch)") +
            "}).foldGlyph;",
            bare);
        assert.strictEqual(bare.fold("c"), "c", "no Config: glyph untouched");
    }

    // ---- 2. G60Printer: the punch keeps the raw byte --------------------
    {
        const src = read(PRINTER_PATH);
        assert.ok(/var foldGlyph = \(typeof opts\.foldGlyph === 'function'\)\s*\?\s*opts\.foldGlyph : null;/.test(src),
            "g60printer.js must read the foldGlyph option (default: no fold)");

        // Every fold must be preceded by the onChar() punch of the same char,
        // so the tape records the RAW code while the paper prints upper case.
        const folds = [];
        const needle = "if (foldGlyph) c = foldGlyph(c);";
        for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
            folds.push(i);
        }
        assert.strictEqual(folds.length, 2,
            "both render paths (doPrintChar + getLine) must fold the glyph");
        folds.forEach((at) => {
            const punch = src.lastIndexOf("onChar(c.charCodeAt(0))", at);
            assert.ok(punch !== -1 && at - punch < 400,
                "the fold must follow the onChar punch of the same character " +
                "(the punch copies the received code)");
        });

        // The paced echo path is the teletype's main output funnel.
        const doPrint = extractBlock(src, "function doPrintChar(c)");
        assert.ok(doPrint.indexOf("onChar(c.charCodeAt(0))") <
            doPrint.indexOf("foldGlyph"),
            "doPrintChar must punch BEFORE folding the glyph");

        // The line printer omits the option entirely (it prints both cases).
        const lp11 = read(path.join(ROOT, "src", "devices", "lp11.js"));
        assert.ok(lp11.indexOf("foldGlyph") === -1,
            "the LP11 line printer must not fold its output");
    }

    // ---- 3. CONFIG wiring ----------------------------------------------
    {
        const app = read(APP_PATH);
        assert.ok(app.indexOf("foldGlyph: function (ch)") !== -1,
            "the console printer must be built with the foldGlyph option");
        assert.ok(app.indexOf("Config.get().forceUpperCaseOut") !== -1,
            "the fold must read Config.forceUpperCaseOut per character");
        assert.ok(/Config\.set\(\{ forceUpperCaseOut: this\.checked \}\)/.test(app),
            "the CONFIG checkbox must persist immediately (no Apply needed)");
        assert.ok(app.indexOf("config-forceUpperCaseOut") !== -1,
            "the form must look up the checkbox");

        // The VT52 console never reaches the teletype printer, and the field is
        // dimmed with the other teletype-only options.
        const ttyFields = extractBlock(app, "var ttyFields = [");
        assert.ok(ttyFields.indexOf("config-field-forceUpperCaseOut") !== -1,
            "the field must be dimmed when the console is not a teletype");
        assert.ok(ttyFields.indexOf("config-field-upperCaseOnly") !== -1,
            "the field must sit next to Upper Case Only");
    }

    // ---- 4. Markup + config defaults ------------------------------------
    {
        const html = read(HTML_PATH);
        assert.ok(html.indexOf('id="config-field-forceUpperCaseOut"') !== -1,
            "CONFIG page must carry the new field");
        assert.ok(html.indexOf('id="config-forceUpperCaseOut"') !== -1,
            "CONFIG page must carry the new checkbox");
        assert.ok(html.indexOf("Force PDP Output Uppercase") !== -1,
            "the field must be labelled Force PDP Output Uppercase");

        const cfg = read(CONFIG_PATH);
        assert.ok(/forceUpperCaseOut: true,/.test(cfg),
            "the option must default to TRUE (authentic Model 33 ASR)");
        assert.ok(/forceUpperCaseOut: typeof o\.forceUpperCaseOut === "undefined"/.test(cfg),
            "an absent key must fall back to the default (old saved configs)");
    }

    // ---- 5. QuickBoot: a LIVE option, never a reload ---------------------
    {
        const qb = read(QUICKBOOT_PATH);
        const dirty = extractBlock(qb, "function hardwareDirty(cfg, profile)");
        assert.ok(dirty.indexOf("forceUpperCaseOut") === -1,
            "forceUpperCaseOut must not mark the layout dirty (no reload)");
        assert.ok(/function liveProfile\(cfg, profile\)/.test(qb),
            "quickboot.js must expose liveProfile() for the no-reload options");
        assert.ok(/Config\.set\(\{ forceUpperCaseOut: live\.forceUpperCaseOut \}\)/.test(qb),
            "launch() must apply the flag live, before the layout check");
    }

    console.log("force-upper-out: all tests passed");
}

run();
