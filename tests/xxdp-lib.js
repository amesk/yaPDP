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
    fs.writeFileSync(file, text);
    console.error("  artifact: " + file);
  } catch (err) { /* best effort */ }
  const tail = text.slice(-1500);
  console.error("  console tail:\n" +
    tail.split("\n").map((l) => "    | " + l).join("\n"));
}

// Poll `needle` in the machine console output until it appears or the budget
// runs out. Returns true when found.
async function waitFor(mach, needle, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mach.getOut().indexOf(needle) !== -1) return true;
    await sleep(150);
  }
  return false;
}

function sendLine(evalIn, text) {
  const bytes = Array.from((text + "\r")).map((c) => c.charCodeAt(0) & 0x7f);
  evalIn("window.dlReceiveQueue(0, " + JSON.stringify(bytes) + ")");
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

  if (!await waitFor(mach, "ENTER DATE", 45000)) {
    dumpConsole("date", mach.getOut());
    assert.fail("XXDP+ date prompt never appeared within 45000ms");
  }
  sendLine(ev, "09-SEP-78");
  if (!await waitFor(mach, "THIS IS XXDP+", 45000)) {
    dumpConsole("monitor", mach.getOut());
    assert.fail("XXDP+ monitor never came up within 45000ms");
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
  sendLine(ev, command);
  if (resolveNeedle) {
    // Name the PHASE when this fails. The old message was
    // "<needle> recognised", which reads like a success and sent a whole
    // investigation down the wrong path: the run had actually TIMED OUT waiting
    // for the loader to print the name.
    if (!await waitFor(mach, resolveNeedle, resolveTimeout)) {
      console.error("diagnostic name was never resolved");
      dumpConsole("resolve", mach.getOut());
      assert.fail(resolveNeedle + " was not resolved within " + resolveTimeout +
        "ms — the loader never printed it (a slow runner needs a longer budget, " +
        "see the per-test timeouts)");
    }
    sendLine(ev, ""); // acknowledge the resolved name
  }
  if (!await waitFor(mach, startNeedle, startTimeout)) {
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

module.exports = {
  bootXxdp, launchDiagnostic, runToVerdict, waitFor, sendLine, sendChar, sleep,
};
