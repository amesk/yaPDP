#!/usr/bin/env node
/**
 * Model 33 ASR console paper growth — pure helper modular tests.
 *
 * Extracts the pure teletypePaperMaxHeight() helper straight from the real
 * source (src/pdp11-app.js) so the test exercises the production formula
 * rather than a copy, then runs it in an isolated VM context.
 *
 * teletypePaperMaxHeight() turns the measured distance from the console paper
 * bottom (the carriage) to the top of the browser window into the paper's
 * max-height. The console paper grows upward from the carriage (like the LP11
 * printer page) and must stop exactly when its top edge reaches the window
 * top; this helper clamps the value so it can never be negative.
 *
 * Run with:  node tests/teletype-paper-growth.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker) {
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
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

function loadMaxHeight() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function teletypePaperMaxHeight");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.maxh = teletypePaperMaxHeight;", sandbox);
  return sandbox.maxh;
}

function run() {
  const maxh = loadMaxHeight();

  // --- Full-height window: paper reaches the window top exactly ----------
  {
    const m = maxh(562, 0);
    assert.strictEqual(m, 562, "carriage at 562px: max-height is 562px");
  }

  // --- Carriage at the very top of the window: no room to grow -----------
  {
    const m = maxh(0, 0);
    assert.strictEqual(m, 0, "carriage at the window top: max-height 0");
  }

  // --- A top reserve stops the paper short of the window top -------------
  {
    const m = maxh(562, 12);
    assert.strictEqual(m, 550, "reserve 12px: max-height is 550px");
  }

  // --- Reserve larger than the gap clamps to 0 (never negative) ----------
  {
    const m = maxh(8, 20);
    assert.strictEqual(m, 0, "reserve bigger than the gap: clamped to 0");
  }

  // --- Missing / string arguments are coerced like Number() ----------------
  {
    assert.strictEqual(maxh(562, undefined), 562,
      "undefined reserve treated as 0");
    assert.strictEqual(maxh(562, "10"), 552,
      "string reserve coerced to number");
    assert.strictEqual(maxh("100", 0), 100,
      "string bottom coerced to number");
  }

  // --- Carriage above the window top yields 0 (never negative) ------------
  {
    const m = maxh(-40, 0);
    assert.strictEqual(m, 0, "carriage above the window top: clamped to 0");
  }

  console.log("teletype-paper-growth: all tests passed");
}

run();
