#!/usr/bin/env node
/**
 * Snapshot manager UI — selection retention tests.
 *
 * Regression guard for refreshUI(): the snapshot <select> is rebuilt from
 * scratch on every refresh (select.innerHTML = ""), which used to drop the
 * operator's selection and jump back to the first entry (the oldest, since
 * list() is sorted oldest-first). This test drives the real SnapshotStore
 * IIFE from src/snapshots.js in a VM sandbox with a minimal fake DOM and
 * asserts that:
 *   1. a selection that still exists survives a refresh;
 *   2. an explicit id (the Save/Import flow) selects the fresh snapshot;
 *   3. when the selected entry is gone, the fallback is the NEWEST snapshot;
 *   4. an empty store shows the placeholder and disables the controls.
 *
 * Run with:  node tests/snapshot-ui-selection.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "snapshots.js");
const STATE_FORMAT_PATH = path.join(__dirname, "..", "src", "state-format.js");
const STATE_FRAME_PATH = path.join(__dirname, "..", "src", "state-frame.js");

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
// Fake in-memory IndexedDB (same stub shape as tests/snapshotstore.test.js)
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

  const req = { result: fakeDB, onupgradeneeded: null, onsuccess: null, onerror: null };
  const indexedDB = {
    open: () => {
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
    _store: store,
  };
  return indexedDB;
}

// ------------------------------------------------------------------
// Minimal fake DOM: a registry of elements + <select>/<option> semantics.
// Only what refreshUI() touches: getElementById, createElement("option"),
// innerHTML = "", appendChild, value, selectedIndex, options, disabled.
// ------------------------------------------------------------------
function makeFakeDOM() {
  const registry = new Map();

  function createSelect() {
    const sel = {
      _options: [],
      _value: "",
      disabled: false,
      appendChild(opt) { sel._options.push(opt); return opt; },
      addEventListener() {},
      focus() {},
    };
    Object.defineProperty(sel, "options", {
      get() { return sel._options; },
    });
    // A real <select> reports "" when its assigned value has no matching
    // option — mirror that, so refreshUI's `!!select.value` gate is honest.
    Object.defineProperty(sel, "value", {
      get() {
        return sel._options.some((o) => o.value === sel._value) ? sel._value : "";
      },
      set(v) { sel._value = v == null ? "" : String(v); },
    });
    Object.defineProperty(sel, "selectedIndex", {
      get() {
        const v = sel.value;
        for (let i = 0; i < sel._options.length; i++) {
          if (sel._options[i].value === v) return i;
        }
        return -1;
      },
      set(i) { sel._value = sel._options[i] ? sel._options[i].value : ""; },
    });
    Object.defineProperty(sel, "innerHTML", {
      get() { return ""; },
      set(v) { if (v === "") sel._options = []; },
    });
    return sel;
  }

  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => (tag === "option"
      ? { value: "", textContent: "", dataset: {} }
      : { style: {}, appendChild() {}, addEventListener() {} }),
    addEventListener: () => {},
    body: { appendChild() {} },
  };

  return { document, registry, createSelect };
}

function buildSandbox() {
  const fakeIDB = makeFakeIndexedDB();
  const dom = makeFakeDOM();
  const cpu = {
    runState: 3, // STATE_HALT
    PSW: 0xf,
    registerVal: new Uint16Array(8),
    registerAlt: new Uint16Array(6),
    stackPointer: new Uint16Array(4),
    mmuPAR: new Uint16Array(64),
    mmuPDR: new Uint16Array(64),
    unibusMap: new Uint32Array(32),
    memory: new Uint16Array(4096),
    MMR0: 0,
    flagC: NaN,
    displayAddress: 0,
  };
  for (let i = 0; i < cpu.memory.length; i++) cpu.memory[i] = (i * 7) & 0xffff;

  return {
    console,
    Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView,
    Map, Set, Promise,
    setTimeout, clearTimeout, setInterval: () => 0,
    indexedDB: fakeIDB,
    CompressionStream, DecompressionStream,
    StateFormat: undefined,
    StateFrame: undefined,
    Response,
    TextEncoder, TextDecoder,
    STATE_HALT: 3,
    STATE_RUN: 0,
    CPU: cpu,
    DataLoader: { list: () => ["rk0.dsk", "rk1.dsk"] },
    iopage: {
      _devices: { "17777560": { rcsr: 0x80, iMask: 0 }, "17777400": { rkcs: 0x80, iMask: 1 } },
      snapshotDevices() { return JSON.parse(JSON.stringify(this._devices)); },
      restoreDevices(state) { this._devices = JSON.parse(JSON.stringify(state)); },
    },
    DiskStore: { IMAGE_VERSION: "0.1.0" },
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
    location: { reload: () => {} },
    document: dom.document,
    _dom: dom,
    window: {
      paperTape: {
        _buffer: [0x11, 0x22, 0x33],
        snapshot() { return { buffer: this._buffer.slice() }; },
        restore(bytes) { this._buffer = bytes ? bytes.slice() : []; },
      },
    },
  };
}

function loadSnapshotStore(sb) {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = extractIIFE(src, "var SnapshotStore = (() => {");
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(STATE_FORMAT_PATH, "utf8"), sb);
  sb.StateFormat = vm.runInContext("StateFormat", sb);
  vm.runInContext(fs.readFileSync(STATE_FRAME_PATH, "utf8"), sb);
  sb.StateFrame = vm.runInContext("StateFrame", sb);
  vm.runInContext(code, sb);
  return sb.SnapshotStore;
}

// refreshUI() resolves list() through a chain of setTimeout(0) hops.
const flush = () => new Promise((r) => setTimeout(r, 30));
const pause = () => new Promise((r) => setTimeout(r, 5)); // distinct Date.now() ids

function makeButton() {
  return { disabled: false };
}

async function run() {
  const sb = buildSandbox();
  const SS = loadSnapshotStore(sb);

  // ---- seed three snapshots (oldest-first ids A, B, C) ---------------
  await SS.save("A");
  await pause();
  await SS.save("B");
  await pause();
  await SS.save("C");

  const items = await SS.list();
  assert.strictEqual(items.length, 3, "three snapshots saved");
  assert.deepStrictEqual(items.map((i) => i.name), ["A", "B", "C"],
    "list() is oldest-first");

  // Register the DOM the manager modal would have created.
  const select = sb._dom.createSelect();
  const dom = sb._dom;
  dom.registry.set("snap-select", select);
  dom.registry.set("snap-load", makeButton());
  dom.registry.set("snap-export", makeButton());
  dom.registry.set("snap-share", makeButton());
  dom.registry.set("snap-rename", makeButton());
  dom.registry.set("snap-delete", makeButton());
  dom.registry.set("snap-count", { textContent: "" });

  // ---- Test 1: an existing selection survives a refresh -------------
  // Build the list once (as opening the manager would). With no prior
  // selection the rebuild falls back to the newest entry.
  SS.refreshUI();
  await flush();
  assert.strictEqual(select.options.length, 3, "list built with 3 entries");
  assert.strictEqual(select.value, items[2].id,
    "a first build selects the newest snapshot");

  // Now pick the middle entry — it exists in the options, so a real
  // <select> reports it — and refresh again; it must survive.
  select.value = items[1].id; // "B"
  SS.refreshUI();
  await flush();
  assert.strictEqual(select.options.length, 3, "list rebuilt with 3 entries");
  assert.strictEqual(select.value, items[1].id,
    "selection kept on the middle snapshot across a refresh");
  assert.strictEqual(select.disabled, false, "select enabled");
  assert.strictEqual(dom.registry.get("snap-load").disabled, false,
    "Load stays enabled with a selection");
  console.log("PASS test 1: refresh keeps an existing selection");

  // ---- Test 2: an explicit id wins (the Save/Import flow) -----------
  // save() is followed by refreshUI(snap.id): the fresh entry is not in the
  // stale options yet, so only an explicit request can select it.
  await pause();
  const fresh = await SS.save("D");
  SS.refreshUI(fresh.id);
  await flush();
  assert.strictEqual(select.options.length, 4, "list rebuilt with 4 entries");
  assert.strictEqual(select.value, fresh.id,
    "the just-saved snapshot is selected");
  console.log("PASS test 2: an explicit id selects the just-saved snapshot");

  // ---- Test 3: deleting the selection falls back to the NEWEST ------
  await SS.remove(fresh.id);
  SS.refreshUI();
  await flush();
  assert.strictEqual(select.options.length, 3, "list rebuilt with 3 entries");
  assert.strictEqual(select.value, items[2].id,
    "fallback lands on the newest snapshot, not the oldest");
  assert.strictEqual(dom.registry.get("snap-load").disabled, false,
    "controls stay enabled while entries remain");
  console.log("PASS test 3: deleting the selection falls back to the newest");

  // ---- Test 4: an empty store shows the placeholder and disables -----
  await SS.remove(items[0].id);
  await SS.remove(items[1].id);
  await SS.remove(items[2].id);
  SS.refreshUI();
  await flush();
  assert.strictEqual(select.options.length, 1, "one placeholder option");
  assert.strictEqual(select.options[0].value, "", "placeholder has empty value");
  assert.strictEqual(select.value, "", "no real selection when empty");
  assert.strictEqual(select.disabled, true, "select disabled when empty");
  assert.strictEqual(dom.registry.get("snap-load").disabled, true,
    "Load disabled when empty");
  assert.strictEqual(dom.registry.get("snap-delete").disabled, true,
    "Delete disabled when empty");
  assert.strictEqual(dom.registry.get("snap-count").textContent, "0 snapshots",
    "counter reports zero");
  console.log("PASS test 4: empty store shows placeholder and disables controls");

  console.log("\nAll snapshot UI selection tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
