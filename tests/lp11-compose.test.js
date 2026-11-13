#!/usr/bin/env node
/**
 * LP11 glyph-composition tests.
 *
 * Unix V5's printer driver (/usr/sys/dmr/lp.c, lpcanon()) prints a character
 * the LP11 type train does not have by striking a base glyph, backing the
 * carriage up one column and striking a mark over it: '(' + BS + '-' builds a
 * '{'. The two strikes share ONE column — the driver decrements its own column
 * counter so the extra byte never eats a pitch — which is why a listing printed
 * that way keeps its alignment.
 *
 * The paper copy therefore carries the COMPOSED character (Save .txt, the paper
 * snapshot) and a COMPOSE run marks the column so the printed sheet and the
 * Printer page can paint the two strikes over it. A '{' the guest printed
 * directly, without the overstrike, must never be composed back.
 *
 * Run with:  node tests/lp11-compose.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const paper = require(path.join(ROOT, "src", "lp11paper.js"));

const LF = 10;
const BS = 8;

function freshState() {
    return { buffer: [], bufferRuns: [], line: "", lineRuns: [], col: 0 };
}

function feed(state, codes) {
    for (const c of codes) paper.textPut(state, c);
    return state;
}

function codes(text) {
    return Array.from(text).map((ch) => ch.charCodeAt(0));
}

// The five pairs Unix V5's lpcanon() builds, base + mark.
const PAIRS = [
    ["(", "-", "{"],
    [")", "-", "}"],
    ["'", "-", "`"],
    ["!", "-", "|"],
    ["^", "-", "~"],
];

function run() {
    // 1. The table: every pair builds exactly one glyph, in both directions.
    {
        for (const [base, mark, glyph] of PAIRS) {
            assert.strictEqual(paper.composePair(base, mark), glyph,
                `'${base}' + '${mark}' builds '${glyph}'`);
            assert.deepStrictEqual(paper.splitGlyph(glyph), { base, mark },
                `'${glyph}' splits back into '${base}' + '${mark}'`);
        }
        assert.strictEqual(paper.composePair("5", "4"), null,
            "a pair the driver never composes is not in the table");
        assert.strictEqual(paper.composePair("A", "-"), null,
            "a letter struck over by '-' is not a composite glyph");
        assert.strictEqual(paper.composePair("(", "="), null,
            "the mark alone does not decide");
        assert.strictEqual(paper.splitGlyph("Q"), null, "a plain glyph does not split");
        const first = paper.splitGlyph("{");
        first.base = "X";
        assert.deepStrictEqual(paper.splitGlyph("{"),
            { base: "(", mark: "-" },
            "splitGlyph hands out a fresh copy, so a caller cannot corrupt the table");
    }

    // 2. The paper copy carries the composed character, in ONE column.
    {
        const s = freshState();
        feed(s, codes("(").concat([BS], codes("-")));
        assert.strictEqual(s.line, "{", "the two strikes build one character");
        assert.strictEqual(s.col, 1, "and consume exactly one column");
        assert.deepStrictEqual(s.lineRuns,
            [{ at: 0, len: 1, kind: paper.COMPOSE }],
            "the column is marked as composed");
    }

    // 2b. The column accounting is the driver's: the next glyph follows at once.
    {
        const s = freshState();
        feed(s, codes("(").concat([BS], codes("-")));
        feed(s, codes("Q"));
        assert.strictEqual(s.line, "{Q", "the next glyph lands in the next column");
        assert.strictEqual(s.col, 2, "two columns, not three");
    }

    // 2c. Every V5 pair survives the round trip through the copy.
    {
        for (const [base, mark, glyph] of PAIRS) {
            const s = freshState();
            feed(s, codes(base).concat([BS], codes(mark)));
            assert.strictEqual(s.line, glyph, `'${base}' + BS + '${mark}' is '${glyph}'`);
            assert.strictEqual(s.col, 1, "one column per composed character");
        }
    }

    // 3. Nothing else about overstrike changes: bold, underline and the blot.
    {
        const twice = freshState();
        feed(twice, codes("A").concat([BS], codes("A")));
        assert.strictEqual(twice.line, "A", "the same glyph struck twice stays one glyph");
        assert.deepStrictEqual(twice.lineRuns,
            [{ at: 0, len: 1, kind: paper.BOLD }], "and reads as bold");

        const under = freshState();
        feed(under, codes("_").concat([BS], codes("X")));
        assert.deepStrictEqual(under.lineRuns,
            [{ at: 0, len: 1, kind: paper.UNDERLINE }], "an underscore strike underlines");

        const blot = freshState();
        feed(blot, codes("A").concat([BS], codes("B")));
        assert.strictEqual(blot.line, "B", "a real blot keeps the last glyph");
        assert.deepStrictEqual(blot.lineRuns,
            [{ at: 0, len: 1, kind: paper.BOLD }], "and still reads as bold");
    }

    // 4. normalizeRuns keeps the new kind and still drops anything else (an
    //    older build reading a newer snapshot must not choke).
    {
        const runs = paper.normalizeRuns([
            { at: 0, len: 1, kind: paper.COMPOSE },
            { at: 1, len: 1, kind: "garbage" },
            { at: 2, len: 1, kind: paper.BOLD },
        ]);
        assert.deepStrictEqual(runs, [
            { at: 0, len: 1, kind: paper.COMPOSE },
            { at: 2, len: 1, kind: paper.BOLD },
        ], "compose survives normalization, unknown kinds are dropped");
    }

    // 5. Save .txt is the composed character — a .txt is not a byte stream.
    {
        const s = freshState();
        feed(s, codes("x=(").concat([BS], codes("-"), codes("}"), [LF]));
        assert.strictEqual(paper.joinText(s.buffer, s.line), "x={}\n",
            "the .txt copy shows the composed glyphs, not the strikes");
    }

    // 6. The printed sheet shows the TWO STRIKES, like the Printer page.
    {
        const html = paper.lineHtml({
            text: "{",
            runs: [{ at: 0, len: 1, kind: paper.COMPOSE }],
        });
        assert.strictEqual(html,
            '<span class="compose" data-base="(" data-mark="-">{</span>',
            "a composed cell carries the pair for CSS to paint");
    }

    // 6b. An apostrophe base is attribute-safe (the backtick pair). The entity
    //     is assembled from its code point: written literally, an editor
    //     rewrites it back into a bare quote — the same trap the ESCAPE_MAP
    //     comment in src/lp11paper.js warns about.
    {
        const AMP = String.fromCharCode(38);
        const html = paper.lineHtml({
            text: "`",
            runs: [{ at: 0, len: 1, kind: paper.COMPOSE }],
        });
        assert.ok(html.indexOf('data-base="' + AMP + '#39;"') !== -1,
            "the quote is escaped in the attribute");
        assert.ok(html.indexOf('data-mark="-"') !== -1, "the mark is present");
    }

    // 6c. A literal '{' — the guest printed it, nothing was overstruck — is
    //     printed plain: composition is never guessed back from the glyph.
    {
        const html = paper.lineHtml({ text: "{", runs: [] });
        assert.strictEqual(html, "{", "a literal brace is not decomposed");
    }

    // 6d. Two touching composed columns are merged into one run by
    //     normalizeRuns, so lineHtml must walk the run per character.
    {
        const html = paper.lineHtml({
            text: "{}",
            runs: [{ at: 0, len: 2, kind: paper.COMPOSE }],
        });
        assert.strictEqual(
            html.split('class="compose"').length - 1, 2,
            "each column of a merged run gets its own composed span");
    }

    // 7. The print document carries the rules that paint the pair.
    {
        const doc = paper.buildPrintDocument(
            [{ text: "{", runs: [{ at: 0, len: 1, kind: paper.COMPOSE }] }],
            { columns: 132, paper: "plain" }
        );
        assert.ok(/span\.compose\s*\{[^}]*position:\s*relative/.test(doc),
            "the composed cell is a positioning context");
        assert.ok(/span\.compose\s*\{[^}]*color:\s*transparent/.test(doc),
            "the composite itself is painted transparent");
        assert.ok(/span\.compose::before\s*\{\s*content:\s*attr\(data-base\)/.test(doc),
            "::before paints the base glyph");
        assert.ok(/span\.compose::after\s*\{\s*content:\s*attr\(data-mark\)/.test(doc),
            "::after paints the mark");
        assert.ok(doc.indexOf('data-base="("') !== -1, "the pair reaches the sheet");
    }

    // 8. Parity guard: the screen path builds the same cell, and only the LP11
    //    instances compose (a Model 33 ASR keeps its authentic blot).
    {
        const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
        const g60 = read("src/g60printer.js");
        const css = read("css/g60printer.css");
        const device = read("src/devices/lp11.js");
        const iopage = read("src/iopage.js");

        assert.ok(/options\.composeGlyphs/.test(g60),
            "g60printer.js documents the compose option");
        assert.ok(/setAttribute\('data-base'/.test(g60),
            "the cell carries the base glyph for CSS");
        assert.ok(/setAttribute\('data-mark'/.test(g60),
            "the cell carries the mark for CSS");
        assert.ok(/span\.compose::before/.test(css),
            "css/g60printer.css paints the composed cell");
        assert.ok(/composeGlyphs:\s*true/.test(device),
            "the LP11 Device composes");
        assert.ok(/composeGlyphs:\s*true/.test(iopage),
            "the legacy LP11 closure composes");
    }

    console.log("lp11-compose.test.js: all tests passed");
}

run();
