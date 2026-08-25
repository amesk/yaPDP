#!/usr/bin/env node
/**
 * DiskStore write-back cache modular tests.
 *
 * These tests extract the DiskStore, createCache, and fetchBlock sections
 * directly from the real source file (src/iopage.js) so they exercise the
 * actual production code rather than a copy, then run them in an isolated
 * VM context with a lightweight in-memory IndexedDB stub.
 *
 * Run with:  node tests/diskstore.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "iopage.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level declaration
// (same helper as dataloader.test.js)
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error("marker not found: " + startMarker);
  }
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) {
    throw new Error("no opening brace for: " + startMarker);
  }
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        if (tail) {
          const rest = src.slice(i + 1, i + 1 + tail.length);
          if (rest !== tail) {
            throw new Error("expected tail '" + tail + "' after " + startMarker);
          }
          return src.slice(start, i + 1 + tail.length);
        }
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

// ------------------------------------------------------------------
// Minimal in-memory IndexedDB stub
// ------------------------------------------------------------------
// Supports the subset of the API DiskStore uses: open(), objectStore,
// transaction, put/get/delete/getAllKeys/clear, onupgradeneeded.
function makeFakeIndexedDB() {
  const store = new Map(); // key -> value
  const listeners = [];

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
    _store: store
  };

  const fakeDB = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => {
      const tx = { oncomplete: null, onerror: null };
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
      tx.objectStore = () => objectStore;
      return tx;
    }
  };

  const req = {
    result: fakeDB,
    onupgradeneeded: null, onsuccess: null, onerror: null,
    _fire() { if (this.onsuccess) this.onsuccess(); }
  };

  const indexedDB = {
    open: () => {
      // Fire success on next tick (mirrors async reality); onsuccess is
      // assigned synchronously right after open() returns, so this fires
      // after the handler is installed.
      setTimeout(() => req._fire(), 0);
      return req;
    },
    _store: store,
  };
  return indexedDB;
}

function buildSandbox() {
  const fakeIDB = makeFakeIndexedDB();
  return {
    console,
    Uint8Array,
    Uint16Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    setTimeout,
    clearInterval,
    setInterval: () => 0, // no real periodic flush in tests
    indexedDB: fakeIDB,
    fzstd: { decompress: null },
    downLoadAdd: () => {},
  };
}

function loadSections() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const ioBlockSize = "const IO_BLOCKSIZE = 131072;";
  const diskStore = extractBlock(src, "var DiskStore = (() => {", ")();");
  const createCache = extractBlock(src, "function createCache(cache, block, dataView)");
  const fetchBlock = extractBlock(src, "async function fetchBlock(controlBlock, block)");
  const imageError = extractBlock(src, "function imageError(reason, message)");
  const assertCompleteImage = extractBlock(src, "function assertCompleteImage(response, buffer, url)");
  return { ioBlockSize, diskStore, createCache, fetchBlock, imageError, assertCompleteImage };
}

function makeContext(sandbox, sections) {
  const code = [
    sections.ioBlockSize,
    "var DataLoader;",
    sections.diskStore,
    sections.createCache,
    sections.imageError,
    sections.assertCompleteImage,
    sections.fetchBlock,
    "var _fetchCalls = 0;",
    "async function __fetch() { _fetchCalls++; return { ok:false, status:404, arrayBuffer: async () => new ArrayBuffer(0) }; }",
    "fetch = __fetch;",
  ].join("\n");

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  Object.defineProperty(sandbox, "__fetchCalls", {
    get: () => sandbox._fetchCalls,
  });
  return sandbox;
}

function makeCtrl(url, compressed) {
  return { cache: [], url, compressed: !!compressed };
}

async function run() {
  const sections = loadSections();

  // ---- Test 1: markDirty + flush persists a block to IDB -----------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    const ctrl = makeCtrl("rk0.dsk", true);
    ctrl.cache[0] = new Uint16Array(131072 >>> 1);
    ctrl.cache[0][0] = 0xABCD;
    ctrl.cache[0][1] = 0x1234;

    DiskStore.markDirty(ctrl, 0);
    assert.strictEqual(DiskStore.hasDirty("rk0.dsk"), true);

    await DiskStore.flush("rk0.dsk");
    assert.strictEqual(DiskStore.hasDirty("rk0.dsk"), false, "dirty cleared after flush");

    const saved = await DiskStore.getBlock("rk0.dsk", 0);
    assert.ok(saved instanceof Uint8Array, "saved block is Uint8Array");
    assert.strictEqual(saved.length, 131072, "saved block is full IO_BLOCKSIZE bytes");
    assert.strictEqual(saved[0], 0xCD, "little-endian low byte");
    assert.strictEqual(saved[1], 0xAB, "little-endian high byte");
    console.log("PASS test 1: markDirty + flush persists a block to IDB");
  }

  // ---- Test 2: getBlock returns undefined for never-written block ----
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();
    const saved = await DiskStore.getBlock("rk0.dsk", 7);
    assert.strictEqual(saved, undefined);
    console.log("PASS test 2: getBlock undefined for unwritten block");
  }

  // ---- Test 3: fetchBlock serves saved block without network --------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    // Write a distinctive pattern to block 3 of rp1.dsk.
    const ctrl = makeCtrl("rp1.dsk", true);
    ctrl.cache[3] = new Uint16Array(131072 >>> 1);
    for (let i = 0; i < 8; i++) ctrl.cache[3][i] = 0xDEAD + i;
    DiskStore.markDirty(ctrl, 3);
    await DiskStore.flush("rp1.dsk");

    // New control block (fresh page state) — fetchBlock must overlay.
    const ctrl2 = makeCtrl("rp1.dsk", true);
    const status = await sb.fetchBlock(ctrl2, 3);
    assert.strictEqual(status, 200);
    assert.strictEqual(sb.__fetchCalls, 0, "no network fetch for saved block");
    assert.ok(ctrl2.cache[3], "block populated");
    assert.strictEqual(ctrl2.cache[3][0], 0xDEAD);
    assert.strictEqual(ctrl2.cache[3][7], 0xDEAD + 7);
    console.log("PASS test 3: fetchBlock overlays saved block without network");
  }

  // ---- Test 4: listDirty / dirtyBlockCount --------------------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    const ctrl = makeCtrl("rk2.dsk", true);
    ctrl.cache[0] = new Uint16Array(131072 >>> 1);
    ctrl.cache[1] = new Uint16Array(131072 >>> 1);
    DiskStore.markDirty(ctrl, 0);
    DiskStore.markDirty(ctrl, 1);
    await DiskStore.flush("rk2.dsk");

    assert.deepStrictEqual(JSON.parse(JSON.stringify(DiskStore.listDirty())), ["rk2.dsk"]);
    assert.strictEqual(DiskStore.dirtyBlockCount("rk2.dsk"), 2);
    console.log("PASS test 4: listDirty / dirtyBlockCount");
  }

  // ---- Test 5: clear discards saved blocks --------------------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    const ctrl = makeCtrl("rl0.dsk", true);
    ctrl.cache[0] = new Uint16Array(131072 >>> 1);
    ctrl.cache[0][0] = 0xBEEF;
    DiskStore.markDirty(ctrl, 0);
    await DiskStore.flush("rl0.dsk");
    assert.strictEqual((await DiskStore.getBlock("rl0.dsk", 0)) !== undefined, true);

    await DiskStore.clear("rl0.dsk");
    assert.strictEqual((await DiskStore.getBlock("rl0.dsk", 0)), undefined);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(DiskStore.listDirty())), []);
    console.log("PASS test 5: clear discards saved blocks");
  }

  // ---- Test 6: clearAll discards everything -------------------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    for (const url of ["rk0.dsk", "rk1.dsk"]) {
      const ctrl = makeCtrl(url, true);
      ctrl.cache[0] = new Uint16Array(131072 >>> 1);
      DiskStore.markDirty(ctrl, 0);
      await DiskStore.flush(url);
    }
    assert.strictEqual(DiskStore.listDirty().length, 2);

    await DiskStore.clearAll();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(DiskStore.listDirty())), []);
    assert.strictEqual((await DiskStore.getBlock("rk0.dsk", 0)), undefined);
    console.log("PASS test 6: clearAll discards everything");
  }

  // ---- Test 7: flush with no dirty blocks resolves false ------------
  {
    const sb = buildSandbox();
    makeContext(sb, sections);
    const DiskStore = sb.DiskStore;
    await DiskStore.init();
    const ok = await DiskStore.flush("rk0.dsk");
    assert.strictEqual(ok, false);
    console.log("PASS test 7: flush with no dirty blocks resolves false");
  }

  console.log("\nAll DiskStore tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
