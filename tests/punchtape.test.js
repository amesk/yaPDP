#!/usr/bin/env node
/**
 * Model 33 ASR paper-tape punch tests.
 *
 * Two layers:
 *   1. Modular: extracts the pure encodePunch() helper straight from the real
 *      source (src/punchtape.js) and verifies the 8-track ASCII encoding.
 *   2. Structural: string checks on the production markup (pdp11.html) and CSS
 *      (css/g60printer.css) guarding that the ASR tape unit (reader + punch)
 *      and the scrollable #punchtape window exist and are styled.
 *
 * The tape is encoded from the actual 7-bit ASCII codes (track 1 = LSB),
 * track 8 left unpunched (parity track), a feed hole always between tracks
 * 3 and 4. This keeps the pattern consistent (unlike a hand-written table:
 * e.g. '0' vs '8' must differ, DEL punches all seven tracks, SPACE punches
 * its bit 6).
 *
 * Run with:  node tests/punchtape.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "punchtape.js");
const HTML_PATH = path.join(__dirname, "..", "pdp11.html");
const CSS_PATH = path.join(__dirname, "..", "css", "g60printer.css");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
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
      if (depth === 0) {
        if (tail) {
          const rest = src.slice(i + 1, i + 1 + tail.length);
          if (rest !== tail) {
            throw new Error("expected tail '" + tail + "' after " + startMarker);
          }
          return src.slice(start, i + 1 + tail.length);
        }
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

function loadEncodePunch() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const fn = extractBlock(src, "function encodePunch", "");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.encode = encodePunch;", sandbox);
  return sandbox.encode;
}

// Compare track-by-track with strictEqual: deepStrictEqual would fail because
// the helper runs in an isolated VM realm and its array prototype differs
// from the main realm's Array.prototype even though the values are identical.
function assertTracks(actual, expected, desc) {
  assert.strictEqual(actual.length, expected.length, desc + ": length");
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(actual[i], expected[i], desc + ": track " + (i + 1));
  }
}

function testEncode() {
  const encode = loadEncodePunch();

  const cases = [
    // [description, code, expected tracks Д1..Д8]
    ["A (0x41)", 0x41, [1, 0, 0, 0, 0, 0, 1, 0]],
    ["1 (0x31)", 0x31, [1, 0, 0, 0, 1, 1, 0, 0]],
    ["0 (0x30)", 0x30, [0, 0, 0, 0, 1, 1, 0, 0]],
    ["8 (0x38) must differ from '0'", 0x38, [0, 0, 0, 1, 1, 1, 0, 0]],
    ["9 (0x39)", 0x39, [1, 0, 0, 1, 1, 1, 0, 0]],
    ["LF (0x0A)", 0x0a, [0, 1, 0, 1, 0, 0, 0, 0]],
    ["CR (0x0D)", 0x0d, [1, 0, 1, 1, 0, 0, 0, 0]],
    ["SPACE (0x20) punches its bit 6", 0x20, [0, 0, 0, 0, 0, 1, 0, 0]],
    ["DEL (0x7F) punches all seven tracks", 0x7f, [1, 1, 1, 1, 1, 1, 1, 0]],
  ];

  for (const [desc, code, expected] of cases) {
    assertTracks(encode(code), expected, "encodePunch(" + desc + ")");
  }

  // Track 8 (parity) must always be unpunched for any byte in 0..127.
  for (let c = 0; c < 128; c++) {
    const t = encode(c);
    assert.strictEqual(t.length, 8, "encodePunch must return 8 tracks");
    assert.strictEqual(t[7], 0, "track 8 must be unpunched for code " + c);
  }

  console.log("punchtape-encode: OK (" + cases.length + " known patterns + full 0..127 sweep)");
}

// ------------------------------------------------------------------
// Structural checks: the ASR tape unit markup and CSS.
// ------------------------------------------------------------------
function testMarkup() {
  const html = fs.readFileSync(HTML_PATH, "utf8");

  assert.ok(html.indexOf('id="asr-tape-unit"') !== -1,
    "pdp11.html must contain the ASR tape unit (#asr-tape-unit)");
  assert.ok(html.indexOf('id="asr-mech"') !== -1,
    "pdp11.html must contain the reader+punch row (#asr-mech)");
  assert.ok(html.indexOf('id="asr-reader"') !== -1,
    "pdp11.html must contain the tape reader (#asr-reader)");
  assert.ok(html.indexOf('id="asr-punch"') !== -1,
    "pdp11.html must contain the tape punch (#asr-punch)");
  assert.ok(html.indexOf('id="punchtape"') !== -1,
    "pdp11.html must contain the hanging tape (#punchtape)");
  assert.ok(html.indexOf('id="teletype-controls"') !== -1,
    "pdp11.html must contain the operator controls panel (#teletype-controls)");
  for (const id of ["tty-tear-tape", "tty-tear-paper", "tty-save-tape"]) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1,
      "pdp11.html must contain the operator button (#" + id + ")");
  }
  // CCU (Call Control Unit) rotary line switch (LINE/OFF/LOCAL) on the apron
  // right of the keyboard, replacing the old LOCAL/LINE push-buttons.
  assert.ok(html.indexOf('id="ccu-switch-lever"') !== -1,
    "pdp11.html must contain the CCU switch lever (#ccu-switch-lever)");
  for (const mode of ["line", "off", "local"]) {
    assert.ok(html.indexOf('data-tty-mode="' + mode + '"') !== -1,
      "pdp11.html must contain the CCU switch position '" + mode + "'");
  }
  assert.ok(html.indexOf('id="tty-local"') === -1,
    "pdp11.html must NOT contain the removed #tty-local button");
  assert.ok(html.indexOf('id="tty-line"') === -1,
    "pdp11.html must NOT contain the removed #tty-line button");
  // Punch operator buttons (ON/OFF/BSP/REL) on the TAPE PUNCH cabinet.
  for (const id of ["punch-on", "punch-off", "punch-bsp", "punch-rel"]) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1,
      "pdp11.html must contain the punch button (#" + id + ")");
  }
  // The punch buttons must be in the historical 2x2 order (REL OFF on the
  // top row, BSP ON below) — the DOM order wraps into the two rows.
  {
    const ids = ["punch-rel", "punch-off", "punch-bsp", "punch-on"];
    const pos = ids.map((id) => html.indexOf('id="' + id + '"'));
    assert.ok(pos.every((p) => p !== -1) &&
        pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3],
      "punch buttons must be ordered REL/OFF/BSP/ON (2x2: REL OFF over BSP ON)");
  }
  // Four-position reader switch (START/STOP/FREE/AUTO) on the TAPE READER.
  assert.ok(html.indexOf('id="reader-switch-lever"') !== -1,
    "pdp11.html must contain the reader switch lever (#reader-switch-lever)");
  for (const mode of ["start", "stop", "free", "auto"]) {
    assert.ok(html.indexOf('data-reader-mode="' + mode + '"') !== -1,
      "pdp11.html must contain the reader switch position '" + mode + "'");
  }
  assert.ok(html.indexOf("src='src/punchtape.js'") !== -1,
    "pdp11.html must load src/punchtape.js");

  console.log("punchtape-markup: OK (ASR tape unit present in pdp11.html)");
}

function testCss() {
  const css = fs.readFileSync(CSS_PATH, "utf8");

  for (const selector of [
    "#teletype-rig",
    "#asr-tape-unit",
    "#asr-reader",
    "#asr-punch",
    "#punchtape",
    "#teletype-controls",
    ".tty-btn",
    "#ccu-apron",
    ".ccu-switch",
    ".ccu-switch-disc",
    ".ccu-switch-lever",
    ".ccu-switch-pos",
    ".asr-punch-buttons",
    ".asr-btn",
    ".asr-btn.active",
    ".asr-reader-switch",
    ".asr-switch-pos",
    ".asr-switch-lever",
    ".pt-row",
    ".pt-hole",
    ".pt-sprocket",
  ]) {
    assert.ok(css.indexOf(selector + " {") !== -1,
      "css/g60printer.css must define '" + selector + "'");
  }

  // The LOCAL/LINE buttons were replaced by the CCU rotary switch, so the
  // old `.tty-btn.active` accent rule must be gone.
  assert.ok(css.indexOf(".tty-btn.active") === -1,
    "css/g60printer.css must NOT define the removed .tty-btn.active (LOCAL/LINE buttons are gone)");

  // The cabinet must be reader+punch only and let the tape hang past it.
  {
    const unitRule = extractBlock(css, "#asr-tape-unit {", "");
    assert.ok(/align-self\s*:\s*flex-start\s*;/.test(unitRule),
      "#asr-tape-unit must not stretch (flex-start) so the tape hangs below:\n" + unitRule);
    assert.ok(/overflow\s*:\s*visible\s*;/.test(unitRule),
      "#asr-tape-unit must NOT clip the hanging tape (overflow: visible):\n" + unitRule);
  }

  // The punch must sit ABOVE the reader, as on the historical machine.
  {
    const mechRule = extractBlock(css, "#asr-mech {", "");
    assert.ok(/flex-direction\s*:\s*column\s*;/.test(mechRule),
      "#asr-mech must stack the punch ABOVE the reader (flex-direction: column):\n" + mechRule);
  }

  // The tape must be absolutely positioned (out of the flow, so the page
  // never resizes) hanging from the bottom of the cabinet, and scroll itself
  // once it reaches the bottom of the window.
  const tapeRule = extractBlock(css, "#punchtape {", "");
  assert.ok(/position\s*:\s*absolute\s*;/.test(tapeRule),
    "#punchtape must be absolutely positioned (out of flow, no page resize):\n" + tapeRule);
  assert.ok(/top\s*:\s*112px\s*;/.test(tapeRule),
    "#punchtape must emerge from the MIDDLE of the TAPE PUNCH slot (top: 112px = slot top 106px + half slot 6px):\n" + tapeRule);
  assert.ok(/overflow-y\s*:\s*auto\s*;/.test(tapeRule),
    "#punchtape must scroll vertically once it reaches the window edge (overflow-y: auto):\n" + tapeRule);

  console.log("punchtape-css: OK (tape unit + hanging scrollable tape styled)");
}

testEncode();
testMarkup();
testCss();
