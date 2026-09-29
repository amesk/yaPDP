#!/usr/bin/env node
/**
 * Reboot must reset the PROCESSOR state, not just the panel and the devices.
 *
 * Reproduces the reported symptom: a guest boots fine on a fresh page, then
 * the same guest dies after a Reboot with "HALT at 2 PSW: 17". The first boot
 * leaves PSW = 0x17 (kernel mode, priority 7, MMU on); resetPanelControls()
 * reset the switches and the devices but NOT the CPU, so the next kernel
 * started in the inherited mode, took a trap 4 through vector 2 and halted.
 *
 * Memory must stay untouched: the accelerator start (console switches set an
 * address written by the DEC boot ROM into a vector and transfer control) and
 * our own bootstrap both rely on RAM surviving a reset, exactly like the real
 * machine — only the registers and PSW are cleared.
 *
 * The check runs the REAL resetPanelControls() source in a VM with a stub CPU,
 * so what is asserted is the shipped function, not a copy of it.
 *
 * Run with:  node tests/reboot-cpu-state.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const PANEL = path.join(ROOT, "src", "pdp11-panel.js");

const src = fs.readFileSync(PANEL, "utf8");
const m = src.match(/function resetPanelControls\(\)\s*\{[\s\S]*?\n  \}/);
assert.ok(m, "resetPanelControls() found in src/pdp11-panel.js");

// A CPU carrying the state a running kernel leaves behind.
const cpu = {
    registerVal: new Uint16Array([0x1234, 1, 2, 3, 4, 5, 0xFF00, 0x0100]),
    registerAlt: new Uint16Array([9, 9, 9, 9, 9, 9]),
    stackPointer: new Uint16Array([0x200, 0x300, 0x400, 0x500]),
    trapPSW: 0x17,
    PSW: 0x17,
    mmuMode: 3,
    switchRegister: 0xF0F0,
};
const pswWrites = [];
const memory = new Uint16Array(64).fill(0xBEEF); // guest RAM that must survive

const sandbox = {
    console,
    CPU: cpu,
    panel: { rotary0: 0, rotary1: 0, autoIncr: 0, halt: 0, step: 0, lampTest: 0 },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    moveSwitch: () => {},
    setPowerState: () => {},
    window: {},
    writePSW: function (v) { cpu.PSW = v; cpu.mmuMode = v >>> 14; pswWrites.push(v); },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[0] + "\nresetPanelControls();", sandbox, { filename: PANEL });

assert.strictEqual(cpu.registerVal.every((v) => v === 0), true,
    "R0-R7 are cleared");
assert.strictEqual(cpu.registerAlt.every((v) => v === 0), true,
    "the alternate register set is cleared");
assert.strictEqual(cpu.stackPointer.every((v) => v === 0), true,
    "the per-mode stack pointers are cleared");
assert.strictEqual(cpu.trapPSW, 0, "trapPSW is cleared");
assert.strictEqual(pswWrites.length, 1, "PSW is reset through writePSW() once");
assert.strictEqual(pswWrites[0], 0, "PSW resets to kernel mode with priority 0");
assert.strictEqual(cpu.PSW, 0, "the CPU ends up with the reset PSW");
assert.strictEqual(cpu.mmuMode, 0, "the MMU mode follows the reset PSW");
assert.strictEqual(cpu.switchRegister, 0, "the console switch register is cleared");

// The accelerator start and our bootstrap need RAM to survive a reset.
assert.strictEqual(memory.every((v) => v === 0xBEEF), true,
    "main memory is NOT cleared by the reset");

console.log("resetPanelControls: processor state cleared, memory preserved");
console.log("reboot-cpu-state.test.js: all tests passed");
