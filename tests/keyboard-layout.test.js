#!/usr/bin/env node
/**
 * Physical keyboard on a NON-US layout — regression tests.
 *
 * The emulator is often driven from a machine whose OS layout is Cyrillic.
 * Both physical-keyboard handlers used to fall back to the deprecated
 * `keyCode` (the US physical key position) whenever `e.key` was not printable
 * ASCII, so a Cyrillic layout silently produced Latin letters — a partial
 * recode that translated letters but left the digits and punctuation of the
 * same physical key behind. The handlers now take the character from `e.key`
 * only; Ctrl+<letter> keeps reading `keyCode`, so Ctrl+C and friends still
 * work in every layout.
 *
 * Both handlers are extracted from the REAL source (src/pdp11-app.js) with a
 * brace-balancing extractor and run in a VM against a fake DOM, so the test
 * exercises the production handlers rather than a copy — the same technique
 * tests/model33-keyboard.test.js uses for the pure helpers.
 *
 * Covered:
 *   - a Cyrillic printable key types NOTHING and is not swallowed
 *     (preventDefault is not called, so browser shortcuts keep working);
 *   - a US-layout character still passes through unchanged (case, digits);
 *   - Ctrl+<letter> still resolves through keyCode — Ctrl+ф sends 0x03;
 *   - the bit-paired Ctrl+@ (NUL) survives the change;
 *   - the VT52/VT100 handler routes the same results to its own unit;
 *   - a structural guard: neither handler may regain the `keyCode` recode,
 *     and neither may lose its Ctrl path.
 *
 * Run with:  node tests/keyboard-layout.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single function (same as
// tests/model33-keyboard.test.js).
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

// ------------------------------------------------------------------
// Fake DOM. Both handlers ask for their own page, the teletype page (the
// VT52 handler stands down while it is active) and, at install time, an
// element to hang a paste listener on.
// ------------------------------------------------------------------
function fakeElement(isActive) {
  return {
    classList: { contains: (cls) => cls === "active" && isActive },
    addEventListener() { /* paste listener: never fired here */ },
    offsetWidth: 0
  };
}

function makeDocument(activePageId) {
  const doc = {
    keydown: [],
    addEventListener(type, fn) {
      if (type === "keydown") doc.keydown.push(fn);
    },
    getElementById(id) { return fakeElement(id === activePageId); },
    querySelector() { return null; } // no canvas: the paste binding is skipped
  };
  return doc;
}

function keyEvent(overrides) {
  return Object.assign({
    key: "", keyCode: 0, code: "",
    repeat: false, ctrlKey: false, altKey: false, metaKey: false,
    target: { tagName: "BODY" },
    prevented: false,
    preventDefault() { this.prevented = true; }
  }, overrides);
}

// ------------------------------------------------------------------
// Harnesses
// ------------------------------------------------------------------
function loadTeletype() {
  const doc = makeDocument("page-teletype");
  const sent = [];
  const sandbox = {
    document: doc,
    window: {},
    sendDL(bytes) { for (const b of bytes) sent.push(b); }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractBlock(SOURCE, "function model33UpperOnly"),
    extractBlock(SOURCE, "function upperOnly"),
    extractBlock(SOURCE, "function installPhysicalKeyboard"),
    "; this.install = installPhysicalKeyboard;"
  ].join("\n"), sandbox);
  sandbox.install();
  return {
    press(overrides) {
      sent.length = 0;
      const ev = keyEvent(overrides);
      doc.keydown.forEach((fn) => fn(ev));
      return { bytes: sent.slice(), event: ev };
    }
  };
}

