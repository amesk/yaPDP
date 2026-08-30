#!/usr/bin/env node
/**
 * Disk-path headless tests — the full guest write-back loop in Node.
 *
 * Closes the disk-path coverage gap: the DiskStore unit tests exercise the
 * cache API in isolation, and the browser e2e exercises one block in a real
 * browser — but nothing drove the REAL guest-OS write path (CPU -> diskIO
 * OP_WRITE -> cache -> markDirty -> flush -> overlay on next boot) without
 * a browser. This test does exactly that, using the headless machine:
 *
 *   1. RT-11 boots headlessly, the guest creates a file (COPY) — real
 *      writes land in the disk cache and are reported to DiskStore.
 *   2. flushAll() persists the dirty blocks into the (in-memory) IndexedDB
 *      stub — the write-back half of the loop.
 *   3. A fresh machine context boots with those saved blocks overlaid on
 *      the pristine image (the restore half) — DIR must show the file and
 *      TYPE must print its contents.
 *
 * This is the scenario the 2.11 BSD "bad free count" bug lived in
 * (save/restore with a write-back overlay), so the test is also a
 * regression anchor for it.
 *
 * Run with:  node tests/disk-path.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { bootRT11 } = require("../tools/headless-boot.js");

// ------------------------------------------------------------------
// In-memory IndexedDB stub (same shape as tests/diskstore.test.js),
// with optional pre-seeded entries for the restore scenario.
// ------------------------------------------------------------------
function makeFakeIndexedDB(seed) {
  const store = new Map(seed || []);

  const objectStore = {
    put(value, key) { store.set(key, value); },
    get(key) {
      const req = { onsuccess: null, onerror: null, result: store.get(key) };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    delete(key) { store.delete(key); },
    getAllKeys() {
      const req = {
        onsuccess: null, onerror: null, result: Array.from(store.keys()),
      };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    clear() { store.clear(); },
    _store: store,
  };

  const fakeDB = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => {
      const tx = { oncomplete: null, onerror: null };
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
      tx.objectStore = () => objectStore;
      return tx;
    },
  };

  const req = {
    result: fakeDB,
    onupgradeneeded: null, onsuccess: null, onerror: null,
    _fire() { if (this.onsuccess) this.onsuccess(); },
  };

  const indexedDB = {
    open: () => {
      setTimeout(() => req._fire(), 0);
      return req;
    },
    _store: store,
  };
  return indexedDB;
}

// Send a line to the guest console and wait for a fresh "." prompt.
async function sendLine(sandbox, getOut, line, timeoutMs = 20000) {
  const before = getOut().length;
  sandbox.window.dlReceiveQueue(0, Array.from(line + "\r").map((c) => c.charCodeAt(0)));
  const t0 = Date.now();
  let tail = "";
  do {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("timeout waiting for prompt after '" + line + "'\nreply so far:\n" + tail);
    }
    await new Promise((r) => setTimeout(r, 100));
    tail = getOut().slice(before);
  } while (!/^\.[\s]*$/.test(tail.slice(tail.lastIndexOf("\n") + 1)));
  return tail;
}

// Send a line and wait until its reply contains a marker (no prompt wait —
// for commands whose output ends before the prompt, e.g. DIR's footer).
async function sendAndWait(sandbox, getOut, line, marker, timeoutMs = 20000) {
  const before = getOut().length;
  sandbox.window.dlReceiveQueue(0, Array.from(line + "\r").map((c) => c.charCodeAt(0)));
  const t0 = Date.now();
  let tail = "";
  do {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("timeout waiting for '" + marker + "' after '" + line + "'\nreply so far:\n" + tail);
    }
    await new Promise((r) => setTimeout(r, 100));
    tail = getOut().slice(before);
  } while (tail.indexOf(marker) === -1);
  return tail;
}

async function run() {
  // ==================================================================
  // Test 1: guest write path — COPY creates a file, write-back persists
  // ==================================================================
  const idb1 = makeFakeIndexedDB();
  const m1 = await bootRT11({ indexedDB: idb1 });

  // The guest copies V4USER.TXT -> TEST.TXT. Real disk writes happen:
  // a data block for the new file plus the directory blocks, all reported
  // to DiskStore.markDirty() by diskIO(OP_WRITE).
  const copyReply = await sendLine(m1.sandbox, m1.getOut, "COPY V4USER.TXT TEST.TXT");
  assert.ok(copyReply.indexOf("?") === -1, "COPY succeeded without an error reply");

  // Write-back: flush dirty blocks into the (stub) IndexedDB.
  await m1.evalIn("DiskStore.flushAll()");
  assert.strictEqual(m1.evalIn("DiskStore.hasDirty('rk1.dsk')"), false,
    "no pending dirty blocks after flushAll");

  const savedKeys = Array.from(idb1._store.keys());
  const blockKeys = savedKeys.filter((k) => /^rk1\.dsk::[0-9]+$/.test(k));
  assert.ok(blockKeys.length > 0,
    "dirty blocks persisted to IDB (got " + blockKeys.length + ": " + savedKeys.join(", ") + ")");
  const meta = idb1._store.get("rk1.dsk::meta");
  assert.ok(meta && Array.isArray(meta.blocks) && meta.blocks.length > 0,
    "per-image meta record lists saved blocks");
  m1.halt(); // stop this machine — it would otherwise keep emulating at full speed
  console.log("PASS test 1: guest COPY wrote " + blockKeys.length +
    " dirty block(s) -> flushAll persisted them to IDB");

  // ==================================================================
  // Test 2: restore — the write survives a fresh boot (overlay)
  // ==================================================================
  // A brand-new machine context, same "disk" (saved blocks overlaid on the
  // pristine image) — exactly what a page reload / snapshot restore does.
  const idb2 = makeFakeIndexedDB(Array.from(idb1._store.entries()));
  const m2 = await bootRT11({ indexedDB: idb2 });

  const dirReply = await sendAndWait(m2.sandbox, m2.getOut, "DIR", "Free blocks");
  assert.ok(/TEST\s+\.TXT/.test(dirReply),
    "DIR shows TEST.TXT after restore (file survived the reboot)");

  // And the content is the copied text, not garbage or an empty block.
  const typeReply = await sendAndWait(m2.sandbox, m2.getOut, "TYPE TEST.TXT", "Welcome to RT-11");
  assert.ok(typeReply.indexOf("Welcome to RT-11") !== -1,
    "TYPE TEST.TXT prints the copied contents");
  m2.halt();
  console.log("PASS test 2: file survives reboot — DIR + TYPE see the overlaid write");

  // ==================================================================
  // Test 3: pristine machine does NOT see the file (control)
  // ==================================================================
  // Without the saved blocks, the same disk must not contain TEST.TXT —
  // proving test 2's result came from the write-back overlay, not from
  // the base image.
  const m3 = await bootRT11({}); // no IDB, no saved blocks
  const dir3 = await sendAndWait(m3.sandbox, m3.getOut, "DIR", "Free blocks");
  assert.ok(!/TEST\s+\.TXT/.test(dir3),
    "pristine image has no TEST.TXT (control for the overlay)");
  console.log("PASS test 3: pristine image has no TEST.TXT (control)");

  console.log("\nAll disk-path tests passed.");
  process.exit(0); // the sandbox keeps interval timers alive — exit explicitly
}

run().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
