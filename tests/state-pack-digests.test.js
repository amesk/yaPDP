#!/usr/bin/env node
/**
 * pack() digest reuse — the contract that makes the Share shortcut safe.
 *
 * pack() hashes every blob it stores with a pure-JS SHA-256
 * (imagefingerprint.js — crypto.subtle is absent on file:// and in some
 * desktop WebViews). A self-contained state carries whole disk images, and the
 * identity of an image is already known from the moment it is mounted, so the
 * caller may hand pack() one digest per blob id and skip re-reading 100+ MiB
 * of disks in the middle of the Share dialog.
 *
 * These tests pin what makes that safe:
 *   1. a reused digest is written into the catalog exactly as given;
 *   2. the state still unpacks, to the same bytes, and the manifest is intact;
 *   3. a malformed digest is IGNORED — pack() hashes instead, because a value
 *      that is not a SHA-256 would produce a catalog entry no reader accepts;
 *   4. a well-formed but WRONG digest is caught by unpack() — which is why only
 *      a digest the caller actually computed may be handed over;
 *   5. knownBlobDigests() maps collectEmbeddedResources() ids onto
 *      imageFingerprints, and never invents an entry for an image whose digest
 *      was not recorded.
 *
 * Run with:  node tests/state-pack-digests.test.js
 * Exit code 0 = all passed.
 */
"use strict";

const path = require("path");
const assert = require("assert");
const { StateFormat } = require(path.join(__dirname, "..", "src", "state-format.js"));
const { ImageFingerprint } = require(path.join(__dirname, "..", "src", "imagefingerprint.js"));

const MANIFEST = {
    schemaVersion: StateFormat.SCHEMA_VERSION,
    label: "digest probe",
    device: "rp1",
};

function memoryWords(count) {
    const words = new Uint16Array(count);
    for (let i = 0; i < count; i++) words[i] = (i * 7) & 0xffff;
    return words;
}

// A stand-in for an embedded disk image: 4 KiB is enough to make the digest
// meaningful, and small enough to keep the test instant.
const DISK = Uint8Array.from({ length: 4096 }, function (_, i) { return (i * 31) & 0xff; });
const DISK_DIGEST = ImageFingerprint.ofBytes(DISK);

function packWith(digests) {
    const blobs = [{ id: "resource-0", mediaType: "application/octet-stream", bytes: DISK }];
    return digests
        ? StateFormat.pack(MANIFEST, memoryWords(64), blobs, { digests: digests })
        : StateFormat.pack(MANIFEST, memoryWords(64), blobs);
}

function catalogEntry(container, id) {
    const parsed = StateFormat.unpack(container);
    assert.ok(parsed, "the container unreadable");
    return parsed.blobCatalog.find(function (item) { return item.id === id; });
}

// ---- 1. baseline: pack() computes the digest itself -----------------------
assert.strictEqual(catalogEntry(packWith(null), "resource-0").sha256, DISK_DIGEST,
    "without help, pack() records ImageFingerprint.ofBytes");

// ---- 2. a reused digest is written verbatim, and the state still reads ----
const reused = packWith({ "resource-0": DISK_DIGEST });
assert.strictEqual(catalogEntry(reused, "resource-0").sha256, DISK_DIGEST,
    "the caller's digest reaches the catalog unchanged");
const parsedReused = StateFormat.unpack(reused);
assert.deepStrictEqual(Array.from(parsedReused.blobs["resource-0"]), Array.from(DISK),
    "the blob bytes survive the shortcut");
assert.strictEqual(parsedReused.manifest.label, MANIFEST.label,
    "the manifest is untouched");
assert.strictEqual(parsedReused.manifest.imageFingerprints, undefined,
    "pack() does not invent manifest fields");

// ---- 3. a malformed digest is ignored, not trusted -----------------------
assert.strictEqual(catalogEntry(packWith({ "resource-0": "not-a-digest" }), "resource-0").sha256,
    DISK_DIGEST, "a value that is not a SHA-256 is hashed instead");
assert.strictEqual(catalogEntry(packWith({ "resource-0": "A".repeat(64) }), "resource-0").sha256,
    DISK_DIGEST, "uppercase hex is not the canonical form and is refused");
assert.strictEqual(catalogEntry(packWith({ "resource-0": "a".repeat(63) }), "resource-0").sha256,
    DISK_DIGEST, "a truncated digest is refused");

// ---- 4. a wrong digest is caught on the way back in ----------------------
assert.strictEqual(StateFormat.unpack(packWith({ "resource-0": "a".repeat(64) })), null,
    "unpack() verifies the catalog digest, so a wrong one yields an unreadable state");

// ---- 5. an id the blob list does not use changes nothing ----------------
assert.strictEqual(catalogEntry(packWith({ "resource-9": DISK_DIGEST }), "resource-0").sha256,
    DISK_DIGEST, "a digest for another id is simply not used");

// ---- 6. knownBlobDigests(): fingerprints + embeddedImages -> blob ids ----
assert.deepStrictEqual(
    StateFormat.knownBlobDigests(
        { "rp1.dsk": DISK_DIGEST },
        { "rp1.dsk": "resource-0" }),
    { "resource-0": DISK_DIGEST },
    "the url is the join key between the two maps");
assert.deepStrictEqual(
    StateFormat.knownBlobDigests({ "rp1.dsk": DISK_DIGEST }, { "rk1.dsk": "resource-1" }),
    {}, "an image with no recorded fingerprint is left for pack() to hash");
assert.deepStrictEqual(
    StateFormat.knownBlobDigests({ "rp1.dsk": "nope" }, { "rp1.dsk": "resource-0" }),
    {}, "a malformed fingerprint is never promoted to a digest");
assert.deepStrictEqual(StateFormat.knownBlobDigests(null, { "rp1.dsk": "resource-0" }), {},
    "a legacy state without fingerprints keeps hashing");
assert.deepStrictEqual(StateFormat.knownBlobDigests({ "rp1.dsk": DISK_DIGEST }, null), {},
    "a state with no embedded images has nothing to reuse");

// ---- 7. the real shortcut: pack(knownBlobDigests(...)) reads like a plain pack
const embedded = { "rp1.dsk": "resource-0" };
const fingerprints = { "rp1.dsk": DISK_DIGEST };
const manifest = Object.assign({}, MANIFEST, {
    imageFingerprints: fingerprints,
    embeddedImages: embedded,
});
const quick = StateFormat.pack(manifest, memoryWords(64),
    [{ id: "resource-0", mediaType: "application/octet-stream", bytes: DISK }],
    { digests: StateFormat.knownBlobDigests(manifest.imageFingerprints, manifest.embeddedImages) });
const plain = StateFormat.pack(manifest, memoryWords(64),
    [{ id: "resource-0", mediaType: "application/octet-stream", bytes: DISK }]);
assert.deepStrictEqual(Array.from(quick), Array.from(plain),
    "reusing the digests produces a byte-identical container");

console.log("ok: pack() reuses recorded digests without weakening the catalog");
