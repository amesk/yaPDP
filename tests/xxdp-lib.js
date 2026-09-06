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
const { bootHeadless } = require("../tools/headless-machine.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  assert.ok(await waitFor(mach, "ENTER DATE", 15000), "XXDP+ date prompt");
  sendLine(ev, "09-SEP-78");
  assert.ok(await waitFor(mach, "THIS IS XXDP+", 15000), "XXDP+ monitor up");

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
    assert.ok(await waitFor(mach, resolveNeedle, resolveTimeout),
      resolveNeedle + " recognised");
    sendLine(ev, ""); // acknowledge the resolved name
  }
  assert.ok(await waitFor(mach, startNeedle, startTimeout),
    startNeedle + " (diagnostic started)");
}

/**
 * Run the loaded diagnostic to a verdict.
 *
 * cfg:
 *   endPass   RegExp matched against the whole console output (a clean pass).
 *   error     RegExp for failure text (optional; tail-matched defence).
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
      console.error("diagnostic reported an error; tail:\n" + out.slice(-600));
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
  console.error("diagnostic did not reach END PASS in time; tail:\n" +
    mach.getOut().slice(-800));
  assert.fail("timed out waiting for END PASS");
}

module.exports = {
  bootXxdp, launchDiagnostic, runToVerdict, waitFor, sendLine, sendChar, sleep,
};
