#!/usr/bin/env node
/**
 * boot() must perform a virtual power cycle: the whole processor state goes
 * back to its power-on values while main memory is preserved.
 *
 * Reported symptom: a guest boots fine on a fresh page, then dies after a
 * Reboot with "HALT at 2 PSW: 17". boot() copied the bootstrap into memory and
 * reset the devices, but left the processor alone, so the next boot inherited
 * the previous kernel's state:
 *
 *   - PSW = 0x17 (kernel, priority 7, N set)  -> trap 4 through vector 2,
 *     printed as "HALT at 2 PSW: 17";
 *   - mmuEnable and the PAR/PDR tables programmed by the old kernel -> once
 *     the PSW was cleared the halt went away, but the second boot still
 *     failed: measured mmuEnable = 48 while the first kernel ran, 0 on the
 *     second boot, because the new kernel saw an MMU that already looked
 *     configured and never enabled it.
 *
 * Main memory must survive: the accelerator start (console switches place an
 * address written by the DEC boot ROM into a vector and transfer control) and
 * the guest both rely on RAM across a reset, exactly like the real 11/70,
 * whose core memory kept its contents when the power was switched off.
 *
 * The check extracts the REAL boot() source from src/pdp11.js (a plain browser
 * script, not a module) and runs it in a VM with a CPU carrying a running
 * kernel's state.
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
const PDP = path.join(ROOT, "src", "pdp11.js");

const src = fs.readFileSync(PDP, "utf8");
const m = src.match(/function boot\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(m, "boot() found in src/pdp11.js");

// The state a running kernel leaves behind, plus guest RAM to preserve.
const cpu = {
    CPU_Error: 4,
    runState: 0,
    interruptRequested: 1,
    trapMask: 0x30,
    trapPSW: 0x17,
    PSW: 0x17,
    flagC: 1,
    flagNZ: 0x100,
    flagV: 0x1000,
    MMR0: 0x1234, MMR1: 0x5678, MMR2: 0x9abc, MMR3: 0x10,
    mmuEnable: 48,
    mmuLastPage: 7,
    mmuMode: 3,
    mmuPageMask: 0x3f,
    mmuPAR: new Uint16Array(64).fill(0xAB),
    mmuPDR: new Uint16Array(64).fill(0xCD),
    memory: new Uint16Array(0o120000 / 2 + 64).fill(0xBEEF),
    unibusMap: new Uint32Array(32).fill(0xEF),
    modifyAddress: 0x1234,
    modifyRegister: 5,
    registerVal: new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]),
    registerAlt: new Uint16Array([9, 9, 9, 9, 9, 9]),
    stackPointer: new Uint16Array([0x200, 0x300, 0x400, 0x500]),
    stackLimit: 0x10,
    PIR: 0x80,
    displayAddress: 1, displayBusReg: 2, displayDataPaths: 3,
    displayMicroAdrs: 4, displayPhysical: 5, displayRegister: 6,
    statusLights: 0,
    switchRegister: 0xF0F0,
};

const GUEST_WORD = 100; // far below BOOTBASE: must keep the guest's contents

const sandbox = {
    console,
    CPU: cpu,
    bootcode: [0x0A0A, 0x0B0B, 0x0C0C],
    BOOTBASE: 0o120000,
    STATE_RESET: 1,
    STATE_RUN: 0,
    iopage: { reset: () => { sandbox.__iopageReset = (sandbox.__iopageReset || 0) + 1; } },
    writePSW: function (v) { cpu.PSW = v; cpu.mmuMode = v >>> 14; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[0] + "\nboot();", sandbox, { filename: PDP });

// --- processor state back to power-on --------------------------------------
assert.strictEqual(cpu.CPU_Error, 0, "CPU_Error is cleared");
assert.strictEqual(cpu.trapMask, 0, "trapMask is cleared");
assert.strictEqual(cpu.trapPSW, -1, "trapPSW returns to -1 (no trap in progress)");
assert.strictEqual(cpu.flagC !== cpu.flagC, true, "flagC is NaN again");
assert.strictEqual(cpu.flagNZ !== cpu.flagNZ, true, "flagNZ is NaN again");
assert.strictEqual(cpu.flagV, 0x8000, "flagV returns to its power-on value");
assert.strictEqual(cpu.PSW, 0, "PSW resets to kernel mode with priority 0");
assert.strictEqual(cpu.mmuMode, 0, "the MMU mode follows the reset PSW");
assert.strictEqual(cpu.PIR, 0, "PIR is cleared");

// --- MMU back to power-on --------------------------------------------------
assert.strictEqual(cpu.MMR0, 0, "MMR0 is cleared");
assert.strictEqual(cpu.MMR1, 0, "MMR1 is cleared");
assert.strictEqual(cpu.MMR2, 0, "MMR2 is cleared");
assert.strictEqual(cpu.MMR3, 0, "MMR3 is cleared");
assert.strictEqual(cpu.mmuEnable, 0, "the MMU is disabled, so accesses bypass translation");
assert.strictEqual(cpu.mmuLastPage, 0, "mmuLastPage is cleared");
assert.strictEqual(cpu.mmuPAR.every((v) => v === 0), true, "the PAR table is cleared");
assert.strictEqual(cpu.mmuPDR.every((v) => v === 0), true, "the PDR table is cleared");
assert.strictEqual(cpu.unibusMap.every((v) => v === 0), true, "the Unibus map is cleared");
assert.strictEqual(cpu.modifyRegister, -1, "modifyRegister returns to -1");

// --- registers, stack, console --------------------------------------------
assert.strictEqual(cpu.registerAlt.every((v) => v === 0), true, "the alternate bank is cleared");
assert.strictEqual(cpu.stackPointer.every((v) => v === 0), true, "the per-mode stack pointers are cleared");
assert.strictEqual(cpu.stackLimit, 0xff, "stackLimit returns to its power-on value");
assert.strictEqual(cpu.switchRegister, 0, "the console switch register is cleared");
assert.strictEqual(cpu.statusLights, 0x3000, "the status lights return to their power-on value");
assert.strictEqual(cpu.displayRegister, 0, "the display registers are cleared");

// --- memory survives, bootstrap lands, control transfers -------------------
assert.strictEqual(cpu.memory[GUEST_WORD], 0xBEEF,
    "guest memory outside the bootstrap area is NOT cleared");
assert.strictEqual(cpu.memory[0o120000 >>> 1], 0x0A0A, "the bootstrap is written at BOOTBASE");
assert.strictEqual(cpu.registerVal[7], 0o120000, "PC jumps to the bootstrap");
assert.strictEqual(cpu.registerVal[6], 0o120000, "SP is set to the bootstrap base");
assert.strictEqual(cpu.runState, 0, "the CPU ends up running");
assert.ok(sandbox.__iopageReset >= 1, "the devices are reset");

console.log("boot(): processor and MMU power-cycled, memory preserved");
console.log("reboot-cpu-state.test.js: all tests passed");
