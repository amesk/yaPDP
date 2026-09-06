#!/usr/bin/env node
/**
 * e2e XXDP verification — KFPAD0 (FP11-F floating-point) runs to END PASS.
 *
 * Second authenticity-gate test (after EKBBF0, the 11/70 CPU one). KFPAD0
 * exercises the FP11-F floating-point unit (see docs/xxdp-diagnostics.md:
 * the FP mnemonic = FP11/FPU). Run on the headless stack — same core
 * machine as the Web UI, minus the DOM logic.
 *
 * KFPAD0 specifics vs EKBBF0:
 *   - launched with the exact name "R KFPAD0" (a wildcard like R KFPAD0??
 *     is NOT matched by this monitor — it prints "NOT FOUND: KFPAD0.B").
 *   - the banner / first report takes ~20-30 s to appear (the diagnostic
 *     paces itself), so use a generous wait before asserting it started.
 *   - it loops endless passes; report every 4 passes. We assert the FIRST
 *     clean "END PASS #N" (errors 0). The pass counter grows so the regex
 *     must not hardcode "# 1".
 *
 * Run with:  node tests/e2e-xxdp-kfp.js
 * Exit code 0 = KFPAD0 reached a clean END PASS.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendLine(evalIn, text) {
  const bytes = Array.from((text + "\r")).map((c) => c.charCodeAt(0) & 0x7f);
  evalIn("window.dlReceiveQueue(0, " + JSON.stringify(bytes) + ")");
}
async function waitFor(mach, needle, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mach.getOut().indexOf(needle) !== -1) return true;
    await sleep(150);
  }
  return false;
}

async function run() {
  console.log("e2e-xxdp-kfp: booting XXDP+ (rk3) headlessly ...");

  const mach = await bootHeadless({
    image: "media/rk3.dsk.zst", urlName: "rk0.dsk",
    bootCmd: "BOOT RK0\r", stableMs: 1200, timeoutMs: 30000,
  });
  const ev = mach.evalIn;

  // 1. Reach the XXDP+ monitor.
  assert.ok(await waitFor(mach, "ENTER DATE", 15000), "XXDP+ date prompt");
  sendLine(ev, "09-SEP-78");
  assert.ok(await waitFor(mach, "THIS IS XXDP+", 15000), "XXDP+ monitor up");

  // 2. Launch the KFPAD0 FP11-F diagnostic (exact name; wildcard not matched).
  sendLine(ev, "R KFPAD0");
  assert.ok(await waitFor(mach, "KFPAD0.BIC", 15000), "KFPAD0.BIC recognised");
  sendLine(ev, ""); // acknowledge the resolved name
  // Banner is slow (~20-30 s on first report), so be generous here.
  assert.ok(await waitFor(mach, "CKFPAD0", 40000), "KFPAD0 started (CKFPAD0)");

  // 3. Wait for the first clean END PASS. KFPAD0 loops forever printing a
  //    report every 4 passes, so we only assert the first clean one.
  const deadline = Date.now() + 90000;
  let sawPass = false;
  while (Date.now() < deadline) {
    const out = mach.getOut();
    // KFPAD0's report is a bare "END PASS #N" line (no TOTAL ERRORS
    // suffix — unlike EKBBF0). Any clean END PASS counts.
    if (/END PASS\s+\#\s*\d+/i.test(out)) {
      sawPass = true;
      break;
    }
    if (/\bERROR\b|MISMATCH|CPU.*FAIL|HALT/.test(out.slice(-1200))) {
      console.error("KFPAD0 reported an error; tail:\n" + out.slice(-600));
      assert.fail("KFPAD0 ended with an error");
    }
    await sleep(400);
  }
  mach.halt();

  if (!sawPass) {
    console.error("KFPAD0 did not reach END PASS in time; tail:\n" +
      mach.getOut().slice(-800));
    assert.fail("timed out waiting for KFPAD0 END PASS");
  }
  console.log("PASS e2e-xxdp-kfp: KFPAD0 (FP11-F floating-point) clean END PASS");
}

run().then(() => process.exit(0))
  .catch((e) => { console.error("e2e-xxdp-kfp error:", e.message); process.exit(1); });
