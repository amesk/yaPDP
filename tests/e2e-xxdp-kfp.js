#!/usr/bin/env node
/**
 * e2e XXDP verification — KFPAD0 (FP11-F floating-point) runs to END PASS.
 *
 * Second authenticity-gate test (after EKBBF0, the 11/70 CPU one). KFPAD0
 * exercises the FP11-F floating-point unit (see docs/xxdp-diagnostics.md:
 * the FP mnemonic = FP11/FPU). The boot / launch / verdict skeleton is shared
 * (tests/xxdp-lib.js); this file declares only KFPAD0's specifics.
 *
 * KFPAD0 vs EKBBF0:
 *   - launched with the exact name "R KFPAD0" (a wildcard like R KFPAD0??
 *     is NOT matched by this monitor — it prints "NOT FOUND: KFPAD0.B").
 *   - the banner / first report takes ~20-30 s to appear (self-paced), so use
 *     a generous wait before asserting it started.
 *   - it loops endless passes, reporting every 4; we assert the FIRST clean
 *     "END PASS #N". The pass counter grows so the regex must not hardcode
 *     "# 1", and the report line is a bare "END PASS #N" (no TOTAL ERRORS
 *     suffix — unlike EKBBF0).
 *
 * Run with:  node tests/e2e-xxdp-kfp.js
 * Exit code 0 = KFPAD0 reached a clean END PASS.
 */
"use strict";

const xxdp = require("./xxdp-lib.js");

async function run() {
  console.log("e2e-xxdp-kfp: booting XXDP+ (rk3) headlessly ...");
  const { mach, ev, panel } = await xxdp.bootXxdp();

  await xxdp.launchDiagnostic({
    mach, ev,
    command: "R KFPAD0",
    resolveNeedle: "KFPAD0.BIC", resolveTimeout: 15000,
    startNeedle: "CKFPAD0", startTimeout: 40000,
  });

  // KFPAD0 is self-paced — it loops passes by itself, no panel interaction.
  // Wait for the first clean END PASS (any pass number).
  await xxdp.runToVerdict({
    mach, ev, panel,
    endPass: /END PASS\s+\#\s*\d+/i,
    error: /\bERROR\b|MISMATCH|CPU.*FAIL|HALT/i,
    timeoutMs: 90000,
  });

  console.log("PASS e2e-xxdp-kfp: KFPAD0 (FP11-F floating-point) clean END PASS");
}

run().then(() => process.exit(0))
  .catch((e) => { console.error("e2e-xxdp-kfp error:", e.message); process.exit(1); });
