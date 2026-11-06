#!/usr/bin/env node
/**
 * Phosphor palette contract.
 *
 * The VT100's tube is painted from three sources, and they used to drift apart:
 *   - PHOSPHORS in src/terminal-core.js — the canvas glyph colours;
 *   - --vt52-bg / --vt52-fg in css/pdp11.css — the glass plate and the
 *     plain-text field;
 *   - the CONFIG control in pdp11.html — which tubes the operator may pick.
 *
 * p3 (amber) is the LATER tube: the VT220 era and the DEC terminals that
 * followed it, a factory option from the VT300 series on — never a VT100 one.
 * The hint under the control has to say so, or the field reads as a 1978
 * catalogue entry that never existed; this test pins that disclaimer.
 *
 * Run with:  node tests/phosphor-css.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const JS_PATH = path.join(ROOT, "src", "terminal-core.js");
const CSS_PATH = path.join(ROOT, "css", "pdp11.css");
const HTML_PATH = path.join(ROOT, "pdp11.html");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// The declarations of a TOP-LEVEL rule whose selector starts its own line. A
// rule that merely CONTAINS the selector as a descendant must not be picked up.
function ruleBody(css, selector) {
  let idx = -1;
  for (let at = css.indexOf(selector + " {"); at !== -1; at = css.indexOf(selector + " {", at + 1)) {
    const lineStart = css.lastIndexOf("\n", at) + 1;
    if (css.slice(lineStart, at).trim() === "") idx = at; // selector starts the line
  }
  assert.ok(idx !== -1, "css/pdp11.css must define the " + selector + " rule");
  const open = css.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces in the " + selector + " rule");
}

function decl(body, name) {
  const m = new RegExp(name.replace(/-/g, "\\-") + "\\s*:\\s*([^;]+);").exec(body);
  return m ? m[1].trim() : null;
}

// PHOSPHORS = { p4: Object.freeze({ fg, bg }), ... } in src/terminal-core.js
function palettes() {
  const src = read(JS_PATH);
  const start = src.indexOf("const PHOSPHORS = Object.freeze({");
  assert.ok(start !== -1, "src/terminal-core.js must define PHOSPHORS");
  const end = src.indexOf("});", start);
  assert.ok(end !== -1, "PHOSPHORS must be a closed object literal");
  const block = src.slice(start, end);
  const out = {};
  const re = /(\w+)\s*:\s*Object\.freeze\(\{\s*fg:\s*"([^"]+)",\s*bg:\s*"([^"]+)"\s*\}\)/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = { fg: m[2], bg: m[3] };
  return out;
}

function run() {
  const pal = palettes();
  const css = read(CSS_PATH);

  // --- 1. the palette table itself ---------------------------------------
  assert.deepStrictEqual(Object.keys(pal).sort(), ["p1", "p3", "p4"],
    "PHOSPHORS must carry exactly the three tubes the CONFIG offers: p4, p1, p3");

  // --- 2. the stylesheet paints the same pairs ---------------------------
  // The LAST plain "body {" rule is the phosphor block (the first one is the
  // page layout); both are top-level, so the matcher takes the last.
  const base = ruleBody(css, "body");
  assert.strictEqual((decl(base, "--vt52-fg") || "").toLowerCase(), pal.p4.fg.toLowerCase(),
    "body --vt52-fg must be the p4 foreground");
  assert.strictEqual((decl(base, "--vt52-bg") || "").toLowerCase(), pal.p4.bg.toLowerCase(),
    "body --vt52-bg must be the p4 background");

  for (const name of ["p1", "p3"]) {
    const sel = 'body[data-phosphor="' + name + '"] .vt52-rig[data-dialect="vt100"]';
    const body = ruleBody(css, sel);
    assert.strictEqual((decl(body, "--vt52-fg") || "").toLowerCase(), pal[name].fg.toLowerCase(),
      sel + " --vt52-fg must match PHOSPHORS." + name + ".fg");
    assert.strictEqual((decl(body, "--vt52-bg") || "").toLowerCase(), pal[name].bg.toLowerCase(),
      sel + " --vt52-bg must match PHOSPHORS." + name + ".bg");
    // Reverse video swaps the LIVE pair, so the flipped tube has to restate it.
    const rev = ruleBody(css, sel + ".reverse-video");
    assert.strictEqual((decl(rev, "--vt52-bg") || "").toLowerCase(), pal[name].fg.toLowerCase(),
      sel + ".reverse-video must swap fg/bg");
  }

  // --- 3. no halo on either surface --------------------------------------
  // The canvas paints an OPAQUE background, so a drop-shadow() on it can only
  // outline the whole rectangle — it showed as a thin bright stripe along the
  // canvas edges. A shadow around a thin glyph (Canvas shadowBlur or a CSS
  // text-shadow) reads as a second contour of the letter instead of bloom. So
  // there is no halo at all, in EITHER rendering mode: the phosphor shows in
  // the colour, and one terminal never looks like two.
  const canvasRule = ruleBody(css, ".vt52-crt canvas");
  assert.ok(!/filter\s*:/.test(canvasRule),
    "the canvas must carry NO filter: a drop-shadow there frames the picture " +
    "with a hard bright rectangle");
  const flicker = ruleBody(css, "@keyframes crt-flicker");
  assert.ok(!/drop-shadow/.test(flicker) && /brightness\(/.test(flicker),
    "crt-flicker must only flicker the brightness");
  assert.ok(!/\btext-shadow\s*:/.test(ruleBody(css, ".vt52-crt textarea.vt52-textarea")),
    "no glyph halo in the plain-text field: the canvas has none either, and " +
    "one terminal must not look like two");
  const core = read(JS_PATH);
  assert.ok(!/shadowBlur|shadowColor/.test(core),
    "the canvas renderer must not draw a glyph halo — it shows as a second " +
    "contour of every letter (measured, not guessed: see the note by PHOSPHORS)");

  // --- 4. the CONFIG control ---------------------------------------------
  const html = read(HTML_PATH);
  const at = html.indexOf('id="config-field-vt100Phosphor"');
  assert.ok(at !== -1, "pdp11.html must keep the phosphor field");
  const field = html.slice(at, at + 1400);
  assert.ok(/class="config-control config-segmented"/.test(field),
    "the phosphor pick must be the segmented button row");
  for (const v of ["p4", "p1", "p3"]) {
    assert.ok(new RegExp('type="radio" name="vt100Phosphor" value="' + v + '"').test(field),
      "value=" + v + " must stay a RADIO in the vt100Phosphor group — the form " +
      "code, setFieldDisabled and the e2e suite all read that group");
  }
  assert.ok(/VT220|VT300/.test(field),
    "the hint must say amber belongs to the LATER (VT220-era) tubes, not to a VT100");

  // --- 4b. the authored glass plate follows the tube ---------------------
  // The artwork's plate fill is inline (#141914), so a phosphor rule alone left
  // it behind: the canvas edge showed as a rectangle against the SVG backdrop.
  assert.ok(/\.vt52-rig \.vt52-layer-Glass[\s\S]{0,240}?fill:\s*var\(--vt52-bg\)/.test(css),
    "the inlined glass plate must be painted from var(--vt52-bg), or a green/" +
    "amber canvas sits on a P4-grey plate with a visible seam");
  assert.ok(/var\(--vt52-bg\)\s*!important/.test(css),
    "the plate fill is inline in the artwork — the rule needs !important to win");

  // --- 5. the button states the form relies on ---------------------------
  const segCss = css.slice(css.indexOf(".config-segmented"));
  assert.ok(segCss.length > 0 && css.indexOf(".config-segmented") !== -1,
    "css/pdp11.css must style .config-segmented");
  assert.ok(/\.config-segmented input:checked\+span/.test(segCss),
    "the chosen tube must read as a pressed button");
  assert.ok(/\.config-segmented input:focus-visible\+span/.test(segCss),
    "keyboard focus must be visible on the button row");
  assert.ok(/\.config-segmented input:disabled\+span/.test(segCss),
    "a dimmed field (no VT100 installed) must not look pressable");

  console.log("PASS: phosphor palettes agree across JS, CSS and the CONFIG form");
}

run();
