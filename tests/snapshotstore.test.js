#!/usr/bin/env node
/**
 * SnapshotStore modular tests.
 *
 * Extracts the SnapshotStore IIFE from the real src/snapshots.js and runs
 * it in an isolated VM context with:
 *   - a fake in-memory IndexedDB (same stub pattern as diskstore.test.js)
 *   - a minimal CPU stub (registers + memory as Uint16Array)
 *   - native CompressionStream/DecompressionStream (Node >= 18)
 *
 * Run with:  node tests/snapshotstore.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "snapshots.js");
const STATE_FORMAT_PATH = path.join(__dirname, "..", "src", "state-format.js");
const SF_SOURCE = fs.readFileSync(STATE_FORMAT_PATH, "utf8");
// src/state-frame.js — the frame contract (zstd / gzip / bare) the store reads
// its .state bytes through. Loaded into the sandbox after state-format.js, in
// the same order the page loads them.
const STATE_FRAME_PATH = path.join(__dirname, "..", "src", "state-frame.js");
const FRAME_SOURCE = fs.readFileSync(STATE_FRAME_PATH, "utf8");

// ------------------------------------------------------------------
// Extract the SnapshotStore IIFE (balanced braces)
// ------------------------------------------------------------------
function extractIIFE(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error("marker not found: " + startMarker);
  const braceOpen = src.indexOf("{", start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        // IIFE ends with })(); — swallow the trailing call too
        return src.slice(start, i + 2 + 2); // "})();" is 4 chars from '}'
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

// ------------------------------------------------------------------
// Fake in-memory IndexedDB (auto-fires onsuccess via setTimeout)
// ------------------------------------------------------------------
function makeFakeIndexedDB() {
  const store = new Map();

  const objectStore = {
    put(value, key) { store.set(key, value); },
    get(key) {
      const req = { onsuccess: null, onerror: null, result: store.get(key) };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    getAll() {
      const req = { onsuccess: null, onerror: null, result: Array.from(store.values()) };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    delete(key) { store.delete(key); },
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

  const req = { result: fakeDB, onupgradeneeded: null, onsuccess: null, onerror: null };
  const indexedDB = {
    open: () => {
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    _store: store
  };
  return indexedDB;
}

// Minimal in-memory DiskStore: enough of the production surface for the
// machine-state tests to exercise the write-back OVERLAY (the blocks a guest
// wrote, e.g. COPY onto a disk) through save/export/import/restore. The real
// module normalises block bytes on restore (src/diskstore.js); this double
// mirrors that so a broken serialisation in src/snapshots.js is what a test
// failure points at.
function makeFakeDiskStore() {
  const images = new Map(); // url -> { fp, blocks: Map(block -> Uint8Array) }
  function image(url) {
    let im = images.get(url);
    if (!im) { im = { fp: null, blocks: new Map() }; images.set(url, im); }
    return im;
  }
  function normalizeBytes(v) {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (Array.isArray(v)) return Uint8Array.from(v);
    if (v && typeof v === "object") return new Uint8Array(Object.values(v));
    return new Uint8Array(0);
  }
  return {
    IMAGE_VERSION: "0.1.0",
    // test helpers
    setBlock(url, block, bytes) { image(url).blocks.set(block, Uint8Array.from(bytes)); },
    getBlockBytes(url, block) {
      const im = images.get(url);
      const b = im && im.blocks.get(block);
      return b ? Uint8Array.from(b) : undefined;
    },
    setFingerprint(url, fp) { image(url).fp = fp; },
    // production-facing API
    fingerprintOf(url) { const im = images.get(url); return im ? im.fp : null; },
    captureOverlay() {
      const out = {};
      images.forEach((im, url) => {
        if (im.blocks.size === 0) return;
        const blocks = {};
        im.blocks.forEach((bytes, b) => { blocks[b] = Uint8Array.from(bytes); });
        out[url] = { v: im.fp, blocks: blocks };
      });
      return Promise.resolve(out);
    },
    restoreOverlay(overlay) {
      if (!overlay || typeof overlay !== "object") return Promise.resolve();
      Object.keys(overlay).forEach((url) => {
        const rec = overlay[url] || {};
        const im = image(url);
        im.blocks = new Map();
        const raw = rec.blocks || {};
        Object.keys(raw).forEach((b) => {
          im.blocks.set(parseInt(b, 10), normalizeBytes(raw[b]));
        });
        if (rec.v !== undefined) im.fp = rec.v;
      });
      return Promise.resolve();
    },
    clearAll() { images.forEach((im) => { im.blocks = new Map(); }); return Promise.resolve(); },
  };
}

function buildSandbox() {
  const fakeIDB = makeFakeIndexedDB();
  const cpu = {
    runState: 3, // STATE_HALT
    PSW: 0xf,
    registerVal: new Uint16Array(8),
    registerAlt: new Uint16Array(6),
    stackPointer: new Uint16Array(4),
    mmuPAR: new Uint16Array(64),
    mmuPDR: new Uint16Array(64),
    unibusMap: new Uint32Array(32),
    memory: new Uint16Array(4096), // small test RAM
    MMR0: 0,
    flagC: NaN,
    displayAddress: 0,
  };
  // Fill memory with a known pattern.
  for (let i = 0; i < cpu.memory.length; i++) cpu.memory[i] = (i * 7) & 0xffff;

  return {
    console,
    Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView,
    Map, Set, Promise,
    setTimeout, clearTimeout, setInterval: () => 0,
    indexedDB: fakeIDB,
    CompressionStream, DecompressionStream,
    // src/state-format.js — the shared container (loaded into the sandbox by
    // loadSnapshotStore; declared here so captureMemory can reach it).
    StateFormat: undefined,
    // src/state-frame.js — the frame around that container, same treatment.
    StateFrame: undefined,
    Response,
    TextEncoder, TextDecoder,
    STATE_HALT: 3,
    STATE_RUN: 0,
    CPU: cpu,
    DataLoader: {
      list: () => ["rk0.dsk", "rk1.dsk"],
    },
    iopage: {
      _devices: { "17777560": { rcsr: 0x80, iMask: 0 }, "17777400": { rkcs: 0x80, iMask: 1 } },
      snapshotDevices() { return JSON.parse(JSON.stringify(this._devices)); },
      restoreDevices(state) { this._devices = JSON.parse(JSON.stringify(state)); },
    },
    DiskStore: makeFakeDiskStore(),
    Config: {
      _cfg: { consoleType: "teletype", userTerminals: 0, printer: false, vt11: false },
      get() { return Object.assign({}, this._cfg); },
      set(patch) { Object.assign(this._cfg, patch); },
    },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    location: { reload: () => { /* no-op in tests */ } },
    document: {
      getElementById: () => null,
      addEventListener: () => {},
    },
    window: {
      paperTape: {
        _buffer: [0x11, 0x22, 0x33],
        snapshot() { return { buffer: this._buffer.slice() }; },
        restore(bytes) { this._buffer = bytes ? bytes.slice() : []; },
      },
    },
  };
}

