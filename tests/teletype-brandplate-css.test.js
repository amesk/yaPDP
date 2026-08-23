#!/usr/bin/env node
/**
 * Model 33 ASR console brand plate — CSS contract tests.
 *
 * Guards css/g60printer.css so the console teletype's lower face plate carries
 * the authentic Teletype Corporation wordmark (drawn from
 * assets/images/teletype-corp-logo.svg) instead of a "MODEL 33 ASR" text label
 * — matching historical photos of the Model 33 ASR cabinet.
 *
 * These are deliberately simple string checks on the production CSS (and on the
 * logo asset) so a future "simplification" back to the text label is caught.
 *
 * Run with:  node tests/teletype-brandplate-css.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");
const LOGO_PATH = path.join(__dirname, "..", "assets", "images", "teletype-corp-logo.svg");

// Extract a top-level CSS rule body given the selector prefix.
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

  // --- The logo asset the brand plate draws must exist -------------------
  assert.ok(fs.existsSync(LOGO_PATH),
    "assets/images/teletype-corp-logo.svg must exist next to the brand-plate rule");

  // --- The front-panel brand plate must use the logo, not a text label ----
  {
    const rule = extractRule(css, "#g60printer div#printer_frontpannel::after {");
    assert.ok(!/content\s*:\s*["']MODEL 33 ASR["']\s*;/.test(rule),
      "the front-panel brand plate must NOT carry the 'MODEL 33 ASR' text label:\n" + rule);
    assert.ok(/background-image\s*:\s*url\(['"]\.\.\/assets\/images\/teletype-corp-logo\.svg['"]\)\s*;/.test(rule),
      "the brand plate must draw the Teletype Corporation logo:\n" + rule);
    assert.ok(/background-size\s*:\s*contain\s*;/.test(rule),
      "the logo must scale to fit the plate (background-size: contain):\n" + rule);
    assert.ok(/background-repeat\s*:\s*no-repeat\s*;/.test(rule),
      "the logo must not tile across the plate:\n" + rule);
  }

  // --- No "MODEL 33 ASR" text label anywhere in the console CSS ----------
  {
    assert.ok(!/content\s*:\s*["']MODEL 33 ASR["']\s*;/.test(css),
      "the console CSS must not contain any 'MODEL 33 ASR' text label");
  }

  console.log("teletype-brandplate-css: all tests passed");
}

run();
