#!/usr/bin/env node
/**
 * LP11 printable-document tests (the Print button).
 *
 * The document built here is what the hidden print iframe receives: it used to
 * be one <pre> of 12px Courier with no page-break CSS, so 132 columns wrapped
 * onto a narrow sheet and the form-feed sentinels the guest sent produced no
 * sheet break at all. This suite pins the three promises of the fix:
 *
 *   1. a sheet ends on FF or after 66 lines, and never as an empty sheet
 *      (no leading, trailing or doubled blank pages);
 *   2. the type is sized from the printable box (100cqw / --colw) so the
 *      configured column count spans the paper the print dialog hands us,
 *      with a height guard so 66 lines still fit one sheet;
 *   3. double-struck glyphs print bold and underscored ones underlined,
 *      without changing the 132-column grid.
 *
 * Run with:  node tests/lp11-print.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const paper = require(path.join(ROOT, "src", "lp11paper.js"));

const COLUMNS = paper.DEFAULT_COLUMNS;       // 132
const LINES = paper.DEFAULT_LINES_PER_PAGE;  // 66

// buildPrintDocument takes raw buffer lines (FF sentinels and the legacy
// literal marker included) or prepared entries; both shapes are exercised.
function doc(lines, options) {
    return paper.buildPrintDocument(lines, options);
}

// paginate() works on prepared entries, so the tests that call it directly
// wrap plain lines themselves.
function paginationInput(lines) {
    return lines.map((line) => (typeof line === "string")
        ? { text: line, runs: [] } : line);
}

// How many <section class="page"> the document carries, i.e. printed sheets.
function sheetCount(html) {
    return (html.match(/<section class="page">/g) || []).length;
}

function run() {
    // 1. Three jobs separated by FF print as three sheets.
    {
        const html = doc(["JOB1", "\f", "JOB2", "\f", "JOB3"]);
        assert.strictEqual(sheetCount(html), 3, "one sheet per FF-separated job");
    }

    // 2. No FF at all: the sheet breaks every 66 lines (11in at 6 LPI).
    {
        const lines = [];
        for (let i = 0; i < 70; i++) lines.push("LINE " + i);
        assert.strictEqual(sheetCount(doc(lines)), 2, "70 lines spill onto a second sheet");

        const full = [];
        for (let i = 0; i < LINES; i++) full.push("LINE " + i);
        assert.strictEqual(sheetCount(doc(full)), 1, "exactly 66 lines stay on one sheet");

        const one = full.concat(["EXTRA"]);
        assert.strictEqual(sheetCount(doc(one)), 2, "the 67th line opens a new sheet");
    }

    // 3. An FF right after a full sheet must not add a blank one, and a
    //    trailing FF must not either.
    {
        const lines = [];
        for (let i = 0; i < LINES; i++) lines.push("LINE " + i);
        assert.strictEqual(sheetCount(doc(lines.concat(["\f", "NEXT"]))), 2,
            "an FF after a full sheet does not add a blank page");
        assert.strictEqual(sheetCount(doc(["A", "\f"])), 1,
            "a trailing FF does not print an empty sheet");
        assert.strictEqual(sheetCount(doc(["\f", "A"])), 1,
            "a leading FF does not print an empty sheet");
    }

    // 4. The platen is columns wide: a longer strike is cut, not wrapped.
    {
        const long = "X".repeat(COLUMNS + 20);
        const pages = paper.paginate(paginationInput([long]), {});
        assert.strictEqual(pages.length, 1, "one line is one page");
        assert.strictEqual(pages[0][0].text.length, COLUMNS,
            "the line is clipped at the platen width, so nothing wraps");
    }

    // 5. Overstruck glyphs keep their styling in the document.
    {
        const html = doc([{
            text: "AB",
            runs: [{ at: 0, len: 1, kind: paper.BOLD },
                { at: 1, len: 1, kind: paper.UNDERLINE }],
        }]);
        assert.ok(html.indexOf("<b>A</b>") !== -1, "a double strike prints bold");
        assert.ok(html.indexOf("<u>B</u>") !== -1, "an underscore strike prints underlined");
        assert.ok(/b \{ font-weight: 700; \}/.test(html),
            "the bold face must be requested explicitly");
        assert.ok(/u \{ text-decoration: underline; \}/.test(html),
            "the underline must be drawn as text decoration (advance unchanged)");
    }

    // 5b. Styling never leaks outside the run, and the run survives neighbours.
    {
        const html = doc([{
            text: "xAYz",
            runs: [{ at: 1, len: 1, kind: paper.BOLD }],
        }]);
        assert.ok(html.indexOf("x<b>A</b>Yz") !== -1,
            "only the struck column is bold");
    }

    // 5c. A bold run that runs past the platen edge is clipped with the text.
    {
        const text = "y".repeat(COLUMNS + 5);
        const pages = paper.paginate(paginationInput([{
            text: text,
            runs: [{ at: 0, len: text.length, kind: paper.BOLD }],
        }]), {});
        assert.strictEqual(pages[0][0].text.length, COLUMNS, "text clipped");
        assert.strictEqual(pages[0][0].runs[0].at + pages[0][0].runs[0].len, COLUMNS,
            "the run is clipped with the text");
    }

    // 6. Escaping: the job is guest output, so it must never inject markup.
    {
        const amp = String.fromCharCode(38);
        const html = doc(["<script>&</script>"]);
        const escaped = amp + "lt;script" + amp + "gt;" + amp + "amp;" +
            amp + "lt;/script" + amp + "gt;";
        assert.ok(html.indexOf(escaped) !== -1,
            "angle brackets and ampersands are escaped");
        assert.strictEqual(html.indexOf("<script>"), -1, "no raw markup reaches the page");
    }

    // 7. The print stylesheet must fit the type to the printable box, not to a
    //    guessed sheet, must turn the sheet landscape (fanfold is wider than it
    //    is tall) and must carry a fallback for engines without container
    //    queries.
    {
        const html = doc(["A"]);
        assert.ok(/@page \{ size: landscape; margin: 10mm; \}/.test(html),
            "the sheet is turned landscape like real fanfold, paper stays the dialog's");
        // 10 pitch and 6 LPI put a line 1.667 glyph advances apart; with a 0.6em
        // advance that is exactly one character cell tall, so the 132 x 66 block
        // keeps the real printed area's 79.2 x 66 em (1.2) proportion.
        assert.strictEqual(paper.LINE_HEIGHT, 1,
            "6 LPI at 10 pitch: one cell of line pitch, nothing compact");
        assert.ok(/--cell: min\(calc\(100cqw \/ var\(--colw\)\), calc\(100vh \/ var\(--lpp\)\)\)/.test(html),
            "the machine's character cell is the smaller of the width and height fits");
        assert.ok(Math.abs((COLUMNS * 0.6) / LINES - 1.2) < 1e-9,
            "132 columns x 66 lines keep the 1.2 proportion of the real print area");
        assert.ok(/\.page \{ position: relative; break-after: page;/.test(html),
            "each sheet breaks after it");
        assert.ok(/\.page:last-child \{ break-after: auto;/.test(html),
            "the last sheet does not add a trailing blank page");
        // Paper look: the SAME artwork the Printer page uses (so bar period and
        // colour cannot drift from it) plus perforated tractor strips that take
        // width from the text column exactly as the real holes do.
        assert.ok(/\.page \{[^}]*padding: 0 1\.7%;/.test(html),
            "the tractor strips take 1.7% of the sheet on each side, as on screen");
        assert.ok(/\.col \{ position: relative; container-type: inline-size; \}/.test(html),
            "the text column is what 100cqw measures");
        assert.ok(/pre \{ background-image: url\('assets\/images\/paper\.png'\),/.test(html),
            "the green bars are the on-screen paper tile, not an imitation");
        // The fallback must carry the TILE'S colours (228,232,229 on
        // 242,240,239), not an invented green: otherwise a sheet printed
        // before the tile decodes looks a different colour from the page.
        assert.ok(/repeating-linear-gradient\(to bottom, #e4e8e5 0 calc\(var\(--cell\)\),/.test(html) &&
            /#f2f0ef calc\(var\(--cell\)\) calc\(var\(--cell\) \* 2\)/.test(html),
            "the fallback bars use paper.png's own colours, so both layers match");
        // The tractor strips are painted on the page box, so the page itself
        // must be the paper's colour (241,239,238) — otherwise the white rows
        // read as grey next to a #fff margin.
        assert.ok(/\.page \{ background-color: #f1efee; \}/.test(html),
            "the margins are the same paper as the text column");
        assert.ok(/background-size: 100% calc\(var\(--cell\) \* 4\), 100% calc\(var\(--cell\) \* 2\)/.test(html),
            "one 64px tile per four 16px lines on screen: the bar period is kept");
        assert.ok(/\.page::before, \.page::after \{ content: ""; position: absolute;/.test(html),
            "both edges carry a perforated strip, painted inside the page box");
        assert.ok(/radial-gradient\(circle closest-side at 50% 50%, #141414 0 62%, transparent 72%\)/.test(html),
            "a feed hole is a black dot, not a faint grey one");
        assert.ok(/background-size: 100% 12\.7mm;/.test(html),
            "feed holes are half an inch apart, as on the paper");
        // The glyph is drawn INSIDE the cell (a line printer's dot matrix never
        // fills it), and letter-spacing restores the advance so the column grid
        // stays exact — this is what keeps 6 LPI type from touching.
        assert.ok(/font-size: calc\(var\(--cell\) \* var\(--glyph\)\);/.test(html),
            "the glyph is drawn smaller than the cell");
        assert.ok(/line-height: calc\(1 \/ var\(--glyph\)\);/.test(html),
            "the line pitch stays one cell regardless of the glyph size");
        assert.ok(/letter-spacing: calc\(var\(--cell\) \* var\(--adv\) \* \(1 - var\(--glyph\)\)\);/.test(html),
            "letter-spacing restores the advance the smaller glyph lost");
        assert.ok(html.indexOf("--glyph: " + paper.GLYPH_FALLBACK) !== -1,
            "a fallback glyph factor is present for engines without measurement");
        assert.ok(paper.GLYPH_FALLBACK > 0.6 && paper.GLYPH_FALLBACK < 1,
            "the fallback leaves the glyph inside the cell, not filling it");
        assert.ok(/calc\(100vh \/ var\(--lpp\)\)/.test(html),
            "a height guard keeps one logical sheet on one physical sheet");
        assert.ok(/container-type: inline-size/.test(html),
            "the box the columns are measured against");
        assert.ok(/@supports not \(container-type: inline-size\)/.test(html),
            "older engines still get a usable size");
        assert.ok(html.indexOf("--lpp: " + LINES) !== -1,
            "the height guard knows the sheet is 66 lines tall");
        assert.ok(html.indexOf("--colw: " + (COLUMNS * 0.6).toFixed(4)) !== -1,
            "the fallback column width matches the default 132-column platen");
    }

    // 7a-bis. Plain paper: no bars, no strips, full printable width. This is
    // what a job going onto real fanfold wants — the perforation is already
    // there and drawing a second one would double it.
    {
        const html = doc(["A"], { paper: "plain" });
        assert.ok(html.indexOf("repeating-linear-gradient") === -1, "no green bars");
        assert.ok(html.indexOf("radial-gradient") === -1, "no drawn perforation");
        assert.ok(/\.page \{[^}]*padding: 0 0;/.test(html),
            "the whole printable width belongs to the text");
    }

    // 7b. A narrower CONFIG width sizes the page for that width instead.
    {
        const html = doc(["A"], { columns: 80 });
        assert.ok(html.indexOf("--colw: " + (80 * 0.6).toFixed(4)) !== -1,
            "the printable width follows the configured column count");
        const pages = paper.paginate(paginationInput(["Z".repeat(100)]), { columns: 80 });
        assert.strictEqual(pages[0][0].text.length, 80, "an 80-column platen clips at 80");
    }

    // 8. Jobs captured by the pre-fix build glued a literal "\f" onto the line;
    //    they must still break pages instead of printing the marker.
    {
        const html = doc(["OLD JOB\\f", "NEXT JOB"]);
        assert.strictEqual(sheetCount(html), 2, "the legacy marker still breaks the sheet");
        assert.strictEqual(html.indexOf("\\f"), -1, "the legacy marker is not printed");
        assert.ok(html.indexOf("OLD JOB") !== -1, "the line itself is kept");
    }

    // 9. Malformed runs (unsorted, overlapping, unknown kind) are tolerated:
    //    a snapshot is untrusted input.
    {
        const runs = paper.normalizeRuns([
            { at: 3, len: 2, kind: paper.BOLD },
            { at: 0, len: 2, kind: paper.BOLD },
            { at: 1, len: 4, kind: paper.UNDERLINE },
            { at: 9, len: 1, kind: "italic" },
        ]);
        assert.deepStrictEqual(runs, [
            { at: 0, len: 2, kind: paper.BOLD },
            { at: 1, len: 4, kind: paper.UNDERLINE },
            { at: 3, len: 2, kind: paper.BOLD },
        ], "runs are sorted, unknown kinds dropped, overlapping ones kept as recorded");
    }

    // 10. Blank paper: no document is printed at all (and Node has no DOM, so
    //     printDocument reports "nothing to do" instead of throwing).
    {
        assert.strictEqual(paper.canPrint(), false, "Node has no print surface");
        assert.strictEqual(
            paper.printDocument(["", ""], "", [[], []]),
            false, "empty paper prints nothing");
        assert.strictEqual(sheetCount(doc([""])), 1, "a single blank line is still a sheet");
    }

    console.log("lp11-print.test.js: all tests passed");
}

run();
