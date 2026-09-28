#!/usr/bin/env node
/**
 * VT100 dialect tests — the ANSI escape letters the DECscope grammar gives a
 * different meaning to.
 *
 * A VT100 is a superset of the VT52 (src/dialect/vt100.js extends
 * src/vt52.js), so the inherited grammar answers most sequences. Two letters,
 * however, mean something else on each machine:
 *
 *   ESC D   VT52: cursor left        VT100: IND (index — LF without a CR)
 *   ESC M   VT52: delete line        VT100: RI  (reverse index)
 *
 * The VT100's termcap advertises exactly those as its scrolling capabilities
 * (the 2.11 BSD entry reads ":sf=2*\ED:sr=2*\EM:"), so a full-screen program
 * scrolls the screen with ESC D. With the inherited DECscope reading the
 * scroll became a cursor move: the guest drew its next line over the bottom
 * line and the text above never moved. VT52 compatibility mode (DECANM,
 * CSI ? 2 h) must still answer with the DECscope meanings.
 *
 * Loads the real production modules (engine, then VT52, then VT100) in an
 * isolated VM context, in the order the page loads them, and inspects the
 * sparse screen buffer directly.
 *
 * Run with:  node tests/vt100-dialect.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const CORE_PATH  = path.join(__dirname, "..", "src", "terminal-core.js");
const VT52_PATH  = path.join(__dirname, "..", "src", "vt52.js");
const VT100_PATH = path.join(__dirname, "..", "src", "dialect", "vt100.js");

const ESC = "\x1b";
const SPACE = 32;

/**
 * Create a fresh VT100 terminal (engine → VT52 → VT100, page order) with no
 * canvas, in screen mode. noHardcopyFallback mirrors what the application
 * passes: a VT100 is a CRT-only machine and must never fall back to the
 * hardcopy <textarea>, which is what would otherwise happen at the bottom
 * margin.
 */
function makeTerminal(options) {
    const sandbox = { console, window: {} };
    vm.createContext(sandbox);
    [CORE_PATH, VT52_PATH, VT100_PATH].forEach((p) => {
        vm.runInContext(fs.readFileSync(p, "utf8"), sandbox);
    });

    const textArea = {
        value: "", tabIndex: 0, style: {},
        setSelectionRange() {}, addEventListener() {}, focus() {},
        scrollTop: 0, scrollHeight: 0,
    };

    const unit = 42;
    sandbox.window.vt100Initialize(unit, () => {}, textArea, null,
        Object.assign({ noHardcopyFallback: true }, options || {}));

    return {
        term: sandbox.window.vt100Get(unit),
        write: (data) => sandbox.window.vt100Write(unit, data),
    };
}

/** One row of `len` cells holding the character `ch`. */
function rowOf(ch, len = 1) {
    return Array.from({ length: len }, () => ({ c: ch.charCodeAt(0), a: 0 }));
}

/** A 0-based screen: rows "A", "B", "C", … */
function rowsOf(letters) {
    return letters.split("").map((ch) => rowOf(ch));
}

// ---- ESC D is IND: one line down, the column untouched --------------------
{
    const { term, write } = makeTerminal();
    assert.strictEqual(term.modes.ansi, true, "a VT100 powers on in ANSI mode");

    term.screen = rowsOf("AB");
    term.cursorRow = 0;
    term.cursorCol = 3;
    write(ESC + "D");

    assert.strictEqual(term.cursorRow, 1, "ESC D is IND: the cursor moves down one line");
    assert.strictEqual(term.cursorCol, 3, "ESC D is IND: the column is preserved (it is not cursor-left)");
    assert.strictEqual(term.screen.length, 2, "ESC D neither adds nor deletes a line");
}

// ---- ESC D at the bottom margin scrolls the screen up ---------------------
{
    const { term, write } = makeTerminal();
    term.rows = 5;
    term.margin = { top: 0, bottom: 5 };
    term.screen = rowsOf("ABCDE");
    term.cursorRow = 4;
    term.cursorCol = 0;
    write(ESC + "D");

    assert.strictEqual(term.screen.length, 5, "ESC D at the bottom keeps the screen height");
    assert.strictEqual(term.screen[0][0].c, "B".charCodeAt(0), "the top line scrolled off");
    assert.strictEqual(term.screen[3][0].c, "E".charCodeAt(0), "the lines above moved up");
    assert.strictEqual(term.screen[4][0].c, SPACE, "a blank line appeared at the bottom");
    assert.strictEqual(term.cursorRow, 4, "the cursor stays on the bottom line");
}

// ---- ESC M is RI: one line up, nothing deleted ----------------------------
{
    const { term, write } = makeTerminal();
    term.screen = rowsOf("ABC");
    term.cursorRow = 2;
    term.cursorCol = 0;
    write(ESC + "M");

    assert.strictEqual(term.cursorRow, 1, "ESC M is RI: the cursor moves up one line");
    assert.strictEqual(term.screen.length, 3, "ESC M does not delete a line");
    assert.strictEqual(term.screen[2][0].c, "C".charCodeAt(0), "'C' stays in place");
}

// ---- ESC M at the top margin scrolls the screen down ----------------------
{
    const { term, write } = makeTerminal();
    term.rows = 4;
    term.margin = { top: 0, bottom: 4 };
    term.screen = rowsOf("ABCD");
    term.cursorRow = 0;
    term.cursorCol = 0;
    write(ESC + "M");

    assert.strictEqual(term.screen.length, 4, "ESC M at the top keeps the screen height");
    assert.strictEqual(term.screen[0][0].c, SPACE, "a blank line appeared at the top");
    assert.strictEqual(term.screen[1][0].c, "A".charCodeAt(0), "the old first line moved down");
    assert.strictEqual(term.cursorRow, 0, "the cursor stays on the top line");
}

// ---- VT52 compatibility mode keeps the DECscope meanings ------------------
{
    const { term, write } = makeTerminal();
    write(ESC + "[?2h");   // DECANM: VT52 mode
    assert.strictEqual(term.modes.ansi, false, "CSI ?2 h drops the VT100 into VT52 mode");

    term.screen = rowsOf("AB");
    term.cursorRow = 1;
    term.cursorCol = 1;
    write(ESC + "D");
    assert.strictEqual(term.cursorCol, 0, "in VT52 mode ESC D is still cursor-left");

    term.screen = rowsOf("ABC");
    term.cursorRow = 1;
    term.cursorCol = 0;
    write(ESC + "M");
    assert.strictEqual(term.screen.length, 3, "in VT52 mode ESC M still deletes a line");
    assert.strictEqual(term.screen[1][0].c, "C".charCodeAt(0), "'C' moved up after ESC M");
}

console.log("vt100-dialect: OK (IND/RI in ANSI mode, DECscope meanings in VT52 mode)");
