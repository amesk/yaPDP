#!/usr/bin/env node
/**
 * Model 33 ASR teletype proportional-scaling modular tests.
 *
 * Extracts the pure teletypeFitScale() helper straight from the real source
 * (src/pdp11-app.js) so the test exercises the production formula rather than
 * a copy, then runs it in an isolated VM context.
 *
 * teletypeFitScale() decides how much the Model 33 ASR rig (#teletype-rig:
 * the SVG artwork plus every HTML control anchored to it) must be shrunk
 * (transform: scale) to fit the available window. It mirrors
 * lp11FitScale()/panelFitScale(), but has no left-sticker reservation: the rig
 * is a plain, symmetric machine, so the scale is simply
 * min(availW/natW, availH/natH), floored at 10%.
 *
 * ttyScaleFor() is the second half of the same mechanism: the paper window and
 * the two hanging tapes are sized in LOCAL px and must divide their
 * viewport-driven max-height by the element's visual scale (the product of the
 * rig transform and the block's own contain scale), which the helper reads as
 * rendered width / layout width.
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

function loadTtyScaleFor() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function ttyScaleFor");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.scaleFor = ttyScaleFor;", sandbox);
  return sandbox.scaleFor;
}

function run() {
  const fit = loadFitScale();
  const scaleFor = loadTtyScaleFor();

  // Natural geometry of the SVG art layer: the artwork viewBox (502.41464 x
  // 328.45203) times the rig's --tty-u (2.89 px per SVG unit) — see the
  // "SVG art layer" block in css/g60printer.css.
  const NAT_W = 1452; // 502.41464 * 2.89
  const NAT_H = 949;  // 328.45203 * 2.89

  // --- Full size: plenty of window, no scaling ---
  {
    const s = fit(NAT_W + 240, NAT_H + 160, NAT_W, NAT_H);
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
    // Height ratio 500/949 ≈ 0.527 is tighter than width ratio 800/1452.
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

  // --- ttyScaleFor: rendered width over layout width ------------------------
  {
    // #punchtape is 107px wide; at a rig scale of 0.7 the browser reports
    // 74.9px, so the local max-height must be divided by 0.7.
    assert.ok(Math.abs(scaleFor(107 * 0.7, 107) - 0.7) < 1e-9,
      "tape at rig scale 0.7: visual scale is 0.7");

    // #g60printer is 808px wide and carries the rig transform AND its own
    // contain scale onto the Paper marker (0.7 * 0.7129 ≈ 0.499).
    assert.ok(Math.abs(scaleFor(808 * 0.7 * 0.7129, 808) - 0.7 * 0.7129) < 1e-9,
      "printer block: the visual scale is the product of both transforms");

    // Unscaled rig: exactly 1.
    assert.strictEqual(scaleFor(808, 808), 1, "unscaled block: scale 1");
  }

  // --- ttyScaleFor: defensive defaults -------------------------------------
  {
    assert.strictEqual(scaleFor(0, 808), 1,
      "hidden element (rendered 0): falls back to scale 1");
    assert.strictEqual(scaleFor(808, 0), 1,
      "unsized element (layout 0): falls back to scale 1");
    assert.strictEqual(scaleFor(NaN, 808), 1,
      "NaN measurement: falls back to scale 1");
    assert.strictEqual(scaleFor("808", "808"), 1,
      "numeric strings are accepted (computed-style friendly)");
  }

  console.log("\nAll teletype scaling tests passed.");
}

run();
