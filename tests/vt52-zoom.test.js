#!/usr/bin/env node
/**
 * VT52 zoom mode — contract tests.
 *
 * Zoom hides the cabinet artwork and grows the tube to the largest 4:3 box the
 * window allows, clearing the corner controls. The state is PER TERMINAL
 * (console TT0, TTY1, TTY2) and persists in Config.vt52Zoom, so each terminal
 * remembers its own zoom between sessions.
 *
 * This suite parses the production sources and pins the pieces that must agree:
 *   • the page <-> terminal mapping (src/vt52zoom.js) and the order
 *     initVT52Page uses (src/pdp11-app.js);
 *   • the config shape (src/config.js): a three-boolean array, defaulting off;
 *   • the three-layer styling: outer case, recessed bezel, tube — where the two
 *     hidden pieces of the old cabinet (top vent grille, right-hand "digital"
 *     panel) must NOT come back;
 *   • the fit arithmetic: the tube is inset by both walls, and the reserved
 *     gutters keep the box clear of the floating corner buttons.
 *
 * Run with:  node tests/vt52-zoom.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CSS_PATH = path.join(__dirname, "..", "css", "pdp11.css");
const ZOOM_PATH = path.join(__dirname, "..", "src", "vt52zoom.js");
const CONFIG_PATH = path.join(__dirname, "..", "src", "config.js");
const APP_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");
const HTML_PATH = path.join(__dirname, "..", "pdp11.html");

// Extract a single top-level CSS rule body by selector (brace balancing).
function extractRule(css, selector) {
  const marker = selector + " {";
  const start = css.indexOf(marker);
  assert.ok(start !== -1, "rule not found: " + selector);
  const open = start + marker.length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + selector);
}

function run() {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const zoom = fs.readFileSync(ZOOM_PATH, "utf8");
  const config = fs.readFileSync(CONFIG_PATH, "utf8");
  const app = fs.readFileSync(APP_PATH, "utf8");
  const html = fs.readFileSync(HTML_PATH, "utf8");

  // --- 1. The page <-> terminal mapping -----------------------------------
  {
    // The zoom module must map exactly the three VT52 pages, in the same
    // terminal order initVT52Page() registers them.
    assert.ok(/PAGE_UNIT/.test(zoom), "vt52zoom.js must declare PAGE_UNIT");
    for (const [pageId, unit] of [
      ["page-vt52-console", 0],
      ["page-vt52", 1],
      ["page-vt52-2", 2]
    ]) {
      const re = new RegExp('"' + pageId + '"\\s*:\\s*' + unit);
      assert.ok(re.test(zoom),
        "PAGE_UNIT must map " + pageId + " to terminal " + unit);
    }
    // ... and the app must register the terminals in that same order, or the
    // flags would land on the wrong terminal.
    const reg = /initVT52Page\((\d),\s*'(page-vt52[^']*)'/g;
    const seen = {};
    let m;
    while ((m = reg.exec(app)) !== null) seen[m[2]] = Number(m[1]);
    assert.strictEqual(seen["page-vt52-console"], 0, "console must be terminal 0");
    assert.strictEqual(seen["page-vt52"], 1, "TTY1 must be terminal 1");
    assert.strictEqual(seen["page-vt52-2"], 2, "TTY2 must be terminal 2");
  }

  // --- 2. Config shape: three booleans, default off ------------------------
  {
    assert.ok(/vt52Zoom:\s*\[false,\s*false,\s*false\]/.test(config),
      "Config DEFAULTS must ship vt52Zoom as three false flags (per terminal)");
    assert.ok(/function normalizeVt52Zoom/.test(config),
      "Config must normalize the zoom flags");
    assert.ok(/vt52Zoom:\s*normalizeVt52Zoom\(o\.vt52Zoom\)/.test(config),
      "Config.validate must route vt52Zoom through the normalizer");
    // A missing/garbage value must not throw and must yield three flags.
    const norm = /function normalizeVt52Zoom\(value\)\s*\{([\s\S]*?)\n    \}/.exec(config);
    assert.ok(norm, "normalizeVt52Zoom body not found");
    const body = norm[1];
    assert.ok(/Array\.isArray/.test(body),
      "the normalizer must reject non-arrays (old configs keep the cabinet)");
    assert.ok(/\[false, false, false\]/.test(body),
      "the normalizer must fall back to three false flags");
  }

  // --- 3. Persistence: the flag survives through Config --------------------
  {
    assert.ok(/Config\.set\(\{\s*vt52Zoom:/.test(zoom),
      "the zoom state must be written back through Config.set");
    assert.ok(/Config\.get\(\)/.test(zoom),
      "the zoom state must be read back through Config.get");
    // It must copy the array rather than mutating the stored one (Config holds
    // a frozen set; writing into it would be lost or throw in strict mode).
    assert.ok(/\.slice\(\)/.test(zoom),
      "setZoomed must copy the flags array before editing it");
  }

  // --- 4. The button ------------------------------------------------------
  {
    assert.ok(/id="zoom-btn"/.test(html), "pdp11.html must carry the zoom button");
    assert.ok(/id="icon-zoom"/.test(html) && /id="icon-zoom-exit"/.test(html),
      "pdp11.html must carry both zoom icons");
    assert.ok(/src\/vt52zoom\.js/.test(html),
      "pdp11.html must load src/vt52zoom.js");
    // It must sit left of the fullscreen button, not on top of it.
    const fsRule = extractRule(css, ".fullscreen-btn");
    const zoomRule = extractRule(css, ".zoom-btn");
    assert.ok(/position\s*:\s*fixed/.test(zoomRule) && /position\s*:\s*fixed/.test(fsRule),
      "both floating buttons must be fixed");
    const fsRight = parseFloat(/right\s*:\s*([0-9.]+)px/.exec(fsRule)[1]);
    const zRight = parseFloat(/right\s*:\s*([0-9.]+)px/.exec(zoomRule)[1]);
    const fsWidth = parseFloat(/width\s*:\s*([0-9.]+)px/.exec(fsRule)[1]);
    assert.ok(zRight >= fsRight + fsWidth,
      "the zoom button must clear the fullscreen button (" + zRight + " vs " +
      (fsRight + fsWidth) + ")");
    // One active-state class, mirroring the fullscreen button.
    assert.ok(/\.zoom-btn\.zoom-on/.test(css),
      "the lit zoom state must be styled");
    // Off a VT52 page the button disappears — a greyed-out control would still
    // occupy the corner and invite a click that can do nothing. Same .hidden
    // convention as .quick-boot-btn / .console-reboot.
    assert.ok(/\.zoom-btn\.hidden\s*\{[^}]*display\s*:\s*none/.test(css),
      "the zoom button must be hidden (not merely disabled) where no VT52 is shown");
    assert.ok(/classList\.toggle\("hidden"/.test(zoom),
      "updateUI must toggle the .hidden class from the active terminal");
    assert.strictEqual(/\.zoom-btn:disabled/.test(css), false,
      "the zoom button must not be styled as disabled any more");
  }

  // --- 5. Page change keeps the button honest -----------------------------
  {
    assert.ok(/yapdp:pagechange/.test(zoom),
      "vt52zoom.js must follow the active page");
    const panel = fs.readFileSync(path.join(__dirname, "..", "src", "pdp11-panel.js"), "utf8");
    assert.ok(/yapdp:pagechange/.test(panel),
      "switchPage must announce the page change");
  }

  // --- 6. The three-layer zoom styling ------------------------------------
  {
    const backdrop = extractRule(css, ".vt52-zoomed .vt52-backdrop");
    assert.ok(/display\s*:\s*none/.test(backdrop),
      "zoom must hide the artwork backdrop");

    const outer = extractRule(css, ".vt52-zoomed");
    assert.ok(/gradient/.test(outer),
      "the outer case must keep the moulded-plastic gradient");
    assert.ok(/border-top-color\s*:\s*#ece6d8/.test(outer),
      "the outer case must keep the light top catch");
    assert.ok(/--vt52-case-wall\s*:/.test(outer) && /--vt52-bezel-wall\s*:/.test(outer),
      "both wall thicknesses must be published as variables");

    const bezel = extractRule(css, ".vt52-zoomed .vt52-bezel");
    assert.ok(/position\s*:\s*absolute/.test(bezel),
      "the bezel must be an absolute layer (not a flex child that steals space)");
    assert.ok(/inset\s+0\s+4px\s+12px/.test(bezel),
      "the bezel must be recessed by an inner shadow (the old .vt52-bezel trim)");
    assert.ok(/left\s*:\s*var\(--vt52-case-wall\)/.test(bezel) &&
      /right\s*:\s*var\(--vt52-case-wall\)/.test(bezel),
      "the bezel must fill the case inside the outer wall");

    const tube = extractRule(css, ".vt52-zoomed .vt52-crt");
    assert.ok(/left\s*:\s*var\(--vt52-tube-left\)/.test(tube),
      "the tube must be inset by both walls");
    assert.ok(/inset\s+0\s+0\s+90px/.test(tube),
      "the tube must keep its glass vignette");

    // The two pieces of the old cabinet that belong to hidden parts must stay
    // away: the vent grille and the "digital" side panel.
    assert.strictEqual(css.indexOf(".vt52-vents"), -1,
      "the top vent grille must NOT come back in zoom mode");
    assert.strictEqual(css.indexOf(".vt52-side-plastic"), -1,
      "the right-hand digital panel must NOT come back in zoom mode");
  }

  // --- 7. The fit arithmetic ----------------------------------------------
  {
    // The box is the tube plus BOTH walls (and their borders) on each side.
    assert.ok(/VT52_CASE_WALL\s*=\s*(\d+)/.test(app),
      "the outer wall thickness must be a named constant");
    assert.ok(/VT52_BEZEL_WALL\s*=\s*(\d+)/.test(app),
      "the bezel wall thickness must be a named constant");
    const caseWall = Number(/VT52_CASE_WALL\s*=\s*(\d+)/.exec(app)[1]);
    const bezelWall = Number(/VT52_BEZEL_WALL\s*=\s*(\d+)/.exec(app)[1]);
    const cssCase = Number(/--vt52-case-wall\s*:\s*(\d+)px/.exec(
      extractRule(css, ".vt52-zoomed"))[1]);
    const cssBezel = Number(/--vt52-bezel-wall\s*:\s*(\d+)px/.exec(
      extractRule(css, ".vt52-zoomed"))[1]);
    assert.strictEqual(cssCase, caseWall,
      "the CSS outer wall must equal VT52_CASE_WALL");
    assert.strictEqual(cssBezel, bezelWall,
      "the CSS bezel wall must equal VT52_BEZEL_WALL");
    const tubeLeft = Number(/--vt52-tube-left\s*:\s*(\d+)px/.exec(
      extractRule(css, ".vt52-zoomed"))[1]);
    assert.strictEqual(tubeLeft, caseWall + bezelWall,
      "--vt52-tube-left must be the sum of both walls");

    // The screen marker is the tube: its size must come from the artwork data.
    assert.ok(/VT52_SCREEN_W\s*=\s*112\.852/.test(app) &&
      /VT52_SCREEN_H\s*=\s*84\.639/.test(app),
      "the tube size must be the Screen marker dimensions");
    assert.ok(Math.abs((112.852 / 84.639) - (4 / 3)) < 1e-4,
      "the Screen marker must stay 4:3, or zoom would letterbox the canvas");

    // The fit must reserve the corner controls: a height-only or width-only
    // fit used to push the tube under the floating buttons.
    assert.ok(/VT52_GUTTER_SIDE/.test(app) && /VT52_GUTTER_TOP/.test(app) &&
      /VT52_GUTTER_BOTTOM/.test(app),
      "the fit must reserve gutters for the floating controls");
    assert.ok(/getBoundingClientRect\(\)\.top/.test(app),
      "the fit must measure the box's real top (the page centres its content)");
  }

  // --- 8. Leaving zoom re-fits the cabinet at once -------------------------
  {
    // Unzooming changes the TERMINAL's own size, not the page's box, so the
    // ResizeObserver in installVT52Scaling() (it watches the page) never fires.
    // Without an explicit re-fit the cabinet came back at its natural 1074x830
    // size, unscaled, and the page's overflow: hidden clipped its lower half
    // until the next window resize. The fit is therefore addressed per page id
    // through the registry installVT52Scaling() publishes.
    assert.ok(/var VT52_FIT = \{\};/.test(app),
      "installVT52Scaling must publish its per-page fit callbacks in VT52_FIT");
    assert.ok(/VT52_FIT\[pageId\] = apply;/.test(app),
      "installVT52Scaling must register each page's fit callback");
    assert.ok(/function vt52Rescale\(rig\)/.test(app),
      "the app must expose a vt52Rescale(rig) re-fit helper");
    assert.ok(/window\.vt52Rescale = vt52Rescale;/.test(app),
      "vt52Rescale must be published on window for the zoom module");
    // The old hook was never defined anywhere — a silent no-op, which is how
    // the stale (clipped) geometry survived. No CALL may come back.
    assert.strictEqual(/window\.__vt52Rescale\s*\(/.test(app), false,
      "the dead window.__vt52Rescale() call must be gone");

    const unzoom = /function vt52Unzoom\(rig\)\s*\{([\s\S]*?)\n\}/.exec(app);
    assert.ok(unzoom, "vt52Unzoom body not found");
    assert.ok(/window\.vt52Rescale\(rig\)/.test(unzoom[1]),
      "vt52Unzoom must re-fit the cabinet it just uncovered");

    // ... and it must be the rig's OWN page: TTY 1 must never be fitted with
    // the console page's callback.
    const rescale = /function vt52Rescale\(rig\)\s*\{([\s\S]*?)\n\}/.exec(app);
    assert.ok(rescale, "vt52Rescale body not found");
    assert.ok(/rig\.closest\('\.page'\)/.test(rescale[1]),
      "vt52Rescale must resolve the page that owns the rig");
    assert.ok(/VT52_FIT\[page\.id\]/.test(rescale[1]),
      "vt52Rescale must look the fit callback up by page id");
  }

  // --- 9. Entering zoom re-fits as well (the fit is not one-directional) ----
  {
    // The cabinet's scale and its reserved container height were computed for
    // the NATURAL cabinet. Zoom replaces the box with a window-sized one but
    // moves neither the page's box (so the ResizeObserver stays silent) nor the
    // stale scale: the maximised tube was drawn at the old cabinet scale (69% on
    // a 1400x800 window) and looked needlessly small until a window resize.
    const zoomBody = /function vt52Zoom\(rig\)\s*\{([\s\S]*?)\n\}/.exec(app);
    assert.ok(zoomBody, "vt52Zoom body not found");
    assert.ok(/window\.vt52Rescale\(rig\)/.test(zoomBody[1]),
      "vt52Zoom must re-fit after writing the zoomed geometry");

    // ... and a re-fit may only measure the NATURAL size: the reservation left
    // by the previous pass has to be cleared first, or statusPad reads it back
    // as the natural content height and the reservation drifts.
    const apply = /function apply\(\)\s*\{([\s\S]*?)\n    \}/.exec(app);
    assert.ok(apply, "installVT52Scaling's apply() body not found");
    const body = apply[1];
    assert.ok(/container\.style\.height = '';/.test(body),
      "apply() must clear the reserved height before measuring");
    assert.ok(body.indexOf("container.style.height = ''") <
      body.indexOf("container.offsetHeight"),
      "the reserved height must be cleared BEFORE statusPad is measured");
  }

  console.log("vt52-zoom: all tests passed");
}

run();
