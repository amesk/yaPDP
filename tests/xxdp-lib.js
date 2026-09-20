"use strict";

/**
 * xxdp-lib.js — shared driver for the headless XXDP e2e tests.
 *
 * Every XXDP authenticity-gate test (docs/ROADMAP.md) does the same shape of
 * work: boot XXDP+ off the rk3 disk, answer the date prompt until the monitor
 * is up, launch one DEC diagnostic, then drive it until it reports a clean END
 * PASS (or bail on an error / timeout). The only things that differ per
 * diagnostic are the run command, the startup banner to wait for, the phrasing
 * of the pass/error lines, and — occasionally — panel interaction while the
 * diagnostic runs (EKBBF0 needs switch 7 raised and a character typed per ask;
 * KFPAD0 just paces itself).
 *
 * This module keeps that shared skeleton in one place; each e2e script becomes
 * a declaration of its diagnostic plus a tiny per-test interaction callback,
 * instead of a 100-line near-copy of its sibling.
 *
 * Uses:  const xxdp = require("./xxdp-lib.js");
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { bootHeadless } = require("../tools/headless-machine.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where a failed run leaves its console tail. Without this a red XXDP step in
// CI carries one line of text and nothing else (no artifact is uploaded), so a
// flake and a real regression look identical from the outside. Same directory
// the other e2e suites write to, so the CI artifact step picks it up.
const ARTIFACTS = path.join(__dirname, "artifacts");

// Dump the console tail (and a bounded head) so a failure can be diagnosed
// after the fact. Best effort: an unwritable directory must not mask the
// original failure.
function dumpConsole(label, text) {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const file = path.join(ARTIFACTS, "xxdp-" + label + ".log");
    // The WHOLE console, not a tail: a previous artifact carried 381 bytes —
    // enough to see the command arrive mangled ("RRRR...EEEE..."), not enough
    // to see what led up to it, which is the part that explains why.
    fs.writeFileSync(file, text);
    console.error("  artifact: " + file + " (" + text.length + " bytes)");
  } catch (err) { /* best effort */ }
  const tail = text.slice(-1500);
  console.error("  console tail:\n" +
    tail.split("\n").map((l) => "    | " + l).join("\n"));
}

// Poll `needle` in the machine console output until it appears or the budget
// runs out. Returns true when found.
//
// The elapsed time is REPORTED, not just compared against the budget. A test
// that only says "passed" hides how close it came: the XXDP launch phases were
// green locally (a workstation resolves the .BIC name in ~2.5 s) and red on a
// CI runner, and there was no number to tell whether the runner was genuinely
// slower or the failure had another cause. Now every wait prints its own
// millisecond count, so a CI log carries the measurement.
async function waitFor(mach, needle, timeoutMs, phase) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    if (mach.getOut().indexOf(needle) !== -1) {
      const elapsed = Date.now() - startedAt;
      phases.push({ name: phase || needle, ms: elapsed, ok: true });
      console.log("  wait " + String(elapsed).padStart(7) + " ms  " +
        (phase ? phase + ": " : "") + JSON.stringify(needle));
      return true;
    }
    await sleep(150);
  }
  const elapsed = Date.now() - startedAt;
  phases.push({ name: phase || needle, ms: elapsed, ok: false, budget: timeoutMs });
  console.error("  wait " + String(elapsed).padStart(7) + " ms  " +
    (phase ? phase + ": " : "") + JSON.stringify(needle) + "  TIMED OUT (budget " +
    timeoutMs + " ms)");
  return false;
}

function sendLine(evalIn, text) {
  const bytes = Array.from((text + "\r")).map((c) => c.charCodeAt(0) & 0x7f);
  evalIn("window.dlReceiveQueue(0, " + JSON.stringify(bytes) + ")");
}
// Feed a line ONE byte at a time, with a pause — the way an operator types and
// the way the other harnesses do it (typeOnKeyboard sleeps ~120 ms per key).
// A CI run once showed the guest receive a command with every character
// repeated many times ("RRRR...EEEE...KKKK..." -> "? INVALID COMMAND"): that is
// what a burst into a device which is not draining yet looks like.
async function typeLineSlowly(evalIn, text, perByteMs = 35) {
  for (const ch of text) {
    evalIn("window.dlReceiveQueue(0, [" + (ch.charCodeAt(0) & 0x7f) + "])");
    await sleep(perByteMs);
  }
  evalIn("window.dlReceiveQueue(0, [13])");
}

function sendChar(evalIn, ch) {
  evalIn("window.dlReceiveQueue(0, [" + (ch.charCodeAt(0) & 0x7f) + "])");
}

/**
 * Boot XXDP+ (rk3) headlessly and reach the monitor prompt.
 * @returns {Promise<{mach:object, ev:function, panel:object}>}
 *   `mach` is the bootHeadless machine handle (getOut / halt),
 *   `ev` runs code in the machine (window, CPU, ...),
 *   `panel` is the headless front-panel helper from xxdp-panel.js.
 */
async function bootXxdp() {
  const mach = await bootHeadless({
    image: "media/rk3.dsk.zst", urlName: "rk0.dsk",
    bootCmd: "BOOT RK0\r", stableMs: 1200, timeoutMs: 30000,
  });
  const ev = mach.evalIn;

  if (!await waitFor(mach, "ENTER DATE", 15000, "boot:date")) {
    dumpConsole("date", mach.getOut());
    assert.fail("XXDP+ date prompt never appeared within 15000ms");
  }
  sendLine(ev, "09-SEP-78");
  if (!await waitFor(mach, "THIS IS XXDP+", 15000, "boot:monitor")) {
    dumpConsole("monitor", mach.getOut());
    assert.fail("XXDP+ monitor never came up within 15000ms");
  }

  return { mach, ev, panel: require("./xxdp-panel.js").createPanel(ev) };
}