function loadVT52(unit, pageId) {
  const doc = makeDocument(pageId);
  const calls = [];
  const sandbox = {
    document: doc,
    window: {},
    navigator: {},
    PasteUtil: { pasteIntoUnit() { /* clipboard paths are not exercised */ } },
    // copy through the HOST Array prototype: `bytes` was built inside the vm
    // realm, and deepStrictEqual compares prototypes (a same-realm copy keeps
    // the assertion honest).
    bridgeSendToUnit(u, bytes) {
      calls.push({ unit: u, bytes: Array.prototype.slice.call(bytes) });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractBlock(SOURCE, "function installVT52Keyboard") +
    "\n; this.install = installVT52Keyboard;", sandbox);
  sandbox.install(unit, pageId);
  return {
    press(overrides) {
      calls.length = 0;
      const ev = keyEvent(overrides);
      doc.keydown.forEach((fn) => fn(ev));
      return { calls: calls.slice(), event: ev };
    }
  };
}

function run() {
  // ---- Structural guard ------------------------------------------------
  // The behaviour above can only be trusted if the recode never comes back:
  // it must not be reintroduced into either handler, and the Ctrl path the
  // fix deliberately left in place must not be removed along with it.
  ["function installPhysicalKeyboard", "function installVT52Keyboard"].forEach((marker) => {
    const body = extractBlock(SOURCE, marker);
    assert.ok(!/code\s*\+\s*32/.test(body),
      marker + ": the keyCode -> lowercase-letter recode must not come back");
    assert.ok(!/ch\s*=\s*code\b/.test(body),
      marker + ": the printable character must come from e.key, never from keyCode");
    assert.ok(/ctrlKey\s*&&\s*code\s*>=\s*65\s*&&\s*code\s*<=\s*90/.test(body),
      marker + ": Ctrl+<letter> still resolves through keyCode (Ctrl+C in any layout)");
  });

  // ---- Model 33 console (teletype page) --------------------------------
  const tty = loadTeletype();

  // US layout: behaviour is unchanged.
  assert.deepStrictEqual(tty.press({ key: "a", keyCode: 65, code: "KeyA" }).bytes, [0x61],
    "lowercase a");
  assert.deepStrictEqual(tty.press({ key: "A", keyCode: 65, code: "KeyA" }).bytes, [0x41],
    "uppercase A");
  assert.deepStrictEqual(tty.press({ key: "7", keyCode: 55, code: "Digit7" }).bytes, [0x37],
    "a digit");
  assert.deepStrictEqual(tty.press({ key: "Enter", keyCode: 13, code: "Enter" }).bytes, [13],
    "Enter is still CR");

  // Cyrillic layout: the physical key position must NOT leak a Latin letter.
  // Every one of these keys would have produced a letter before the fix.
  const cyrillic = [
    { key: "\u0444", keyCode: 65, code: "KeyA" },        // ф = the A position
    { key: "\u0424", keyCode: 65, code: "KeyA" },        // Ф = SHIFT+A position
    { key: "\u0439", keyCode: 81, code: "KeyQ" },        // й = the Q position
    { key: "\u0436", keyCode: 59, code: "Semicolon" },   // ж = the ; position
    { key: "\u0431", keyCode: 188, code: "Comma" },      // б = the , position
    { key: "\u044e", keyCode: 190, code: "Period" }      // ю = the . position
  ];
  cyrillic.forEach((ev) => {
    const r = tty.press(ev);
    assert.deepStrictEqual(r.bytes, [],
      "a Cyrillic key (" + ev.key + ") must type nothing, not " +
      JSON.stringify(r.bytes));
    assert.strictEqual(r.event.prevented, false,
      "the key is not swallowed: browser shortcuts keep working (" + ev.key + ")");
  });

  // The Ctrl path is deliberately kept: it is layout-independent, is not a
  // transliteration of a letter and the control byte is the same one a real
  // keyboard sends.
  assert.deepStrictEqual(tty.press({ key: "c", keyCode: 67, code: "KeyC", ctrlKey: true }).bytes,
    [0x03], "Ctrl+C on a US layout");
  assert.deepStrictEqual(tty.press({ key: "\u0441", keyCode: 67, code: "KeyC", ctrlKey: true }).bytes,
    [0x03], "Ctrl+с still sends Ctrl+C from a Cyrillic layout");
  assert.deepStrictEqual(tty.press({ key: "@", keyCode: 50, code: "Digit2", ctrlKey: true }).bytes,
    [0x00], "Ctrl+@ is still the bit-paired NUL");

  // ---- VT52 / VT100 (its own page and unit) ----------------------------
  const vt = loadVT52(2, "page-vt52");

  assert.deepStrictEqual(vt.press({ key: "a", keyCode: 65, code: "KeyA" }).calls,
    [{ unit: 2, bytes: [0x61] }], "VT52: lowercase a reaches its own unit");
  assert.deepStrictEqual(vt.press({ key: "A", keyCode: 65, code: "KeyA" }).calls,
    [{ unit: 2, bytes: [0x41] }], "VT52: uppercase A is not folded");

  const vtCyr = vt.press({ key: "\u0444", keyCode: 65, code: "KeyA" });
  assert.deepStrictEqual(vtCyr.calls, [], "VT52: a Cyrillic key types nothing");
  assert.strictEqual(vtCyr.event.prevented, false, "VT52: and is not swallowed");

  assert.deepStrictEqual(
    vt.press({ key: "\u0441", keyCode: 67, code: "KeyC", ctrlKey: true }).calls,
    [{ unit: 2, bytes: [0x03] }], "VT52: Ctrl+с still sends Ctrl+C");

  console.log("keyboard-layout: all tests passed");
}

run();
