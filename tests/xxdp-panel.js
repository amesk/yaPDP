"use strict";

/**
 * xxdp-panel.js — headless PDP-11 front-panel access for XXDP e2e tests.
 *
 * A DEC front panel shows the machine's switch/lamp state and lets the
 * operator throw the console switches. XXDP field diagnostics read that
 * panel: some ask the operator to raise a specific switch (e.g. switch 7 to
 * continue), others signal success/failure purely through the lamps (an old
 * hard diagnostic that passes silently drives the address/data lights and
 * only does a HALT on error — see docs/xxdp-diagnostics.md).
 *
 * This module exposes those panel registers over the headless machine's
 * evalIn bridge, as small named operations instead of reaching into CPU.*
 * from every test. It is generic — the bit values of the CPU diagnostic
 * switches are a property of the diagnostic, not of the panel, so callers
 * pass masks; the CPU diag switch semantics are documented in
 * docs/xxdp-diagnostics.md:
 *   bit15 halt-on-error, bit14 loop-in-subtest,
 *   bit13 suppress error msgs, bit04 suppress info msgs, bit07 = switch 7.
 *
 * Registers (as implemented by the emulated PDP-11/70 CPU, src/pdp11.js):
 *   CPU.switchRegister   — the lowered console switches (R/W)
 *   CPU.displayAddress   — the address lamps / ADRS display (R/W by diag)
 *   CPU.displayDataPaths — the data path (data) lamps
 *   CPU.registerVal[7]   — the program counter (PC)
 *   CPU.runState         — STATE_RUN=0 / STATE_WAIT=2 / STATE_HALT=3
 */

const assert = require("assert");

// Concrete mask helper for a single numbered console switch (bit index).
function bit(n) {
  assert.ok(Number.isInteger(n) && n >= 0 && n <= 15, "switch bit 0..15");
  return 1 << n;
}

/**
 * Return an object of named panel operations driven through `evalIn`.
 * `isOctal` is accepted to keep call sites readable when passing octal
 * literals by hand, but callers should prefer the mask helpers below.
 */
function createPanel(evalIn) {
  assert.strictEqual(typeof evalIn, "function", "evalIn bridge required");

  // Read the whole console switch register.
  function switchRegister() {
    return evalIn("CPU.switchRegister & 0xFFFF");
  }
  // Is the given mask of switches currently up?
  function switchUp(mask) {
    return (switchRegister() & mask) === mask;
  }
  // Raise the given mask of switches (OR into the register).
  function setSwitch(mask, on) {
    assert.ok(Number.isInteger(mask) && mask >= 0 && mask <= 0xffff, "mask 0..0xffff");
    const value = on === false ? 0 : 1;
    evalIn("CPU.switchRegister = (CPU.switchRegister & ~" + mask +
      ") | (" + mask + " * " + value + ");");
  }
  // Lower the given mask of switches (clear bits).
  function clearSwitch(mask) {
    setSwitch(mask, false);
  }

  // --- lamps / observer state ---
  // Address lamps (what the panel ADRS display shows right now).
  function addressLights() {
    return evalIn("CPU.displayAddress & 0xFFFF");
  }
  // Data-path lamps (the DATA display).
  function dataLights() {
    return evalIn("(CPU.displayDataPaths || 0) & 0xFFFF");
  }
  // Program counter.
  function pc() {
    return evalIn("(CPU.registerVal[7] || 0) & 0xFFFF");
  }
  // Raw CPU run state (0 RUN, 2 WAIT, 3 HALT).
  function runState() {
    return evalIn("CPU.runState");
  }
  // Convenience: are we halted (indicating a hard diagnostic stopped on error)?
  function halted() {
    return runState() === 3;
  }
  // Octal dump used for diagnostics / tail reporting.
  function describe() {
    return {
      sr: switchRegister().toString(8),
      adrs: addressLights().toString(8),
      data: dataLights().toString(8),
      pc: pc().toString(8),
      runState: runState(),
    };
  }

  return {
    bit,
    switchRegister, switchUp, setSwitch, clearSwitch,
    addressLights, dataLights, pc, runState, halted, describe,
  };
}

// Octal aliases for the classic named console switches a caller may mask:
const SWITCH = {
  SW7: 0o200,        // console switch 7 (many CPU diags ask to set this)
  HALT_ON_ERROR: 0o100000,   // bit15
  LOOP_SUBTEST: 0o40000,     // bit14
  SUPPRESS_ERROR: 0o20000,   // bit13
  SUPPRESS_INFO: 0o20,       // bit04
};

module.exports = { createPanel, bit, SWITCH };
