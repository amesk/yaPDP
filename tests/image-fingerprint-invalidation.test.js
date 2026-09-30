#!/usr/bin/env node
/**
 * Image-change invalidation tests: the caches and snapshots of a repacked image.
 *
 * This is the regression the whole fingerprint mechanism exists for. The old
 * scheme tagged every cached block with a hand-maintained IMAGE_VERSION, and
 * the hand forgot: media/rp1.dsk.zst (BSD 2.11) was repacked three times while
 * the constant stayed "0.1.0". A block saved from the old disk then matched the
 * current version and was overlaid onto a different disk — silent filesystem
 * corruption in the guest.
 *
 * What is pinned here, against the real production code in a VM sandbox:
 *
 *   1. DiskStore.getBlock() refuses a block saved under a DIFFERENT known
 *      fingerprint (the corruption case) and accepts one saved under the
 *      current fingerprint (the normal case);
 *   2. it does NOT refuse anything when a fingerprint is UNKNOWN on either
 *      side — the behaviour every host without a .zst depends on;
 *   3. DiskStore.restoreOverlay() skips an overlay recorded against a different
 *      build of the disk, and applies one from the same build;
 *   4. SnapshotStore.incompatibleImages() names the images that changed and
 *      stays silent when they did not — the rule restore() now enforces;
 *   5. a snapshot with NO fingerprint information restores as it always did.
 *
 * Run with:  node tests/image-fingerprint-invalidation.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
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
    if (start === -1) throw new Error("marker not found: " + startMarker);
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
                    if (rest !== tail) throw new Error("bad tail after " + startMarker);
                    return src.slice(start, i + 1 + tail.length);
                }
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

// IndexedDB stub shaped like the one in tests/diskstore.test.js and
// tests/snapshotstore.test.js: the TRANSACTION fires oncomplete, which is what
// flush() awaits — a stub that only wires the object store makes flush() hang.
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
        }
    };
}

// Load DiskStore plus the real ImageFingerprint into one sandbox, so the
// invalidation rule is exercised through the production modules, not a copy.
function buildDiskStoreSandbox() {
    const sandbox = {
        console, Uint8Array, Uint16Array, ArrayBuffer, DataView, Map, Set,
        setTimeout, clearInterval,
        setInterval: () => 0,
        indexedDB: makeFakeIndexedDB()
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(FINGERPRINT_PATH, "utf8"), sandbox);
    vm.runInContext(
        extractBlock(fs.readFileSync(DISKSTORE_PATH, "utf8"),
            "var DiskStore = (() => {", ")();"),
        sandbox);
    return sandbox;
}

// Build a SnapshotStore sandbox with a stub DiskStore whose fingerprints we
// control, plus the real ImageFingerprint.
function buildSnapshotStoreSandbox(fingerprints) {
    const src = fs.readFileSync(path.join(ROOT, "src", "snapshots.js"), "utf8");
    const sandbox = {
        console, Uint8Array, ArrayBuffer, Map, Set, Date, JSON, String, Number,
        setTimeout, Promise, Math,
        indexedDB: makeFakeIndexedDB(),
        // The only DiskStore surface incompatibleImages() uses.
        DiskStore: {
            fingerprintOf: (url) => (url in fingerprints ? fingerprints[url] : null)
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(FINGERPRINT_PATH, "utf8"), sandbox);
    vm.runInContext(
        extractBlock(src, "var SnapshotStore = (() => {", ")();"),
        sandbox);
    return sandbox;
}

function makeCtrl(url) {
    return { cache: [], url };
}

async function testGetBlockAcrossBuilds() {
    const sb = buildDiskStoreSandbox();
    const DiskStore = sb.DiskStore;
    await DiskStore.init();
    // A written cache block: the block must actually contain bytes so the
    // stored payload is non-empty (an absent cache block is skipped by flush).
    const ctrl = makeCtrl("rk0.dsk");
    ctrl.cache[0] = new Uint16Array(8).fill(0x1234);

    // A block saved while build A was loaded.
    DiskStore.registerImage("rk0.dsk", "aaaa1111");
    DiskStore.markDirty(ctrl, 0);
    await DiskStore.flush("rk0.dsk");

    // Same build: the block is still the disk's own.
    const same = await DiskStore.getBlock("rk0.dsk", 0);
    assert.ok(same, "a block from the current build is served");

    // The image is repacked (new .zst -> new fingerprint).
    DiskStore.registerImage("rk0.dsk", "bbbb2222");
    const stale = await DiskStore.getBlock("rk0.dsk", 0);
    assert.strictEqual(stale, undefined,
        "a block saved from a DIFFERENT build of the disk must be refused " +
        "(this is the corruption case the old hand-bumped version missed)");
    console.log("PASS: getBlock() refuses a block from a different build of the image");
}

async function testGetBlockUnknownIsPermissive() {
    const sb = buildDiskStoreSandbox();
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    // Saved with no identity known (e.g. an image mounted from a bundle).
    const ctrl = makeCtrl("mt0.tap");
    ctrl.cache[3] = new Uint16Array(8).fill(0x4321);
    DiskStore.markDirty(ctrl, 3);
    await DiskStore.flush("mt0.tap");
    const anon = await DiskStore.getBlock("mt0.tap", 3);
    assert.ok(anon, "an image with no fingerprint keeps its cache (unknown never invalidates)");

    // And learning the identity later does not retroactively kill it when the
    // lookups disagree — only two KNOWN, differing fingerprints do.
    DiskStore.registerImage("mt0.tap", "cccc3333");
    const after = await DiskStore.getBlock("mt0.tap", 3);
    assert.ok(after, "saved-as-unknown vs known-now is NOT a mismatch");
    console.log("PASS: unknown fingerprints never invalidate a cache");
}

async function testRestoreOverlayAcrossBuilds() {
    const sb = buildDiskStoreSandbox();
    const DiskStore = sb.DiskStore;
    await DiskStore.init();

    // The snapshot was taken on build A.
    DiskStore.registerImage("rp1.dsk", "aaaa1111");
    const overlay = {
        "rp1.dsk": { v: "aaaa1111", blocks: { 5: new Uint8Array([1, 2, 3]).buffer } }
    };

    // Same build: the overlay applies. A control block must be registered so
    // restoreOverlay has a cache to invalidate (its absence is also handled,
    // but the cache-invalidation path is the interesting one).
    const ctrl = makeCtrl("rp1.dsk");
    ctrl.cache[5] = new Uint16Array(2);
    DiskStore.markDirty(ctrl, 5);
    await DiskStore.restoreOverlay(overlay);
    const applied = await DiskStore.getBlock("rp1.dsk", 5);
    assert.ok(applied, "an overlay from the current build is restored");

    // Repacked since: the snapshot's blocks belong to another disk and must be
    // ignored rather than written over the new one.
    await DiskStore.clear("rp1.dsk");
    DiskStore.registerImage("rp1.dsk", "bbbb2222");
    await DiskStore.restoreOverlay(overlay);
    const skipped = await DiskStore.getBlock("rp1.dsk", 5);
    assert.strictEqual(skipped, undefined,
        "an overlay recorded against a DIFFERENT build must not be applied");
    console.log("PASS: restoreOverlay() ignores an overlay from a different build");
}

function testIncompatibleImages() {
    // The snapshot names two disks; one has been repacked since.
    const sb = buildSnapshotStoreSandbox({
        "rk0.dsk": "aaaa1111", // unchanged
        "rp1.dsk": "bbbb2222"  // current build differs from the snapshot's
    });
    const SS = sb.SnapshotStore;
    const snap = {
        name: "before the upgrade",
        imageFingerprints: { "rk0.dsk": "aaaa1111", "rp1.dsk": "aaaa1111" }
    };

    const bad = SS.incompatibleImages(snap);
    assert.strictEqual(bad.length, 1, "exactly the repacked image is named");
    assert.strictEqual(bad[0].url, "rp1.dsk");
    assert.strictEqual(bad[0].then, "aaaa1111");
    assert.strictEqual(bad[0].now, "bbbb2222");

    // Unchanged images are silent.
    const ok = SS.incompatibleImages({
        imageFingerprints: { "rk0.dsk": "aaaa1111" }
    });
    assert.strictEqual(ok.length, 0, "a snapshot on the same build is compatible");

    // No fingerprint information at all (older snapshot, or a host that never
    // learned one): nothing to contradict, so nothing is refused.
    assert.strictEqual(SS.incompatibleImages({}).length, 0,
        "a snapshot with no fingerprints restores as before");
    assert.strictEqual(SS.incompatibleImages({ imageFingerprints: null }).length, 0,
        "a null fingerprint map restores as before");

    // An image the snapshot knows but the machine has not loaded now cannot be
    // judged yet — it is not a mismatch.
    assert.strictEqual(SS.incompatibleImages({
        imageFingerprints: { "tm0.tap": "dddd4444" }
    }).length, 0, "an image not currently loaded is not a mismatch");
    console.log("PASS: incompatibleImages() names only the images that really changed");
}

async function testRestoreRefusesAndKeepsMachine() {
    // restore() must refuse BEFORE it touches CPU/RAM: a half-applied restore
    // (new memory on an old disk) is worse than no restore.
    const sb = buildSnapshotStoreSandbox({ "rp1.dsk": "bbbb2222" });
    const SS = sb.SnapshotStore;
    const snap = {
        id: "snap-1",
        name: "old build",
        cpu: { runState: 1, pc: 0o1000 },
        memory: { format: "raw", data: new ArrayBuffer(8) },
        imageFingerprints: { "rp1.dsk": "aaaa1111" }
    };
    const ok = await SS.restore(snap);
    assert.strictEqual(ok, false,
        "restore() refuses a snapshot whose disk changed under it");
    console.log("PASS: restore() refuses an incompatible snapshot");
}

(async () => {
    await testGetBlockAcrossBuilds();
    await testGetBlockUnknownIsPermissive();
    await testRestoreOverlayAcrossBuilds();
    testIncompatibleImages();
    await testRestoreRefusesAndKeepsMachine();
    console.log("image-fingerprint-invalidation: all tests passed");
})().catch((err) => {
    console.error("FAIL: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
