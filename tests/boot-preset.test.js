#!/usr/bin/env node
/**
 * Boot-ROM preset & record tests (bootDevice 'last').
 *
 * With bootDevice 'last' the emulated socket holds a device-specific PROM: the
 * emulator presets the device name at the fixed cell 0o1000 and boot.mac
 * (macro-asm/boot.mac: bootsel) boots that medium on its own — no banner, no
 * '@' prompt, no typed command. Conversely, when the operator boots a device
 * BY HAND at the '@' prompt ("BOOT RK1"), boot.mac records it at cell 0o1002,
 * so the next boot() can remember it for 'last'.
 *
 * Both are driven here against the REAL emulator sources in the headless
 * sandbox (the headless-boot harness).
 *
 * Run with:  node tests/boot-preset.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootRT11 } = require("../tools/headless-boot.js");

const DEVICE_CELL = 0o1000 >>> 1;   // preset cell: "RK"
const RK = "R".charCodeAt(0) | ("K".charCodeAt(0) << 8);

(async function run() {
  // ---- 1. The preset boots the device with no '@' and no typing ----------
  const r1 = await bootRT11({
    preset: true,          // a device PROM boots on its own: no '@', no typing
    waitFor: ".",
    timeoutMs: 90000,
    onSandbox: function (sb) {
      sb.Config = {
        get: function () { return { bootDevice: "last" }; },
        set: function () { return this.get(); },
      };
      sb.LastBoot = { get: function () { return "rk1"; } };
      sb.OSBoot = {
        scenarioFor: function (k) { return k === "rk1" ? { device: "rk1" } : null; },
      };
    },
  });
  assert.strictEqual(r1.out.indexOf("@"), -1,
    "no '@' prompt in preset mode\n" + r1.out);
  assert.ok(r1.out.indexOf("RT-11SJ") !== -1,
    "RT-11 booted from the preset device\n" + r1.out);
  r1.halt();
  console.log("PASS 1: preset boots the device without '@'");

  // ---- 2. A manual boot is recorded and replayed by 'last' ---------------
  const r2 = await bootRT11();   // interactive: the harness types "BOOT RK1"
  const rec = r2.evalIn("BootMailbox.peek()");
  assert.strictEqual(rec.code, RK, "boot.mac recorded the device it booted (RK)");
  assert.strictEqual(rec.unit, 1, "boot.mac recorded the unit (1)");

  // With bootDevice 'last', the next boot() reads that record, remembers the
  // device and presets it — a MANUAL boot is thus replayed.
  let seen = null;
  r2.sandbox.Config = {
    get: function () { return { bootDevice: "last" }; },
    set: function () { return this.get(); },
  };
  r2.sandbox.LastBoot = {
    get: function () { return seen; },
    remember: function (d) { seen = d; return d; },
  };
  r2.sandbox.OSBoot = {
    scenarioFor: function (k) { return k === "rk1" ? { device: "rk1" } : null; },
  };
  r2.evalIn("boot(); 1");
  assert.strictEqual(seen, "rk1", "the manual boot was remembered as 'rk1'");
  assert.strictEqual(r2.evalIn("CPU.memory[" + DEVICE_CELL + "]"), RK,
    "the preset cell holds the remembered device (RK)");
  assert.strictEqual(r2.evalIn("CPU.memory[" + (DEVICE_CELL + 1) + "]"),
    "1".charCodeAt(0), "the preset unit is 1");
  r2.halt();
  console.log("PASS 2: a manual BOOT is recorded and replayed by 'last'");

  console.log("boot-preset.test.js: all tests passed");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
})().catch(function (e) {
  console.error("boot-preset.test.js: FAILED\n" + (e && e.message ? e.message : e));
  process.exit(1);
});
