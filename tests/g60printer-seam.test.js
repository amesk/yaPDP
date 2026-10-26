#!/usr/bin/env node
/**
 * G60Printer sheet-seam tests.
 *
 * The fanfold seam is a property of the PAPER, not of the job: 66 lines fill a
 * sheet whether or not the driver sends a form feed for it. The printer used to
 * draw the perforation only on FF, so a job that happened to fill the sheet
 * exactly ran into the next sheet with no separator at all.
 *
 * pageAdvance() is the pure sheet arithmetic behind doPrintln() and
 * sheetStep() is the decision built on it (queue the seam? open a fresh line on
 * this sheet?). Both are extracted straight from the real source (same pattern
 * as tests/g60printer-flush.test.js) so the test exercises the production
 * formula, and a source contract pins what cannot be extracted without a DOM.
 *
 * The blank-row regression pinned here: the line feed that fills a sheet used
 * to open the next line on THAT sheet, leaving one empty row between the last
 * printed line and the perforation — an .art file printed from RT-11 (which
 * sends no form feeds) showed an extra empty line on every page throw while the
 * Print preview paginated correctly.
 *
 * Run with:  node tests/g60printer-seam.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "g60printer.js");

function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error("marker not found: " + startMarker);
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) throw new Error("no opening brace for: " + startMarker);
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

function loadSheetHelpers() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = extractBlock(src, "function pageAdvance", "") + "\n" +
    extractBlock(src, "function sheetStep", "");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code +
    "\n; this.pageAdvance = pageAdvance; this.sheetStep = sheetStep;", sandbox);
  return sandbox;
}

function run() {
  const { pageAdvance, sheetStep } = loadSheetHelpers();
  const LENGTH = 66; // 11in sheet at 6 LPI

  // 1. Lines 1..65 of a sheet are not the last one.
  {
    let pos = 0;
    for (let line = 1; line < LENGTH; line++) {
      const step = pageAdvance(pos, LENGTH);
      assert.strictEqual(step.full, false, "line " + line + " must not close the sheet");
      pos = step.pos;
    }
    assert.strictEqual(pos, LENGTH - 1, "65 lines leave one line on the sheet");
  }

  // 2. The 66th line closes the sheet and wraps the counter.
  {
    const step = pageAdvance(LENGTH - 1, LENGTH);
    assert.strictEqual(step.full, true, "the 66th line closes the sheet");
    assert.strictEqual(step.pos, 0, "the counter wraps for the next sheet");
  }

  // 3. The next sheet starts over, and it happens again every 66 lines.
  {
    const step = pageAdvance(0, LENGTH);
    // The helper comes from another VM realm, so compare fields, not objects.
    assert.strictEqual(step.pos, 1, "a fresh sheet holds line 1");
    assert.strictEqual(step.full, false, "and the sheet does not close yet");

    let pos = 0;
    let closings = 0;
    for (let line = 1; line <= LENGTH * 2; line++) {
      const s = pageAdvance(pos, LENGTH);
      if (s.full) closings++;
      pos = s.pos;
    }
    assert.strictEqual(closings, 2, "two sheets, two seams");
    assert.strictEqual(pos, 0, "132 lines end exactly on a sheet boundary");
  }

  // 4. The panel's teletype paper uses the same helper with its own length.
  {
    const step = pageAdvance(2, 3);
    assert.strictEqual(step.pos, 0, "a 3-line page wraps after the third line");
    assert.strictEqual(step.full, true, "and closes the sheet");
  }

  // 5. A full fanfold sheet: the seam is queued and the fresh line is NOT
  //    opened on the sheet that just ended — it belongs below the perforation.
  {
    let pos = 0;
    let rows = 1;           // the empty line resetPrinter() opens on the paper
    let seams = 0;
    for (let line = 1; line <= LENGTH; line++) {
      const step = sheetStep(pos, LENGTH, true, false);
      pos = step.pos;
      if (step.openLine) rows++;
      if (step.seam) {
        seams++;
        assert.strictEqual(rows, LENGTH,
          "a full sheet must end with exactly " + LENGTH +
          " rows — no blank row above the perforation");
      }
    }
    assert.strictEqual(seams, 1, "one sheet, one automatic seam");
    assert.strictEqual(pos, 0, "the sheet boundary is where it should be");
  }

  // 6. The console teletype (smooth roll, no visible fold) keeps its old
  //    behaviour: the line is opened even where a seam would have been drawn.
  {
    const step = sheetStep(LENGTH - 1, LENGTH, false, false);
    assert.strictEqual(step.seam, true, "the invisible eject is still queued");
    assert.strictEqual(step.openLine, true, "a roll has no perforation to stop at");
  }

  // 7. While a form feed's filler is in flight (seamQueued), the filler lines
  //    are exactly the blank rows that top the sheet off, so they are opened.
  {
    const step = sheetStep(LENGTH - 1, LENGTH, true, true);
    assert.strictEqual(step.seam, false, "the eject is already queued");
    assert.strictEqual(step.openLine, true, "the filler must reach the sheet bottom");
  }

  // 8. Source contract: the seam is queued when the sheet fills, at the FF
  //    position in the stream, and never doubles up with a form feed in flight.
  {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    assert.ok(/var step = sheetStep\(pagePos, pageLength, pageBreakMarker, seamQueued\);/.test(src),
      "doPrintln must take the sheet decision from sheetStep()");
    assert.ok(/if \(step\.seam\) charBuffer\.unshift\(CHAR_FF_MARK\);/.test(src),
      "a full sheet must queue the fold marker at the line-feed position");
    assert.ok(/if \(step\.openLine\) \{/.test(src),
      "doPrintln must not open a line on a sheet the seam closes");
    assert.ok(/seamQueued = true;/.test(src),
      "doFormFeed must announce the seam it queues");
    assert.ok(/seamQueued = false;/.test(src),
      "the seam must be cleared once drawn (and on reset/restore)");
    assert.ok(/var seamQueued = false;/.test(src),
      "the in-flight flag must start false");
  }

  console.log("g60printer-seam.test.js: all tests passed");
}

run();
