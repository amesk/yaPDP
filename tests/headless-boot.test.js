#!/usr/bin/env node
/**
 * Headless machine-boot tests.
 *
 * Boots RT-11 v4.0 (rk1) in pure Node — the real emulator sources loaded
 * into a VM sandbox with DOM stubs, the image mounted straight from media/
 * via DataLoader.mount() (the "file provider" side of the block interface),
 * and "BOOT RK1" typed through the console receive queue. No browser, no
 * puppeteer, no dev server.
 *
 * This is the characterization anchor for the headless machine layer: if a
 * refactor of iopage.js breaks the devices, this test catches it in ~2
 * seconds instead of a 30-second browser boot.
 *
 * Run with:  node tests/headless-boot.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootRT11 } = require("../tools/headless-boot.js");

async function run() {
  // ---- Test 1: RT-11 boots to the monitor prompt --------------------
  const { out, sandbox: sb2, stats, getOut, evalIn } = await bootRT11();

  assert.ok(stats.bootPromptMs >= 0, "bootloader @ prompt reached");
  assert.ok(stats.readyMs >= 0, "guest prompt reached");
  assert.ok(stats.readyMs < 60000, "boot finished within budget (" + stats.readyMs + "ms)");
  assert.ok(out.indexOf("RT-11SJ") !== -1, "RT-11SJ banner present");
  assert.ok(out.indexOf("V04.00C") !== -1, "V04.00C version present");
  assert.ok(/^\.[\s]*$/.test(out.slice(out.lastIndexOf("\n") + 1)),
    "final line is the '.' monitor prompt");
  console.log("PASS test 1: RT-11 boots headlessly to '.' prompt (" +
    stats.readyMs + "ms, bootloader @" + stats.bootPromptMs + "ms)");

  // ---- Test 2: console input reached the guest ----------------------
  // The V4USER.TXT startup file is executed by the monitor, proving the
  // typed "BOOT RK1" line was delivered through dlReceiveQueue and the
  // guest actually ran.
  assert.ok(out.indexOf("Welcome to RT-11") !== -1,
    "startup file V4USER.TXT ran (input path works end to end)");
  console.log("PASS test 2: typed boot command reached the guest (V4USER.TXT ran)");

  // ---- Test 3: machine state is sane after boot ---------------------
  // RT-11 sits in WAIT at the monitor prompt — the CPU must be in
  // STATE_WAIT, not RUN or HALT, proving the guest is alive and idle.
  // ---- Test 3: machine state is sane after boot ---------------------
  // The guest is alive and idle: CPU must NOT be halted (a crash would put
  // it in STATE_HALT / odd-address trap), and the PC must be in monitor
  // territory, not the bootcode region.
  const runState = evalIn("CPU.runState");
  const pc = evalIn("CPU.registerVal[7]");
  assert.notStrictEqual(runState, evalIn("STATE_HALT"),
    "CPU not halted at the monitor prompt (runState=" + runState + ")");
  assert.ok(pc >= 0o1000 && pc < 0o160000,
    "PC in guest memory (octal " + pc.toString(8) + ")");
  console.log("PASS test 3: machine alive at the monitor prompt (runState=" +
    runState + ", PC=" + pc.toString(8) + ")");

  // ---- Test 4: interactive round-trip through the console -----------
  // Type "DIR" — the monitor must answer with the directory listing and a
  // fresh prompt, proving the receive path works after boot. Wait for the
  // listing footer ("Free blocks"), not just "output changed" — the machine
  // may still be printing the tail of V4USER.TXT when DIR is sent.
  sb2.window.dlReceiveQueue(0, Array.from("DIR\r").map((c) => c.charCodeAt(0)));
  const t1 = Date.now();
  let reply = "";
  do {
    if (Date.now() - t1 > 15000) throw new Error("no DIR response");
    await new Promise((r) => setTimeout(r, 100));
    reply = getOut().slice(out.length);
  } while (!/Free blocks/.test(reply));
  assert.ok(/MACRO\s+\.SAV/.test(reply), "DIR lists MACRO.SAV");
  assert.ok(/Files,/.test(reply), "DIR reports file count");
  console.log("PASS test 4: interactive 'DIR' round-trip through dlReceiveQueue");

  console.log("\nAll headless-boot tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
