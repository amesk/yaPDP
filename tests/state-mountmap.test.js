#!/usr/bin/env node
/**
 * State ↔ MountMap tests.
 *
 * A state must remember WHICH image each drive held: a machine with rk4 bound
 * to rk5.dsk restores on another browser reading rk5.dsk, not the default
 * rk4.dsk. The bindings travel as the manifest's `mountmap` field.
 *
 * This file extracts the SnapshotStore IIFE from the real src/snapshots.js and
 * runs it in an isolated VM context (the pattern tests/snapshotstore.test.js
 * established) with:
 *   - a fake in-memory IndexedDB,
 *   - a minimal CPU stub (registers + memory as Uint16Array),
 *   - the REAL src/mountmap.js, so the ordering rules are pinned against the
 *     production registry and not against a double.
 *
 * DOM-free on purpose: no CompressionStream/DecompressionStream, so memory is
 * stored as "raw" and the exported container stays bare — the checks are about
 * the manifest and the table, not about a codec.
 *
 * Run with:  node tests/state-mountmap.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "src", "snapshots.js");
const SF_SOURCE = fs.readFileSync(path.join(ROOT, "src", "state-format.js"), "utf8");
const MOUNTMAP_SOURCE = fs.readFileSync(path.join(ROOT, "src", "mountmap.js"), "utf8");

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
      if (depth === 0) return src.slice(start, i + 2 + 2); // "})();"
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
  const req = { result: fakeDB, onupgradeneeded: null, onsuccess: null, onerror: null };
  return {
    open: () => {
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    _store: store,
  };
}

function plain(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

function buildSandbox(mountedUrls) {
  const cpu = {
    runState: 3, // STATE_HALT
    PSW: 0xf,
    registerVal: new Uint16Array(8),
    registerAlt: new Uint16Array(6),
    stackPointer: new Uint16Array(4),
    mmuPAR: new Uint16Array(64),
    mmuPDR: new Uint16Array(64),
    unibusMap: new Uint32Array(32),
    memory: new Uint16Array(64),
    MMR0: 0,
    flagC: NaN,
    displayAddress: 0,
  };
  for (let i = 0; i < cpu.memory.length; i++) cpu.memory[i] = (i * 7) & 0xffff;

  const localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };

  const urls = mountedUrls || ["rk0.dsk", "rk5.dsk"];

  return {
    console,
    Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView,
    Map, Set, Promise, JSON, Object, Array, String, Number,
    setTimeout, clearTimeout, setInterval: () => 0,
    TextEncoder, TextDecoder,
    indexedDB: makeFakeIndexedDB(),
    localStorage,
    STATE_HALT: 3,
    STATE_RUN: 0,
    CPU: cpu,
    StateFormat: undefined,
    MountMap: undefined,
    DataLoader: {
      list: () => urls.slice(),
      has: (url) => urls.indexOf(url) !== -1,
      get: () => null,
    },
    // The device layer: restoreApply() must reach it AFTER the table is applied.
    iopage: {
      _devices: {},
      restoreDevices(state) { this._devices = JSON.parse(JSON.stringify(state || {})); },
      snapshotDevices() { return JSON.parse(JSON.stringify(this._devices)); },
    },
    Config: {
      _cfg: { consoleType: "teletype", userTerminals: 0, printer: false, vt11: false },
      get() { return Object.assign({}, this._cfg); },
      set(patch) { Object.assign(this._cfg, patch); },
    },
    location: { reload: () => {} },
    window: {
      localStorage,
      __yapdpMountProvider: () => {},
    },
  };
}

function loadSnapshotStore(sb) {
  const code = extractIIFE(fs.readFileSync(SOURCE_PATH, "utf8"), "var SnapshotStore = (() => {");
  vm.createContext(sb);
  vm.runInContext(SF_SOURCE, sb);
  sb.StateFormat = vm.runInContext("StateFormat", sb);
  // The REAL registry, as the page loads it (before snapshots.js).
  vm.runInContext(MOUNTMAP_SOURCE, sb);
  sb.MountMap = vm.runInContext("MountMap", sb);
  vm.runInContext(code, sb);
  return sb.SnapshotStore;
}

async function run() {
  // ---- 1: capture() records the bindings, and always writes the field ------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.MountMap.set("rk4", "rk5.dsk");
    const remapped = await SS.save("remapped");
    assert.deepStrictEqual(plain(remapped.mountmap), { rk4: "rk5.dsk" },
      "a remapped drive travels with the state");

    sb.MountMap.clear();
    const plainSnap = await SS.save("no remaps");
    assert.deepStrictEqual(plain(plainSnap.mountmap), {},
      "a state without remaps still writes the field ({}), never omits it");
    console.log("PASS 1: capture() writes mountmap (including {})");
  }

  // ---- 2: restoreApply() applies the table BEFORE restoreDevices() ---------
  // The refusal ordering matters as much as the value: a controller resolves
  // its url from the table when its control block is created, so a table
  // applied after restoreDevices() would be seen too late.
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.MountMap.set("rk0", "local.dsk"); // the browser's own binding
    let tableAtDevices = null;
    sb.iopage.restoreDevices = function (state) {
      tableAtDevices = plain(sb.MountMap.list());
      this._devices = JSON.parse(JSON.stringify(state || {}));
    };
    const providers = [];
    sb.window.__yapdpMountProvider = (url) => providers.push(url);

    const snap = await SS.save("teleport");
    snap.mountmap = { rk4: "rk5.dsk" };
    const ok = await SS.restoreApply(snap);
    assert.strictEqual(ok, true, "the state applies");

    assert.deepStrictEqual(tableAtDevices, { rk4: "rk5.dsk" },
      "the restored table was in place before restoreDevices()");
    assert.deepStrictEqual(plain(sb.MountMap.list()), { rk4: "rk5.dsk" },
      "the local binding is REPLACED, not merged");
    assert.ok(providers.indexOf("rk5.dsk") !== -1,
      "a provider is registered for the bound image");
    assert.deepStrictEqual(
      JSON.parse(sb.localStorage.getItem(sb.MountMap.STORAGE_KEY)),
      { rk4: "rk5.dsk" },
      "the applied table is persisted, so a reboot reads the same image");
    console.log("PASS 2: restoreApply() replaces the table before restoreDevices() and persists it");
  }

  // ---- 3: a legacy state (no field) leaves the local table alone -----------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.MountMap.set("rl0", "mine.dsk");
    const legacy = await SS.save("legacy");
    delete legacy.mountmap; // exactly what a pre-1.1.0 container looks like
    await SS.restoreApply(legacy);

    assert.deepStrictEqual(plain(sb.MountMap.list()), { rl0: "mine.dsk" },
      "opening a legacy state does not touch this browser's bindings");
    console.log("PASS 3: a legacy state without mountmap keeps the local table");
  }

  // ---- 4: a present but empty table clears the bindings --------------------
  {
    const sb = buildSandbox();
    const SS = loadSnapshotStore(sb);

    sb.MountMap.set("rp1", "bsd211.dsk");
    const empty = await SS.save("cleared");
    empty.mountmap = {};
    await SS.restoreApply(empty);

    assert.deepStrictEqual(plain(sb.MountMap.list()), {},
      "{} means \"no remapped drives\" and clears the local table");
    console.log("PASS 4: an empty mountmap clears the table");
  }

  // ---- 5: the exported manifest carries the field and the DRIVE key --------
  // With rk4 bound to rk5.dsk the boot device is rk4: ?state= must pre-load
  // rk4, not the rk5 the image happens to be called.
  {
    const sb = buildSandbox(["rk5.dsk"]);
    const SS = loadSnapshotStore(sb);

    sb.MountMap.set("rk4", "rk5.dsk");
    const saved = await SS.save("boot key");
    const bytes = await SS.exportSnapshot(saved.id);
    assert.ok(bytes && bytes.length > 0, "the snapshot exported");

    const parsed = sb.StateFormat.unpack(new Uint8Array(bytes));
    assert.ok(parsed && parsed.manifest, "the container unpacks");
    assert.deepStrictEqual(plain(parsed.manifest.mountmap), { rk4: "rk5.dsk" },
      "the manifest carries the bindings");
    assert.strictEqual(parsed.manifest.device, "rk4",
      "the boot device is the REMAPPED drive, not the image name");
    console.log("PASS 5: exportSnapshot() writes mountmap and derives the remapped device key");
  }

  console.log("\nAll state/mountmap tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