// Run the extracted IIFE in the sandbox and return the module.
function loadSnapshotStore(sb) {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = extractIIFE(src, "var SnapshotStore = (() => {");
  vm.createContext(sb);
  // The shared state container first: SnapshotStore delegates the FORMAT to
  // it (src/state-format.js), so it must be in the sandbox before the store.
  // We also expose it on the sandbox object so the test can drive it directly.
  vm.runInContext(SF_SOURCE, sb);
  sb.StateFormat = vm.runInContext("StateFormat", sb);
  // The frame contract next: the store reads .state bytes (zstd, gzip, or a
  // bare container) through it, so it must be there before the store.
  vm.runInContext(FRAME_SOURCE, sb);
  sb.StateFrame = vm.runInContext("StateFrame", sb);
  vm.runInContext(code, sb);
  return sb.SnapshotStore;
}

async function run() {
  // ---- Test 1: save() captures CPU + RAM, list() shows it -----------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    const snap = await SS.save("test snapshot");
    assert.ok(snap.id, "snapshot has id");
    assert.strictEqual(snap.name, "test snapshot");
    assert.strictEqual(snap.schemaVersion, SS.SCHEMA_VERSION);
    // Image identity is now COMPUTED (a fingerprint per mounted url), not a
    // hand-maintained version string. No DiskStore in this sandbox means no
    // fingerprints were learned, which is recorded as an empty map — and an
    // empty map, like an unknown fingerprint, never refuses a restore.
    // (deepStrictEqual would compare prototypes across the VM realm)
    assert.strictEqual(Object.keys(snap.imageFingerprints || {}).length, 0);
    assert.deepStrictEqual(snap.mounted, ["rk0.dsk", "rk1.dsk"]);
    assert.ok(snap.memory.data instanceof ArrayBuffer, "RAM is ArrayBuffer");
    assert.strictEqual(snap.memory.format, "gzip");
    assert.deepStrictEqual(snap.devices, {
      "17777560": { rcsr: 0x80, iMask: 0 },
      "17777400": { rkcs: 0x80, iMask: 1 },
    }, "devices captured (L2)");

    const items = await SS.list();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].name, "test snapshot");
    console.log("PASS test 1: save() captures CPU/RAM/mounted, list() works");
  }

  // ---- Test 2: rename / remove --------------------------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    const snap = await SS.save("original");
    await SS.rename(snap.id, "renamed");
    let items = await SS.list();
    assert.strictEqual(items[0].name, "renamed");

    await SS.remove(snap.id);
    items = await SS.list();
    assert.strictEqual(items.length, 0);
    console.log("PASS test 2: rename + remove");
  }

  // ---- Test 3: restore() puts CPU + RAM back -------------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    // Mutate the machine after the snapshot.
    sb.CPU.registerVal[7] = 0x1234; // PC
    sb.CPU.PSW = 0x1f;
    sb.CPU.memory[100] = 0xDEAD;

    const snap = await SS.save("pre-mutation");
    sb.CPU.registerVal[7] = 0x9999;
    sb.CPU.PSW = 0;
    sb.CPU.memory[100] = 0;

    const ok = await SS.restore(snap);
    assert.strictEqual(ok, true);
    assert.strictEqual(sb.CPU.registerVal[7], 0x1234, "PC restored");
    assert.strictEqual(sb.CPU.PSW, 0x1f, "PSW restored");
    assert.strictEqual(sb.CPU.memory[100], 0xDEAD, "RAM restored");
    // Whole RAM must match the pre-mutation pattern.
    assert.strictEqual(sb.CPU.memory[0], 0, "mem[0] restored from pattern");
    assert.strictEqual(sb.CPU.memory[1], 7, "mem[1] restored from pattern");
    console.log("PASS test 3: restore() restores CPU + full RAM");
  }

  // ---- Test 4: restore() with raw (non-gzip) memory ------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    // Build a raw snapshot manually: RAM words -> little-endian bytes.
    const words = sb.CPU.memory;
    const raw = new Uint8Array(words.length * 2);
    for (let i = 0; i < words.length; i++) {
      raw[i * 2] = words[i] & 0xff;
      raw[i * 2 + 1] = words[i] >>> 8;
    }
    const snap = {
      id: "snap-raw",
      name: "raw test",
      createdAt: Date.now(),
      schemaVersion: SS.SCHEMA_VERSION,
      imageVersion: "0.1.0",
      cpu: { runState: 3, PSW: 0xf, registerVal: { t: "u16", d: Array.from(new Uint16Array(8)) } },
      memory: { format: "raw", data: raw.buffer },
      mounted: [],
    };
    sb.CPU.memory[50] = 0xABCD;
    await SS.restore(snap);
    assert.strictEqual(sb.CPU.memory[50], (50 * 7) & 0xffff, "raw restore works");
    assert.strictEqual(sb.CPU.PSW, 0xf, "cpu fields restored from raw snapshot");
    console.log("PASS test 4: restore() raw memory path");
  }

  // ---- Test 5: load() sets pending key, init() applies it ------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    sb.CPU.registerVal[0] = 0x7777; // state to persist
    const snap = await SS.save("pending test");

    // "Reload": pending key set, then machine state changes before init
    // runs (as it would on a fresh page).
    await SS.load(snap.id);
    assert.ok(sb.localStorage.getItem("yapdp-pending-snapshot"), "pending key set");

    sb.CPU.registerVal[0] = 0; // machine changed before init
    const applied = await SS.init();
    assert.strictEqual(applied, true, "init applied pending snapshot");
    assert.strictEqual(sb.localStorage.getItem("yapdp-pending-snapshot"), null, "pending cleared");
    assert.strictEqual(sb.CPU.registerVal[0], 0x7777, "register restored via init");
    console.log("PASS test 5: load() + init() pending flow");
  }

  // ---- Test 6: MAX_SNAPSHOTS bounds the store ------------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    for (let i = 0; i < 12; i++) {
      await SS.save("snap " + i);
    }
    const items = await SS.list();
    assert.strictEqual(items.length, 10, "store capped at MAX_SNAPSHOTS");
    console.log("PASS test 6: MAX_SNAPSHOTS bound");
  }

  // ---- Test 7: restore() applies device registers (L2) ---------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    const snap = await SS.save("device test");
    assert.deepStrictEqual(snap.devices["17777400"], { rkcs: 0x80, iMask: 1 });

    // Mutate device state, then restore.
    sb.iopage._devices["17777400"] = { rkcs: 0, iMask: 0 };
    await SS.restore(snap);
    assert.deepStrictEqual(sb.iopage._devices["17777400"], { rkcs: 0x80, iMask: 1 }, "device regs restored");
    console.log("PASS test 7: restore() applies device registers (L2)");
  }

  // ---- Test 8: punched tape captured + restored (L2) ------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    const snap = await SS.save("tape test");
    assert.deepStrictEqual(snap.punchtape, { buffer: [0x11, 0x22, 0x33] }, "tape captured");

    // Mutate tape, then restore.
    sb.window.paperTape._buffer = [0xFF];
    await SS.restore(snap);
    assert.deepStrictEqual(sb.window.paperTape._buffer, [0x11, 0x22, 0x33], "tape restored");
    console.log("PASS test 8: punched tape captured + restored (L2)");
  }

  // ---- Test 9: snapshot captures the structural config (device set) ---
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.Config.set({ consoleType: "vt52", userTerminals: 1, printer: true, vt11: true });
    const snap = await SS.save("config test");
    // JSON round-trip: snap.config is created inside the VM realm, so its
    // prototype differs from a host literal (deepStrictEqual would fail).
    assert.deepStrictEqual(JSON.parse(JSON.stringify(snap.config)), {
      consoleType: "vt52", userTerminals: 1, printer: true, vt11: true,
    }, "structural config captured");
    console.log("PASS test 9: snapshot captures structural config");
  }

  // ---- Test 10: load() applies a differing hardware config -----------
  // Simulates: snapshot saved with a printer/VT52 console, then the user
  // quick-boots another OS (which changes consoleType/printer). load() must
  // apply the snapshot's config before the single reload, so the next boot
  // (init) restores with the correct device set.
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.Config.set({ consoleType: "vt52", userTerminals: 1, printer: true, vt11: true });
    sb.CPU.registerVal[0] = 0x4242;
    const snap = await SS.save("hw test");

    // User then quick-boots another OS: hardware config changes.
    sb.Config.set({ consoleType: "teletype", userTerminals: 0, printer: false, vt11: false });
    sb.CPU.registerVal[0] = 0;

    let reloads = 0;
    sb.location.reload = () => { reloads++; };

    await SS.load(snap.id);
    assert.strictEqual(reloads, 1, "load() reloads once");
    assert.ok(sb.localStorage.getItem("yapdp-pending-snapshot"), "pending key set for next boot");
    assert.deepStrictEqual(sb.Config.get(), {
      consoleType: "vt52", userTerminals: 1, printer: true, vt11: true,
    }, "snapshot hardware config applied before reload");

    // Next boot: config now matches, init restores directly.
    const applied = await SS.init();
    assert.strictEqual(applied, true, "init restores on the next boot");
    assert.strictEqual(reloads, 1, "no extra reload from init");
    assert.strictEqual(sb.localStorage.getItem("yapdp-pending-snapshot"), null, "pending cleared");
    assert.strictEqual(sb.CPU.registerVal[0], 0x4242, "register restored after config applied");
    console.log("PASS test 10: load() applies differing hardware config before reload");
  }

  // ---- Test 10b: init() safety net for config mismatch ----------------
  // If the pending snapshot was queued by something other than load() (or
  // the config changed between load() and boot), init() itself must apply
  // the snapshot's config, reload and keep the pending key.
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.Config.set({ consoleType: "vt52", userTerminals: 1, printer: true, vt11: true });
    sb.CPU.registerVal[0] = 0x5151;
    const snap = await SS.save("hw test 2");

    // Config changed after the snapshot was queued (e.g. quickboot raced).
    sb.Config.set({ consoleType: "teletype", userTerminals: 0, printer: false, vt11: false });
    sb.CPU.registerVal[0] = 0;

    let reloads = 0;
    sb.location.reload = () => { reloads++; };

    // Queue the pending snapshot directly (bypassing load()).
    sb.localStorage.setItem("yapdp-pending-snapshot", snap.id);
    const applied = await SS.init();
    assert.strictEqual(applied, false, "init defers restore on config mismatch");
    assert.strictEqual(reloads, 1, "init reloads to apply the device set");
    assert.ok(sb.localStorage.getItem("yapdp-pending-snapshot"), "pending key kept for second boot");
    assert.deepStrictEqual(sb.Config.get(), {
      consoleType: "vt52", userTerminals: 1, printer: true, vt11: true,
    }, "snapshot hardware config applied by init");

    // Second boot: config matches, restore proceeds.
    const applied2 = await SS.init();
    assert.strictEqual(applied2, true, "second boot restores");
    assert.strictEqual(sb.localStorage.getItem("yapdp-pending-snapshot"), null, "pending cleared");
    assert.strictEqual(sb.CPU.registerVal[0], 0x5151, "register restored after config applied");
    console.log("PASS test 10b: init() safety net applies config + keeps pending");
  }

  // ---- Test 11: old snapshots without config stay backward compatible --
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.Config.set({ consoleType: "vt52", userTerminals: 1, printer: true, vt11: true });
    sb.CPU.registerVal[0] = 0x5151;
    const snap = await SS.save("old-style");
    delete snap.config; // simulate a pre-config snapshot

    sb.CPU.registerVal[0] = 0;
    let reloads = 0;
    sb.location.reload = () => { reloads++; };

    const ok = await SS.restore(snap);
    assert.strictEqual(ok, true, "restore works without config field");
    assert.strictEqual(reloads, 0, "no reload for snapshots without config");
    assert.strictEqual(sb.CPU.registerVal[0], 0x5151, "state restored");
    console.log("PASS test 11: snapshots without config field restore as before");
  }

  // ---- Test 12: save() with steps stores steps in the snapshot ----------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    const testSteps = [{ send: "root" }, { waitFor: "login:" }];
    const snap = await SS.save("with steps", testSteps, "test steps");
    assert.deepStrictEqual(snap.steps, testSteps, "steps stored in snapshot");
    assert.strictEqual(snap.stepsMessage, "test steps", "stepsMessage stored in snapshot");
    console.log("PASS test 12: save() with steps stores steps in snapshot");
  }

  // ---- Test 13: save() without steps leaves steps as null ---------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    const snap = await SS.save("no steps");
    assert.strictEqual(snap.steps, null, "steps is null when not provided");
    assert.strictEqual(snap.stepsMessage, null, "stepsMessage is null when not provided");
    console.log("PASS test 13: save() without steps leaves steps as null");
  }

  // ---- Test 14: a GZIP state (what the page itself exports) applies -----
  // Every state exported from the browser is gzip (it has only
  // CompressionStream), and a shared .state.zst arrives by URL or by drop.
  // Reading it must not depend on the frame being zstd; a bare container — a
  // writer with no compressor at all — must keep working too.
  {
    const zlib = require("zlib");
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.CPU.registerVal[0] = 0x7777;
    const container = Buffer.from(sb.StateFormat.pack({
      schemaVersion: SS.SCHEMA_VERSION,
      label: "gzip share",
      device: "rk1",
      cpu: { registerVal: [0x7777] },
    }, sb.CPU.memory));

    sb.CPU.registerVal[0] = 0;
    const viaGzip = await SS.applyStateBytes(
      new Uint8Array(zlib.gzipSync(container)), "shared.state.zst");
    assert.strictEqual(viaGzip.ok, true,
      "a gzip state must apply: " + JSON.stringify(viaGzip));
    assert.strictEqual(sb.CPU.registerVal[0], 0x7777,
      "the gzip state's registers landed");

    sb.CPU.registerVal[0] = 0;
    const bare = await SS.applyStateBytes(new Uint8Array(container), "local.state");
    assert.strictEqual(bare.ok, true, "a bare container must still apply");
    assert.strictEqual(sb.CPU.registerVal[0], 0x7777,
      "the bare state's registers landed");

    const foreign = await SS.applyStateBytes(new Uint8Array([1, 2, 3, 4]), "no.state");
    assert.strictEqual(foreign.ok, false, "a foreign file is refused");
    assert.strictEqual(foreign.reason, "not-a-state", "and the reason says why");
    console.log("PASS test 14: gzip and bare states apply, foreign bytes refused");
  }

  // ---- Test 15: overlay (write-back disk blocks) survives export/import --
  // The bug this pins: overlay.blocks held Uint8Array, JSON.stringify (inside
  // StateFormat.pack) turned it into a plain object, and restoreOverlay read
  // that object as an empty block — the exported/imported snapshot "lost its
  // disk" (guest writes on RK1 vanished, DIR hung). The bytes must survive
  // save -> exportSnapshot -> importState -> restore unchanged.
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);
    const url = "rk5.dsk";
    const sentinel = [0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33, 0x44];
    sb.DiskStore.setFingerprint(url, "fp-rk5");
    sb.DiskStore.setBlock(url, 42, sentinel);

    const snap = await SS.save("overlay test");
    assert.ok(snap.overlay && snap.overlay[url], "overlay captured at save");

    const bytes = await SS.exportSnapshot(snap.id);
    assert.ok(bytes && bytes.length > 0, "snapshot exported");

    // Import the exported file, then restore it onto a wiped disk.
    const imported = await SS.importState(new Uint8Array(bytes));
    assert.strictEqual(imported.ok, true, "import ok: " + JSON.stringify(imported));

    const stored = sb.indexedDB._store.get(imported.id);
    assert.ok(stored && stored.overlay && stored.overlay[url], "imported overlay present");
    assert.deepStrictEqual(Array.from(stored.overlay[url].blocks[42]), sentinel,
      "imported overlay block bytes match the original");

    sb.DiskStore.setBlock(url, 42, [0, 0, 0, 0, 0, 0, 0, 0]);
    const ok = await SS.restore(stored);
    assert.strictEqual(ok, true, "restore ok");
    assert.deepStrictEqual(Array.from(sb.DiskStore.getBlockBytes(url, 42)), sentinel,
      "restored disk block bytes match the original");
    console.log("PASS test 15: overlay survives export/import/restore");
  }

  console.log("\nAll SnapshotStore tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