/**
 * Launch one diagnostic by typing `command` at the monitor, acknowledging the
 * resolved .BIC name, then asserting the diagnostic banner in
 * `cfg.startNeedle` within `cfg.startTimeout`.
 */
async function launchDiagnostic({ mach, ev, command, resolveNeedle,
  resolveTimeout = 15000, startNeedle, startTimeout }) {
  // Type the command out instead of pushing the whole line in one call, and
  // RETRY it when the name does not come back. A CI run showed the guest
  // receive the command with every character repeated many times and answer
  // "? INVALID COMMAND": a burst that landed while the monitor was not yet
  // draining its input. After such a rejection the guest sits at its prompt, so
  // sending the line again is harmless — a lost race becomes a slower but
  // successful launch instead of a red step.
  const ATTEMPTS = 3;
  let attemptsUsed = 0;
  if (resolveNeedle) {
    // Name the PHASE when this fails. The old message was
    // "<needle> recognised", which reads like a success and sent a whole
    // investigation down the wrong path: the run had actually TIMED OUT waiting
    // for the loader to print the name.
    let resolved = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !resolved; attempt++) {
      attemptsUsed = attempt;
      await typeLineSlowly(ev, command);
      resolved = await waitFor(mach, resolveNeedle, resolveTimeout,
        "launch:resolve" + (attempt > 1 ? " (attempt " + attempt + ")" : ""));
      if (!resolved) {
        console.error("  attempt " + attempt + " of " + ATTEMPTS +
          " did not resolve " + JSON.stringify(resolveNeedle));
        ev("window.dlReceiveQueue(0, [3])"); // ^C: drop the rejected line
        await sleep(500);
      }
    }
    if (!resolved) {
      dumpConsole("resolve", mach.getOut());
      assert.fail(resolveNeedle + " was not resolved in " + ATTEMPTS +
        " attempts of " + resolveTimeout + "ms each — the loader never printed it");
    }
    if (attemptsUsed > 1) {
      console.log("  resolved on attempt " + attemptsUsed + " of " + ATTEMPTS +
        " — the first send did not reach the monitor");
    }
    await typeLineSlowly(ev, ""); // acknowledge the resolved name
  } else {
    await typeLineSlowly(ev, command);
  }
  if (!await waitFor(mach, startNeedle, startTimeout, "launch:start")) {
    console.error("diagnostic never started");
    dumpConsole("start", mach.getOut());
    assert.fail(startNeedle + " never appeared within " + startTimeout +
      "ms — the diagnostic did not start");
  }
}

/**
 * Run the loaded diagnostic to a verdict.
 *
 * cfg:
 *   endPass   RegExp matched against the whole console output (a clean pass).
 *   error     RegExp for failure text (optional; tail-matched defence).
 *             Keep it specific: it is tested against the last 1200 characters,
 *             so a bare /\bERROR\b/i matches the harmless banner text a
 *             diagnostic prints while RESOLVING its name (e.g. "EKBBF0.BIC
 *             recognised" appears next to an "ERROR" word in the loader's
 *             listing) and fails a healthy run. Prefer a verdict-shaped
 *             pattern such as /TOTAL ERRORS SINCE LAST REPORT\s+[1-9]/i,
 *             which only matches a real reported error count in a report line.
 *   timeoutMs overall budget for the verdict wait.
 *   drive(ctx) optional per-test interaction callback. Called on each poll;
 *             ctx = { mach, ev, panel, out, outLen }. Return true when it performed
 *             an action so the driver gives the machine a beat before the next
 *             poll. Absent ⇒ the diagnostic is self-paced (idle wait).
 *
 * Returns after a clean pass; otherwise prints a tail and fails the assertion.
 */
async function runToVerdict({ mach, ev, panel, endPass, error, timeoutMs, drive }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = mach.getOut();

    if (error && error.test(out.slice(-1200))) {
      mach.halt();
      console.error("diagnostic reported an error");
      dumpConsole("error", out);
      assert.fail("diagnostic ended with an error");
    }
    if (endPass.test(out)) {
      mach.halt();
      return;
    }

    if (drive) {
      const acted = await drive({ mach, ev, panel, out, outLen: out.length });
      if (acted) { await sleep(250); continue; }
    }
    await sleep(250);
  }
  mach.halt();
  console.error("diagnostic did not reach END PASS in time");
  dumpConsole("timeout", mach.getOut());
  assert.fail("timed out waiting for END PASS");
}

// Every wait that has completed, in order — the suite prints this as a table so
// one CI run answers "how long did each phase really take" without a re-run.
const phases = [];
function phaseReport() {
  if (!phases.length) return "";
  const width = Math.max.apply(null, phases.map((p) => p.name.length));
  const rows = phases.map((p) =>
    "  " + p.name.padEnd(width) + "  " + String(p.ms).padStart(8) + " ms" +
    (p.ok ? "" : "   <-- TIMED OUT (budget " + p.budget + " ms)"));
  return "\nXXDP phase timings:\n" + rows.join("\n") + "\n";
}

module.exports = {
  bootXxdp, launchDiagnostic, runToVerdict, waitFor, sendLine, typeLineSlowly,
  sendChar, sleep,
  phaseReport,
};
