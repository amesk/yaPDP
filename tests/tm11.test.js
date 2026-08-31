#!/usr/bin/env node
/**
 * Headless TM11 magtape controller tests.
 *
 * Boots RT-11 (rk1, fast) on the headless machine layer and exercises the
 * TM11 register file (17772520): MTS defaults, rewind command, INIT
 * reset, MTRD timing-hack read. Regression anchor for the TM11 port.
 *
 * Run with:  node tests/tm11.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const MTS_BASE = 0o17772520;

async function run() {
  const r = await bootHeadless({
    image: "media/rk1.dsk.zst",
    urlName: "rk1.dsk",
    bootCmd: "BOOT RK1\r",
    timeoutMs: 60000,
  });

  const tm = r.machine.findDevice("tm0");
  assert.ok(tm, "tm0 device exists on the headless machine");

  const rd = (a) => r.evalIn("readWordByPhysical(" + a + ")");
  const wr = (a, v) => r.evalIn("writeWordByPhysical(" + a + ", " + v + ")");

  // ---- Test 1: MTS defaults (unit selected, write-locked, ready) ----
  // Before the first tape command the per-drive control block does not
  // exist yet, so the dynamic BOT bit is not asserted (same as iopage.js).
  // MTS_SEL|MTS_WRL|MTS_RDY = 0x40|0x04|0x01 = 0x45 = 0o105
  const mts0 = rd(MTS_BASE);
  assert.strictEqual(mts0, 0o105,
    "MTS defaults to SEL|WRL|RDY before first command (got " +
    mts0.toString(8) + ")");
  console.log("PASS test 1: MTS defaults (SEL|WRL|RDY = " + mts0.toString(8) + ")");

  // ---- Test 2: rewind command completes, BOT gets asserted ----
  // MTC: RDY|GO|FUN(7=REWIND) = 0x80|0x01|(7<<1) = 0x8F
  wr(MTS_BASE + 2, 0x8F);
  const mtsAfterRewind = rd(MTS_BASE);
  assert.ok(mtsAfterRewind & 0x20,
    "BOT set after rewind (MTS=" + mtsAfterRewind.toString(8) + ")");
  assert.ok(mtsAfterRewind & 1,
    "RDY set after rewind (MTS=" + mtsAfterRewind.toString(8) + ")");
  console.log("PASS test 2: rewind completes, BOT+RDY set");

  // ---- Test 3: INIT (MTC bit 0x1000) resets the controller ----
  wr(MTS_BASE + 2, 0x6080 | 0x1000); // density + RDY + INIT
  const mtsAfterInit = rd(MTS_BASE);
  assert.strictEqual(mtsAfterInit, 0o145,
    "MTS back to defaults after INIT (got " + mtsAfterInit.toString(8) + ")");
  console.log("PASS test 3: INIT resets controller state");

  // ---- Test 4: MTD returns 0, MTRD toggles the timing hack ----
  assert.strictEqual(rd(MTS_BASE + 0o10), 0, "MTD reads 0");
  const mtrd1 = rd(MTS_BASE + 0o12);
  assert.strictEqual(mtrd1, 0x80FF, "first MTRD read returns 0x80FF (got " +
    mtrd1.toString(16) + ")");
  const mtrd2 = rd(MTS_BASE + 0o12);
  assert.strictEqual(mtrd2, 0, "second MTRD read toggles back to 0 (got " +
    mtrd2.toString(16) + ")");
  console.log("PASS test 4: MTD=0, MTRD timing hack toggles");

  // ---- Test 5: TM11 answers at its interrupt priority ----
  const pri = tm.poll(0) & 0o340;
  assert.strictEqual(pri, 5 << 5, "TM11 priority is 5 (got " + pri.toString(8) + ")");
  assert.strictEqual(tm.poll(1), 0o224, "TM11 vector is 0224");
  console.log("PASS test 5: TM11 priority 5, vector 0224");

  console.log("\nAll tm11 tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
