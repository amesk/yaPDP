#!/usr/bin/env node
/**
 * G60Printer paper-restore tests.
 *
 * A state restore rebuilds the printed paper from `G60Printer.snapshot()`
 * (rows of `{ text, cls }`). The live renderer builds a row as ONE <span> per
 * character cell (doPrintChar / doPrintln / doFormFeedMarker), and the cell
 * width is the stylesheet's 7px — not the lp1 face's own 0.5em advance.
 * Rebuilding a row as a single span collapsed a 132-column line from 924px to
 * ~660px, so a restored sheet (e.g. the Madonna artwork) came back horizontally
 * squeezed — the "stretched picture" seen after every snapshot reload while the
 * paper that printed it looked right. The guarantee this file pins is:
 * "a restored row has the same tree shape as a printed row".
 *
 * buildPaperRow() is extracted straight from the real source (src/g60printer.js)
 * so the test exercises the production builder, then run in an isolated VM
 * context with a DOM stub — the same pattern as tests/g60printer-flush.test.js.
 *
 * Run with:  node tests/g60printer-paper-restore.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "g60printer.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
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
      if (depth === 0) {
        if (tail) {
          const rest = src.slice(i + 1, i + 1 + tail.length);
          if (rest !== tail) {
            throw new Error("expected tail '" + tail + "' after " + startMarker);
          }
          return src.slice(start, i + 1 + tail.length);
        }
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

// ------------------------------------------------------------------
// DOM stub: only what buildPaperRow() touches. Every element records its
// children so the test can assert the CELL structure, not just the text.
// ------------------------------------------------------------------
function makeElement(tag) {
  return {
    tagName: tag,
    className: "",
    textContent: "",
    children: [],
    appendChild: function (child) {
      this.children.push(child);
      return child;
    }
  };
}

function loadBuilder() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const builder = extractBlock(src, "function buildPaperRow", "");
  const sandbox = { document: { createElement: makeElement } };
  vm.createContext(sandbox);
  vm.runInContext(builder + "\n; this.buildPaperRow = buildPaperRow;", sandbox);
  return sandbox;
}

function run() {
  const { buildPaperRow } = loadBuilder();

  // 1. A printed line is one span per cell, so the stylesheet's 7px advance
  //    applies to every column. This is the regression: one span for the whole
  //    row made the paper 1.4x narrower than the one that printed it.
  {
    const text = "\u00A0" + "0123456789".repeat(13) + "1"; // 132 columns + spacer
    const p = buildPaperRow({ text: text, cls: "" });
    assert.strictEqual(p.tagName, "p", "a row must be a <p>");
    assert.strictEqual(p.children.length, text.length,
      "restored row must carry one <span> per character cell, got " +
      p.children.length + " for " + text.length + " characters");
    assert.strictEqual(p.children[0].textContent, "\u00A0",
      "the leading NBSP spacer (column 0) must survive the restore");
    assert.strictEqual(p.children[p.children.length - 1].textContent, "1");
    p.children.forEach(function (span, i) {
      assert.strictEqual(span.tagName, "span", "cell " + i + " must be a <span>");
    });
  }

  // 2. An empty row keeps one NBSP cell (as resetPrinter() opens it).
  {
    const p = buildPaperRow({ text: "", cls: "" });
    assert.strictEqual(p.children.length, 1, "an empty row is one NBSP cell");
    assert.strictEqual(p.children[0].textContent, "\u00A0");
  }

  // 3. A missing/odd row payload must not throw and still yields a cell.
  {
    const p = buildPaperRow(null);
    assert.strictEqual(p.children.length, 1, "a null row degrades to one cell");
    assert.strictEqual(p.className, "", "no class for a null row");
  }

  // 4. The row class survives (the perforation seam is a `p.pageBreak`).
  {
    const p = buildPaperRow({ text: "\u00A0", cls: "pageBreak" });
    assert.strictEqual(p.className, "pageBreak",
      "the row class must be restored (page seams)");
  }

  // 5. Spaces drawn on the paper are stored as NBSP and stay NBSP cells; a
  //    surrogate pair is ONE cell (two UTF-16 units must not become two cells,
  //    or every column after it would shift right by 7px).
  {
    const p = buildPaperRow({ text: "\u00A0A B\uD83D\uDE00C" });
    assert.deepStrictEqual(
      p.children.map(function (s) { return s.textContent; }),
      ["\u00A0", "A", " ", "B", "\uD83D\uDE00", "C"],
      "cells must follow code points, not UTF-16 units");
  }

  // 6. The restored DOM must come from the same builder the live path implies:
  //    restore() may not go back to a single span per row.
  {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    const start = src.indexOf("this.restore = function(state)");
    assert.ok(start !== -1, "G60Printer.restore must exist");
    const restoreBody = src.slice(start, start + 1600);
    assert.ok(/buildPaperRow\(rows\[i\]\)/.test(restoreBody),
      "restore() must rebuild rows through buildPaperRow()");
    assert.ok(!/span\.textContent\s*=\s*\(r\.text/.test(restoreBody),
      "restore() must not rebuild a row as one span (that squeezes the paper)");
    assert.ok(/createDocumentFragment/.test(restoreBody),
      "restore() must insert the rebuilt rows in one go (a sheet is thousands of cells)");
  }

  // 7. The cell width the fix depends on is still 7px in the stylesheet, and the
  //    LP11 sheet keeps its 10-pitch x 6-LPI cell (tests/lp11-sheet-aspect.test.js
  //    owns the vertical side; this pins the horizontal one).
  {
    const css = fs.readFileSync(path.join(__dirname, "..", "css", "g60printer.css"), "utf8");
    const spanRule = css.match(/#lp11_printer td#lp11g60paper_printarea span \{[\s\S]*?\}/);
    assert.ok(spanRule, "the LP11 character-cell rule must exist");
    assert.ok(/width:\s*7px\s*;/.test(spanRule[0]),
      "one character cell must stay 7px wide (the restored paper depends on it)");
    assert.ok(/height:\s*var\(--lp11-cell\)\s*;/.test(spanRule[0]),
      "one character cell must keep the 6 LPI height");
  }

  console.log("g60printer paper-restore tests: all passed");
}

try {
  run();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
