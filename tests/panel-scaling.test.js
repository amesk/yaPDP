#!/usr/bin/env node
/**
 * Front-panel proportional-scaling modular tests.
 *
 * Extracts the pure panelFitScale() helper straight from the real source
 * (src/pdp11-app.js) so the test exercises the production formula rather than
 * a copy, then runs it in an isolated VM context.
 *
 * panelFitScale() decides how much the PDP-11/70 front panel (.frame) must be
 * shrunk (transform: scale) to fit the available window. It mirrors the
 * lp11FitScale() helper used by the LP11 printer cabinet, but also reserves
 * room for the operator's hand-written "Help Me!" sticky note, which extends
 * ~280px to the LEFT of the panel (see .panel-sticker in css/pdp11.css). The
 * panel stays centred, so the note needs symmetric room on the axis it
 * occupies: the width must fit natW + 2 * stickerExtent while the note stands
 * beside the panel, and the height must fit natH + 2 * stickerVExtent when it
 * stands above or below it. Which of the two it is comes from
 * panelStickerSide(), the second helper extracted below: the note leaves the
 * panel's side as soon as it does not fit there, so that showing it never
 * costs the operator panel size.
 *
 * Run with:  node tests/panel-scaling.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");
const CSS_PATH = path.join(__dirname, "..", "css", "pdp11.css");

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

function loadHelpers() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function panelFitScale");
  const pick = extractBlock(src, "function panelStickerSide");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n" + pick +
    "\n; this.fit = panelFitScale; this.side = panelStickerSide;", sandbox);
  return { fit: sandbox.fit, side: sandbox.side };
}

function run() {
  const { fit, side } = loadHelpers();

  // Representative natural geometry of the front panel (.frame: 272x93 units
  // at 4x5px per unit). The sticker extent is the note's measured left
  // protrusion (see installPanelScaling.measureExtent): a 260px wide note +
  // 2 * unitWidth = 8px gap to the panel edge, plus the -3deg rotation corner
  // overhang — around 276-280px for the current note geometry.
  const NAT_W = 1088; // 272 * 4px
  const NAT_H = 465;  // 93 * 5px
  const STICKER = 280; // representative measured bounding-box protrusion

  // --- Full size: plenty of window, no scaling ---
  {
    // 1920@100%: page ~1842 wide (sidebar excluded), panel + sticker fit.
    const s = fit(1818, 936, NAT_W, NAT_H, STICKER);
    assert.strictEqual(s, 1, "wide/tall window: panel keeps full size");
  }

  // --- Width-limited: 1920@125% shrinks the panel so the sticker stays clear ---
  {
    // Content area ~1458 wide (1920 @125% minus the 78px sidebar), so the
    // panel page's clientWidth is ~1458 and availW = clientWidth - 40 = 1418.
    // The sticker's symmetric reserve makes the footprint 1088 + 2*280 = 1648,
    // so scale = 1418 / 1648.
    const pageW = 1458;
    const availW = pageW - 40;
    const s = fit(availW, 936, NAT_W, NAT_H, STICKER);
    const expected = availW / (NAT_W + 2 * STICKER);
    assert.ok(Math.abs(s - expected) < 1e-9,
      "125% width: scale is the footprint ratio (" + s + " vs " + expected + ")");
    // Invariant: because installPanelScaling() feeds availW = clientWidth - 40,
    // the sticker's (unrotated) left edge lands exactly 20px inside the page —
    // the -3deg rotated corner still leaves ~14px, clearing the sidebar shadow.
    const stickerLeft = pageW / 2 - (NAT_W / 2 + STICKER) * s;
    assert.ok(Math.abs(stickerLeft - 20) < 1e-6,
      "sticker left edge clears the page edge by ~20px");
  }

  // --- Height-limited: short window (even wide) scales vertically too ---
  {
    // availH = 300 < NAT_H 465 → height-bound; width ratio would be > 1.
    const s = fit(2000, 300, NAT_W, NAT_H, STICKER);
    const expected = 300 / NAT_H;
    assert.ok(Math.abs(s - expected) < 1e-9,
      "short window: scale is the height ratio (" + s + " vs " + expected + ")");
  }

  // --- Both constrained: the smaller of the two wins ---
  {
    // Width ratio 1000/1624 ≈ 0.616 is tighter than height ratio 400/465.
    const s = fit(1000, 400, NAT_W, NAT_H, STICKER);
    const expected = 1000 / (NAT_W + 2 * STICKER);
    assert.ok(Math.abs(s - expected) < 1e-9,
      "both axes: the tighter (width) ratio wins");
  }

  // --- Readability floor: never collapse below 10% ---
  {
    const s = fit(10, 900, NAT_W, NAT_H, STICKER);
    assert.strictEqual(s, 0.1, "tiny window: clamped to 10%");
  }

  // --- Hidden page: zero natural size means no scaling needed ---
  {
    assert.strictEqual(fit(0, 0, 0, 0, STICKER), 1, "hidden/unsized: scale 1");
  }

  // --- Boundary: exactly the footprint width keeps full size ---
  {
    assert.strictEqual(fit(NAT_W + 2 * STICKER, 936, NAT_W, NAT_H, STICKER), 1,
      "boundary width: still scale 1");
    const s = fit(NAT_W + 2 * STICKER - 1, 936, NAT_W, NAT_H, STICKER);
    assert.ok(s < 1 && s > 0.99,
      "just below boundary: scales a hair down (" + s + ")");
  }

  // --- Which side of the cabinet the note takes (panelStickerSide) ---
  // Beside the panel the note reserves its own width on BOTH sides (the frame
  // is centred), so it only stays there while the page really has that room;
  // otherwise it moves above or below the cabinet, where the roomier side wins
  // — and where it costs height instead of width.
  const NOTE = { needSide: 276, needHeight: 160 };
  {
    assert.strictEqual(side({ side: 400, above: 200, below: 200, ...NOTE }), "left",
      "the note fits beside the panel: it stays there");
    assert.strictEqual(side({ side: 276, above: 0, below: 0, ...NOTE }), "left",
      "boundary: exactly the room the note needs beside the panel");
    assert.strictEqual(side({ side: 180, above: 120, below: 300, ...NOTE }), "below",
      "tight width, more room below: the note goes below the cabinet");
    assert.strictEqual(side({ side: 180, above: 300, below: 120, ...NOTE }), "above",
      "tight width, more room above: the note goes above the cabinet");
    assert.strictEqual(side({ side: 180, above: 200, below: 200, ...NOTE }), "above",
      "a tie picks above, deterministically");
    // No measurement yet (the note's layout has not flushed): never move it on
    // a guess — beside the panel stays the default.
    assert.strictEqual(side({ side: 180, above: 300, below: 300,
      needSide: 268, needHeight: 0 }), "left", "unmeasured note: beside the panel");
    assert.strictEqual(side(null), "left", "no measurements at all: beside the panel");
  }

  // --- Above/below the note costs HEIGHT, never width ---
  {
    // The width that made the side placement shrink the panel (see the 125%
    // case above: 1418 availW) no longer touches it at all.
    assert.strictEqual(fit(1418, 936, NAT_W, NAT_H, 0, 160), 1,
      "note above the panel: the width it would have taken is free");
    // …while its own height is what bounds the fit now (reserved twice, like
    // the width was: the frame is centred on this axis too).
    const s = fit(2000, 600, NAT_W, NAT_H, 0, 160);
    assert.ok(Math.abs(s - 600 / (NAT_H + 2 * 160)) < 1e-9,
      "note above the panel: the height bound reserves the note twice (" + s + ")");
    // Control: with no note at all the bound is the panel's own height, so the
    // new argument changes nothing for a hidden note.
    assert.ok(Math.abs(fit(2000, 300, NAT_W, NAT_H, 0) - 300 / NAT_H) < 1e-9,
      "no note: the panel's own height is the bound");
    assert.strictEqual(fit(2000, 900, NAT_W, NAT_H, 0, 160), 1,
      "tall enough for the note above: full panel size");
  }

  // --- CSS: the two placements exist and keep the note on the cabinet ---
  {
    const css = fs.readFileSync(CSS_PATH, "utf8");
    assert.ok(/\.panel-sticker\.sticker-above\s*\{[^}]*bottom:\s*calc\(100%/.test(css),
      "the note must be able to sit on top of the cabinet");
    assert.ok(/\.panel-sticker\.sticker-below\s*\{[^}]*top:\s*calc\(100%/.test(css),
      "…and under it");
    assert.ok(/\.panel-sticker\.sticker-above[\s\S]*?right:\s*auto/.test(css),
      "the side anchor must be released, or the note would stay beside the panel");
    assert.ok(/\.panel-sticker\.sticker-above[\s\S]*?translateX\(-50%\)\s*rotate\(-3deg\)/
      .test(css), "both placements centre the note and keep its tilt");
  }

  console.log("\nAll panel scaling tests passed.");
}

run();
