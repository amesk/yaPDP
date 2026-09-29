#!/usr/bin/env node
/**
 * Console input feed: a mistimed timer must not stall the queue.
 *
 * Reported from the browser: load a guest, work, press Reboot (auto-boot on),
 * then type `boot rk0` — the console goes deaf until the page is reloaded.
 *
 * The cause was in the feed's pacing, and it lived in both stacks:
 *
 *   dlPump()/_pump() paces itself with a timer. A timer can fire in the window
 *   between placing a byte in RBUF and the guest reading it. _acceptChar()
 *   then refuses (DONE is still set), the feed leaves receiverBusy set, and
 *   nothing restarts it: the timer is gone and the queue stands still. Reading
 *   RBUF is the event that frees the receiver, so it is the event that must
 *   resume the feed — and it did not.
 *
 * Both stacks are checked here, because `?core=1` is the default and the
 * legacy stack is the rollback path: a fix in one alone lets the two drift.
 *
 * Run with:  node tests/dl11-feed-stall.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const RCSR = 0o17777560;
const RBUF = 0o17777562;
const DL_RCSR_DONE = 0x80;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------
// Legacy stack: extract dl11() from src/iopage.js and drive it directly.
// Same extraction pattern as tests/dl11-recv.test.js.
// ----------------------------------------------------------------------

// Minimal brace-balancing extractor for a single top-level function.
function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error("marker not found: " + startMarker);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

// dlPump is a closure inside the iopage IIFE, so it cannot be extracted on its
// own the way dl11() can: it is pulled out by name from the whole file and run
// in a sandbox whose state variables it shares with the extracted device. The
// device's access() is what the guest calls, and the fix under test is that it
// resumes the feed.
function loadLegacy() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "iopage.js"), "utf8");
  const dl11 = extractBlock(src, "function dl11(vt52Unit, deviceVector)", "");
  const insertData = extractBlock(src, "function insertData", "");
  const requestInterrupt = extractBlock(src, "function requestInterrupt", "");

  const sandbox = {};
  sandbox.CPU = { interruptRequested: 0, runState: 0, PSW: 0, registerVal: [0] };
  sandbox.STATE_WAIT = 3;
  sandbox.trap = function () { return -1; };
  sandbox.window = sandbox;
  sandbox.document = { getElementById: function () { return null; } };
  sandbox.Config = { get: function () { return null; } };
  sandbox.vt52Initialize = function () { return null; };
  sandbox.vt52Write = function () { return null; };
  sandbox.vt52Get = function () { return null; };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  vm.createContext(sandbox);
  vm.runInContext(
    insertData + "\n" + requestInterrupt + "\n" + dl11 +
      "\n; this.dev = dl11(0, 0o60);",
    sandbox
  );
  return sandbox;
}

async function legacyStall() {
  const s = loadLegacy();
  const dev = s.dev;
  // Queue two bytes: the first is placed in RBUF, the second must follow.
  s.window.__yapdpBridge.dlReceiveQueue(0, [0x41, 0x42]);
  await delay(30);

  // The guest takes the first byte. Before the fix the second never arrived.
  assert.strictEqual(dev.access(RBUF, -1, false), 0x41, "legacy: first byte is 'A'");
  await delay(40);
  assert.strictEqual(dev.access(RBUF, -1, false), 0x42,
    "legacy: the second byte must arrive after RBUF is read — a mistimed timer " +
    "left receiverBusy set and nothing resumed the feed (see dlPump in iopage.js)");
}

// ----------------------------------------------------------------------
// Core stack: the same shape, on src/devices/dl11.js.
// ----------------------------------------------------------------------

async function coreStall() {
  const { ConsoleDL11 } = require(path.join(__dirname, "..", "src", "devices", "dl11.js"));
  const machine = {
    io: { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) },
    interruptRequests: [],
    cpu: { interruptRequests: [] },
  };
  const dev = new ConsoleDL11(machine, "console", { unit: 0, vector: 0o60 });

  dev.receive([0x41, 0x42]);
  await delay(30);
  assert.strictEqual(dev.rbuf, 0x41, "core: first byte is 'A'");

  // Read RBUF through the device's own bus access path — the same call the
  // guest makes. Only a read value (data < 0) counts.
  const taken = dev.access(0o2, -1, false);
  assert.strictEqual(taken, 0x41, "core: the guest reads 'A'");
  assert.strictEqual(dev.rcsr & DL_RCSR_DONE, 0, "core: reading RBUF clears DONE");

  await delay(40);
  assert.strictEqual(dev.rbuf, 0x42,
    "core: the second byte must arrive after RBUF is read — the same mistimed " +
    "timer applies to _pump in src/devices/dl11.js");

  // And reset must not leave a feed in flight: after a bus reset the receiver
  // is free and the flag is clear, so a later feed starts from a clean state.
  dev.receive([0x43]);
  dev.reset();
  assert.strictEqual(dev.receiverBusy, false,
    "core: reset must clear receiverBusy, or every later _pump returns at once");
  assert.strictEqual(dev._timer, null,
    "core: reset must cancel a feed timer that is still scheduled");
}

async function run() {
  await legacyStall();
  console.log("OK  legacy: the queue keeps moving after RBUF is read");

  await coreStall();
  console.log("OK  core:   the queue keeps moving after RBUF is read");
  console.log("OK  core:   reset leaves no feed in flight");

  console.log("dl11 feed-stall tests: all passed");
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
