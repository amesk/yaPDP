#!/usr/bin/env node
/**
 * LP11 paper-copy modular tests.
 *
 * Exercises src/lp11paper.js — the ONE text state machine both printer paths
 * share (the devices/lp11.js Device and the legacy iopage.js closure). It used
 * to live twice, and the copies drifted: the Device wrote a literal two-character
 * "\f" instead of a real page break, and only the legacy copy padded TABs. This
 * suite pins the shared behaviour, plus the source-level parity guard that keeps
 * either implementation from growing its own copy again.
 *
 * The stream under test is what a 2.11BSD lpd writes to the LP11 controller:
 * printable ASCII, BS (0o10), TAB (0o11), LF (0o12), CR (0o15) and FF (0o14).
 *
 * Run with:  node tests/lp11-text.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const PAPER_PATH = path.join(ROOT, "src", "lp11paper.js");
const DEVICE_PATH = path.join(ROOT, "src", "devices", "lp11.js");
const IOPAGE_PATH = path.join(ROOT, "src", "iopage.js");
const PAGE_PATH = path.join(ROOT, "pdp11.html");

const paper = require(PAPER_PATH);

// Control codes (decimal) — the LP11 driver's stream.
const LF = 10;   // 0o12
const FF = 12;   // 0o14 form feed
const CR = 13;   // 0o15
const TAB = 9;   // 0o11
const BS = 8;    // 0o10
const DEL = 127; // 0o7F

function freshState() {
    return { buffer: [], bufferRuns: [], line: "", lineRuns: [], col: 0 };
}

// Feed an array of character codes into the state machine.
function feed(state, codes) {
    for (const c of codes) paper.textPut(state, c);
    return state;
}

function codes(text) {
    return Array.from(text).map((ch) => ch.charCodeAt(0));
}

function run() {
    const put = paper.textPut;

    // 1. Printable characters accumulate in the current line.
    {
        const s = freshState();
        feed(s, codes("Hi"));
        assert.strictEqual(s.line, "Hi", "printables accumulate");
        assert.strictEqual(s.col, 2, "cursor advances with the line");
    }

    // 2. LF pushes the finished line into the buffer and resets the cursor.
    {
        const s = freshState();
        feed(s, codes("AB").concat([LF], codes("C")));
        assert.deepStrictEqual(s.buffer, ["AB"], "LF pushes the completed line");
        assert.deepStrictEqual(s.bufferRuns.length, 1,
            "the run stream stays aligned with the buffer");
        assert.strictEqual(s.line, "C", "next line starts after LF");
        assert.strictEqual(s.col, 1, "cursor resets after LF");
    }

    // 3. CR then the same glyph = nroff bold: one clean glyph, printed bold.
    {
        const s = freshState();
        feed(s, codes("A").concat([CR], codes("A")));
        assert.strictEqual(s.line, "A", "CR overstrike collapses bold to one glyph");
        assert.deepStrictEqual(s.lineRuns, [{ at: 0, len: 1, kind: paper.BOLD }],
            "double strike records a bold run (printed bold)");
    }

    // 4. BS over an underscore = nroff underline: one glyph, underlined.
    {
        const s = freshState();
        feed(s, codes("_").concat([BS], codes("X")));
        assert.strictEqual(s.line, "X", "BS overstrike collapses underline");
        assert.deepStrictEqual(s.lineRuns, [{ at: 0, len: 1, kind: paper.UNDERLINE }],
            "underscore overstrike records an underline run");

        const mirror = freshState();
        feed(mirror, codes("X").concat([BS], codes("_")));
        assert.deepStrictEqual(mirror.lineRuns, [{ at: 0, len: 1, kind: paper.UNDERLINE }],
            "a glyph struck onto an underscore underlines the same way");
    }

    // 4b. A different glyph struck over another leaves the LAST glyph (that is
    //     what the mechanism prints) and reads as bold: a real ink blot cannot
    //     be reproduced on paper, "heavier" can.
    {
        const s = freshState();
        feed(s, codes("A").concat([BS], codes("B")));
        assert.strictEqual(s.line, "B", "the last glyph struck survives the blot");
        assert.deepStrictEqual(s.lineRuns, [{ at: 0, len: 1, kind: paper.BOLD }],
            "an ink-blot overstrike prints bold");
    }

    // 4b-bis. A strike can only ADD ink: it never erases what is on the paper.
    //     A blank strike prints nothing, and an underscore struck over a glyph
    //     underlines that glyph instead of replacing it (the "sh [ -ceik…"
    //     mangling came from treating the incoming byte as a replacement).
    {
        const blank = freshState();
        feed(blank, codes("A").concat([BS], codes(" ")));
        assert.strictEqual(blank.line, "A", "a blank strike leaves the glyph");
        assert.deepStrictEqual(blank.lineRuns, [], "and adds no styling");

        const onto = freshState();
        feed(onto, codes(" ").concat([BS], codes("A")));
        assert.strictEqual(onto.line, "A", "a glyph struck onto a blank prints");

        const bracket = freshState();
        feed(bracket, codes("[").concat([BS], codes("_")));
        assert.strictEqual(bracket.line, "[",
            "an underscore strike keeps the glyph it lands on");
        assert.deepStrictEqual(bracket.lineRuns, [{ at: 0, len: 1, kind: paper.UNDERLINE }],
            "and underlines it");
    }

    // 4c. Touching bold columns merge into one run instead of piling up.
    {
        const s = freshState();
        feed(s, codes("AB").concat([CR], codes("AB")));
        assert.deepStrictEqual(s.lineRuns, [{ at: 0, len: 2, kind: paper.BOLD }],
            "adjacent bold columns merge into a single run");
    }

    // 5. TAB advances to the next 8-column stop with spaces.
    {
        const s = freshState();
        feed(s, codes("ab").concat([TAB], codes("x")));
        assert.strictEqual(s.line, "ab      x", "TAB pads to the next 8-column stop");
        assert.strictEqual(s.col, 9, "TAB cursor lands on the tab stop");
    }

    // 5b. TAB must never erase what is already printed: it only moves the
    //     carriage to the next stop. Padding through the glyph writer strikes
    //     the platen, which is how a man page lost phrases in the job copy
    //     while the animated paper still showed them.
    {
        const s = freshState();
        feed(s, codes("0123456789ABCDEFGHIJ"));    // 20 columns of text
        feed(s, [TAB]);
        assert.strictEqual(s.line, "0123456789ABCDEFGHIJ    ",
            "TAB pads the gap to the next stop and keeps every glyph");
        assert.strictEqual(s.col, 24, "the cursor lands on the next stop");
        feed(s, codes("X"));
        assert.strictEqual(s.line, "0123456789ABCDEFGHIJ    X",
            "the glyph after TAB lands past the text, never on top of it");
    }

    // 5c. A TAB with the cursor INSIDE the line (after a CR) moves the cursor
    //     and touches nothing — the carriage has no type.
    {
        const s = freshState();
        feed(s, codes("ABCDEFGHIJ"));
        feed(s, [CR, TAB]);
        assert.strictEqual(s.line, "ABCDEFGHIJ", "TAB erased nothing");
        assert.strictEqual(s.col, 8, "the cursor jumped to the next stop");
    }

    // 5d. Property: whatever the column a TAB arrives at, no printed glyph is
    //     ever lost. nroff lays man pages out with tabs, and a tab that struck
    //     the platen ate whole phrases out of the job copy.
    {
        for (const gap of [0, 1, 2, 3, 5, 7, 8, 9]) {
            const s = freshState();
            for (let i = 0; i < 20; i++) {
                paper.textPut(s, 0x41 + i);              // 'A'..'T'
                for (let g = 0; g < gap; g++) paper.textPut(s, 0x20);
                paper.textPut(s, TAB);
            }
            const letters = s.line.replace(/ /g, "");
            assert.strictEqual(letters, "ABCDEFGHIJKLMNOPQRST",
                "TAB lost a glyph when the gap to the next stop was " + gap);
        }
    }

    // 6. FF records a real 0x0C page sentinel (2.11BSD lpd sends FF between
    //    jobs, so the export keeps real page breaks).
    {
        const s = freshState();
        feed(s, codes("J1").concat([LF, FF]));
        assert.deepStrictEqual(s.buffer, ["J1", "\f"], "FF pushes a page sentinel");
        assert.strictEqual(s.buffer[1], "\f", "the sentinel is a real 0x0C");
        assert.notStrictEqual(s.buffer[1], "\\f",
            "FF must not store a literal backslash-f marker");
        assert.strictEqual(s.line, "", "cursor state unchanged by FF");
    }

    // 6b. FF in the middle of a line completes that line first (the sheet is
    //     ejected at the current position, not with a half-printed line lost).
    {
        const s = freshState();
        feed(s, codes("JOB").concat([FF], codes("NEXT")));
        assert.deepStrictEqual(s.buffer, ["JOB", "\f"],
            "a half-printed line is completed before the eject");
        assert.strictEqual(s.line, "NEXT", "printing continues on the next sheet");
    }

    // 6c. A second FF with nothing printed in between does not add a blank
    //     sheet — the on-screen fanfold only ejects a sheet that has content.
    {
        const s = freshState();
        feed(s, codes("A").concat([LF, FF, FF]));
        assert.deepStrictEqual(s.buffer, ["A", "\f"], "a duplicate FF is a no-op");
    }

    // 6d. FF on a blank machine prints nothing at all.
    {
        const s = freshState();
        feed(s, [FF]);
        assert.deepStrictEqual(s.buffer, [], "FF before any output is ignored");
    }

    // 7. Two jobs separated by a form feed keep their page boundary.
    {
        const s = freshState();
        feed(s, codes("Job1").concat([LF, FF], codes("Job2"), [LF]));
        assert.deepStrictEqual(s.buffer, ["Job1", "\f", "Job2"],
            "jobs keep the FF boundary");
        assert.strictEqual(s.line, "", "current line is empty after the last LF");
    }

    // 8. DEL and other control codes are ignored (do not move the cursor).
    {
        const s = freshState();
        feed(s, codes("A").concat([DEL, 0, 1], codes("B")));
        assert.strictEqual(s.line, "AB", "DEL/controls ignored");
    }

    // 9. joinText is what Save .txt writes: real sentinels, no styling.
    {
        const s = freshState();
        feed(s, codes("A").concat([LF, FF], codes("B")));
        assert.strictEqual(paper.joinText(s.buffer, s.line), "A\n\f\nB",
            "Save .txt keeps the 0x0C page breaks");
    }

    // 10. A caller may pass a bare { buffer, line, col } state (the pre-fix
    //     shape used by old tests and any out-of-tree call site).
    {
        const s = { buffer: [], line: "", col: 0 };
        put(s, "X".charCodeAt(0));
        put(s, CR);
        put(s, "X".charCodeAt(0));
        assert.strictEqual(s.line, "X", "the bare state still works");
        assert.deepStrictEqual(s.lineRuns, [{ at: 0, len: 1, kind: paper.BOLD }],
            "the run stream is created lazily");
    }

    // 10b. The raw-stream recorder stays silent unless it is asked for, and
    //      keeps the LAST bytes when the job overflows its ring.
    {
        const before = paper.rawStream().length;
        paper.textPut(freshState(), 0x41);
        assert.strictEqual(paper.rawStream().length, before,
            "nothing is recorded while __lp11Record is off");

        globalThis.__lp11Record = true;
        try {
            const s = freshState();
            feed(s, codes("HI").concat([TAB], codes("OK")));
            const raw = paper.rawStream();
            assert.deepStrictEqual(raw, [0x48, 0x49, TAB, 0x4f, 0x4b],
                "the recorder returns the bytes the guest wrote, in order");
        } finally {
            delete globalThis.__lp11Record;
        }
    }

    // 11. Parity guard: both printer paths must delegate to this module instead
    //     of carrying their own copy of the state machine again.
    {
        const device = fs.readFileSync(DEVICE_PATH, "utf8");
        const iopage = fs.readFileSync(IOPAGE_PATH, "utf8");
        const page = fs.readFileSync(PAGE_PATH, "utf8");

        assert.ok(/require\("\.\.\/lp11paper\.js"\)/.test(device),
            "devices/lp11.js must require src/lp11paper.js");
        assert.ok(/Lp11PaperLib\.printDocument/.test(iopage),
            "iopage.js must print through src/lp11paper.js");
        assert.ok(/lp11paper\.js/.test(iopage),
            "iopage.js must load src/lp11paper.js");
        assert.ok(!/function\s+lp11TextPut/.test(device),
            "devices/lp11.js must not keep its own textPut copy");
        assert.ok(!/function\s+lp11TextPut/.test(iopage),
            "iopage.js must not keep its own textPut copy");

        const paperTag = page.indexOf("src/lp11paper.js");
        const legacyTag = page.indexOf("src/iopage.js");
        const deviceTag = page.indexOf("src/devices/lp11.js");
        assert.ok(paperTag !== -1, "pdp11.html must load src/lp11paper.js");
        assert.ok(paperTag < legacyTag && paperTag < deviceTag,
            "pdp11.html must load src/lp11paper.js before either printer path");
    }

    console.log("lp11-text.test.js: all tests passed");
}

run();
