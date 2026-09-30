#!/usr/bin/env node
/**
 * Image fingerprint tests (src/imagefingerprint.js).
 *
 * The fingerprint is what replaced the hand-maintained IMAGE_VERSION: it is
 * computed from the image bytes, so a repacked .zst invalidates the caches and
 * snapshots that belong to the old build without anyone having to remember to
 * bump a constant. Two things have to be true for that to be safe, and both are
 * pinned here:
 *
 *   1. the hash IS FNV-1a/32 — checked against the published test vectors and
 *      against a BigInt reference over random input, because the 32-bit
 *      multiply is where a straightforward implementation goes wrong
 *      (h * 16777619 exceeds 2^53, and the naive shift decomposition uses
 *      SIGNED shifts that go negative for large h). A hash that is quietly
 *      wrong still "works" until two different images collide;
 *   2. UNKNOWN means UNKNOWN — a fingerprint that was never computed (no
 *      manifest, file://, a desktop bundle) must match everything, or every
 *      host without a .zst would start refusing good snapshots and discarding
 *      good caches.
 *
 * Run with:  node tests/image-fingerprint.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");

const { ImageFingerprint: F } = require(path.join(__dirname, "..", "src", "imagefingerprint.js"));

// The FNV-1a/32 reference, in BigInt: the ground truth the fast path is
// measured against. Independent of the production implementation.
function refFnv1a32(bytes) {
    let h = 0x811c9dc5n;
    const prime = 16777619n;
    const mask = 0xffffffffn;
    for (const b of bytes) {
        h ^= BigInt(b);
        h = (h * prime) & mask;
    }
    return Number(h);
}

function testVectors() {
    // Published FNV-1a/32 test vectors.
    const cases = [
        ["", 0x811c9dc5],          // offset basis
        ["a", 0xe40c292c],
        ["b", 0xe70c2de5],
        ["foobar", 0xbf9cf968],
        ["hello", 0x4f9f2cab]
    ];
    for (const [text, expected] of cases) {
        assert.strictEqual(F.fnv1a32(Buffer.from(text)), expected >>> 0,
            "FNV-1a/32 of " + JSON.stringify(text) + " must be the published value");
    }
    console.log("PASS: FNV-1a/32 matches the published test vectors");
}

function testAgainstReference() {
    // Random lengths and bytes, so a carry/overflow bug in the multiply shows
    // up: the naive h*prime path loses precision, and the shift path goes
    // negative, both of which pass a single short input but fail here.
    for (let i = 0; i < 300; i++) {
        const n = 1 + Math.floor(Math.random() * 4096);
        const bytes = Buffer.alloc(n);
        for (let j = 0; j < n; j++) bytes[j] = Math.floor(Math.random() * 256);
        assert.strictEqual(F.fnv1a32(bytes), refFnv1a32(bytes),
            "fingerprint must equal the BigInt reference (length " + n + ")");
    }
    console.log("PASS: the fast 32-bit multiply matches the BigInt reference (300 random inputs)");
}

function testFormat() {
    assert.strictEqual(F.format(0), "00000000", "zero is zero-padded");
    assert.strictEqual(F.format(0x811c9dc5), "811c9dc5", "a full hash is 8 hex digits");
    assert.strictEqual(F.format(0xff), "000000ff", "always the same width");
    for (let i = 0; i < 200; i++) {
        const h = Math.floor(Math.random() * 0x100000000);
        assert.match(F.format(h), /^[0-9a-f]{8}$/, "format is always 8 lowercase hex digits");
    }
    console.log("PASS: format() is always 8 lowercase hex digits");
}

function testOfBytes() {
    assert.strictEqual(F.ofBytes(null), null, "no bytes -> no identity");
    assert.strictEqual(F.ofBytes(undefined), null, "absent bytes -> no identity");
    assert.strictEqual(F.ofBytes(new Uint8Array(0)), null,
        "an empty body is not an image and has no identity");
    assert.strictEqual(F.ofBytes(new Uint8Array([1, 2, 3])), F.ofBytes(new Uint8Array([1, 2, 3])),
        "the same bytes fingerprint the same");
    assert.notStrictEqual(F.ofBytes(new Uint8Array([1, 2, 3])), F.ofBytes(new Uint8Array([1, 2, 4])),
        "one changed byte changes the fingerprint");
    console.log("PASS: ofBytes() has no identity for empty bytes and is stable for equal bytes");
}

function testMatches() {
    // The permissive rule: unknown NEVER contradicts. This is what keeps a
    // host without a .zst (or a desktop-bundle image) working.
    assert.strictEqual(F.matches(null, "a1b2c3d4"), true, "unknown saved vs known now: match");
    assert.strictEqual(F.matches("a1b2c3d4", null), true, "known saved vs unknown now: match");
    assert.strictEqual(F.matches(null, null), true, "unknown vs unknown: match");
    assert.strictEqual(F.matches("a1b2c3d4", "a1b2c3d4"), true, "same fingerprint: match");
    assert.strictEqual(F.matches("a1b2c3d4", "ffffffff"), false,
        "two different KNOWN fingerprints: mismatch — this is the whole point");
    assert.strictEqual(F.matches(undefined, "x"), true, "undefined is unknown too");
    console.log("PASS: matches() refuses only two known, differing fingerprints");
}

function testDescribe() {
    assert.strictEqual(F.describe("a1b2c3d4", "ffffffff"), "expected a1b2c3d4, found ffffffff");
    assert.strictEqual(F.describe(null, "ffffffff"), "expected unknown, found ffffffff");
    assert.strictEqual(F.describe("a1b2c3d4", null), "expected a1b2c3d4, found unknown");
    console.log("PASS: describe() reads as plain English for the dialog");
}

testVectors();
testAgainstReference();
testFormat();
testOfBytes();
testMatches();
testDescribe();
console.log("image-fingerprint: all tests passed");
