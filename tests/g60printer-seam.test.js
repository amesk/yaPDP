#!/usr/bin/env node
/**
 * G60Printer sheet-seam tests.
 *
 * The fanfold seam is a property of the PAPER, not of the job: 66 lines fill a
 * sheet whether or not the driver sends a form feed for it. The printer used to
 * draw the perforation only on FF, so a job that happened to fill the sheet
 * exactly ran into the next sheet with no separator at all.
 *
 * pageAdvance() is the pure sheet arithmetic behind doPrintln(); it is
 * extracted straight from the real source (same pattern as
 * tests/g60printer-flush.test.js) so the test exercises the production formula,
 * and a source contract pins the two behaviours that cannot be extracted
 * without a DOM: the automatic seam on a full sheet, and the rule that a form
 * feed travelling through the pacing queue must not draw a second one.
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

function loadPageAdvance() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function pageAdvance", "");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.pageAdvance = pageAdvance;", sandbox);
  return sandbox.pageAdvance;
}

function run() {
  const pageAdvance = loadPageAdvance();
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

  // 5. Source contract: the seam is queued when the sheet fills, and the
  //    automatic one never doubles up with a form feed already in flight.
  {
    const src = fs.readFileSync(SOURCE_PATH, "utf8");
    assert.ok(/var sheet = pageAdvance\(pagePos, pageLength\);/.test(src),
      "doPrintln must take the sheet position from pageAdvance()");
    assert.ok(/if \(sheet\.full && !seamQueued\) charBuffer\.push\(CHAR_FF_MARK\);/.test(src),
      "a full sheet must queue the fold marker unless a form feed is already on its way");
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
