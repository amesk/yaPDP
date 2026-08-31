#!/usr/bin/env node
/**
 * Headless write-back tests — the full guest write path on the NEW
 * headless machine layer (no iopage.js, no browser).
 *
 *   1. RT-11 boots headlessly; the guest creates a file (COPY) — real
 *      writes land in the DiskService cache and are marked dirty.
 *   2. flushDrive() pushes dirty blocks to the provider's writeBlock,
 *      which writes back into the in-memory image (overlay).
 *   3. A fresh machine boots from the written-back imageBytes — DIR must
 *      show the file and TYPE must print it (the write survived).
 *
 * This is the headless-stack twin of tests/disk-path.test.js (which runs
 * the iopage.js machine); it anchors the write-back contract of
 * bootHeadless ({ writeBlock, imageBytes }).
 *
 * Run with:  node tests/writeback.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootHeadless } = require("../tools/headless-machine.js");

const bytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootRT11(opts = {}) {
  return bootHeadless(Object.assign({
    image: "media/rk1.dsk.zst",
    urlName: "rk1.dsk",
    bootCmd: "BOOT RK1\r",
    timeoutMs: 60000,
  }, opts));
}

async function sendLine(r, line, timeoutMs = 20000) {
  const before = r.getOut().length;
  r.machine.findDevice("console").receive(bytes(line + "\r"));
  const t0 = Date.now();
  let tail = "";
  do {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("timeout waiting for prompt after '" + line + "'\nreply so far:\n" + tail);
    }
    await sleep(100);
    tail = r.getOut().slice(before);
  } while (!/^\.[\s]*$/.test(tail.slice(tail.lastIndexOf("\n") + 1)));
  return tail;
}

async function sendAndWait(r, line, marker, timeoutMs = 20000) {
  const before = r.getOut().length;
  r.machine.findDevice("console").receive(bytes(line + "\r"));
  const t0 = Date.now();
  let tail = "";
  do {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("timeout waiting for '" + marker + "' after '" + line + "'\nreply so far:\n" + tail);
    }
    await sleep(100);
    tail = r.getOut().slice(before);
  } while (tail.indexOf(marker) === -1);
  return tail;
}

async function run() {
  // ---- Test 1: guest write path marks blocks dirty ------------------
  const m1 = await bootRT11();
  const copyReply = await sendLine(m1, "COPY V4USER.TXT TEST.TXT");
  assert.ok(copyReply.indexOf("?") === -1,
    "COPY succeeded without an error reply");

  const dirty = m1.machine.disk.dirtyBlockCount("rk1.dsk");
  assert.ok(dirty > 0, "guest write marked blocks dirty (got " + dirty + ")");
  console.log("PASS test 1: guest COPY wrote " + dirty + " dirty block(s)");

  // ---- Test 2: flushDrive pushes them into the in-memory image -------
  await m1.machine.disk.flushDrive("rk1.dsk");
  assert.strictEqual(m1.machine.disk.dirtyBlockCount("rk1.dsk"), 0,
    "no dirty blocks after flushDrive");
  const pristine = await bootHeadless({
    image: "media/rk1.dsk.zst", urlName: "rk1.dsk",
    bootCmd: "BOOT RK1\r", timeoutMs: 60000,
  });
  const imageChanged = !Buffer.from(m1.imageBytes).equals(Buffer.from(pristine.imageBytes));
  assert.ok(imageChanged, "written-back image differs from the pristine image");
  console.log("PASS test 2: flushDrive persisted the write into the image");

  // ---- Test 3: the write survives a fresh boot from imageBytes -------
  const m2 = await bootRT11({ imageBytes: m1.imageBytes });
  const dirReply = await sendAndWait(m2, "DIR", "Free blocks");
  assert.ok(/TEST\s+\.TXT/.test(dirReply),
    "DIR shows TEST.TXT after reboot from written-back image");
  const typeReply = await sendAndWait(m2, "TYPE TEST.TXT", "Welcome to RT-11");
  assert.ok(typeReply.indexOf("Welcome to RT-11") !== -1,
    "TYPE TEST.TXT prints the copied contents");
  console.log("PASS test 3: file survives reboot via imageBytes (DIR + TYPE)");

  // ---- Test 4: pristine image does NOT have the file (control) -------
  const dir3 = await sendAndWait(pristine, "DIR", "Free blocks");
  assert.ok(!/TEST\s+\.TXT/.test(dir3),
    "pristine image has no TEST.TXT (control for the overlay)");
  console.log("PASS test 4: pristine image has no TEST.TXT (control)");

  console.log("\nAll writeback tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
