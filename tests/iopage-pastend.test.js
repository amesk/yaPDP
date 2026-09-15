#!/usr/bin/env node
/**
 * iopage fetchBlock(): reads PAST the end of a mounted image.
 *
 * Regression anchor for a silent hang. createCache() with zero-length data
 * creates NO cache block, so a read whose cache block lies past the end of the
 * image stayed a cache miss: diskIO() re-entered fetchBlock() forever, the
 * guest never received a completion and the machine simply stopped producing
 * output. This bites a short dropped `.tap`/`.dsk`, an HTTP 416 range answer
 * and a truncated `.zst` image alike.
 *
 * fetchBlock() must materialise an explicit all-zero block instead - the same
 * guard the headless DiskService has (src/devices/disk-service.js, _loadBlock).
 * Reading zeros is also the semantics the tape controllers need past EOF: a
 * zero record length is a tape mark, so the guest stops instead of stalling.
 *
 * Exercises the legacy iopage stack (?core=0), which is where fetchBlock()
 * lives; the emulator is booted headless through tools/headless-boot.js.
 *
 * Run with:  node tests/iopage-pastend.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootRT11 } = require("../tools/headless-boot.js");

const OP_ACCUM = 4;   // tape record-length accumulation
const OP_READ = 2;    // disk/tape data copy
const SHORT_IMAGE = 1000; // one partial cache block, block 1 is past the end

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until the guest-side counter reaches `want` (the CPU loop drains the
// scheduled disk callbacks, so this is what "the read completed" means).
async function waitFor(r, expr, want, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (r.evalIn(expr) >= want) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await sleep(25);
  }
}

async function run() {
  const r = await bootRT11({ timeoutMs: 60000 });
  try {
    // ---- test 1: OP_ACCUM (tape record length) past the end of the image ----
    // A 1000-byte image mounted locally: block 1 starts at 131072, well past
    // its end. Before the fix cache[1] stayed undefined and this never
    // completed.
    r.evalIn("DataLoader.mount('short.tap', new Uint8Array(" + SHORT_IMAGE + "))");
    r.evalIn(`
      var __fetchCalls = 0;
      (function () {
        var orig = fetchBlock;
        fetchBlock = function () { __fetchCalls++; return orig.apply(null, arguments); };
      })();
      var __completions = 0;
      var __lastAddress = -1;
      var __lastCode = -1;
      var __cb1 = {
        cache: [], url: 'short.tap', position: IO_BLOCKSIZE, command: 0,
        callback: function (cb, code, position, address) {
          __completions++; __lastCode = code; __lastAddress = address;
        }
      };
      diskIO(__cb1, ${OP_ACCUM}, IO_BLOCKSIZE, 0, 4, null);
    `);

    const done1 = await waitFor(r, "__completions", 1, 5000);
    assert.ok(done1, "OP_ACCUM past the end of the image completes (no stuck retry)");

    const block1 = r.evalIn("__cb1.cache[1] !== undefined");
    assert.ok(block1, "an explicit cache block exists past the end of the image");
    assert.strictEqual(r.evalIn("__cb1.cache[1].length"),
      r.evalIn("IO_BLOCKSIZE >>> 1"), "the empty block is a full-size word block");
    assert.strictEqual(r.evalIn("__cb1.cache[1][0]"), 0, "the empty block reads as zeros");
    assert.strictEqual(r.evalIn("__lastCode"), 0, "the read completes successfully (code 0)");
    // Zeros accumulate into address 0 = a tape mark, so a tape guest sees EOF.
    assert.strictEqual(r.evalIn("__lastAddress"), 0,
      "a zero record length past EOF accumulates to address 0 (tape mark)");
    console.log("PASS test 1: OP_ACCUM past EOF completes, zeros -> tape mark");

    // ---- test 2: fetchBlock is not re-entered forever ----
    // A stuck read called it once per retry, without bound.
    assert.ok(r.evalIn("__fetchCalls") <= 3,
      "fetchBlock entered a bounded number of times (got " + r.evalIn("__fetchCalls") + ")");
    console.log("PASS test 2: fetchBlock called " + r.evalIn("__fetchCalls") +
      " time(s), no infinite retry");

    // ---- test 3: OP_READ (data copy) past the end of the image ----
    r.evalIn(`
      var __readDone = 0;
      var __cb2 = {
        cache: [], url: 'short.tap', position: IO_BLOCKSIZE + 4, command: 0,
        callback: function () { __readDone++; }
      };
      diskIO(__cb2, ${OP_READ}, IO_BLOCKSIZE + 4, 0o400000, 16, null);
    `);
    const done2 = await waitFor(r, "__readDone", 1, 5000);
    assert.ok(done2, "OP_READ past the end of the image completes");
    assert.strictEqual(r.evalIn("__readDone"), 1,
      "the data copy completes exactly once (no repeated rescheduling)");
    console.log("PASS test 3: OP_READ past EOF completes once");

    console.log("\nAll iopage past-end tests passed.");
  } finally {
    // Stop the CPU loop so the process can exit.
    r.halt();
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
