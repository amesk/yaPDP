#!/usr/bin/env node
/**
 * e2e XXDP verification — EKBBF0 (11/70 CPU) runs to a clean END PASS.
 *
 * First "authenticity gate" test (docs/ROADMAP.md): a real DEC field
 * diagnostic certifying the PDP-11 CPU emulation on the headless stack.
 * The shared boot / launch / verdict skeleton lives in tests/xxdp-lib.js;
 * this file only declares EKBBF0's run command, banner and the panel
 * interaction specific to it (lift switch 7 + answer each fresh
 * "TYPE A CHARACTER TO CONTINUE" prompt with one character).
 *
 * Run with:  node tests/e2e-xxdp-ekbbf0.js
 * Exit code 0 = EKBBF0 passed clean.
 */
"use strict";

const xxdp = require("./xxdp-lib.js");
const { SWITCH } = require("./xxdp-panel.js");

async function run() {
  console.log("e2e-xxdp-ekbbf0: booting XXDP+ (rk3) headlessly ...");
  const { mach, ev, panel } = await xxdp.bootXxdp();

  await xxdp.launchDiagnostic({
    mach, ev,
    command: "R EKBB??",
    resolveNeedle: "EKBBF0.BIC", resolveTimeout: 12000,
    startNeedle: "CEKBBF0 11/70", startTimeout: 25000,
  });

  // Drive the operator-console interaction to a clean END PASS: the diag
  // asserts a KB11-B/C CPU, then asks to look at the lights, set switch 7 and
  // press a character — moving on only when switch 7 is up AND a character
  // arrives. Feed a character exactly when a fresh "TYPE A CHARACTER" ask
  // appears (console grows), never on a timer; set switch 7 only once.
  let switch7Set = false;
  let lastAsk = -1;
  let charsFed = 0;

  await xxdp.runToVerdict({
    mach, ev, panel,
    endPass: /END PASS\s+\#\s*\d+\s+TOTAL ERRORS SINCE LAST REPORT\s+0/i,
    error: /\bERROR\b|MISMATCH|(^|\n)(FAIL|HALT)/i,
    timeoutMs: 120000,
    drive: async ({ out, outLen }) => {
      if (!switch7Set && out.indexOf("CHANGE SWITCH 7") !== -1) {
        panel.setSwitch(SWITCH.SW7);
        switch7Set = true;
        return true;
      }
      const outLenNow = (outLen !== undefined) ? outLen : -1;
      if (out.indexOf("TYPE A CHARACTER TO CONTINUE") !== -1 &&
          outLenNow !== lastAsk) {
        xxdp.sendChar(ev, "A");
        lastAsk = outLenNow;
        charsFed++;
        return true;
      }
      return false;
    },
  });

  console.log("PASS e2e-xxdp-ekbbf0: EKBBF0 (11/70 CPU) clean END PASS (" +
    charsFed + " char(s) fed)");
}

run().then(() => process.exit(0))
  .catch((e) => { console.error("e2e-xxdp-ekbbf0 error:", e.message); process.exit(1); });
