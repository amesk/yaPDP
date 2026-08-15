#!/usr/bin/env node
/**
 * LP11 plain-text accumulation modular tests.
 *
 * Extracts the pure lp11TextPut() / lp11PutChar() helpers straight from the
 * real source (src/iopage.js) so the test exercises the production formula
 * rather than a copy, then runs them in an isolated VM context (same pattern
 * as tests/paper-geometry.test.js).
 *
 * These helpers build the plain-text copy of printed LP11 jobs used by the
 * "Print" / "Save .txt" buttons. They handle the character stream a 2.11BSD
 * lpd writes to the LP11 controller: printable ASCII, BS (0o10), TAB (0o11),
 * LF (0o12), CR (0o15) and — added for page separation between jobs — form
 * feed FF (0o14), which records a "\f" page-eject marker so the exported text
 * keeps real page breaks.
 *
 * Run with:  node tests/lp11-text.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "iopage.js");

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

// Control codes (decimal) — must match the LP11 handler in src/iopage.js.
const LF = 10;   // 0o12
const FF = 12;   // 0o14 form feed
const CR = 13;   // 0o15
const TAB = 9;   // 0o11
const BS = 8;    // 0o10
const DEL = 127; // 0o7F

function loadPut() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const putChar = extractBlock(src, "function lp11PutChar", "");
  const textPut = extractBlock(src, "function lp11TextPut", "");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    putChar + "\n" + textPut + "\n; this.put = lp11TextPut;",
    sandbox
  );
  return sandbox.put;
}

function freshState() {
  return { buffer: [], line: "", col: 0 };
}

// Feed an array of character codes into the state machine.
function feed(put, state, codes) {
  for (const c of codes) put(state, c);
}

function run() {
  const put = loadPut();

  // 1. Printable characters accumulate in the current line.
  {
    const s = freshState();
    feed(put, s, ["H".charCodeAt(0), "i".charCodeAt(0)]);
    assert.strictEqual(s.line, "Hi", "printables accumulate");
    assert.strictEqual(s.col, 2, "cursor advances with the line");
  }

  // 2. LF pushes the finished line into the buffer and resets the cursor.
  {
    const s = freshState();
    feed(put, s, ["A".charCodeAt(0), "B".charCodeAt(0), LF, "C".charCodeAt(0)]);
    assert.deepStrictEqual(s.buffer, ["AB"], "LF pushes the completed line");
    assert.strictEqual(s.line, "C", "next line starts after LF");
    assert.strictEqual(s.col, 1, "cursor resets after LF");
  }

  // 3. CR returns the cursor to column 0 so later characters overstrike —
  //    nroff/man bold ("A\rA") collapses to a single clean glyph.
  {
    const s = freshState();
    feed(put, s, ["A".charCodeAt(0), CR, "A".charCodeAt(0)]);
    assert.strictEqual(s.line, "A", "CR overstrike collapses bold to one glyph");
  }

  // 4. BS moves the cursor back so a letter over an underscore becomes a
  //    clean glyph (nroff/man underline).
  {
    const s = freshState();
    feed(put, s, ["_".charCodeAt(0), BS, "X".charCodeAt(0)]);
    assert.strictEqual(s.line, "X", "BS overstrike collapses underline");
  }

  // 5. TAB advances to the next 8-column stop with spaces.
  {
    const s = freshState();
    feed(put, s, ["a".charCodeAt(0), "b".charCodeAt(0), TAB, "x".charCodeAt(0)]);
    assert.strictEqual(s.line, "ab      x", "TAB pads to the next 8-column stop");
    assert.strictEqual(s.col, 9, "TAB cursor lands on the tab stop");
  }

  // 6. FF records a "\f" page-eject marker line (2.11BSD lpd sends FF
  //    between jobs, so exported text keeps real page breaks).
  {
    const s = freshState();
    feed(put, s, ["J".charCodeAt(0), "1".charCodeAt(0), LF, FF]);
    assert.deepStrictEqual(s.buffer, ["J1", "\f"], "FF pushes a page-eject marker");
    assert.strictEqual(s.line, "", "cursor state unchanged by FF");
  }

  // 7. Two jobs separated by a form feed keep their page boundary.
  {
    const s = freshState();
    feed(put, s, [
      "J".charCodeAt(0), "o".charCodeAt(0), "b".charCodeAt(0), "1".charCodeAt(0),
      LF, FF,
      "J".charCodeAt(0), "o".charCodeAt(0), "b".charCodeAt(0), "2".charCodeAt(0),
      LF
    ]);
    assert.deepStrictEqual(s.buffer, ["Job1", "\f", "Job2"], "jobs keep FF boundary");
    assert.strictEqual(s.line, "", "current line is empty after the last LF");
  }

  // 8. DEL and other control codes are ignored (do not move the cursor).
  {
    const s = freshState();
    feed(put, s, ["A".charCodeAt(0), DEL, 0, 1, "B".charCodeAt(0)]);
    assert.strictEqual(s.line, "AB", "DEL/controls ignored");
  }

  console.log("lp11-text.test.js: all tests passed");
}

run();
