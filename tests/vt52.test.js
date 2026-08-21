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

/**
 * Create a fresh Terminal instance that records every byte sent back to the
 * emulator (receiveRoutine), for testing terminal responses (CPR, ESC Z
 * identify) and keyboard translation (handleKey).
 */
function makeCapturingTerminal() {
    const sandbox = { console, window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox);

    const textArea = {
        value: "", tabIndex: 0, style: {},
        setSelectionRange() {}, addEventListener() {}, focus() {},
        scrollTop: 0, scrollHeight: 0,
        offsetWidth: 0,
        classList: { add() {}, remove() {} },
    };

    const unit = 77;
    const sent = [];
    sandbox.window.vt52Initialize(unit, (u, bytes) => {
        sent.push(...bytes);
    }, textArea, null, {});
    const term = sandbox.window.vt52Get(unit);

    term.modes.screen = true;
    term.screen = [[]];
    term.cursorRow = 0;
    term.cursorCol = 0;
    term.overHang = 0;

    return {
        sandbox,
        term,
        sent,
        write: (data) => sandbox.window.vt52Write(unit, data),
    };
}

function cell(term, col) {
    return term.screen[0][col];
}

/**
 * Create a fresh Terminal instance and bolt a mock canvas pipeline onto it so
 * renderText() can be exercised without a real <canvas> (which would start the
 * 500ms blink interval and keep the Node process alive). Returns { term, calls }
 * where calls records every ctx.fillText / ctx.fillRect plus the ctx.font in
 * effect when each glyph was drawn.
 */
