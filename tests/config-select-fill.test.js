#!/usr/bin/env node
/**
 * CONFIG form → config fill tests (the <select> regression of #75).
 *
 * initConfigForm() populates the CONFIG form from the persisted config. The
 * console type, the teletype speed and the VT100 phosphor used to be radio
 * groups; the first two became <select> elements in #75, but the helper that
 * writes them still assigned `.checked` — a property a <select> does not have,
 * so the assignment was silently dropped and the form kept whatever the markup
 * had chosen.
 *
 * The consequences were user-visible and are pinned here:
 *   - CONFIG showed "Teletype (Model 33 ASR)" while the machine ran a VT100;
 *   - leaving the page asked about "Unapplied configuration" the user never
 *     made (isDirty() read the wrong form value);
 *   - applying from that state read "none" for both user terminals and would
 *     have dropped them.
 *
 * This test extracts setRadioChecked() from the real source and drives it
 * against minimal control doubles, so it exercises the production helper
 * rather than a copy.
 *
 * Run with:  node tests/config-select-fill.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "pdp11-app.js");

// Brace-balancing extractor for a single function body.
function extractBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error("marker not found: " + startMarker);
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) throw new Error("no opening brace for: " + startMarker);
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

function loadSetRadioChecked() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  // The helper is nested inside initConfigForm(); lift it out on its own.
  const fn = extractBlock(src, "function setRadioChecked");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.setRadioChecked = setRadioChecked;", sandbox);
  return sandbox.setRadioChecked;
}

// A <select> only exposes .value; assigning .checked must be a no-op on it,
// which is exactly the bug: the real element ignores the property.
function makeSelect(value) {
  return { tagName: "SELECT", value: value, checked: undefined };
}
function makeRadio(value, checked) {
  return { tagName: "INPUT", value: value, checked: !!checked };
}

function run() {
  const setRadioChecked = loadSetRadioChecked();

  // --- A <select> receives the config value through .value ----------------
  {
    const sel = makeSelect("teletype");
    setRadioChecked([sel], "vt100");
    assert.strictEqual(sel.value, "vt100",
      "a <select> must be filled through .value (rc: #75 console type)");
  }

  // --- ... and the write is not a one-way trip: 'none' clears a terminal ---
  {
    const tt1 = makeSelect("vt52");
    const tt2 = makeSelect("vt52");
    setRadioChecked([tt1, tt2], "none");
    assert.strictEqual(tt1.value, "none", "user terminal 1 must clear to none");
    assert.strictEqual(tt2.value, "none", "user terminal 2 must clear to none");
  }

  // --- Radio groups keep working: .value selects, .checked reflects ------
  {
    const group = [makeRadio("p4", true), makeRadio("green", false)];
    setRadioChecked(group, "green");
    assert.strictEqual(group[0].checked, false, "the old pick must uncheck");
    assert.strictEqual(group[1].checked, true, "the new pick must check");
  }

  // --- The reported symptom, end to end: consoleType vt100 + two terminals -
  // (the exact persisted state the wizard leaves behind after booting rk1)
  {
    const consoleSel = makeSelect("teletype");      // markup default
    const tt1 = makeSelect("none");                 // markup default
    const tt2 = makeSelect("none");                 // markup default
    const cfg = { consoleType: "vt100", userTerminalTypes: ["vt52", "vt52"] };

    setRadioChecked([consoleSel], cfg.consoleType);
    setRadioChecked([tt1, tt2], cfg.userTerminalTypes[0]);
    setRadioChecked([tt2], cfg.userTerminalTypes[1]);

    assert.strictEqual(consoleSel.value, "vt100",
      "CONFIG must show the console the machine actually runs");
    assert.strictEqual(tt1.value, "vt52", "TT1 must show the installed terminal");
    assert.strictEqual(tt2.value, "vt52", "TT2 must show the installed terminal");
    // isDirty() compares exactly these form reads with the config.
    assert.strictEqual(consoleSel.value, cfg.consoleType,
      "no phantom 'Unapplied configuration' after a wizard boot");
    assert.deepStrictEqual([tt1.value, tt2.value], cfg.userTerminalTypes.slice(),
      "Apply must not read 'none' and drop the user terminals");
  }

  // --- Missing elements are tolerated (a form without the control) --------
  {
    const sel = makeSelect("vt100");
    assert.doesNotThrow(() => setRadioChecked([null, sel, undefined], "vt52"),
      "a missing control must not throw");
    assert.strictEqual(sel.value, "vt52", "the present control is still filled");
  }

  console.log("\nAll config select-fill tests passed.");
}

run();
