#!/usr/bin/env node
/**
 * VT52 terminal modular tests.
 *
 * Loads the real production module (src/vt52.js) in an isolated VM context and
 * exercises the overstrike handling that mirrors the LP11 printer fix:
 * nroff/man emits bold as "X\bX" (or "X\rX") and underline as "_\bX", so a
 * character overstriking an existing glyph must mark the cell bold/underline
 * (SGR bitmask) instead of silently replacing it.
 *
 * The terminal is created WITHOUT a canvas (allowCanvas=false), forced into
 * screen mode, and the sparse screen buffer is inspected directly. Attribute
 * bitmasks: ATTR_BOLD = 1, ATTR_UNDERSCORE = 2.
 *
 * Run with:  node tests/vt52.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "vt52.js");

// Attribute bitmask flags (must mirror src/vt52.js constants).
const ATTR_BOLD = 1;
const ATTR_UNDERSCORE = 2;

const BS = "\b";   // 0x08 backspace
const CR = "\r";   // 0x0D carriage return
const ESC = "\x1b";

/**
 * Create a fresh Terminal instance in screen mode with one empty row.
 * Returns { term, write } where write() feeds a string through vt52Write.
 */
function makeTerminal() {
    const sandbox = { console, window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox);

    const textArea = {
        value: "",
        tabIndex: 0,
        style: {},
        setSelectionRange() {},
        addEventListener() {},
        focus() {},
        scrollTop: 0,
        scrollHeight: 0,
    };

    const unit = 1;
    sandbox.window.vt52Initialize(unit, () => {}, textArea, null, {});
    const term = sandbox.window.vt52Get(unit);

    // Force screen mode with a single empty row (no escape sequence needed).
    term.modes.screen = true;
    term.screen = [[]];
    term.cursorRow = 0;
    term.cursorCol = 0;
    term.overHang = 0;

    return {
        term,
        write: (data) => sandbox.window.vt52Write(unit, data),
    };
}

function cell(term, col) {
    return term.screen[0][col];
}

