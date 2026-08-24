#!/usr/bin/env node
/**
 * Model 33 ASR teletype proportional-scaling modular tests.
 *
 * Extracts the pure teletypeFitScale() helper straight from the real source
 * (src/pdp11-app.js) so the test exercises the production formula rather than
 * a copy, then runs it in an isolated VM context.
 *
 * teletypeFitScale() decides how much the Model 33 ASR rig (#teletype-rig:
 * printer + keyboard + ASR tape unit) must be shrunk (transform: scale) to fit
 * the available window. It mirrors lp11FitScale()/panelFitScale(), but has no
 * left-sticker reservation: the rig is a plain, symmetric machine, so the
 * scale is simply min(availW/natW, availH/natH), floored at 10%.
 *
 * Run with:  node tests/teletype-scaling.test.js
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

function loadFitScale() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function teletypeFitScale");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.fit = teletypeFitScale;", sandbox);
  return sandbox.fit;
}

function run() {
  const fit = loadFitScale();

  // Representative natural geometry of the teletype rig: #g60printer (808px)
  // + 12px gap + #asr-tape-unit (170px) ≈ 990px wide; printer + keyboard deck
  // ≈ 636px tall (asr cabinet and keyboard deck bottoms align at 636px).
  const NAT_W = 990;
  const NAT_H = 636;

  // --- Full size: plenty of window, no scaling ---
  {
    const s = fit(1500, 900, NAT_W, NAT_H);
    assert.strictEqual(s, 1, "wide/tall window: rig keeps full size");
  }

  // --- Width-limited: narrow window shrinks the rig ---
  {
    const s = fit(800, 900, NAT_W, NAT_H);
    const expected = 800 / NAT_W;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "narrow window: scale is the width ratio (" + s + " vs " + expected + ")");
  }

  // --- Height-limited: short window (even wide) scales vertically too ---
  {
    const s = fit(2000, 500, NAT_W, NAT_H);
    const expected = 500 / NAT_H;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "short window: scale is the height ratio (" + s + " vs " + expected + ")");
  }

  // --- Both constrained: the smaller of the two wins ---
  {
    // Height ratio 500/636 ≈ 0.786 is tighter than width ratio 800/990.
    const s = fit(800, 500, NAT_W, NAT_H);
    const expected = 500 / NAT_H;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "both axes: the tighter (height) ratio wins");
  }

  // --- Readability floor: never collapse below 10% ---
  {
    const s = fit(10, 900, NAT_W, NAT_H);
    assert.strictEqual(s, 0.1, "tiny window: clamped to 10%");
  }

  // --- Hidden page: zero natural size means no scaling needed ---
  {
    assert.strictEqual(fit(0, 0, 0, 0), 1, "hidden/unsized: scale 1");
  }

  // --- Boundary: exactly the natural size keeps full scale ---
  {
    assert.strictEqual(fit(NAT_W, NAT_H, NAT_W, NAT_H), 1,
      "boundary size: still scale 1");
    const s = fit(NAT_W - 1, NAT_H, NAT_W, NAT_H);
    assert.ok(s < 1 && s > 0.99,
      "just below boundary: scales a hair down (" + s + ")");
  }

  console.log("\nAll teletype scaling tests passed.");
}

run();
