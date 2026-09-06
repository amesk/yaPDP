#!/usr/bin/env node
/**
 * e2e XXDP verification — EKBBF0 (11/70 CPU) runs to a clean END PASS.
 *
 * Purpose: verify the PDP-11 emulation logic against a real DEC field
 * diagnostic, on the headless stack (no browser, no UI layer in the way).
 * XXDP+ (rk3) is booted, the EKBBF0 CPU diagnostic is launched, and the
 * test drives it through its operator-console interaction — the console
 * lights check and the switch-7 prompt — until the diagnostic reports
 * END PASS with 0 errors.
 *
 * This is the first "authenticity gate" test from docs/ROADMAP.md: a DEC
 * diagnostic certifying the emulation. The operator steps the diagnostic
 * paces itself are driven programmatically against the machine registers:
 *   - "switch 7" is bit 7 (mask 0200) of the console switch register the
 *     diagnostic reads from the KS11 panel hardware;
 *   - the "TYPE A CHARACTER TO CONTINUE" prompts are answered with one
 *     character when the diagnostic asks (detected by console-output growth),
 *     never pumped continuously.
 *
 * Run with:  node tests/e2e-xxdp-ekbbf0.js   (full diagnostics suite)
 * Exit code 0 = EKBBF0 passed clean.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendLine(evalIn, text) {
  const bytes = Array.from((text + "\r")).map((c) => c.charCodeAt(0) & 0x7f);
  evalIn("window.dlReceiveQueue(0, " + JSON.stringify(bytes) + ")");
}
function sendChar(evalIn, ch) {
  evalIn("window.dlReceiveQueue(0, [" + (ch.charCodeAt(0) & 0x7f) + "])");
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
  console.log("e2e-xxdp-ekbbf0: booting XXDP+ (rk3) headlessly ...");

  const mach = await bootHeadless({
    image: "media/rk3.dsk.zst", urlName: "rk0.dsk",
    bootCmd: "BOOT RK0\r", stableMs: 1200, timeoutMs: 30000,
  });
  const ev = mach.evalIn;

  // 1. Answer the date prompt to reach the XXDP+ monitor.
  assert.ok(await waitFor(mach, "ENTER DATE", 15000), "XXDP+ date prompt");
  sendLine(ev, "09-SEP-78");
  assert.ok(await waitFor(mach, "THIS IS XXDP+", 15000), "XXDP+ monitor up");

  // 2. Launch the EKBBF0 CPU diagnostic.
  sendLine(ev, "R EKBB??");
  assert.ok(await waitFor(mach, "EKBBF0.BIC", 12000), "EKBBF0.BIC recognised");
  sendLine(ev, ""); // confirm the resolved name
  assert.ok(await waitFor(mach, "CEKBBF0 11/70", 25000), "EKBBF0 started");

  // 3. Drive the operator-console interaction to a clean END PASS.
  //    The diagnostic asserts the CPU is a KB11-B/C, then asks the operator
  //    to look at the lights, set switch 7 and press a character — moving on
  //    only when switch 7 is up AND a character is received. Feed a character
  //    exactly when the "TYPE A CHARACTER" ask appears (console grows), never
  //    on a timer.
  const deadline = Date.now() + 120000;
  let switch7Set = false;
  let lastAsk = -1;
  let charsFed = 0;
  let verdict = null;

  while (Date.now() < deadline && !verdict) {
    const out = mach.getOut();

    if (/END PASS\s+\#\s*\d+\s+TOTAL ERRORS SINCE LAST REPORT\s+0/i.test(out)) {
      verdict = "pass";
      break;
    }
    if (/\bERROR\b|MISMATCH|(^|\n)(FAIL|HALT)/i.test(out.slice(-1500))) {
      verdict = "error";
      break;
    }

    // Operator ask: lift switch 7 (only once) when the diag prints it.
    if (!switch7Set && out.indexOf("CHANGE SWITCH 7") !== -1) {
      mach.evalIn("CPU.switchRegister = 0200;");
      switch7Set = true;
      await sleep(400);
      continue;
    }
    // Operator ask: answer "TYPE A CHARACTER" once per fresh ask.
    if (out.indexOf("TYPE A CHARACTER TO CONTINUE") !== -1 && out.length !== lastAsk) {
      sendChar(ev, "A");
      lastAsk = out.length;
      charsFed++;
      await sleep(500);
      continue;
    }
    await sleep(200);
  }

  mach.halt();

  if (verdict === "pass") {
    console.log("PASS e2e-xxdp-ekbbf0: EKBBF0 (11/70 CPU) clean END PASS (" +
      charsFed + " char(s) fed)");
    return;
  }
  if (verdict === "error") {
    console.error("EKBBF0 reported an error; tail:\n" + mach.getOut().slice(-600));
    assert.fail("EKBBF0 ended with an error");
  }
  console.error("EKBBF0 did not report END PASS in time; switch7Set=" +
    switch7Set + " charsFed=" + charsFed + "; tail:\n" + mach.getOut().slice(-600));
  assert.fail("timed out waiting for EKBBF0 END PASS");
}

run().then(() => process.exit(0))
  .catch((e) => { console.error("e2e-xxdp-ekbbf0 error:", e.message); process.exit(1); });
