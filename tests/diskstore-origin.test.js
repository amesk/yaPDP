#!/usr/bin/env node
/**
 * DiskStore overlay ORIGIN tests: whose writes are on this disk?
 *
 * Blocks a guest writes are saved to IndexedDB and overlaid on the base image
 * on the next launch. A state imported from someone else's link (`?state=`)
 * leaves ITS writes in the same place — so the disk can carry changes the
 * current user never made. This suite pins the marker that says so:
 *
 *   1. `markOrigin(url, "state")` + `originOf(url)` round-trips in memory;
 *   2. the origin is WRITTEN INTO the per-image meta record, so it is part of
 *      what `flush()` persists rather than a fact that dies with the session;
 *   3. `restoreOverlay()` carries the overlay's own origin: a state's blocks
 *      arrive marked "state", a guest's own blocks unmark it;
 *   4. `init()` reads the origin back from IndexedDB — the marker survives a
 *      reload, which is the whole reason it lives in the record;
 *   5. `clear(url)` drops the origin with the blocks: Reset clears the claim
 *      as well as the data.
 *
 * Loaded the way the sibling suites do it: the real vector/disk sections from
 * the source files, driven in a VM sandbox with an in-memory IndexedDB.
 *
 * Run with:  node tests/diskstore-origin.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DISKSTORE_PATH = path.join(ROOT, "src", "diskstore.js");
const FINGERPRINT_PATH = path.join(ROOT, "src", "imagefingerprint.js");

// Minimal brace-balancing extractor (same helper as the sibling suites).
function extractBlock(src, startMarker, tail) {
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, "marker not found: " + startMarker);
    const braceOpen = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                if (tail) {
                    const rest = src.slice(i + 1, i + 1 + tail.length);
                    assert.strictEqual(rest, tail, "bad tail after " + startMarker);
                    return src.slice(start, i + 1 + tail.length);
                }
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

// In-memory IndexedDB, shaped like tests/diskstore.test.js (the transaction
// fires oncomplete, which is what flush() awaits).
function makeFakeIndexedDB() {
    const store = new Map();
    const objectStore = {
        put(value, key) { store.set(key, value); },
        get(key) {
            const req = { onsuccess: null, onerror: null, result: store.get(key) };
            setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
            return req;
        },
        delete(key) { store.delete(key); },
        getAllKeys() {
            const req = { onsuccess: null, onerror: null, result: Array.from(store.keys()) };
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
    return {
        open: () => {
            const req = { result: fakeDB, onupgradeneeded: null, onsuccess: null, onerror: null };
            setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
            return req;
        },
        _store: store
    };
}

function buildSandbox(fakeIDB) {
    const sandbox = {
        console, Uint8Array, Uint16Array, ArrayBuffer, DataView, Map, Set,
        setTimeout, clearInterval,
        setInterval: () => 0,
        indexedDB: fakeIDB,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(FINGERPRINT_PATH, "utf8"), sandbox);
    vm.runInContext(
        extractBlock(fs.readFileSync(DISKSTORE_PATH, "utf8"),
            "var DiskStore = (() => {", ")();"),
        sandbox);
    return sandbox;
}

function makeCtrl(url) {
    return { cache: [], url };
}

async function testMarkerInMemory() {
    const sandbox = buildSandbox(makeFakeIndexedDB());
    const DS = sandbox.DiskStore;
    await DS.init();

    assert.strictEqual(DS.originOf("rk0.dsk"), null,
        "an image nobody imported has no origin");
    DS.markOrigin("rk0.dsk", "state");
    assert.strictEqual(DS.originOf("rk0.dsk"), "state",
        "markOrigin() is readable back through originOf()");
    DS.markOrigin("rk0.dsk", null);
    assert.strictEqual(DS.originOf("rk0.dsk"), null,
        "markOrigin(url, null) clears the mark");
    console.log("PASS: the origin round-trips in memory and clears on null");
}

async function testOriginIsPersisted() {
    const idb = makeFakeIndexedDB();
    const sandbox = buildSandbox(idb);
    const DS = sandbox.DiskStore;
    await DS.init();

    DS.registerImage("rk0.dsk", "aaaa1111");
    DS.markOrigin("rk0.dsk", "state");
    const ctrl = makeCtrl("rk0.dsk");
    ctrl.cache[0] = new Uint16Array(4).fill(0x1234);
    DS.markDirty(ctrl, 0);
    await DS.flush("rk0.dsk");

    const meta = idb._store.get("rk0.dsk::meta");
    assert.ok(meta, "flush() wrote the per-image meta record");
    assert.strictEqual(meta.origin, "state",
        "the origin travels IN the meta record, so it is persisted, not session-only");
    console.log("PASS: the origin is written into the per-image meta record");
}

async function testRestoreOverlayCarriesOrigin() {
    const sandbox = buildSandbox(makeFakeIndexedDB());
    const DS = sandbox.DiskStore;
    await DS.init();

    DS.registerImage("rp1.dsk", "bbbb2222");
    // A state's overlay says where it came from.
    await DS.restoreOverlay({
        "rp1.dsk": {
            v: "bbbb2222",
            origin: "state",
            blocks: { 5: new Uint8Array([1, 2, 3]).buffer },
        },
    });
    assert.strictEqual(DS.originOf("rp1.dsk"), "state",
        "an overlay marked as a state's leaves the image marked");

    // The guest's own write-back has no origin: the mark is cleared.
    await DS.restoreOverlay({
        "rp1.dsk": {
            v: "bbbb2222",
            blocks: { 6: new Uint8Array([4]).buffer },
        },
    });
    assert.strictEqual(DS.originOf("rp1.dsk"), null,
        "an overlay without an origin clears the mark (the guest wrote these)");
    console.log("PASS: restoreOverlay() carries the overlay's own origin");
}

async function testOriginSurvivesInit() {
    const idb = makeFakeIndexedDB();
    {
        const sandbox = buildSandbox(idb);
        const DS = sandbox.DiskStore;
        await DS.init();
        DS.registerImage("rk0.dsk", "aaaa1111");
        DS.markOrigin("rk0.dsk", "state");
        const ctrl = makeCtrl("rk0.dsk");
        ctrl.cache[1] = new Uint16Array(4).fill(0x5678);
        DS.markDirty(ctrl, 1);
        await DS.flush("rk0.dsk");
    }
    // A NEW sandbox over the SAME IndexedDB: this is the reload.
    {
        const sandbox = buildSandbox(idb);
        const DS = sandbox.DiskStore;
        await DS.init();
        assert.strictEqual(DS.originOf("rk0.dsk"), "state",
            "init() reads the origin back — the mark survives a reload");
        console.log("PASS: the origin survives a reload (init() reads it back)");
    }
}

async function testClearDropsOrigin() {
    const idb = makeFakeIndexedDB();
    const sandbox = buildSandbox(idb);
    const DS = sandbox.DiskStore;
    await DS.init();

    DS.registerImage("rk0.dsk", "aaaa1111");
    DS.markOrigin("rk0.dsk", "state");
    const ctrl = makeCtrl("rk0.dsk");
    ctrl.cache[0] = new Uint16Array(4).fill(0x9999);
    DS.markDirty(ctrl, 0);
    await DS.flush("rk0.dsk");
    assert.strictEqual(DS.originOf("rk0.dsk"), "state");

    await DS.clear("rk0.dsk");
    assert.strictEqual(DS.originOf("rk0.dsk"), null,
        "clearing an image drops its origin with its blocks");
    console.log("PASS: clear() drops the origin with the blocks");
}

(async () => {
    await testMarkerInMemory();
    await testOriginIsPersisted();
    await testRestoreOverlayCarriesOrigin();
    await testOriginSurvivesInit();
    await testClearDropsOrigin();
    console.log("diskstore-origin: all tests passed");
})().catch((err) => {
    console.error("FAIL: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
