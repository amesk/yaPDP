#!/usr/bin/env node
/**
 * LP11 printer-cabinet proportional-scaling modular tests.
 *
 * Extracts the pure lp11FitScale() helper straight from the real source
 * (src/pdp11-app.js) so the test exercises the production formula rather than
 * a copy, then runs it in an isolated VM context.
 *
 * lp11FitScale() decides how much the LP11 cabinet must be shrunk
 * (transform: scale) to fit the available window. It mirrors the VT52-cabinet
 * scaling already used by the console/user-terminal pages, but also accounts
 * for the printer page's fixed (unscaled) chrome — the top spacer and the
 * Print / Save .txt actions row.
 *
 * Run with:  node tests/lp11-scaling.test.js
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
  const fn = extractBlock(src, "function lp11FitScale");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.fit = lp11FitScale;", sandbox);
  return sandbox.fit;
}

function run() {
  const fit = loadFitScale();

  // Representative natural geometry of the LP11 cabinet (1160px machine plus
  // cabinet padding) and the fixed chrome on the printer page.
  const NAT_W = 1192;  // 1160 machine + 2*16 horizontal cabinet padding
  const NAT_H = 330;   // badge + mechanics bay + operator console + padding
  const FIXED_H = 50;  // top spacer + Print / Save .txt actions row

  // --- Full size: plenty of window, no scaling ---
  {
    const s = fit(1600, 900, NAT_W, NAT_H, FIXED_H);
    assert.strictEqual(s, 1, "wide/tall window: cabinet keeps full size");
  }

  // --- Width-limited: narrow window shrinks the cabinet ---
  {
    const s = fit(1000, 900, NAT_W, NAT_H, FIXED_H);
    const expected = 1000 / NAT_W;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "narrow window: scale is the width ratio (" + s + " vs " + expected + ")");
  }

  // --- Height-limited: short window (even wide) scales vertically too ---
  {
    // room left for the cabinet: 320 - 50 = 270 < NAT_H → height-bound.
    const s = fit(2000, 320, NAT_W, NAT_H, FIXED_H);
    const expected = (320 - FIXED_H) / NAT_H;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "short window: scale is the height ratio (" + s + " vs " + expected + ")");
  }

  // --- Both constrained: the smaller of the two wins ---
  {
    // Height ratio 250/330 ≈ 0.758 is tighter than the width ratio 1000/1192.
    const s = fit(1000, 300, NAT_W, NAT_H, FIXED_H);
    const expected = (300 - FIXED_H) / NAT_H;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "both axes: the tighter (height) ratio wins");
  }

  // --- Readability floor: never collapse below 10% ---
  {
    const s = fit(20, 900, NAT_W, NAT_H, FIXED_H);
    assert.strictEqual(s, 0.1, "tiny window: clamped to 10%");
  }

  // --- Hidden page: zero natural size means no scaling needed ---
  {
    assert.strictEqual(fit(0, 0, 0, 0, 0), 1, "hidden/unsized: scale 1");
  }

  // --- Fixed chrome taller than the viewport: vertical constraint skipped ---
  {
    // spaceH = 30 - 50 < 0 → only the width ratio applies.
    const s = fit(1000, 30, NAT_W, NAT_H, FIXED_H);
    assert.strictEqual(s, Math.min(1, 1000 / NAT_W),
      "no vertical room: width ratio only");
  }

  console.log("\nAll LP11 scaling tests passed.");
}

run();
