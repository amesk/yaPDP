#!/usr/bin/env node
/**
 * LP11 on-screen sheet aspect tests.
 *
 * The Printer page draws the LP11's fanfold sheet cell by cell. A line printer
 * sets 10 pitch (1/10in advance) by 6 LPI (1/6in line), so one line must be
 * 10/6 glyph advances tall; 132 x 66 cells then span 13.2 x 11in — the 1.2
 * aspect of the real print area on 14 7/8 x 11in fanfold. The Google60 16px
 * line made one sheet 1026 x 1061px — TALLER than wide — which stretched every
 * printed line 1.37x vertically (the reported "Print Preview is right, the
 * Printer page is stretched" bug).
 *
 * The screen geometry lives in two places that must agree: the renderer's line
 * pitch in src/g60printer.js (LP11_CELL_HEIGHT) and the sheet's styling in
 * css/g60printer.css (--lp11-cell). This test reads the production sources so
 * the numbers cannot drift, and pins the resulting sheet, not just the
 * constants: 1026 x 775px is wider than tall, as real fanfold is.
 *
 * The console teletype must be left alone: it keeps the 16px Google60 line.
 *
 * Run with:  node tests/lp11-sheet-aspect.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G60_JS = path.join(ROOT, "src", "g60printer.js");
const G60_CSS = path.join(ROOT, "css", "g60printer.css");
const LP11_DEVICE = path.join(ROOT, "src", "devices", "lp11.js");
const IOPAGE = path.join(ROOT, "src", "iopage.js");

// Machine geometry the page already uses.
const COLUMNS = 132;
const LINES = 66;
const CHAR_WIDTH = 7;          // computePaperGeometry's glyph advance
const PADDING_X = 18;          // print-area cell padding, each side
const MARGIN_X = 33;           // tractor-hole margin, each side
// LP11 print-area padding override (css/g60printer.css): 4px top, 1px bottom.
const PAD_TOP = 4;
const PAD_BOTTOM = 1;

function extractRule(css, selector, last) {
    const marker = selector + " {";
    const start = last ? css.lastIndexOf(marker) : css.indexOf(marker);
    if (start === -1) throw new Error("rule not found: " + selector);
    const braceOpen = start + marker.length - 1;
    let depth = 0;
    for (let i = braceOpen; i < css.length; i++) {
        const c = css[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return css.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces for: " + selector);
}

function run() {
    const js = fs.readFileSync(G60_JS, "utf8");
    const css = fs.readFileSync(G60_CSS, "utf8");

    // --- 1. The JS cell height matches 10 pitch x 6 LPI --------------------
    const jsCell = js.match(/var LP11_CELL_HEIGHT = ([\d.]+);/);
    assert.ok(jsCell, "src/g60printer.js must declare LP11_CELL_HEIGHT");
    const cell = parseFloat(jsCell[1]);

    const cw = js.match(/var charWidth = (\d+);/);
    assert.ok(cw, "src/g60printer.js must declare charWidth");
    assert.strictEqual(Number(cw[1]), CHAR_WIDTH, "glyph advance stayed 7px");

    const cellAspect = cell / CHAR_WIDTH;
    const realCellAspect = (1 / 6) / (1 / 10); // 6 LPI at 10 pitch
    assert.ok(Math.abs(cellAspect - realCellAspect) < 0.002,
        `one line must be 10/6 advances tall (${cellAspect.toFixed(4)} vs ${realCellAspect.toFixed(4)})`);

    // --- 2. CSS and JS state the same cell height --------------------------
    const cssCell = css.match(/--lp11-cell:\s*([\d.]+)px;/);
    assert.ok(cssCell, "css/g60printer.css must declare --lp11-cell");
    assert.ok(Math.abs(parseFloat(cssCell[1]) - cell) < 0.001,
        `--lp11-cell (${cssCell[1]}) must equal LP11_CELL_HEIGHT (${cell})`);

    // --- 3. The sheet is drawn with that cell ------------------------------
    const area = extractRule(css, "#lp11_printer td#lp11g60paper_printarea");
    assert.ok(/line-height:\s*var\(--lp11-cell\);/.test(area),
        "the LP11 print area must use the machine's line pitch:\n" + area);
    assert.ok(/font-size:\s*10px;/.test(area),
        "the glyph must fit inside the 11.6667px cell:\n" + area);
    assert.ok(/background-size:\s*96px\s*calc\(var\(--lp11-cell\)\s*\*\s*4\);/.test(area),
        "one paper.png tile must stay four character cells tall:\n" + area);

    const span = extractRule(css, "#lp11_printer td#lp11g60paper_printarea span");
    assert.ok(/height:\s*var\(--lp11-cell\);/.test(span) &&
        /max-height:\s*var\(--lp11-cell\);/.test(span),
        "a glyph cell must be one line tall:\n" + span);

    const line = extractRule(css, "#lp11_printer td#lp11g60paper_printarea p");
    assert.ok(/max-height:\s*var\(--lp11-cell\);/.test(line),
        "a printed row must be one line tall:\n" + line);

    // The seam selector also appears in the shared teletype rule, so take the
    // LAST match: the LP11-specific override introduced for this fix.
    const seam = extractRule(css,
        "#lp11_printer td#lp11g60paper_printarea p.pageBreak", true);
    assert.ok(/max-height:\s*var\(--lp11-cell\);/.test(seam),
        "the fold seam must be one line tall too:\n" + seam);

    // --- 4. The resulting sheet is wider than tall -------------------------
    const contentW = COLUMNS * CHAR_WIDTH;
    const sheetW = contentW + 2 * PADDING_X + 2 * MARGIN_X; // 1026px
    const sheetH = LINES * cell + PAD_TOP + PAD_BOTTOM;     // 775px
    const sheetAspect = sheetW / sheetH;
    const printAspect = contentW / (LINES * cell);          // 13.2 x 11in

    assert.strictEqual(sheetW, 1026, "sheet width stays the 132-column platen");
    assert.ok(sheetAspect > 1,
        `one sheet must be wider than tall (${sheetW} x ${sheetH.toFixed(1)} = ${sheetAspect.toFixed(3)})`);
    assert.ok(Math.abs(sheetAspect - 14.875 / 11) < 0.04,
        `sheet aspect must be close to real fanfold (${sheetAspect.toFixed(3)} vs ${(14.875 / 11).toFixed(3)})`);
    assert.ok(Math.abs(printAspect - 1.2) < 0.01,
        `print area must keep the real 13.2 x 11in aspect (${printAspect.toFixed(3)})`);

    // --- 5. The console teletype keeps its 16px Google60 line -------------
    const ttyArea = extractRule(css, "#g60printer td#paper_printarea");
    assert.ok(/line-height:\s*16px;/.test(ttyArea),
        "the console teletype must keep its 16px line:\n" + ttyArea);
    assert.ok(/opts\.lineHeight[\s\S]{0,80}?:\s*16;/.test(js),
        "G60Printer's lineHeight must still default to 16px");

    // --- 6. Both LP11 printer builders pass the cell height ----------------
    for (const file of [LP11_DEVICE, IOPAGE]) {
        const src = fs.readFileSync(file, "utf8");
        assert.ok(/lineHeight:\s*window\.G60Printer\.LP11_CELL_HEIGHT/.test(src),
            path.relative(ROOT, file) + " must pass the LP11 cell height");
    }

    console.log("\nAll LP11 sheet-aspect tests passed.");
}

run();
