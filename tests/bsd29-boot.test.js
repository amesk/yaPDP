#!/usr/bin/env node
/**
 * Headless BSD 2.9 boot test (slow: ~2-3 minutes).
 *
 * Boots BSD 2.9 (rl0) in pure Node on the headless machine layer — no
 * browser, no puppeteer. Regression anchor for the RL11 port: the kernel
 * must boot through the RL11 controller, reach the single-user '#',
 * Ctrl-D into multi-user, and accept a login typed after getty's input
 * flush (3s settle — see docs/known-issues.md).
 *
 * Run with:  node tests/bsd29-boot.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const bytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const r = await bootHeadless({
    image: "media/rl0.dsk.zst",
    urlName: "rl0.dsk",
    steps: [{ send: "boot rl0", waitFor: ":" }],
    timeoutMs: 60000,
  });
  const consoleDev = r.machine.findDevice("console");
  const send = (s) => consoleDev.receive(bytes(s + "\r"));
  const waitFor = async (needle, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (r.getOut().includes(needle)) return true;
      await sleep(500);
    }
    return false;
  };

  // Bootloader: load the kernel by name. The 2.9 bootloader drops input
  // sent before it finished loading the secondary boot stage (same class
  // of behaviour as getty's input flush), so settle briefly first.
  await sleep(2000);
  send("rl(0,0)rlunix");
  assert.ok(await waitFor("Berkeley UNIX", 90000),
    "kernel banner (RL11 read the kernel)" +
    "\n--- console tail ---\n" + r.getOut().slice(-600));

  // Single-user prompt — kernel boots to '#', no login yet.
  assert.ok(await waitFor("#", 60000),
    "single-user '#' prompt");
  console.log("PASS test 1: BSD 2.9 kernel boots through RL11 to single-user '#'");

  // Enter + Ctrl-D: exit single-user into multi-user (init).
  consoleDev.receive(bytes("\r\x04"));
  assert.ok(await waitFor("login:", 90000),
    "multi-user login: after Ctrl-D" +
    "\n--- console tail ---\n" + r.getOut().slice(-600));
  console.log("PASS test 2: Ctrl-D reaches multi-user (init prints login:)");

  // getty flushes input received before it finished opening the console;
  // settle, then log in as root (no password in this image).
  await sleep(4000);
  send("root");
  assert.ok(await waitFor("Welcome to the 2.9BSD", 60000),
    "root login accepted ('Welcome to the 2.9BSD')" +
    "\n--- console tail ---\n" + r.getOut().slice(-600));
  assert.ok(await waitFor("#", 30000),
    "root shell prompt '#' after login");
  console.log("PASS test 3: root login accepted, shell prompt reached");

  const runState = r.evalIn("CPU.runState");
  assert.notStrictEqual(runState, r.evalIn("STATE_HALT"),
    "CPU not halted at root shell (runState=" + runState + ")");
  console.log("PASS test 4: machine alive at root shell");

  console.log("\nAll bsd29-boot tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
