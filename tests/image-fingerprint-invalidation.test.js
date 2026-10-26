#!/usr/bin/env node
/**
 * Image-identity invalidation tests for cached blocks and snapshots.
 *
 * The regression this mechanism prevents: a stale block from an older disk
 * image being overlaid onto changed base bytes, silently corrupting the guest
 * filesystem. The canonical SHA-256 is computed from decompressed payload
 * bytes, so recompression alone does not invalidate a cache; changed payload
 * bytes do. Pre-0.4.0 FNV-1a/32 values must not match new SHA-256 identities.
 *
 * What is pinned here, against the real production code in a VM sandbox:
 *
 *   1. DiskStore.getBlock() refuses a block saved under a DIFFERENT known
 *      fingerprint (the corruption case) and accepts one saved under the
 *      current fingerprint (the normal case);
 *   2. unknown saved identities remain permissive, but a known saved identity
 *      is not served until the current image identity is known; this prevents
 *      pre-0.4.0 FNV cache blocks from bypassing SHA-256 during startup;
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
const { ImageFingerprint } = require("../src/imagefingerprint.js");

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
function makeFakeIndexedDB(store) {
    store = store || new Map();
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

// Load DiskStore plus the real ImageFingerprint into one sandbox, so the
// invalidation rule is exercised through the production modules, not a copy.
function buildDiskStoreSandbox(indexedDB) {
    const sandbox = {
        console, Uint8Array, Uint16Array, ArrayBuffer, DataView, Map, Set,
        setTimeout, clearInterval,
        setInterval: () => 0,
        indexedDB: indexedDB || makeFakeIndexedDB()
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
function buildSnapshotStoreSandbox(fingerprints, extra) {
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
    // Optional collaborators (DataLoader, window) for the source-aware paths.
    if (extra) Object.keys(extra).forEach((key) => { sandbox[key] = extra[key]; });
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

async function testLegacyKnownCacheIsNotServedBeforeIdentityIsKnown() {
    // Simulate an IndexedDB cache written by pre-0.4.0, then a fresh page
    // where the current image has not been fetched and SHA-256 is still unknown.
    const idb = makeFakeIndexedDB();
    const oldPage = buildDiskStoreSandbox(idb);
    await oldPage.DiskStore.init();
    const ctrl = makeCtrl("rk0.dsk");
    ctrl.cache[0] = new Uint16Array(8).fill(0x1234);
    oldPage.DiskStore.registerImage("rk0.dsk", "aaaa1111");
    oldPage.DiskStore.markDirty(ctrl, 0);
    await oldPage.DiskStore.flush("rk0.dsk");

    const newPage = buildDiskStoreSandbox(makeFakeIndexedDB(idb._store));
    await newPage.DiskStore.init();
    const beforeFetch = await newPage.DiskStore.getBlock("rk0.dsk", 0);
    assert.strictEqual(beforeFetch, undefined,
        "a known legacy cache block must not be served while current identity is unknown");

    // Once the new image has been fetched and identified, the old FNV value
    // still cannot match the new SHA-256 identity.
    newPage.DiskStore.registerImage("rk0.dsk", "b".repeat(64));
    const afterFetch = await newPage.DiskStore.getBlock("rk0.dsk", 0);
    assert.strictEqual(afterFetch, undefined,
        "a legacy cache block must remain stale after SHA-256 is registered");
    console.log("PASS: pre-0.4.0 cache blocks are never served during identity bootstrap");
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

    // If a canonical identity becomes known later, the unknown saved block
    // cannot be proven to belong to that image and must no longer be served.
    DiskStore.registerImage("mt0.tap", "c".repeat(64));
    const after = await DiskStore.getBlock("mt0.tap", 3);
    assert.strictEqual(after, undefined,
        "saved-as-unknown vs known-now is rejected as unverified");
    console.log("PASS: unknown cache identities remain usable only while current identity is also unknown");
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
    // Use valid SHA-256-shaped identities for the normal compatibility case.
    // Short FNV-1a values are reserved for the explicit legacy-rejection tests.
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);

    // The snapshot names two disks; one has been repacked since.
    const sb = buildSnapshotStoreSandbox({
        "rk0.dsk": hashA, // unchanged
        "rp1.dsk": hashB  // current build differs from the snapshot's
    });
    const SS = sb.SnapshotStore;
    const snap = {
        name: "before the upgrade",
        imageFingerprints: { "rk0.dsk": hashA, "rp1.dsk": hashA }
    };

    const bad = SS.incompatibleImages(snap);
    assert.strictEqual(bad.length, 1, "exactly the repacked image is named");
    assert.strictEqual(bad[0].url, "rp1.dsk");
    assert.strictEqual(bad[0].then, hashA);
    assert.strictEqual(bad[0].now, hashB);
    // The reason picks the wording of the refusal, never the decision.
    assert.strictEqual(bad[0].reason, "changed", "a different digest is 'changed'");

    // Unchanged images are silent.
    const ok = SS.incompatibleImages({
        imageFingerprints: { "rk0.dsk": hashA }
    });
    assert.strictEqual(ok.length, 0, "a snapshot on the same build is compatible");

    // No fingerprint information at all (older snapshot, or a host that never
    // learned one): nothing to contradict, so nothing is refused.
    assert.strictEqual(SS.incompatibleImages({}).length, 0,
        "a snapshot with no fingerprints restores as before");
    assert.strictEqual(SS.incompatibleImages({ imageFingerprints: null }).length, 0,
        "a null fingerprint map restores as before");

    // A known pre-0.4.0 FNV-1a/32 value is not compatible with the new
    // canonical SHA-256 identity, even if it refers to the same named image.
    const migrated = buildSnapshotStoreSandbox({ "rp1.dsk": "b".repeat(64) });
    const oldSnapshot = { imageFingerprints: { "rp1.dsk": "aaaa1111" } };
    const legacyBad = migrated.SnapshotStore.incompatibleImages(oldSnapshot);
    assert.strictEqual(legacyBad.length, 1,
        "a legacy fingerprint is rejected rather than mistaken for SHA-256");
    assert.strictEqual(legacyBad[0].reason, "legacy",
        "a pre-0.4.0 identity is reported as 'legacy', not as changed bytes");

    const unknownCurrent = buildSnapshotStoreSandbox({});
    assert.strictEqual(unknownCurrent.SnapshotStore.incompatibleImages(oldSnapshot).length, 1,
        "a legacy snapshot is rejected even before its image can be identified");

    // A valid SHA-256 identity for an image not currently loaded cannot be
    // compared yet — unknown current identity is not itself a mismatch.
    assert.strictEqual(SS.incompatibleImages({
        imageFingerprints: { "tm0.tap": hashA }
    }).length, 0, "an image not currently loaded is not a mismatch");
    console.log("PASS: incompatibleImages() names only the images that really changed");
}

// The refusal dialog must be readable: the digests live in production code as
// 64 unbroken characters, which used to widen the box past the window edge and
// bury the "what now?" answer. These are the formatting rules behind it.
function testRefusalWording() {
    const SS = buildSnapshotStoreSandbox({}).SnapshotStore;

    // A full digest is shortened for the flow, short values pass through.
    const hash = "2e5be12477eb3ec3c1fb7afe03bf17e43860ae337be20fcb75075637c0ffee1";
    assert.strictEqual(SS.shortFingerprint(hash), "2e5be124\u2026",
        "a 64-digit digest becomes 8 digits and an ellipsis");
    assert.strictEqual(SS.shortFingerprint("aaaa1111"), "aaaa1111",
        "a short legacy value is shown as is");
    assert.strictEqual(SS.shortFingerprint(null), "unknown",
        "an unknown identity says so instead of printing null");
    assert.strictEqual(SS.shortFingerprint("a".repeat(13)).length, 9,
        "anything longer than 12 characters is shortened");

    // The disk is named the way the operator knows it, not by its URL.
    assert.strictEqual(SS.imageLabel("media/rk5.dsk.zst"), "rk5.dsk",
        "directory and .zst are stripped");
    assert.strictEqual(SS.imageLabel("rk5.dsk"), "rk5.dsk",
        "a bare name is unchanged");
    assert.strictEqual(SS.imageLabel("C:\\\\images\\\\rp0.dsk"), "rp0.dsk",
        "a windows path is stripped too");
    assert.strictEqual(SS.imageLabel(null), "", "a missing url does not print null");

    // One clause per image, chosen by reason, never containing a full digest.
    const changed = SS.incompatibleReasonText(
        { url: "rk5.dsk", then: hash, now: "1".repeat(64), reason: "changed" });
    assert.ok(changed.indexOf("2e5be124\u2026") !== -1, "the saved digest is shown short");
    assert.ok(changed.indexOf(hash) === -1, "the full saved digest is not in the flow");
    assert.ok(SS.incompatibleReasonText({ reason: "legacy" }).indexOf("identity format") !== -1,
        "a legacy identity is explained, not printed");
    assert.ok(SS.incompatibleReasonText({ reason: "missing" }).indexOf("not available") !== -1,
        "a missing image is explained, not printed");

    // "Use my own copy of this disk": the DIGEST decides, the file name does
    // not. A right-bytes/wrong-name file is accepted, wrong bytes are not, and
    // a legacy identity can never be satisfied this way.
    const diskBytes = new Uint8Array(512);
    diskBytes[0] = 0x5a;
    diskBytes[511] = 0xa5;
    const diskSha = ImageFingerprint.ofBytes(diskBytes);
    const hit = SS.matchSuppliedBytes(
        [{ url: "media/rk5.dsk.zst", then: diskSha, now: "f".repeat(64), reason: "changed" }],
        diskBytes);
    assert.ok(hit.match && hit.match.url === "media/rk5.dsk.zst",
        "the supplied bytes are matched by digest, not by name");
    assert.strictEqual(hit.sha, diskSha, "the reported identity is the file's own");

    const miss = SS.matchSuppliedBytes(
        [{ url: "rk5.dsk", then: "a".repeat(64), now: "b".repeat(64), reason: "changed" }],
        diskBytes);
    assert.strictEqual(miss.match, null, "a different disk is refused");

    const legacy = SS.matchSuppliedBytes(
        [{ url: "rk5.dsk", then: "aaaa1111", now: null, reason: "legacy" }], diskBytes);
    assert.strictEqual(legacy.match, null,
        "a legacy identity is not satisfied by supplying a file");

    const empty = SS.matchSuppliedBytes([{ url: "rk5.dsk", then: diskSha }], new Uint8Array(0));
    assert.strictEqual(empty.match, null, "an empty file never matches");
    console.log("PASS: refusal wording keeps the digests short and the disks named plainly");
    console.log("PASS: a supplied disk is matched by digest, never by file name");
}

// Where an image's bytes came from decides whether a THIN state can ever fetch
// them again: a dropped file cannot, a published version can. And bytes already
// on this machine answer a state even when they are mounted under another name.
function testImageSources() {
    const bytes = new Uint8Array(64);
    bytes[0] = 7;
    const sha = ImageFingerprint.ofBytes(bytes);
    const store = new Map();
    const sourcesOf = new Map();
    const fakeLoader = {
        mount(url, data, source) {
            store.set(url, data);
            sourcesOf.set(url, source || "local");
        },
        get(url) { return store.get(url); },
        has(url) { return store.has(url); },
        list() { return Array.from(store.keys()); },
        sourceOf(url) { return sourcesOf.get(url); }
    };
    const SS = buildSnapshotStoreSandbox({}, { DataLoader: fakeLoader }).SnapshotStore;

    fakeLoader.mount("rk0.dsk", bytes, "network");
    assert.strictEqual(SS.captureImageSources()["rk0.dsk"], "network",
        "the source of every mounted image travels with the state");

    // Arrays cross the VM realm boundary, so compare their text form:
    // deepStrictEqual would compare Array prototypes from two realms.
    const names = (list) => Array.prototype.join.call(list, ",");
    assert.strictEqual(
        names(SS.localOnlyImages({ imageSources: { "rk5.dsk": "local" }, imageVersions: {} })),
        "rk5.dsk", "a local image with no published version is not portable");
    assert.strictEqual(
        names(SS.localOnlyImages({
            imageSources: { "rk5.dsk": "local" },
            imageVersions: { "rk5.dsk": { version: 2, sha256: sha } }
        })), "", "a pinned version makes even a local image portable");
    assert.strictEqual(
        names(SS.localOnlyImages({ imageSources: { "rk5.dsk": "published" }, imageVersions: {} })),
        "", "a published image is not a portability concern");
    assert.strictEqual(
        names(SS.localOnlyImages({ imageSources: { "rk5.dsk": "adopted" }, imageVersions: {} })),
        "rk5.dsk", "bytes adopted from a local copy are still local");

    // The right bytes under a DIFFERENT name answer the state's identity.
    fakeLoader.mount("my-rk5.dsk", bytes, "local");
    assert.strictEqual(names(SS.adoptLocalImages({ imageFingerprints: { "rk5.dsk": sha } })),
        "rk5.dsk", "a dropped copy answers the state under the expected name");
    assert.strictEqual(fakeLoader.sourceOf("rk5.dsk"), "adopted",
        "the adopted image is marked as such, not as published");
    assert.strictEqual(
        names(SS.adoptLocalImages({ imageFingerprints: { "zz.dsk": "f".repeat(64) } })),
        "", "bytes that match nothing are never adopted");
    assert.strictEqual(fakeLoader.has("zz.dsk"), false,
        "nothing is mounted for an identity this machine does not have");
    assert.strictEqual(names(SS.adoptLocalImages({ imageFingerprints: { "rk0.dsk": sha } })),
        "", "an image already mounted with the right bytes is left alone");
    console.log("PASS: image sources decide portability, and identity beats the file name");
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
    await testLegacyKnownCacheIsNotServedBeforeIdentityIsKnown();
    await testGetBlockUnknownIsPermissive();
    await testRestoreOverlayAcrossBuilds();
    testIncompatibleImages();
    testRefusalWording();
    testImageSources();
    await testRestoreRefusesAndKeepsMachine();
    console.log("image-fingerprint-invalidation: all tests passed");
})().catch((err) => {
    console.error("FAIL: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
