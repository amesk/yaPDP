#!/usr/bin/env node
/**
 * Model 33 ASR console paper — CSS contract tests.
 *
 * Guards css/g60printer.css so the console teletype paper keeps the LP11-style
 * growth behaviour: anchored to the carriage (bottom), growing upward
 * (height:auto) up to a viewport-driven max-height (--tty-paper-max), with its
 * own scrollbar, the Google60 top spacer and paper-edge overlays hidden and the
 * print-area top padding dropped so line 1 lands right on the carriage.
 *
 * These are deliberately simple string checks on the production CSS so a
 * future "simplification" back to the fixed 400px paper (or a reintroduced
 * 345px top spacer) is caught.
 *
 * Run with:  node tests/teletype-paper-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");

// Extract a top-level CSS rule body given the selector prefix. `last` picks
// the LAST matching rule: the teletype growth block sits at the end of the
// file and must win the cascade over the base rules earlier in the sheet.
function extractRule(css, selectorStart, last) {
  const idx = last
    ? css.lastIndexOf(selectorStart)
    : css.indexOf(selectorStart);
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

  // --- #g60printer must let the rising paper leave the machine body ---------
  {
    const rule = extractRule(css, "#g60printer {", true);
    assert.ok(/overflow\s*:\s*visible\s*;/.test(rule),
      "#g60printer must be overflow: visible so the paper can rise out of it:\n" + rule);
    assert.ok(!/overflow\s*:\s*hidden\s*;/.test(rule),
      "#g60printer must NOT clip the rising paper with overflow: hidden:\n" + rule);
  }

  // --- #g60printer div#paper must be anchored to the carriage and grow -----
  {
    const rule = extractRule(css, "#g60printer div#paper,");
    assert.ok(/top\s*:\s*auto\s*;/.test(rule),
      "paper must be top:auto (bottom-anchored):\n" + rule);
    assert.ok(/bottom\s*:\s*64px\s*;/.test(rule),
      "paper must be bottom:64px (carriage stays at 400px):\n" + rule);
    assert.ok(/height\s*:\s*auto\s*;/.test(rule),
      "paper must grow with its content (height:auto):\n" + rule);
    assert.ok(/max-height\s*:\s*var\(--tty-paper-max,\s*400px\)\s*;/.test(rule),
      "paper max-height must be driven by --tty-paper-max:\n" + rule);
    assert.ok(/overflow-y\s*:\s*auto\s*;/.test(rule),
      "paper must have its own scrollbar (overflow-y:auto):\n" + rule);
    assert.ok(/overflow-x\s*:\s*hidden\s*;/.test(rule),
      "paper must not scroll horizontally:\n" + rule);
  }

  // --- Top spacer must be gone (no blank paper tail above line 1) -----------
  {
    const rule = extractRule(css, "#g60printer div#paper_topspacer", true);
    assert.ok(/display\s*:\s*none\s*;/.test(rule),
      "the 345px top spacer must be hidden:\n" + rule);
  }

  // --- Print-area top padding dropped so line 1 lands on the carriage -------
  {
    const rule = extractRule(css, "#g60printer td#paper_printarea {", true);
    assert.ok(/padding\s*:\s*4px\s*18px\s*1px\s*18px\s*;/.test(rule),
      "print-area top padding must be 4px:\n" + rule);
  }

  // --- Paper-edge overlays hidden (they would draw over the rising paper) ---
  {
    const rule = extractRule(css, "#g60printer div#printer_topoverlay,", true);
    assert.ok(/display\s*:\s*none\s*;/.test(rule),
      "the top paper-edge overlays must be hidden:\n" + rule);
  }

  // --- Cascade order: the growth block must come after the base 400px rule ---
  {
    const base = css.indexOf("#g60printer div#paper {");
    const growth = css.indexOf("#g60printer div#paper,");
    assert.ok(base !== -1, "base #g60printer div#paper rule must exist");
    assert.ok(growth !== -1 && growth > base,
      "the growth rule must come AFTER the base 400px rule to win the cascade");
  }

  console.log("teletype-paper-css: all tests passed");
}

run();
