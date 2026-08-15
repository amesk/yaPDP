#!/usr/bin/env node
/**
 * G60Printer paper-geometry modular tests.
 *
 * Extracts the pure computePaperGeometry() helper straight from the real
 * source (src/g60printer.js) so the test exercises the production formula
 * rather than a copy, then runs it in an isolated VM context.
 *
 * The helper derives the printable-paper layout for a column count so a full
 * line fills the paper, centred between the fixed machine side skins. These
 * numbers drive both the console teletype (72/80) and the LP11 printer
 * (72/80/100/132).
 *
 * Run with:  node tests/paper-geometry.test.js
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

// Production layout constants (must match src/g60printer.js).
const CHAR_WIDTH = 7;
const PADDING_X = 18;
const MARGIN_X = 33;
const LEFT_SKIN = 67;
const RIGHT_SKIN = 66;

function loadCompute() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function computePaperGeometry", "");
  const sandbox = { Math };
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.compute = computePaperGeometry;", sandbox);
  return sandbox.compute;
}

function run() {
  const compute = loadCompute();

  // Teletype machine: 940px body, bodyWidth = 940 - 67 - 66 = 807.
  const TTY_BODY = 940 - LEFT_SKIN - RIGHT_SKIN;
  assert.strictEqual(TTY_BODY, 807, "teletype body width");

  // --- 72 columns (default Model 33 ASR) ---
  {
    const g = compute(72, {
      bodyWidth: TTY_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.printAreaWidth, 504, "72 cols: content width 72*7");
    assert.strictEqual(g.paperWidth, 606, "72 cols: paper width 504+36+66");
    assert.strictEqual(g.paperLeft, 168, "72 cols: paper centred (round(100.5)=101)");
    assert.strictEqual(g.headOffset, 131, "72 cols: head offset shifts with the paper");
  }

  // --- 80 columns ---
  {
    const g = compute(80, {
      bodyWidth: TTY_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.printAreaWidth, 560, "80 cols: content width 80*7");
    assert.strictEqual(g.paperWidth, 662, "80 cols: paper width 560+102");
    assert.strictEqual(g.paperLeft, 140, "80 cols: paper centred (round(72.5)=73)");
    assert.strictEqual(g.headOffset, 103, "80 cols: head offset shifts with the paper");
  }

  // LP11 machine: 1160px body, bodyWidth = 1160 - 133 = 1027.
  const LP11_BODY = 1160 - LEFT_SKIN - RIGHT_SKIN;
  assert.strictEqual(LP11_BODY, 1027, "LP11 body width");

  // 132 columns must reproduce the original LP11 paper width (1026px).
  {
    const g = compute(132, {
      bodyWidth: LP11_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.printAreaWidth, 924, "132 cols: content width 132*7");
    assert.strictEqual(g.paperWidth, 1026, "132 cols: paper width 924+102");
    assert.strictEqual(g.paperLeft, 68, "132 cols: paper ~centred (round(0.5)=1)");
    assert.strictEqual(g.headOffset, 31, "132 cols: head offset ~unchanged");
  }

  // 72 columns on the LP11 machine: a much narrower, centred paper.
  {
    const g = compute(72, {
      bodyWidth: LP11_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.paperWidth, 606, "LP11 72 cols: paper width");
    assert.strictEqual(g.paperLeft, 278, "LP11 72 cols: centred");
    assert.strictEqual(g.headOffset, 241, "LP11 72 cols: head offset");
  }

  // --- Clamp: a paper wider than the machine body never escapes it ---
  {
    const g = compute(200, {
      bodyWidth: TTY_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.paperWidth, TTY_BODY, "oversized paper is clamped to body");
    assert.strictEqual(g.paperLeft, LEFT_SKIN, "clamped paper sits flush left");
    assert.strictEqual(g.headOffset, 30, "clamped paper keeps the base head offset");
  }

  // --- Invariant: a full line of cols chars fits the paper exactly ---
  for (const cols of [72, 80, 100, 132]) {
    const g = compute(cols, {
      bodyWidth: LP11_BODY, charWidth: CHAR_WIDTH,
      paddingX: PADDING_X, marginX: MARGIN_X, leftSkin: LEFT_SKIN,
    });
    assert.strictEqual(g.printAreaWidth, cols * CHAR_WIDTH,
      cols + " cols: print area holds exactly cols characters");
    assert.ok(g.paperLeft >= LEFT_SKIN, cols + " cols: paper inside the body");
  }

  console.log("\nAll paper-geometry tests passed.");
}

run();