function makeCanvasTerminal() {
    const { term } = makeTerminal();
    term.allowCanvas = true;

    const calls = { fillText: [], fillRect: [] };
    const ctx = {
        fillStyle: "",
        font: "",
        fillRect: (x, y, w, h) => calls.fillRect.push({ x, y, w, h }),
        fillText: (s, x, y) => calls.fillText.push({ s, x, y, font: ctx.font }),
    };
    term.canvas = {
        ctx,
        charWidth: 8,
        blinkCycle: false,
        lastCursor: { row: -1, col: -1 },
    };
    term.glyphBaselineOffset = 0;

    return { term, calls };
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

    // ---- VT52 ESC L inserts a blank line at the cursor ----------------------
    // Full-screen editors (vi termcap "al") use ESC L for the o/O (open line)
    // commands: a blank row is spliced at the cursor and content shifts down.
    {
        const { term, write } = makeTerminal();
        term.screen = [
            [{ c: 65, a: 0 }], // 'A'
            [{ c: 66, a: 0 }], // 'B'
            [{ c: 67, a: 0 }]  // 'C'
        ];
        term.cursorRow = 1;
        term.cursorCol = 0;
        write(ESC + "L");
        assert.strictEqual(term.screen.length, 4, "ESC L adds a row");
        // render() guarantees the cursor cell exists in the sparse buffer, so
        // the inserted row holds one blank space at the cursor column.
        assert.strictEqual(term.screen[1][0].c, 32, "inserted row cell is blank");
        assert.strictEqual(term.screen[2][0].c, 66, "'B' shifts down after ESC L");
        assert.strictEqual(term.screen[3][0].c, 67, "'C' shifts down after ESC L");
    }

    // ---- VT52 ESC M deletes the line at the cursor ---------------------------
    // vi termcap "dl" uses ESC M for dd: the cursor row is removed and the
    // lines below it shift up (a blank line would appear at the bottom of a
    // full 24-row screen; the sparse buffer simply drops it).
    {
        const { term, write } = makeTerminal();
        term.screen = [
            [{ c: 65, a: 0 }], // 'A'
            [{ c: 66, a: 0 }], // 'B'
            [{ c: 67, a: 0 }]  // 'C'
        ];
        term.cursorRow = 1;
        term.cursorCol = 0;
        write(ESC + "M");
        // deleteLines() removes the cursor row and appends a blank line at the
        // bottom (splice clamps to the end of the sparse array), which is how a
        // full 24-row screen would show a fresh bottom row.
        assert.strictEqual(term.screen.length, 3, "ESC M shifts content up and adds a trailing blank row");
        assert.strictEqual(term.screen[0][0].c, 65, "'A' stays in place after ESC M");
        assert.strictEqual(term.screen[1][0].c, 67, "'C' moves up after ESC M");
        assert.strictEqual(term.screen[2].length, 0, "trailing blank row after ESC M");
    }

    // ---- Regression: VT52 ESC I still performs reverse line feed -------------
    // ESC I must remain Reverse Index (cursor up / scroll down); it must not
    // be conflated with ESC M (delete line).
    {
        const { term, write } = makeTerminal();
        term.screen = [
            [{ c: 65, a: 0 }],
            [{ c: 66, a: 0 }]
        ];
        term.cursorRow = 1;
        term.cursorCol = 0;
        write(ESC + "I");
        assert.strictEqual(term.cursorRow, 0, "ESC I moves the cursor up one row");
        assert.strictEqual(term.screen.length, 2, "ESC I does not delete a line");
    }

    // ---- VT100 IRM insert mode (CSI 4 h): typed chars insert, not overwrite --
    // vi with the insert-capable vt100 termcap enters insert mode via im=\E[4h
    // and prints characters, relying on the terminal to shift the rest of the
    // line right. Before this fix CSI 4 h was ignored, so typing overwrote the
    // existing text instead of inserting.
    {
        const { term, write } = makeTerminal();
        write(ESC + "[4h");                 // IRM set (insert mode)
        write("AB");                        // type at (0,0) and (0,1)
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(33)); // cursor to (0,1)
        write("X");                         // must insert, shifting 'B' right
        assert.strictEqual(term.screen[0][0].c, 65, "IRM keeps 'A'");
        assert.strictEqual(term.screen[0][1].c, 88, "IRM inserts 'X' at the cursor");
        assert.strictEqual(term.screen[0][2].c, 66, "IRM shifts 'B' right");

        // Replace mode (CSI 4 l) restores overwrite behaviour
        write(ESC + "[4l");                 // IRM reset (replace mode)
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(33));
        write("Y");
        assert.strictEqual(term.screen[0][1].c, 89, "replace mode overwrites 'X' with 'Y'");
        assert.strictEqual(term.screen[0][2].c, 66, "replace mode leaves 'B' in place (no extra insert)");
    }

    // ---- ESC 7 / ESC 8 save & restore cursor (DECSC/DECRC) ---------------
    {
        const { term, write } = makeTerminal();
        term.screen = [[{ c: 65, a: 0 }], [{ c: 66, a: 0 }]];
        term.cursorRow = 1;
        term.cursorCol = 0;
        write(ESC + "7");   // save (1,0)
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(33)); // move (0,1)
        assert.strictEqual(term.cursorRow, 0, "ESC 7: cursor moved to row 0");
        assert.strictEqual(term.cursorCol, 1, "ESC 7: cursor moved to col 1");
        write(ESC + "8");   // restore (1,0)
        assert.strictEqual(term.cursorRow, 1, "ESC 8 restores the row");
        assert.strictEqual(term.cursorCol, 0, "ESC 8 restores the column");
    }

    // ---- CSI ?25 h/l toggles cursor visibility (DECTCEM) -----------------
    {
        const { term, write } = makeTerminal();
        assert.strictEqual(term.modes.cursorVisible, true, "cursor visible by default");
        write(ESC + "[?25l");
        assert.strictEqual(term.modes.cursorVisible, false, "CSI ?25 l hides the cursor");
        write(ESC + "[?25h");
        assert.strictEqual(term.modes.cursorVisible, true, "CSI ?25 h shows the cursor");
    }

    // ---- CSI ?7 h/l controls auto-wrap (DECAWM) --------------------------
    {
        const { term, write } = makeTerminal();
        // With wrap on (default), a printable on the last column arms a
        // pending wrap; the next printable lands on the next line.
        write("A".repeat(80));
        assert.strictEqual(term.cursorCol, 79, "cursor rests on the last column");
        assert.strictEqual(term.wrapPending, true, "wrap is pending at the right margin");
        write("B");
        assert.strictEqual(term.cursorRow, 1, "DECAWM wraps to the next line");
        assert.strictEqual(term.screen[1][0].c, 66, "wrapped character lands at column 0");

        // With wrap off, the last column is overwritten in place.
        write(ESC + "[?7l");
        write(ESC + "Y" + String.fromCharCode(32 + 1) + String.fromCharCode(32 + 79)); // (1,79)
        write("X");
        assert.strictEqual(term.cursorCol, 79, "DECAWM off: cursor stays at the last column");
        assert.strictEqual(term.wrapPending, false, "DECAWM off: no pending wrap");
        assert.strictEqual(term.screen[1][79].c, 88, "DECAWM off: margin column overwritten");
    }

    // ---- CSI 6 n reports the cursor position (CPR) -----------------------
    {
        const { term, sent, write } = makeCapturingTerminal();
        term.screen = [[{ c: 65, a: 0 }, { c: 66, a: 0 }]];
        term.cursorRow = 0;
        term.cursorCol = 1;
        write(ESC + "[6n");
        assert.deepStrictEqual(sent, [27, 91, 49, 59, 50, 82],
            "CPR answers ESC [ 1 ; 2 R");
    }

    // ---- ESC Z identifies as a VT52 without copier (ESC / K) -------------
    {
        const { sent, write } = makeCapturingTerminal();
        write(ESC + "Z");
        assert.deepStrictEqual(sent, [27, 47, 75], "ESC Z answers ESC / K");
    }

    // ---- BEL invokes the playBell hook and flashes the textarea ----------
    // In textarea mode (no canvas) the visual bell falls back to a CSS class
    // on the textarea; with a playBell hook installed both must happen.
    {
        const { sandbox, term, write } = makeCapturingTerminal();
        let bellCount = 0;
        sandbox.window.playBell = () => bellCount++;
        const added = [];
        term.textArea.classList.add = (c) => added.push(c);
        write("\x07");
        assert.strictEqual(bellCount, 1, "BEL triggers window.playBell once");
        assert.deepStrictEqual(added, ["vt52-bell-flash"],
            "BEL flashes the textarea via the .vt52-bell-flash class");
    }

    // ---- CSI d / G position rows and columns (VPA / CHA) -----------------
    {
        const { term, write } = makeTerminal();
        term.cursorCol = 5;
        write(ESC + "[3d");
        assert.strictEqual(term.cursorRow, 2, "CSI 3 d moves to row 3");
        assert.strictEqual(term.cursorCol, 5, "CSI d keeps the column");
        write(ESC + "[5G");
        assert.strictEqual(term.cursorCol, 4, "CSI 5 G moves to column 5");
        assert.strictEqual(term.cursorRow, 2, "CSI G keeps the row");
    }

    // ---- CSI ?2 h/l selects VT52 / ANSI mode (DECANM) --------------------
    {
        const { term, write } = makeTerminal();
        term.modes.ansi = true;
        write(ESC + "[?2h");
        assert.strictEqual(term.modes.ansi, false, "CSI ?2 h selects VT52 mode");
        write(ESC + "[?2l");
        assert.strictEqual(term.modes.ansi, true, "CSI ?2 l selects ANSI mode");
    }

    // ---- CSI ?1 h/l toggles application cursor keys (DECCKM) -------------
    {
        const { term, sent, write } = makeCapturingTerminal();
        term.modes.ansi = true;
        const fire = (code) =>
            term.handleKey({ code, key: "ArrowUp", ctrlKey: false, preventDefault() {} });

        fire("ArrowUp");
        assert.deepStrictEqual([...sent], [27, 91, 65], "default arrow sends ESC [ A");
        sent.length = 0;

        write(ESC + "[?1h");   // DECCKM set
        assert.strictEqual(term.modes.appCursor, true, "CSI ?1 h enables app cursor keys");
        fire("ArrowUp");
        assert.deepStrictEqual([...sent], [27, 79, 65], "DECCKM arrow sends ESC O A");
        sent.length = 0;

        write(ESC + "[?1l");   // DECCKM reset
        assert.strictEqual(term.modes.appCursor, false, "CSI ?1 l disables app cursor keys");
        fire("ArrowUp");
        assert.deepStrictEqual([...sent], [27, 91, 65], "arrow returns to CSI after DECCKM reset");
    }

    // ---- vi VT52 tail-rewrite (TERM=vt52, no insert mode) -----------------
    // On a terminal without insert capability vi keeps the screen correct by
    // reprinting the tail after the inserted character: it positions with cm
    // (ESC Y), types the inserted char, then repositions and types each
    // shifted character of the original tail.
    {
        const { term, write } = makeTerminal();
        term.screen = [[{ c: 65, a: 0 }, { c: 66, a: 0 }, { c: 67, a: 0 }]]; // "ABC"
        term.cursorRow = 0;
        term.cursorCol = 1;
        // vi: cm to (0,1), type 'X', then cm to (0,2) type 'B', cm to (0,3) type 'C'
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(33)); // (0,1)
        write("X");
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(34)); // (0,2)
        write("B");
        write(ESC + "Y" + String.fromCharCode(32) + String.fromCharCode(35)); // (0,3)
        write("C");
        assert.strictEqual(term.screen[0][0].c, 65, "tail rewrite keeps 'A'");
        assert.strictEqual(term.screen[0][1].c, 88, "tail rewrite keeps the inserted 'X'");
        assert.strictEqual(term.screen[0][2].c, 66, "tail rewrite shifts 'B' right");
        assert.strictEqual(term.screen[0][3].c, 67, "tail rewrite shifts 'C' right");
    }

    // ---- VT52 mode never draws bold/underline (historical accuracy) ---------
    // A DECscope VT52 has no SGR emphasis: bold and underline are VT100-only
    // attributes (DECANM / modes.ansi). Even if a cell carries those attribute
    // bits (via SGR or an nroff/man overstrike), renderText() must mask them
    // out in VT52 mode and draw a plain glyph. In ANSI mode the emphasis is
    // still drawn (regression guard).
    {
        const { term, calls } = makeCanvasTerminal();
        const ATTR_BOTH = ATTR_BOLD | ATTR_UNDERSCORE;

        // VT52 mode (modes.ansi === false): plain single-strike glyph, no underline
        term.modes.ansi = false;
        term.renderText(0, 0, ATTR_BOTH, "X");
        assert.strictEqual(calls.fillText.length, 1,
            "VT52 draws one strike, not a bold double-strike");
        assert.ok(!calls.fillText[0].font.includes("bold"),
            "VT52 uses the normal font, never bold");
        assert.strictEqual(
            calls.fillRect.filter(r => r.h === term.underlineHeight).length, 0,
            "VT52 draws no underline bar");
        calls.fillText.length = 0;
        calls.fillRect.length = 0;

        // ANSI mode (modes.ansi === true): bold double-strike + underline bar
        term.modes.ansi = true;
        term.renderText(0, 0, ATTR_BOTH, "X");
        assert.strictEqual(calls.fillText.length, 2,
            "ANSI bold still draws a double strike");
        assert.ok(calls.fillText[0].font.includes("bold"),
            "ANSI bold still uses the bold font");
        assert.strictEqual(
            calls.fillRect.filter(r => r.h === term.underlineHeight).length, 1,
            "ANSI underline still draws the underline bar");
    }

    console.log("vt52.test.js: all overstrike tests passed");
}

run();