function run() {
    // ---- Bold via backspace overstrike: "N\bN" ----------------------
    {
        const { term, write } = makeTerminal();
        write("N" + BS + "N");
        assert.strictEqual(cell(term, 0).c, 78, "bold cell keeps the glyph 'N'");
        assert.strictEqual(cell(term, 0).a, ATTR_BOLD, "same-glyph overstrike -> bold");
        assert.strictEqual(term.overHang, 0, "overstrike position consumed");
    }

    // ---- Underline via backspace overstrike: "_\bX" -----------------
    {
        const { term, write } = makeTerminal();
        write("_" + BS + "X");
        assert.strictEqual(cell(term, 0).c, 88, "letter over underscore becomes the glyph");
        assert.strictEqual(cell(term, 0).a, ATTR_UNDERSCORE, "letter over underscore -> underline");
    }

    // ---- Bold via carriage-return overstrike: "NAME\rNAME" ----------
    {
        const { term, write } = makeTerminal();
        write("NAME" + CR + "NAME");
        for (let col = 0; col < 4; col++) {
            assert.strictEqual(cell(term, col).a, ATTR_BOLD,
                "column " + col + " should be bold after CR overstrike");
        }
        assert.strictEqual(cell(term, 0).c, 78, "glyph 'N' preserved");
        assert.strictEqual(cell(term, 3).c, 69, "glyph 'E' preserved");
    }

    // ---- Space overstrike only moves the carriage -------------------
    {
        const { term, write } = makeTerminal();
        write("AB" + CR + " C");
        assert.strictEqual(cell(term, 0).c, 65, "space overstrike keeps 'A'");
        assert.strictEqual(cell(term, 0).a, 0, "no attribute added by space");
        assert.strictEqual(cell(term, 1).c, 67, "different glyph overstrike replaces 'B'");
        assert.strictEqual(cell(term, 1).a, 0, "different glyph is a plain overwrite");
    }

    // ---- Underline via underscore over letters: "NAME\r_____" -------
    {
        const { term, write } = makeTerminal();
        write("NAME" + CR + "_____");
        for (let col = 0; col < 4; col++) {
            assert.strictEqual(cell(term, col).a, ATTR_UNDERSCORE,
                "column " + col + " should be underlined");
        }
        assert.strictEqual(cell(term, 0).c, 78, "letter 'N' stays the visible glyph");
        assert.strictEqual(cell(term, 3).c, 69, "letter 'E' stays the visible glyph");
    }

    // ---- Normal typing never marks emphasis -------------------------
    {
        const { term, write } = makeTerminal();
        write("ABC");
        for (let col = 0; col < 3; col++) {
            assert.strictEqual(cell(term, col).a, 0, "plain typing has no attributes");
        }
        assert.strictEqual(term.overHang, 0, "no overstrike pending");
    }

    // ---- SGR bold still works (no regression) -----------------------
    {
        const { term, write } = makeTerminal();
        write(ESC + "[1mN" + ESC + "[0m");
        assert.strictEqual(cell(term, 0).c, 78, "SGR bold keeps the glyph");
        assert.strictEqual(cell(term, 0).a, ATTR_BOLD, "CSI 1 m sets bold attribute");
    }

    // ---- Form feed (^L) clears the screen and homes the cursor --------
    {
        const { term, write } = makeTerminal();
        write("ABC");
        assert.strictEqual(term.screen.length, 1, "typing fills the first row");
        write("\f");
        assert.strictEqual(term.cursorRow, 0, "form feed homes the cursor row");
        assert.strictEqual(term.cursorCol, 0, "form feed homes the cursor column");
        assert.strictEqual(term.screen.length, 1, "a single blank row remains");
        assert.strictEqual(term.screen[0].length, 1, "blank row holds one cell");
        assert.strictEqual(cell(term, 0).c, 32, "cell is blank after form feed");
    }

    // ---- ESC E (VT52 clear screen) clears the screen and homes cursor -
    {
        const { term, write } = makeTerminal();
        write("ABC");
        write(ESC + "E");
        assert.strictEqual(term.cursorRow, 0, "ESC E homes the cursor row");
        assert.strictEqual(term.cursorCol, 0, "ESC E homes the cursor column");
        assert.strictEqual(term.screen.length, 1, "a single blank row remains");
        assert.strictEqual(term.screen[0].length, 1, "blank row holds one cell");
        assert.strictEqual(cell(term, 0).c, 32, "cell is blank after ESC E");
    }

    // ---- Line feed clears any pending overstrike --------------------
    {
        const { term, write } = makeTerminal();
        write("N" + BS);          // arming an overstrike
        assert.strictEqual(term.overHang, 1, "backspace arms one overstrike");
        write("\n");              // line feed must cancel it
        assert.strictEqual(term.overHang, 0, "line feed clears pending overstrike");
    }

    // ---- reset() with noHardcopyFallback keeps the canvas screen mode ------
    // A VT52 CRT terminal (allowCanvas + noHardcopyFallback) must never fall
    // back to the hardcopy <textarea> on RIS (ESC c): that would swap the
    // authentic white/grey phosphor for the browser's default monospace text.
    {
        const sandbox = { console, window: {} };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox);

        const textArea = {
            value: "", tabIndex: 0, style: {},
            setSelectionRange() {}, addEventListener() {}, focus() {},
            scrollTop: 0, scrollHeight: 0,
        };

        const unit = 9;
        sandbox.window.vt52Initialize(unit, () => {}, textArea, null,
            { noHardcopyFallback: true });
        const term = sandbox.window.vt52Get(unit);

        // Simulate an active screen-mode VT52 CRT before RIS.
        term.modes.screen = true;
        term.screen = [[{ c: 65, a: 0 }]];

        term.reset();

        assert.strictEqual(term.modes.screen, true,
            "reset() with noHardcopyFallback keeps screen mode");
        assert.strictEqual(term.screen.length, 0,
            "reset() clears the screen buffer");
    }

    // ---- Control: without noHardcopyFallback reset() falls back to hardcopy --
    {
        const sandbox = { console, window: {} };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox);

        const textArea = {
            value: "", tabIndex: 0, style: {},
            setSelectionRange() {}, addEventListener() {}, focus() {},
            scrollTop: 0, scrollHeight: 0,
        };

        const unit = 10;
        sandbox.window.vt52Initialize(unit, () => {}, textArea, null, {});
        const term = sandbox.window.vt52Get(unit);

        term.modes.screen = true;
        term.reset();

        assert.strictEqual(term.modes.screen, false,
            "reset() without noHardcopyFallback enters hardcopy mode");
    }

    // ---- Historical reverse-video mode (CONFIG) swaps the phosphor colours --
    {
        const { term } = makeTerminal();
        term.setReverseVideo(true);
        assert.strictEqual(term.fgColor, "#141914", "reverse video: dark grey-green text");
        assert.strictEqual(term.bgColor, "#E0E0E0", "reverse video: white/grey background");
        term.setReverseVideo(false);
        assert.strictEqual(term.fgColor, "#E0E0E0", "reverse video off restores grey text");
        assert.strictEqual(term.bgColor, "#141914", "reverse video off restores dark grey-green background");
    }

    console.log("vt52.test.js: all overstrike tests passed");
}

run();
