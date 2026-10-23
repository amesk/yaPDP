#!/usr/bin/env node
/**
 * Probe — does the LP11 print document really behave like paper?
 *
 * Unit tests pin the markup and the pagination logic, but the two promises
 * that depend on the browser's paged media cannot be checked without one:
 *
 *   1. the configured column count spans the PRINTABLE WIDTH of the sheet the
 *      print dialog hands us (@page { size: auto } + 100cqw / --colw);
 *   2. one logical sheet stays one physical sheet (66 lines fit the height).
 *
 * This probe renders the document Chromium would print, converts it to a PDF
 * and measures the glyph runs with PDF.js. Not part of `npm test` (it needs
 * Chromium and ~10s); run it when touching the print CSS or the column fit:
 *
 *   node tools/_probe-lp11-print.js
 *
 * Exit code 0 = the paper geometry holds, non-zero = it does not.
 */
"use strict";

const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const paper = require(path.join(ROOT, "src", "lp11paper.js"));

const COLUMNS = paper.DEFAULT_COLUMNS;       // 132
const LINES_PER_PAGE = paper.DEFAULT_LINES_PER_PAGE; // 66

// Letter, and the @page margins from the document (12mm top/bottom, 10mm sides).
const SHEET_W_PT = 612;
const SHEET_H_PT = 792;
const MARGIN_X_PT = (10 / 25.4) * 72;
const MARGIN_Y_PT = (12 / 25.4) * 72;
const CONTENT_W_PT = SHEET_W_PT - 2 * MARGIN_X_PT;
const CONTENT_H_PT = SHEET_H_PT - 2 * MARGIN_Y_PT;

// A packed sheet: 66 lines of 132 glyphs, one of them bold, then a form feed
// and a short second sheet. Every line is full width so the right edge is
// measurable, and the bold line proves the weight does not widen the grid.
function buildDocument() {
    const buffer = [];
    const bufferRuns = [];
    for (let i = 0; i < LINES_PER_PAGE; i++) {
        buffer.push("M".repeat(COLUMNS));
        bufferRuns.push(i === 0
            ? [{ at: 0, len: COLUMNS, kind: paper.BOLD }]
            : []);
    }
    buffer.push(paper.FF);
    bufferRuns.push([]);
    buffer.push("M".repeat(COLUMNS));
    bufferRuns.push([{ at: 0, len: COLUMNS, kind: paper.UNDERLINE }]);

    const entries = paper.normalizeEntries(buffer, "", bufferRuns);
    return paper.buildPrintDocument(entries, { columns: COLUMNS });
}

async function loadPdfJs() {
    const url = require("url");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = url.pathToFileURL(
        require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    return pdfjs;
}

// Per page: the widest text run (x to x+width) and how many lines it holds.
async function measure(pdfjs, buffer) {
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false,
    }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        let right = 0;
        let left = Infinity;
        let lines = 0;
        for (const item of content.items) {
            if (!item.str || !item.str.trim()) continue;
            const x = item.transform[4];
            const w = item.width;
            if (w <= 0) continue;
            right = Math.max(right, x + w);
            left = Math.min(left, x);
            lines++;
        }
        pages.push({ left, right, lines });
    }
    return pages;
}

(async () => {
    const puppeteer = require("puppeteer");
    const html = buildDocument();

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    let pdf;
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "load" });
        // preferCSSPageSize makes Chromium honour @page; with size:auto it falls
        // back to the format, which is exactly what the print dialog does when
        // the operator picks Letter.
        pdf = await page.pdf({ format: "Letter", preferCSSPageSize: true, printBackground: true });
    } finally {
        await browser.close();
    }

    const pdfjs = await loadPdfJs();
    const pages = await measure(pdfjs, pdf);

    console.log("sheets printed:", pages.length);
    for (const [i, p] of pages.entries()) {
        console.log(`  sheet ${i + 1}: ${p.lines} line(s), x ${p.left.toFixed(1)}..${p.right.toFixed(1)} pt`);
    }

    assert.strictEqual(pages.length, 2,
        "66 lines + FF must print as two sheets (a wrapped or spilled page shows up here)");

    // The full-width line must reach the printable edge: that is the whole
    // "132 columns = the width of the paper" promise, and it is the assertion
    // that fails if cqw/vh stop resolving against the page box.
    const tolerance = CONTENT_W_PT * 0.03; // 3%: glyph side bearings and rounding
    for (const [i, p] of pages.entries()) {
        const used = p.right - p.left;
        assert.ok(Math.abs(used - CONTENT_W_PT) <= tolerance,
            `sheet ${i + 1}: a ${COLUMNS}-column line spans ${used.toFixed(1)}pt of ` +
            `${CONTENT_W_PT.toFixed(1)}pt printable width (±${tolerance.toFixed(1)}pt)`);
        assert.ok(p.left >= MARGIN_X_PT - 1 && p.left <= MARGIN_X_PT + tolerance,
            `sheet ${i + 1}: the left margin is respected (x=${p.left.toFixed(1)}pt)`);
    }

    // One logical sheet is one physical sheet: the 66 lines fit the height.
    assert.strictEqual(pages[0].lines, LINES_PER_PAGE,
        `sheet 1 must hold all ${LINES_PER_PAGE} lines, not overflow onto sheet 2`);
    assert.strictEqual(pages[1].lines, 1, "sheet 2 holds the single line after the FF");

    // The height guard must leave the text inside the page box.
    console.log("ok: " + COLUMNS + " columns across " + CONTENT_W_PT.toFixed(1) + "pt, " +
        LINES_PER_PAGE + " lines on the sheet");
})().catch((e) => {
    console.error("lp11-print probe FAILED:", e.message);
    process.exit(1);
});
