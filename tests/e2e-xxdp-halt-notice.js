#!/usr/bin/env node
/**
 * e2e: XXDP must not look "hung" — a stop is a verdict, idling is not a stop.
 *
 * The emulator core publishes a self-initiated stop through one event
 * (CPU.haltReason, see notifyCpuHalt() in src/pdp11.js). Two properties matter
 * for the authenticity-gate tests and for the operator:
 *
 *   1. an IDLE guest is not a stop — the XXDP+ monitor waits at its prompt
 *      (measured: it polls the console from a run loop instead of sitting in
 *      WAIT), and a notice (or a test failure) per prompt would be noise;
 *   2. a HALTED diagnostic is a failure verdict, not a hang — the "hard" DEC
 *      diagnostics (docs/xxdp-diagnostics.md) print nothing on a fault and
 *      just HALT with an address, so tests/xxdp-lib.js must report
 *      "halted at PC 000010" instead of "timed out waiting for END PASS".
 *
 * Part 1 (always) checks (1) on a live boot and that the launch path of a
 * healthy diagnostic does not see a halt.
 *
 * Part 2 is OPT-IN: XXDP_HALT_NEGATIVE=1 runs EKBCD1 (the 11/70 cache
 * diagnostic that, per docs/xxdp-diagnostics.md, halts at pc = 10) and asserts
 * the halt-aware verdict fires FAST. It is gated because it encodes the current
 * behaviour of an unemulated cache, not a specification: it must never turn a
 * green CI red, but a maintainer can reproduce the diagnosis in one command.
 *
 * Run with:  node tests/e2e-xxdp-halt-notice.test.js
 *            XXDP_HALT_NEGATIVE=1 node tests/e2e-xxdp-halt-notice.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const xxdp = require("./xxdp-lib.js");

// CPU.runState values (mirror src/pdp11.js). The XXDP+ monitor turned out to
// POLL its console from a run loop rather than sit in WAIT, so the assertion is
// the property that matters — "the machine is not halted" — and not which kind
// of not-halted it is.
const STATE_HALT = 3;

async function run() {
  console.log("e2e-xxdp-halt-notice: booting XXDP+ (rk3) headlessly ...");
  const { mach, ev, panel } = await xxdp.bootXxdp();

  // ---- Part 1a: an idle monitor is not a stop ----------------------------
  assert.strictEqual(xxdp.halted(mach), null,
    "the XXDP monitor at its prompt must not be reported as halted");
  const runState = mach.evalIn("CPU.runState");
  assert.notStrictEqual(runState, STATE_HALT,
    "an idle guest is never in STATE_HALT (WAIT or a polling RUN are both fine)");
  console.log("  idle monitor: runState=" + runState +
    ", no halt event (WAIT is not a stop, and neither is polling)");

  // ---- Part 1b: launching a healthy diagnostic sees no halt --------------
  await xxdp.launchDiagnostic({
    mach, ev,
    command: "R EKBB??",
    resolveNeedle: "EKBBF0.BIC", resolveTimeout: 12000,
    startNeedle: "CEKBBF0 11/70", startTimeout: 25000,
  });
  assert.strictEqual(xxdp.halted(mach), null,
    "a starting diagnostic must not have stopped the CPU");
  console.log("  EKBBF0 started, still no halt event");
  mach.halt();

  // ---- Part 2 (opt-in): a halted diagnostic is a fast verdict ------------
  if (process.env.XXDP_HALT_NEGATIVE !== "1") {
    console.log(xxdp.phaseReport());
    console.log("PASS e2e-xxdp-halt-notice: idle monitor is WAIT, healthy " +
      "diagnostics report no halt (negative case is opt-in: XXDP_HALT_NEGATIVE=1)");
    return;
  }

  console.log("  negative: running EKBCD1 (hard cache diagnostic, HALTs on a fault) ...");
  const boot = await xxdp.bootXxdp();
  const ev2 = boot.ev;
  await xxdp.typeLineSlowly(ev2, "R EKBC??");
  await xxdp.typeLineSlowly(ev2, ""); // acknowledge the resolved name

  const started = Date.now();
  let failed = null;
  try {
    await xxdp.runToVerdict({
      mach: boot.mach, ev: ev2, panel: boot.panel,
      // Deliberately unmatchable: the ONLY way out of this wait is the halt.
      endPass: /NEVER-MATCHES-ON-PURPOSE/,
      timeoutMs: 90000,
    });
  } catch (err) {
    failed = err;
  }
  const elapsed = Date.now() - started;

  assert.ok(failed,
    "a halted diagnostic must end the wait with a verdict, not run out the budget");
  assert.ok(/halted at PC/.test(failed.message),
    "the verdict names the halt address: " + failed.message);
  assert.ok(elapsed < 30000,
    "the halt verdict must arrive fast (" + elapsed + " ms, budget 90000 ms)");
  console.log("  halt verdict after " + elapsed + " ms: " + failed.message);

  console.log(xxdp.phaseReport());
  console.log("PASS e2e-xxdp-halt-notice: halted diagnostics fail fast with " +
    "an address instead of a timeout");
}

run().then(() => process.exit(0))
  .catch((e) => { console.error("e2e-xxdp-halt-notice error:", e.message); process.exit(1); });
