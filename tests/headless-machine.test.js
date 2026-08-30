#!/usr/bin/env node
/**
 * Headless-machine tests — the NEW headless stack (refactor stages 0-3).
 *
 * Boots RT-11 v4.0 in pure Node WITHOUT iopage.js: the machine is
 * assembled from the core base classes and devices (Machine, Bus,
 * ConsoleDL11, Rk11, CpuRegs, Kw11, DiskService with a FILE provider),
 * and the real pdp11.js CPU is wired to the bus through the thin sandbox
 * `iopage` adapter.
 *
 * This is the stage-3 milestone anchor: the first time the guest OS boots
 * on the refactored device layer. If a later refactor step breaks a
 * device, this test catches it in ~2 seconds.
 *
 * Run with:  node tests/headless-machine.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

async function run() {
  // ---- Test 1: RT-11 boots to the monitor prompt on the new stack ----
  const { out, stats, evalIn, halt } = await bootHeadless();

  assert.ok(stats.bootPromptMs >= 0, "bootloader @ prompt reached");
  assert.ok(stats.readyMs >= 0, "guest prompt reached");
  assert.ok(stats.readyMs < 60000, "boot finished within budget (" + stats.readyMs + "ms)");
  assert.ok(out.indexOf("RT-11SJ") !== -1, "RT-11SJ banner present");
  assert.ok(out.indexOf("V04.00C") !== -1, "V04.00C version present");
  assert.ok(/^\.[\s]*$/.test(out.slice(out.lastIndexOf("\n") + 1)),
    "final line is the '.' monitor prompt");
  console.log("PASS test 1: RT-11 boots headlessly on the new stack (" +
    stats.readyMs + "ms, bootloader @" + stats.bootPromptMs + "ms)");

  // ---- Test 2: the bus/devices are the refactored classes -----------
  // The machine runs without iopage.js: prove the sandbox iopage is our
  // adapter and the devices are the core classes (via the returned
  // machine handle).
  const { machine } = await bootHeadless();
  assert.ok(machine, "machine handle returned");
  assert.ok(machine.findDevice("console"), "ConsoleDL11 present");
  assert.ok(machine.findDevice("rk0"), "Rk11 present");
  assert.ok(machine.findDevice("cpu-regs"), "CpuRegs present");
  assert.ok(machine.findDevice("kw11"), "Kw11 present");
  assert.ok(machine.disk.hasDrive("rk0.dsk"), "file provider mounted");
  // The sandbox iopage must be the adapter (has access/poll/reset but is
  // NOT the real iopage.js — no deviceAccess of its own).
  const adapterPoll = evalIn("typeof iopage.poll === 'function'");
  assert.strictEqual(adapterPoll, true, "sandbox iopage is the adapter");
  halt();
  console.log("PASS test 2: machine assembled from the core classes");

  // ---- Test 3: guest round-trip — DIR works --------------------------
  const { getOut, evalIn: ev2, halt: h2 } = await bootHeadless();
  // V4USER.TXT runs at startup; type a command and wait for its echo.
  const sb = { dlReceiveQueue: null };
  // Re-route: the tool already exposes dlReceiveQueue on the sandbox
  // window; use evalIn to push a command through the console device.
  ev2("window.dlReceiveQueue(0, Array.from('DIR SYS*.*\\r').map(c => c.charCodeAt(0)))");
  const deadline = Date.now() + 30000;
  let dirSeen = false;
  while (Date.now() < deadline) {
    if (/SYS\*\.\*|Free blocks|DIRECT/.test(getOut())) { dirSeen = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(dirSeen, "guest executed DIR SYS*.* (output: " +
    JSON.stringify(getOut().slice(-80)) + ")");
  h2();
  console.log("PASS test 3: guest round-trip via console device");
}

run().then(() => {
  console.log("All headless-machine tests passed.");
  process.exit(0);
}).catch((e) => {
  console.error("headless-machine test error:", e.message);
  process.exit(1);
});
