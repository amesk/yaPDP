#!/usr/bin/env node
/**
 * Model 33 ASR keyboard — pure helper modular tests.
 *
 * Extracts the pure DOM-free helpers straight from the real source
 * (src/pdp11-app.js) so the test exercises the production mapping rather
 * than a copy, then runs them in an isolated VM context:
 *
 *   - model33KeyCode(def, state): maps a Model 33 key definition plus the
 *     current modifier state (shifted/ctrl) to the byte it transmits.
 *     Base glyphs, SHIFT symbols (digit row, N, M, `,`, `.`, `/`, `;`),
 *     CTRL control codes (DC1..STX) and special-key tokens are covered.
 *   - model33StickyMods(mods, def): the sticky-modifier state transition —
 *     CTRL/SHIFT latch when pressed (a second press does NOT cancel) and
 *     any other key releases both latches.
 *   - m33EchoPunches(code): whether the console print path punches the byte
 *     itself (printable + BS/TAB/LF/FF/CR); the keyboard transmit punch uses
 *     this to avoid double-punching and covers the dropped control codes.
 *   - model33UpperOnly(ch, upperCaseOnly): folds lower-case letters to
 *     upper case when the physical-keyboard Upper-Case-Only flag is set.
 *
 * Run with:  node tests/model33-keyboard.test.js
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

function loadHelpers() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  const code =
    extractBlock(src, "function model33KeyCode") + "\n" +
    extractBlock(src, "function model33StickyMods") + "\n" +
    extractBlock(src, "function m33EchoPunches") + "\n" +
    extractBlock(src, "function model33UpperOnly") + "\n" +
    "; this.m33 = { keyCode: model33KeyCode, stickyMods: model33StickyMods, echoPunches: m33EchoPunches, upperOnly: model33UpperOnly };";
  vm.runInContext(code, sandbox);
  return sandbox.m33;
}

// Replicate the production key-definition shapes (they are plain data in
// src/pdp11-app.js; building them here keeps the assertions readable).
function letter(label, ctrlName, ctrlCode) {
  return { label, code: label.charCodeAt(0), top: ctrlName, ctrlCode, cls: "alpha" };
}
function shifted(label, shiftLabel, shiftCode) {
  return { label, code: label.charCodeAt(0), top: shiftLabel, shiftCode, cls: "alpha" };
}
function both(label, shiftLabel, shiftCode, ctrlName, ctrlCode) {
  return { label, code: label.charCodeAt(0), shiftLabel, shiftCode,
    ctrlLabel: ctrlName, ctrlCode, cls: "alpha" };
}
function plain(label) {
  return { label, code: label.charCodeAt(0), cls: "alpha" };
}
function special(label, token, code) {
  return { label, special: token, code, cls: "mod" };
}

function run() {
  const { keyCode, stickyMods, echoPunches, upperOnly } = loadHelpers();
  const none = { shifted: false, ctrl: false };
  const ctrl = { shifted: false, ctrl: true };
  const shft = { shifted: true, ctrl: false };

  // --- Base (unmodified) codes --------------------------------------
  // Upper-case letters, 0x41-0x5A (Upper Case Only).
  for (let c = 0x41; c <= 0x5A; c++) {
    const def = letter(String.fromCharCode(c), null, null);
    assert.strictEqual(keyCode(def, none), c,
      "base code of letter " + String.fromCharCode(c));
  }
  // Digit / punctuation row.
  assert.strictEqual(keyCode(plain("1"), none), 0x31);
  assert.strictEqual(keyCode(plain("0"), none), 0x30);
  assert.strictEqual(keyCode(plain(":"), none), 0x3A);
  assert.strictEqual(keyCode(plain("-"), none), 0x2D);
  assert.strictEqual(keyCode(plain(";"), none), 0x3B);
  assert.strictEqual(keyCode(plain(","), none), 0x2C);
  assert.strictEqual(keyCode(plain("."), none), 0x2E);
  assert.strictEqual(keyCode(plain("/"), none), 0x2F);
  // Punctuation shift variants never leak into the base.
  assert.strictEqual(keyCode(shifted("1", "!", 0x21), none), 0x31);
  assert.strictEqual(keyCode(shifted("-", "=", 0x3D), none), 0x2D);

  // --- SHIFT symbols -------------------------------------------------
  assert.strictEqual(keyCode(shifted("1", "!", 0x21), shft), 0x21);
  assert.strictEqual(keyCode(shifted("2", '"', 0x22), shft), 0x22);
  assert.strictEqual(keyCode(shifted("3", "#", 0x23), shft), 0x23);
  assert.strictEqual(keyCode(shifted("4", "$", 0x24), shft), 0x24);
  assert.strictEqual(keyCode(shifted("5", "%", 0x25), shft), 0x25);
  assert.strictEqual(keyCode(shifted("6", "&", 0x26), shft), 0x26);
  assert.strictEqual(keyCode(shifted("7", "'", 0x27), shft), 0x27);
  assert.strictEqual(keyCode(shifted("8", "(", 0x28), shft), 0x28);
  assert.strictEqual(keyCode(shifted("9", ")", 0x29), shft), 0x29);
  assert.strictEqual(keyCode(shifted(":", "*", 0x2A), shft), 0x2A);
  assert.strictEqual(keyCode(shifted("-", "=", 0x3D), shft), 0x3D);
  assert.strictEqual(keyCode(shifted(";", "+", 0x2B), shft), 0x2B);
  assert.strictEqual(keyCode(shifted("N", "^", 0x5E), shft), 0x5E);
  assert.strictEqual(keyCode(shifted("M", "]", 0x5D), shft), 0x5D);
  assert.strictEqual(keyCode(shifted(",", "<", 0x3C), shft), 0x3C);
  assert.strictEqual(keyCode(shifted(".", ">", 0x3E), shft), 0x3E);
  assert.strictEqual(keyCode(shifted("/", "?", 0x3F), shft), 0x3F);
  // A key with no SHIFT variant (e.g. the 0 key) stays on its base code.
  assert.strictEqual(keyCode(plain("0"), shft), 0x30);

  // --- CTRL control codes ---------------------------------------------
  const ctrlMap = {
    Q: 0x11, W: 0x17, E: 0x05, R: 0x12, T: 0x14,
    Y: 0x19, U: 0x15, I: 0x09, O: 0x0F, P: 0x10,
    A: 0x01, S: 0x13, D: 0x04, F: 0x06, G: 0x07,
    H: 0x08, J: 0x0A, K: 0x0B, L: 0x0C,
    Z: 0x1A, X: 0x18, C: 0x03, V: 0x16, B: 0x02
  };
  Object.keys(ctrlMap).forEach(function (ch) {
    const def = letter(ch, "name", ctrlMap[ch]);
    assert.strictEqual(keyCode(def, ctrl), ctrlMap[ch], "CTRL+" + ch);
    assert.strictEqual(keyCode(def, none), ch.charCodeAt(0), "plain " + ch);
  });
  // CTRL takes precedence over SHIFT when both are held.
  assert.strictEqual(keyCode(letter("Q", "DC1", 0x11),
    { shifted: true, ctrl: true }), 0x11);

  // --- Triple-named keys (shift symbol + CTRL code on the same cap) ----
  // P @ DLE, K [ VT, N ^ SO, M ] CR: base stays plain, SHIFT gives the
  // symbol, CTRL gives the control code; CTRL wins when both are held.
  assert.strictEqual(keyCode(both("P", "@", 0x40, "DLE", 0x10), none), 0x50);
  assert.strictEqual(keyCode(both("P", "@", 0x40, "DLE", 0x10), shft), 0x40);
  assert.strictEqual(keyCode(both("P", "@", 0x40, "DLE", 0x10), ctrl), 0x10);
  assert.strictEqual(keyCode(both("K", "[", 0x5B, "VT", 0x0B), shft), 0x5B);
  assert.strictEqual(keyCode(both("K", "[", 0x5B, "VT", 0x0B), ctrl), 0x0B);
  assert.strictEqual(keyCode(both("N", "^", 0x5E, "SO", 0x0E), shft), 0x5E);
  assert.strictEqual(keyCode(both("N", "^", 0x5E, "SO", 0x0E), ctrl), 0x0E);
  assert.strictEqual(keyCode(both("M", "]", 0x5D, "CR", 0x0D), shft), 0x5D);
  assert.strictEqual(keyCode(both("M", "]", 0x5D, "CR", 0x0D), ctrl), 0x0D);
  assert.strictEqual(keyCode(both("K", "[", 0x5B, "VT", 0x0B),
    { shifted: true, ctrl: true }), 0x0B, "CTRL beats SHIFT on K");

  // --- Special keys return their token ---------------------------------
  assert.strictEqual(keyCode(special("ESC", "esc", 0x1B), none), "esc");
  assert.strictEqual(keyCode(special("LINE FEED", "lf", 0x0A), none), "lf");
  assert.strictEqual(keyCode(special("RETURN", "cr", 0x0D), none), "cr");
  assert.strictEqual(keyCode(special("DELETE", "del", 0x7F), none), "del");
  assert.strictEqual(keyCode({ space: true, special: "space", code: 0x20 }, none), "space");
  assert.strictEqual(keyCode(special("CTRL", "ctrl", null), none), "ctrl");
  assert.strictEqual(keyCode(special("SHIFT", "shift", null), none), "shift");
  assert.strictEqual(keyCode(special("REPT", "rept", null), none), "rept");
  assert.strictEqual(keyCode(special("BREAK", "break", null), none), "break");
  assert.strictEqual(keyCode(special("HERE IS", "hereis", null), none), "hereis");
  // Defensive: a missing/empty def never crashes the mapper.
  assert.strictEqual(keyCode(null, none), null);

  // --- Sticky CTRL/SHIFT latch -----------------------------------------
  // The helper runs in a VM realm, so deepStrictEqual on its result objects
  // would trip on the sandbox prototype; re-wrap the primitive fields here.
  function stickyFields(state, def) {
    const s = stickyMods(state, def);
    return { shifted: !!s.shifted, ctrl: !!s.ctrl };
  }
  // Pressing CTRL latches it; a second press does NOT cancel the latch.
  assert.deepStrictEqual(stickyFields(none, special("CTRL", "ctrl", null)),
    { shifted: false, ctrl: true }, "CTRL latches");
  assert.deepStrictEqual(stickyFields({ shifted: false, ctrl: true }, special("CTRL", "ctrl", null)),
    { shifted: false, ctrl: true }, "second CTRL press does not cancel");
  // Pressing SHIFT latches it; a second press does NOT cancel the latch.
  assert.deepStrictEqual(stickyFields(none, special("SHIFT", "shift", null)),
    { shifted: true, ctrl: false }, "SHIFT latches");
  assert.deepStrictEqual(stickyFields({ shifted: true, ctrl: false }, special("SHIFT", "shift", null)),
    { shifted: true, ctrl: false }, "second SHIFT press does not cancel");
  // Either modifier can be added on top of the other (CTRL+SHIFT combined).
  assert.deepStrictEqual(stickyFields({ shifted: false, ctrl: true }, special("SHIFT", "shift", null)),
    { shifted: true, ctrl: true }, "SHIFT adds to a latched CTRL");
  assert.deepStrictEqual(stickyFields({ shifted: true, ctrl: false }, special("CTRL", "ctrl", null)),
    { shifted: true, ctrl: true }, "CTRL adds to a latched SHIFT");
  // Any other key (character or function key) trips both latches.
  assert.deepStrictEqual(stickyFields({ shifted: true, ctrl: true }, plain("A")),
    { shifted: false, ctrl: false }, "character key releases both latches");
  ["esc", "lf", "cr", "del", "space", "break", "hereis"].forEach(function (token) {
    assert.deepStrictEqual(stickyFields({ shifted: true, ctrl: true }, special("F", token, null)),
      { shifted: false, ctrl: false }, "function key " + token + " releases both latches");
  });
  // REPT is a repeat latch, not a printing key: it leaves the sticky
  // modifiers alone.
  assert.deepStrictEqual(stickyFields({ shifted: true, ctrl: true }, special("REPT", "rept", null)),
    { shifted: true, ctrl: true }, "REPT leaves sticky modifiers untouched");

  // --- m33EchoPunches (which bytes the console print path punches) ------
  // Printable ASCII and BS/TAB/LF/FF/CR are punched by the print path; the
  // keyboard transmit punch must NOT double-punch them.
  assert.strictEqual(echoPunches(0x41), true, "A punched by print path");
  assert.strictEqual(echoPunches(0x20), true, "SPACE punched by print path");
  assert.strictEqual(echoPunches(0x7E), true, "~ punched by print path");
  [8, 9, 10, 12, 13].forEach(function (c) {
    assert.strictEqual(echoPunches(c), true, "control " + c + " punched by print path");
  });
  // The dropped control codes are the keyboard punch's job (EOT=4, NUL, BEL,
  // VT, SO..US, DEL) — otherwise they would never reach the tape.
  assert.strictEqual(echoPunches(4), false, "EOT (CTRL+D) needs the keyboard punch");
  assert.strictEqual(echoPunches(0), false, "NUL needs the keyboard punch");
  assert.strictEqual(echoPunches(7), false, "BEL needs the keyboard punch");
  assert.strictEqual(echoPunches(11), false, "VT needs the keyboard punch");
  assert.strictEqual(echoPunches(14), false, "SO needs the keyboard punch");
  assert.strictEqual(echoPunches(31), false, "US needs the keyboard punch");
  assert.strictEqual(echoPunches(127), false, "DEL needs the keyboard punch");

  // --- Upper Case Only normalisation -----------------------------------
  // With the flag on, a-z folds to A-Z; everything else passes through.
  assert.strictEqual(upperOnly(0x61, true), 0x41, "a -> A");
  assert.strictEqual(upperOnly(0x7A, true), 0x5A, "z -> Z");
  assert.strictEqual(upperOnly(0x6D, true), 0x4D, "m -> M");
  assert.strictEqual(upperOnly(0x41, true), 0x41, "A stays A");
  assert.strictEqual(upperOnly(0x31, true), 0x31, "digit stays");
  assert.strictEqual(upperOnly(0x20, true), 0x20, "space stays");
  // With the flag off, lower case passes through untouched (2.11 BSD).
  assert.strictEqual(upperOnly(0x61, false), 0x61, "a passes through");
  assert.strictEqual(upperOnly(0x7A, false), 0x7A, "z passes through");
  assert.strictEqual(upperOnly(0x41, false), 0x41, "A passes through");

  console.log("model33-keyboard: all tests passed");
}

run();
