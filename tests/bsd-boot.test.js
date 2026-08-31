#!/usr/bin/env node
/**
 * Headless BSD 2.11 boot test (slow: ~3 minutes).
 *
 * Boots BSD 2.11 (rp1) in pure Node on the headless machine layer —
 * no browser, no puppeteer. This is the regression anchor for the two
 * fixes that made BSD bootable headless:
 *
 *   1. mmu-regs.js Unibus-map range check (map regs 16–31 must accept
 *      writes — BSD's boot loader maps its DMA buffer through map[26],
 *      address 0o17770350; a too-narrow check NXMs the write and DMA
 *      lands at 0+offset → "unix not found").
 *   2. UDA50 MSCP controller port (ra0-ra2) — autoconfig must report
 *      "ra 0 csr 172150 vector 154 vectorset attached" exactly like
 *      iopage.js.
 *
 * Success = the kernel boots, autoconfigures rk/xp/ra, init runs the
 * standard startup and the console reaches "login:".
 *
 * Run with:  node tests/bsd-boot.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const bytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const r = await bootHeadless({
    image: "media/rp1.dsk.zst",
    urlName: "rp1.dsk",
    steps: [{ send: "boot rp1", waitFor: "Press <CR>" }],
    timeoutMs: 60000,
  });

  // Step past the "Press <CR> to boot" countdown.
  const consoleDev = r.machine.findDevice("console");
  consoleDev.receive(bytes("\r"));

  // Wait for the login prompt (kernel boot + init + startup scripts).
  const t0 = Date.now();
  const budgetMs = 200000;
  let out = r.getOut();
  while (!out.includes("login:") && Date.now() - t0 < budgetMs) {
    await sleep(1000);
    out = r.getOut();
  }

  // ---- Test 1: kernel banner -------------------------------------------------
  assert.ok(out.includes("2.11 BSD UNIX"),
    "kernel banner present (kernel loaded and started)");
  console.log("PASS test 1: BSD 2.11 kernel banner");

  // ---- Test 2: autoconfiguration — UDA50 (ra) + RP11 (xp) attached ----------
  assert.ok(/ra 0 csr 172150 vector 154/.test(out),
    "UDA50 'ra 0' autoconfigured at 172150/vec154");
  assert.ok(out.includes("vectorset attached"),
    "ra unit 0 attached (vectorset)");
  assert.ok(/xp 0 csr 176700 vector 254 attached/.test(out),
    "RP11 'xp 0' attached at 176700/vec254");
  assert.ok(/rk 0 csr 177400 vector 220 attached/.test(out),
    "RK11 'rk 0' attached at 177400/vec220");
  console.log("PASS test 2: autoconfig ra + rk + xp attached (iopage parity)");

  // ---- Test 3: full boot to login -------------------------------------------
  assert.ok(out.includes("login:"),
    "console reached 'login:' within budget (" +
    ((Date.now() - t0) / 1000).toFixed(0) + "s)" +
    "\n--- console tail ---\n" + out.slice(-800));
  console.log("PASS test 3: BSD 2.11 boots to login: (" +
    ((Date.now() - t0) / 1000).toFixed(0) + "s after CR)");

  // ---- Test 4: machine still alive ------------------------------------------
  const runState = r.evalIn("CPU.runState");
  assert.notStrictEqual(runState, r.evalIn("STATE_HALT"),
    "CPU not halted at login (runState=" + runState + ")");
  console.log("PASS test 4: machine alive at login (runState=" + runState + ")");

  console.log("\nAll bsd-boot tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
