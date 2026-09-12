#!/usr/bin/env node
/**
 * Model 33 ASR cabinet + keycaps — CSS contract tests.
 *
 * The console teletype cabinet is drawn by assets/Model-33-ASR.svg; the
 * SVG <-> CSS geometry contract lives in tests/teletype-svg-backdrop.test.js.
 * This suite guards what css/g60printer.css must still provide on top of that
 * artwork:
 *   1. The artwork backs the page and the CSS-drawn skin layers (Google60
 *      body, side skins, paper slot, face plate, cover dome, carriage window,
 *      wordmark) are switched OFF, so the artwork is the single source of the
 *      machine's look.
 *   2. Every control keeps its native px layout (key block 576x212, plate
 *      170x164, apron 118x66) and is anchored to its marker rect in the shared
 *      coordinate system (--tty-u * marker coordinate), contain-fitted so the
 *      round keycaps and the knob never distort.
 *   3. The flat-top cylindrical keycaps: a radial highlight over a solid dark
 *      side wall (box-shadow: 0 4px 0 #241f1a) that collapses when the key is
 *      pressed (translateY(4px) on the .down state).
 *
 * These are deliberately simple string checks on the production CSS so a
 * future "simplification" back to a CSS-drawn cabinet, or a control that
 * silently drops its marker anchor, is caught.
 *
 * Run with:  node tests/teletype-cabinet-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");
const HTML_PATH = path.join(__dirname, "..", "pdp11.html");
const APP_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");

// Extract a top-level CSS rule body given the selector prefix (first match).
function extractRule(css, selectorStart) {
  const idx = css.indexOf(selectorStart);
  if (idx === -1) {
    throw new Error("rule not found: " + selectorStart);
  }
  const braceOpen = css.indexOf("{", idx);
  let depth = 0;
  for (let i = braceOpen; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return css.slice(idx, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + selectorStart);
}

// Extract the LAST matching rule (the art-layer block wins the cascade over
// the base rules earlier in the sheet).
function extractLastRule(css, selectorStart) {
  const idx = css.lastIndexOf(selectorStart);
  if (idx === -1) {
    throw new Error("rule not found: " + selectorStart);
  }
  const braceOpen = css.indexOf("{", idx);
  let depth = 0;
  for (let i = braceOpen; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return css.slice(idx, i + 1);
    }
  }
  throw new Error("unbalanced braces for: " + selectorStart);
}

function run() {
  const css = fs.readFileSync(CSS_PATH, "utf8");

  // --- The artwork backs the teletype page ---------------------------------
  {
    const rule = extractRule(css, "#tty-backdrop {");
    assert.ok(/background\s*:\s*url\('\.\.\/assets\/Model-33-ASR\.svg'\)/.test(rule),
      "the backdrop must load assets/Model-33-ASR.svg:\n" + rule);
    assert.ok(/pointer-events\s*:\s*none\s*;/.test(rule),
      "the backdrop must be inert to the mouse (pointer-events: none):\n" + rule);
  }

  // --- The artwork's front-most layers paint over the live controls ---------
  // The machine itself is a background image BEHIND every control, so the layers
  // the artist marked as being in front of it are inlined into their own
  // elements (installTtyForeground, src/pdp11-app.js). There are two of them:
  //   Middle     — the punch tongue, which the PUNCHED tape comes out OVER,
  //                so it must sit between the reader tape (10) and the
  //                punched tape (12);
  //   Foreground — above everything.
  {
    const rule = extractRule(css, "#tty-foreground {");
    assert.ok(/position\s*:\s*absolute\s*;/.test(rule),
      "the foreground must be positioned like the backdrop:\n" + rule);
    const z = /z-index\s*:\s*(\d+)\s*;/.exec(rule);
    assert.ok(z && Number(z[1]) > 12,
      "the foreground must stack above both hanging tapes (z-index > 12):\n" + rule);
    assert.ok(/pointer-events\s*:\s*none\s*;/.test(rule),
      "the foreground is cosmetic — it must never take a click:\n" + rule);

    const backRule = extractRule(css, "#tty-foreground-back {");
    assert.ok(/position\s*:\s*absolute\s*;/.test(backRule),
      "the back front-most layer must be positioned like the backdrop:\n" + backRule);
    const zb = /z-index\s*:\s*(\d+)\s*;/.exec(backRule);
    assert.ok(zb && Number(zb[1]) > 10 && Number(zb[1]) < Number(z[1]),
      "the back layer must sit between the two hanging tapes and the front " +
      "layer (10 < z < front):\n" + backRule);
    assert.ok(/pointer-events\s*:\s*none\s*;/.test(backRule),
      "the back layer is cosmetic — it must never take a click:\n" + backRule);

    const tape = extractRule(css, "#punchtape {");
    const zt = /z-index\s*:\s*(\d+)\s*;/.exec(tape);
    assert.ok(zt && Number(zt[1]) > Number(zb[1]),
      "the punched tape must come out OVER the punch tongue (z-index above the " +
      "back layer's):\n" + tape);
    const reader = extractRule(css, "#readertape {");
    const zr = /z-index\s*:\s*(\d+)\s*;/.exec(reader);
    assert.ok(zr && Number(zr[1]) < Number(zb[1]),
      "the reader tape must still slip UNDER its own tongue (z-index below the " +
      "back layer's):\n" + reader);

    // #tty-overlay must NOT isolate the tapes in a stacking context of its own,
    // otherwise the whole overlay (both tapes included) would sit under every
    // front-most layer and the punched tape could never come out over the tongue.
    const overlay = extractRule(css, "#tty-overlay {");
    assert.ok(!/z-index\s*:/.test(overlay),
      "#tty-overlay must not create a stacking context (no z-index):\n" + overlay);

    const html = fs.readFileSync(HTML_PATH, "utf8");
    assert.ok(html.indexOf('id="tty-foreground"') !== -1,
      "pdp11.html must carry the #tty-foreground host");
    assert.ok(html.indexOf('id="tty-foreground-back"') !== -1,
      "pdp11.html must carry the #tty-foreground-back host");
    const app = fs.readFileSync(APP_PATH, "utf8");
    assert.ok(app.indexOf("function ttyArtLayerId") !== -1 &&
      app.indexOf("installTtyForeground(text)") !== -1 &&
      app.indexOf("'Middle'") !== -1,
      "src/pdp11-app.js must find and inline both front-most layers " +
      "(the artwork's Middle and Foreground labels)");
    assert.ok(/setAttribute\(['"]width['"],\s*['"]100%['"]\)/.test(app) &&
      /setAttribute\(['"]height['"],\s*['"]100%['"]\)/.test(app),
      "the inlined artwork must be sized to the rig box exactly like the " +
      "backdrop (the size is set on the built <svg>, not by a stylesheet rule)");
  }

  // --- The rig is laid out in artwork (viewBox) units ----------------------
  {
    const rule = extractRule(css, "#teletype-rig {");
    assert.ok(/width\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-vb-w\)\)\s*;/.test(rule),
      "the rig width must be the viewBox width in --tty-u units:\n" + rule);
    assert.ok(/height\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-vb-h\)\)\s*;/.test(rule),
      "the rig height must be the viewBox height in --tty-u units:\n" + rule);
    // Every scale() factor must be UNITLESS: a length there makes the whole
    // transform invalid and the browser drops it silently — a real bug the
    // browser probe caught (the keys stayed unscaled because the factor was
    // derived from the length --tty-u instead of the number --tty-u-num).
    for (const name of ["--tty-kbd-sx", "--tty-kbd-sy", "--tty-kbd-k",
                        "--tty-pctrl-k", "--tty-pctrl-btn-k",
                        "--tty-rctrl-k", "--tty-rctrl-switch-k",
                        "--tty-apron-k", "--tty-sheet-k"]) {
      const decl = new RegExp(name + "\\s*:\\s*([^;]+);").exec(rule);
      assert.ok(decl, name + " must be declared in the rig rule:\n" + rule);
      assert.ok(/var\(--tty-u-num\)/.test(decl[1]),
        name + " must derive from the UNITLESS --tty-u-num:\n" + decl[1]);
      assert.ok(!/var\(--tty-u\)/.test(decl[1]),
        name + " must not use the length --tty-u:\n" + decl[1]);
    }
  }

  // --- The CSS-drawn cabinet skin is switched off --------------------------
  // #printer must stay VISIBLE (the paper sheet is its child, see setupPrinter
  // in src/g60printer.js) and only lose its plastic.
  {
    // The LAST rule wins the cascade: the art-layer block sits below the
    // Google60 base rule.
    const rule = extractLastRule(css, "#g60printer div#printer {");
    assert.ok(/background\s*:\s*none\s*;/.test(rule),
      "the printer's CSS plastic must be dropped (the artwork draws it):\n" + rule);
    assert.ok(!/display\s*:\s*none\s*;/.test(rule),
      "#printer must NOT be display:none — the paper sheet lives inside it:\n" + rule);
    assert.ok(!/linear-gradient/.test(rule),
      "the Google60 sand gradient must be gone from #printer:\n" + rule);
  }
  {
    const rule = extractRule(css, "#g60printer div#printer::after,");
    assert.ok(/display\s*:\s*none\s*;/.test(rule),
      "the CSS-drawn skin layers must be hidden (the artwork draws them):\n" + rule);
    for (const sel of ["#g60printer div#printer::after,",
                       "#g60printer div#printer_left,",
                       "#g60printer div#printer_right,",
                       "#g60printer div#printer_frontpannel,",
                       "#g60printer::before,",
                       "#g60printer::after {"]) {
      assert.ok(rule.indexOf(sel) !== -1,
        "the hidden-skin rule must cover '" + sel + "':\n" + rule);
    }
  }

  // --- Printer block: sheet on the Paper marker, print line on the Caret ----
  {
    const rule = extractLastRule(css, "#g60printer {");
    assert.ok(/left\s*:\s*calc\(\(var\(--tty-paper-x\)\s*\+\s*var\(--tty-paper-w\)\s*\/\s*2\)\s*\*\s*var\(--tty-u\)\s*-\s*404px\s*\*\s*var\(--tty-sheet-k\)\)\s*;/.test(rule),
      "the printer block must be centred on the Paper marker (the sheet is centred in the 808px body):\n" + rule);
    assert.ok(/top\s*:\s*calc\(var\(--tty-caret-line-y\)\s*\*\s*var\(--tty-u\)/.test(rule),
      "the print line must land on the Caret marker's bottom edge:\n" + rule);
    assert.ok(/transform\s*:\s*scale\(var\(--tty-sheet-k\)\)\s*var\(--tty-paper-matrix,\s*translate\(0px,\s*0px\)\)\s*;/.test(rule),
      "the sheet must keep its own scale (the width follows the column count) " +
      "and take the quad projection on top — the identity while the " +
      "Paper/Caret marker stays a plain rectangle:\n" + rule);
    assert.ok(/overflow\s*:\s*visible\s*;/.test(rule),
      "the printer block must not clip the rising sheet:\n" + rule);
    // The sheet's quad projection pivots on the block's print point, which IS
    // these two magic numbers: the pivot in TTY_QUAD_MARKERS (src/pdp11-app.js)
    // must stay the same pair, or a tilted Paper marker would rotate the sheet
    // about the wrong point.
    {
      const pivot = /pivot:\s*\[\s*(\d+),\s*(\d+)\s*\]/.exec(
        fs.readFileSync(APP_PATH, "utf8"));
      assert.ok(pivot, "TTY_QUAD_MARKERS must declare the printed sheet's pivot");
      assert.ok(rule.indexOf("- " + pivot[1] + "px * var(--tty-sheet-k)") !== -1 &&
        rule.indexOf("- " + pivot[2] + "px * var(--tty-sheet-k)") !== -1,
        "the sheet pivot (" + pivot[1] + "x" + pivot[2] + ") must be the print " +
        "point this rule positions the block by:\n" + rule);
    }
  }

  // --- Keyboard deck: native key layout, driven by the Keyboard marker ------
  // The block is anchored to the marker's TOP-LEFT corner and stretched to the
  // marker's width/height: while the artwork draws the keycaps the DOM keys are
  // invisible hit areas, so following the marker exactly is what keeps them on
  // the drawn caps.
  {
    const rule = extractRule(css, "#punchkeyboard {");
    assert.ok(/left\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-kbd-x\)\s*\)\s*;/.test(rule),
      "the keyboard must be anchored to the Keyboard marker's x:\n" + rule);
    assert.ok(/top\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-kbd-y\)\s*\)\s*;/.test(rule),
      "the keyboard must be anchored to the Keyboard marker's y:\n" + rule);
    assert.ok(/width\s*:\s*576px\s*;/.test(rule),
      "the key block must keep its native width (576px):\n" + rule);
    assert.ok(/height\s*:\s*212px\s*;/.test(rule),
      "the key block must keep its native height (212px):\n" + rule);
    assert.ok(/transform\s*:\s*var\(--tty-kbd-matrix,\s*scale\(var\(--tty-kbd-sx\),\s*var\(--tty-kbd-sy\)\)\)\s*;/.test(rule),
      "the keyboard must be projected onto a tilted Keyboard marker and fall " +
      "back to the marker fit otherwise:\n" + rule);
  }

  // --- Page-drawn keycaps keep round caps (uniform, centred fit) ------------
  {
    const rule = extractRule(css, "#punchkeyboard.m33-css-caps {");
    assert.ok(/transform\s*:\s*scale\(var\(--tty-kbd-k\)\)\s*;/.test(rule),
      "the CSS keycaps must use the uniform contain factor:\n" + rule);
    assert.ok(/var\(--tty-kbd-x\)\s*\+\s*var\(--tty-kbd-w\)\s*\/\s*2/.test(rule),
      "the CSS keycap block must be centred on the marker:\n" + rule);
  }

  // --- The deck itself is only a positioning layer -------------------------
  {
    const rule = extractRule(css, "#punchkeypane {");
    assert.ok(/position\s*:\s*absolute\s*;/.test(rule),
      "#punchkeypane must be absolutely positioned at the rig origin:\n" + rule);
    assert.ok(/left\s*:\s*0\s*;/.test(rule) && /top\s*:\s*0\s*;/.test(rule),
      "#punchkeypane must sit at the rig origin so controls use artwork coordinates:\n" + rule);
    assert.ok(/background\s*:\s*none\s*;/.test(rule),
      "the deck plastic must come from the artwork (no CSS background):\n" + rule);
  }

  // --- Punch / reader plates: native frame, anchored to their markers -------
  // Both plate frames follow their CONTROL marker: each mechanism is split into
  // the control area (its own marker) and the tape (its own marker).
  {
    const plates = [["pctrl", "punch", extractRule(css, "#asr-punch {")],
                    ["rctrl", "reader", extractRule(css, "#asr-reader {")]];
    for (const [prefix, name, rule] of plates) {
      const anchor = new RegExp(
        "left\\s*:\\s*calc\\(var\\(--tty-u\\)\\s*\\*\\s*var\\(--tty-" + prefix + "-x\\)");
      const fit = new RegExp("scale\\(var\\(--tty-" + prefix + "-k\\)\\)");
      assert.ok(anchor.test(rule),
        "the " + name + " plate must be anchored to its marker's x:\n" + rule);
      assert.ok(fit.test(rule),
        "the " + name + " plate must be contain-fitted by --tty-" + prefix + "-k:\n" + rule);
      assert.ok(/width\s*:\s*170px\s*;/.test(rule),
        "the " + name + " plate must keep its native width (170px):\n" + rule);
      assert.ok(/height\s*:\s*164px\s*;/.test(rule),
        "the " + name + " plate must keep its native height (164px):\n" + rule);
      assert.ok(/background\s*:\s*none\s*;/.test(rule),
        "the " + name + " plate plastic must come from the artwork:\n" + rule);
    }
  }

  // --- The punch button cluster left the plate: it follows its marker --------
  {
    const rule = extractRule(css, "#asr-punch-buttons {");
    assert.ok(/left\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-pctrl-x\)\s*\)\s*;/.test(rule),
      "the button cluster must be anchored to the PuncherControl marker's x:\n" + rule);
    assert.ok(/top\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-pctrl-y\)\s*\)\s*;/.test(rule),
      "the button cluster must be anchored to the PuncherControl marker's y:\n" + rule);
    assert.ok(/transform\s*:\s*var\(--tty-pctrl-matrix,\s*scale\(var\(--tty-pctrl-btn-k\)\)\)\s*;/.test(rule),
      "the cluster must take the quad projection when the page publishes one, " +
      "and fall back to the uniform width-driven fit otherwise:\n" + rule);
    assert.ok(/transform-origin\s*:\s*0\s+0\s*;/.test(rule),
      "the cluster scales from its top-left corner (marker anchored):\n" + rule);
  }

  // --- The reader switch left the plate: it follows its marker --------------
  {
    const rule = extractRule(css, ".asr-reader-switch {");
    assert.ok(/left\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-rctrl-x\)\s*\)\s*;/.test(rule),
      "the reader switch must be anchored to the ReaderControl marker's x:\n" + rule);
    assert.ok(/top\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-rctrl-y\)\s*\)\s*;/.test(rule),
      "the reader switch must be anchored to the ReaderControl marker's y:\n" + rule);
    assert.ok(/transform\s*:\s*var\(--tty-rctrl-matrix,\s*scale\(var\(--tty-rctrl-switch-k\)\)\)\s*;/.test(rule),
      "the switch must take the quad projection when the page publishes one, " +
      "and fall back to the uniform width-driven fit otherwise:\n" + rule);
    assert.ok(/transform-origin\s*:\s*0\s+0\s*;/.test(rule),
      "the switch scales from its top-left corner (marker anchored):\n" + rule);
    assert.ok(/width\s*:\s*40px\s*;/.test(rule) && /height\s*:\s*115px\s*;/.test(rule),
      "the switch must keep its native PORTRAIT 40x115 frame (the marker is a " +
      "portrait slot):\n" + rule);
    assert.ok(/--reader-lever-step\s*:/.test(rule),
      "the switch must define the step between the four lever detents:\n" + rule);
    assert.ok(/--reader-lever-i\s*:/.test(rule),
      "the switch must expose the lever detent index (--reader-lever-i):\n" + rule);
  }

  // --- The reader lever is a VERTICAL four-detent lever, not a rotary knob --
  {
    const slot = extractRule(css, ".asr-switch-slot {");
    assert.ok(/width\s*:\s*12px\s*;/.test(slot) && /height\s*:\s*107px\s*;/.test(slot),
      "the lever slot must be tall and narrow (vertical travel):\n" + slot);
    const handle = extractRule(css, ".asr-switch-handle {");
    assert.ok(/top\s*:\s*calc\(var\(--reader-lever-i\)\s*\*\s*var\(--reader-lever-step\)\)\s*;/.test(handle),
      "the handle must sit on the --reader-lever-i detent:\n" + handle);
    assert.ok(/touch-action\s*:\s*none\s*;/.test(handle),
      "the draggable handle must opt out of browser panning:\n" + handle);
    assert.ok(css.indexOf(".asr-switch-disc") === -1,
      "the old rotary reader knob (.asr-switch-disc) must be gone");
  }

  // --- CCU apron: knob + labels anchored to the Apron marker ----------------
  {
    const rule = extractRule(css, "#ccu-apron {");
    assert.ok(/left\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-apron-x\)/.test(rule),
      "the CCU block must be anchored to the Apron marker's x:\n" + rule);
    assert.ok(/top\s*:\s*calc\(var\(--tty-u\)\s*\*\s*var\(--tty-apron-y\)/.test(rule),
      "the CCU block must be anchored to the Apron marker's y:\n" + rule);
    assert.ok(/width\s*:\s*118px\s*;/.test(rule),
      "the CCU block must keep its native width (118px):\n" + rule);
    assert.ok(/height\s*:\s*66px\s*;/.test(rule),
      "the CCU block must keep its native height (66px):\n" + rule);
    assert.ok(/transform-origin\s*:\s*0\s+0\s*;/.test(rule),
      "the CCU block scales from its own corner (its anchor is the marker " +
      "centre, which is what the fallback's translate compensates):\n" + rule);
    assert.ok(/transform\s*:\s*var\(--tty-apron-matrix,\s*translate\(calc\(-59px \* var\(--tty-apron-k\)\),\s*calc\(-33px \* var\(--tty-apron-k\)\)\)\s*scale\(var\(--tty-apron-k\)\)\)\s*;/.test(rule),
      "the CCU block must be projected onto a tilted Apron marker and keep its " +
      "contain-fitted centring (half of the native 118x66 block) otherwise:\n" + rule);
    assert.ok(/background\s*:\s*none\s*;/.test(rule),
      "the apron pad must come from the artwork:\n" + rule);
  }

  // --- CCU knob: a raised two-step cylinder with dark moulded legends -------
  {
    const base = extractRule(css, ".ccu-switch::before {");
    assert.ok(/border-radius\s*:\s*50%\s*;/.test(base) &&
      /width\s*:\s*44px\s*;/.test(base) &&
      /inset\s+0\s+-3px\s+5px/.test(base),
      "the knob must stand on a WIDE moulded base (raised, not recessed):\n" + base);
    const cap = extractRule(css, ".ccu-switch-disc {");
    assert.ok(/width\s*:\s*28px\s*;/.test(cap) &&
      /inset\s+0\s+-1px\s+2px/.test(cap),
      "the CAP on top must be smaller than the base, with a flat-shaded " +
      "face:\n" + cap);
    const beak = extractRule(css, ".ccu-switch-lever {");
    assert.ok(/transform-origin\s*:\s*50%\s+22px\s*;/.test(beak),
      "the BEAK must orbit the CAP centre (the cap keeps its shading):\n" + beak);
    const pos = extractRule(css, ".ccu-switch-pos {");
    assert.ok(/color\s*:\s*#2f2a22\s*;/.test(pos) && /text-shadow\s*:/.test(pos),
      "the CCU legends must be DARK moulded lettering, as on the real " +
      "apron:\n" + pos);
    const app = fs.readFileSync(APP_PATH, "utf8");
    assert.ok(app.indexOf("document.getElementById('ccu-switch-lever')") !== -1,
      "setTtyMode must rotate the beak, not the knob");
  }

  // --- Paper draws in front of the platen ----------------------------------
  {
    const rule = extractRule(css, "#g60printer div#paper {");
    assert.ok(/z-index\s*:\s*4\s*;/.test(rule),
      "the paper must pass in front of the platen opening (z-index 4):\n" + rule);
  }

  // --- Keycap layout switch: artwork caps (default) vs CSS caps ------------
  // With the default layout the caps and legends belong to the artwork, so the
  // DOM keys must be invisible hit areas in the same boxes (the flat grid in
  // src/pdp11-app.js); the CONFIG option adds .m33-css-caps and the CSS caps
  // draw themselves again.
  {
    const rule = extractRule(css, "#punchkeyboard:not(.m33-css-caps) .m33-key,");
    assert.ok(/background\s*:\s*none\s*;/.test(rule),
      "artwork-caps mode must drop the keycap plastic:\n" + rule);
    assert.ok(/box-shadow\s*:\s*none\s*;/.test(rule),
      "artwork-caps mode must drop the keycap side wall:\n" + rule);
    assert.ok(/cursor\s*:\s*pointer\s*;/.test(rule),
      "the invisible key must keep a pointer cursor:\n" + rule);
  }
  {
    const rule = extractRule(css, "#punchkeyboard:not(.m33-css-caps) .m33-key.down,");
    assert.ok(/transform\s*:\s*none\s*;/.test(rule),
      "artwork-caps mode has nothing to sink when a key is pressed:\n" + rule);
    assert.ok(/box-shadow\s*:\s*none\s*;/.test(rule),
      "artwork-caps mode has no side wall to collapse:\n" + rule);
  }
  {
    const rule = extractRule(css, "#punchkeyboard:not(.m33-css-caps) .m33-key .m33-top,");
    assert.ok(/visibility\s*:\s*hidden\s*;/.test(rule),
      "the legends must come from the artwork in artwork-caps mode:\n" + rule);
  }
  {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    assert.ok(html.indexOf('id="config-field-keyboardLayout"') !== -1,
      "the CONFIG page must offer the keycap layout field");
    for (const value of ["drawn", "grid"]) {
      assert.ok(html.indexOf('name="keyboardLayout" value="' + value + '"') !== -1,
        "the CONFIG page must offer the '" + value + "' keycap layout");
    }
    assert.ok(html.indexOf("m33-css-caps") === -1,
      "the markup must not hardcode the layout class — the default is the artwork caps");
  }

  // --- Flat-top cylindrical keycaps ----------------------------------------
  {
    const rule = extractRule(css, "#punchkeyboard .m33-key {");
    assert.ok(/background\s*:\s*radial-gradient\(circle at 35%\s+35%,\s*#6e6458\s*0%,\s*#403830\s*100%\)\s*;/.test(rule),
      "keycaps must use the brown radial gradient #6e6458→#403830:\n" + rule);
    assert.ok(/border\s*:\s*none\s*;/.test(rule),
      "keycaps must not draw a border (the side wall is the box-shadow):\n" + rule);
    assert.ok(/box-shadow\s*:\s*0\s+4px\s+0\s+#241f1a\s*,/.test(rule),
      "keycaps must have a solid dark side wall (box-shadow: 0 4px 0 #241f1a):\n" + rule);
    assert.ok(!/#757a81/.test(rule),
      "keycaps must NOT use the old domed grey #757a81:\n" + rule);
  }

  // --- Pressed state collapses the side wall -------------------------------
  {
    const rule = extractRule(css, "#punchkeyboard .m33-key.down {");
    assert.ok(/transform\s*:\s*translateY\(4px\)\s*;/.test(rule),
      "a pressed keycap must sink by 4px:\n" + rule);
    assert.ok(/0\s+0\s+0\s+#241f1a\s*,/.test(rule),
      "a pressed keycap must collapse its side wall (0 0 0 #241f1a):\n" + rule);
  }

  // --- Space bar follows the same cylinder style ---------------------------
  {
    const rule = extractRule(css, "#punchkeyboard .m33-space {");
    assert.ok(/0\s+4px\s+0\s+#241f1a\s*,/.test(rule),
      "the space bar must have the same solid side wall (0 4px 0 #241f1a):\n" + rule);
  }
  {
    const rule = extractRule(css, "#punchkeyboard .m33-space.down {");
    assert.ok(/transform\s*:\s*translateY\(4px\)\s*;/.test(rule),
      "a pressed space bar must sink by 4px:\n" + rule);
  }

  console.log("teletype-cabinet-css: all tests passed");
}

run();
