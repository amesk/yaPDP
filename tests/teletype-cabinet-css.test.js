#!/usr/bin/env node
/**
 * Model 33 ASR cabinet + keycaps — CSS contract tests.
 *
 * Guards css/g60printer.css so the console teletype keeps the two visual
 * improvements adopted from the competing `try.html` mockup:
 *   1. The sand-beige cabinet tone (#d1b48c) applied to the printer body,
 *      the keyboard deck and the ASR tape unit.
 *   2. The flat-top cylindrical keycaps: a radial highlight over a solid
 *      dark side wall (box-shadow: 0 4px 0 #241f1a) that collapses when the
 *      key is pressed (translateY(4px) on the .down state).
 *
 * These are deliberately simple string checks on the production CSS so a
 * future "simplification" back to the cream body / domed caps is caught.
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

function run() {
  const css = fs.readFileSync(CSS_PATH, "utf8");

  // --- Sand cabinet tone on the printer body ------------------------------
  {
    const rule = extractRule(css, "#g60printer {");
    assert.ok(/background-color\s*:\s*#d1b48c\s*;/.test(rule),
      "the printer body must use the sand-beige #d1b48c:\n" + rule);
    assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(rule),
      "the printer body border must use the sand border #a68c66:\n" + rule);
    assert.ok(!/background-color\s*:\s*#ddd6c4\s*;/.test(rule),
      "the printer body must NOT use the old cream #ddd6c4:\n" + rule);
  }

  // --- Lower face plate ends where the right skin begins --------------------
  {
    const rule = extractRule(css, "#g60printer div#printer_frontpannel {");
    // right skin starts at left:742px, face plate at left:67px → width 675px,
    // so the plate meets the side skin in a clean seam instead of tucking
    // under it.
    assert.ok(/width\s*:\s*675px\s*;/.test(rule),
      "the lower face plate must end where the right skin begins (width 675px):\n" + rule);
    assert.ok(/left\s*:\s*67px\s*;/.test(rule),
      "the lower face plate must start after the left skin (left 67px):\n" + rule);
  }

  // --- Black paper slot + layering ------------------------------------------
  {
    const rule = extractRule(css, "#g60printer div#printer::after {");
    assert.ok(/top\s*:\s*305px\s*;/.test(rule),
      "the paper slot's bottom must sit at the top of the lower face plate (top 305px):\n" + rule);
    assert.ok(/height\s*:\s*22px\s*;/.test(rule),
      "the paper slot must be 22px tall (centre on the carriage line at 316px):\n" + rule);
    assert.ok(/background\s*:\s*#0a0a0a\s*;/.test(rule),
      "the paper slot must be near-black (#0a0a0a):\n" + rule);
    assert.ok(/width\s*:\s*675px\s*;/.test(rule),
      "the paper slot must end where the right skin begins (width 675px):\n" + rule);
    assert.ok(/z-index\s*:\s*3\s*;/.test(rule),
      "the paper slot must draw above the face plate (z-index 3):\n" + rule);
  }
  {
    // The paper must pass IN FRONT of the slot (paper z-index above the slot's 3).
    const rule = extractRule(css, "#g60printer div#paper {");
    assert.ok(/z-index\s*:\s*4\s*;/.test(rule),
      "the paper must pass in front of the paper slot (z-index 4):\n" + rule);
  }

  // --- Sand keyboard deck --------------------------------------------------
  {
    const rule = extractRule(css, "#punchkeypane {");
    assert.ok(/background\s*:\s*linear-gradient\(180deg,\s*#d6bd99\s*0%,\s*#bfa67e\s*100%\)\s*;/.test(rule),
      "the keyboard deck must use the sand gradient #d6bd99→#bfa67e:\n" + rule);
    assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(rule),
      "the keyboard deck border must use #a68c66:\n" + rule);
  }

  // --- Sand ASR tape-unit cabinet ------------------------------------------
  {
    const rule = extractRule(css, "#asr-tape-unit {");
    assert.ok(/background-color\s*:\s*#d1b48c\s*;/.test(rule),
      "the ASR cabinet must use the sand-beige #d1b48c:\n" + rule);
    assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(rule),
      "the ASR cabinet border must use #a68c66:\n" + rule);
  }

  // --- Punch / reader use the same cream surface + shadow as LINE/OFF/LOCAL --
  {
    const punch = extractRule(css, "#asr-punch {");
    assert.ok(/#ddd6c4/.test(punch) && /#ccc5b0/.test(punch),
      "the punch block must use the cream gradient (#ddd6c4→#ccc5b0) like #ccu-apron:\n" + punch);
    assert.ok(/box-shadow\s*:[\s\S]*0\s+1px\s+3px\s+rgba\(0,\s*0,\s*0,\s*0\.35\)\s*;/.test(punch),
      "the punch block must carry the same drop shadow as #ccu-apron:\n" + punch);
    const reader = extractRule(css, "#asr-reader {");
    assert.ok(/#ddd6c4/.test(reader) && /#ccc5b0/.test(reader),
      "the reader block must use the cream gradient (#ddd6c4→#ccc5b0) like #ccu-apron:\n" + reader);
    assert.ok(/box-shadow\s*:[\s\S]*0\s+1px\s+3px\s+rgba\(0,\s*0,\s*0,\s*0\.35\)\s*;/.test(reader),
      "the reader block must carry the same drop shadow as #ccu-apron:\n" + reader);
  }

  // --- Sand top cover dome (two rounded corners) ---------------------------
  {
    const rule = extractRule(css, "#g60printer::before {");
    assert.ok(/background\s*:\s*linear-gradient\(180deg,\s*#e3cdaa\s*0%,\s*#d6bb95\s*60%,\s*#c6a87e\s*100%\)\s*;/.test(rule),
      "the top cover dome must use the sand gradient #e3cdaa→#d6bb95→#c6a87e:\n" + rule);
    assert.ok(/border\s*:\s*1px\s+solid\s+#a68c66\s*;/.test(rule),
      "the top cover dome border must use #a68c66:\n" + rule);
    assert.ok(!/#f2ecdc/.test(rule),
      "the top cover dome must NOT use the old cream #f2ecdc:\n" + rule);
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
