#!/usr/bin/env node
/**
 * Canonical image identity tests (src/imagefingerprint.js).
 *
 * Image identity is SHA-256 of the decompressed resource payload. The
 * implementation is synchronous and self-contained so it works in browsers,
 * file:// pages, desktop WebViews, and Node tests without crypto.subtle.
 *
 * These tests pin standard SHA-256 vectors, compare random inputs against
 * Node's independent crypto implementation, and preserve the unknown-identity
 * rule required by hosts that cannot expose their original bytes.
 *
 * Run with: node tests/image-fingerprint.test.js
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const path = require("path");

const { ImageFingerprint: F } = require(path.join(__dirname, "..", "src", "imagefingerprint.js"));

function testVectors() {
    const cases = [
        ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        ["a", "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"],
        ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
        ["hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
        ["foobar", "c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2"]
    ];
    for (const [text, expected] of cases) {
        assert.strictEqual(F.sha256(Buffer.from(text)), expected,
            "SHA-256 of " + JSON.stringify(text) + " must match the standard vector");
    }
    console.log("PASS: SHA-256 matches standard test vectors");
}

function testAgainstNodeCrypto() {
    for (let i = 0; i < 300; i++) {
        const n = 1 + Math.floor(Math.random() * 8192);
        const bytes = crypto.randomBytes(n);
        const expected = crypto.createHash("sha256").update(bytes).digest("hex");
        assert.strictEqual(F.sha256(bytes), expected,
            "SHA-256 must match Node crypto (length " + n + ")");
    }
    console.log("PASS: SHA-256 matches Node crypto for 300 random inputs");
}

function testOfBytes() {
    assert.strictEqual(F.ofBytes(null), null, "no bytes -> no identity");
    assert.strictEqual(F.ofBytes(undefined), null, "absent bytes -> no identity");
    assert.strictEqual(F.ofBytes(new Uint8Array(0)), null,
        "an empty body is not an image and has no identity");
    assert.strictEqual(F.ofBytes(new Uint8Array([1, 2, 3])),
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        "ofBytes returns the SHA-256 of the payload");
    assert.strictEqual(F.ofBytes(new Uint8Array([1, 2, 3])), F.ofBytes(new Uint8Array([1, 2, 3])),
        "the same bytes have the same identity");
    assert.notStrictEqual(F.ofBytes(new Uint8Array([1, 2, 3])), F.ofBytes(new Uint8Array([1, 2, 4])),
        "one changed byte changes the identity");
    assert.match(F.ofBytes(new Uint8Array([1, 2, 3])), /^[0-9a-f]{64}$/,
        "the canonical identity is 64 lowercase hex digits");
    console.log("PASS: ofBytes() returns stable SHA-256 identities");
}

function testMatches() {
    assert.strictEqual(F.matches(null, "a".repeat(64)), true, "unknown saved vs known now: match");
    assert.strictEqual(F.matches("a".repeat(64), null), true, "known saved vs unknown now: match");
    assert.strictEqual(F.matches(null, null), true, "unknown vs unknown: match");
    assert.strictEqual(F.matches("a".repeat(64), "a".repeat(64)), true, "same identity: match");
    assert.strictEqual(F.matches("a".repeat(64), "b".repeat(64)), false,
        "different known identities are a mismatch");
    assert.strictEqual(F.matches("a1b2c3d4", "a".repeat(64)), false,
        "a pre-0.4.0 FNV-1a/32 value must not be mistaken for a SHA-256 identity");
    assert.strictEqual(F.matches(undefined, "x"), true, "undefined is unknown too");
    console.log("PASS: matches() refuses differing known identities, including legacy-to-SHA migration");
}

function testDescribe() {
    assert.strictEqual(F.describe("a1b2c3d4", "f".repeat(64)),
        "expected a1b2c3d4, found " + "f".repeat(64));
    assert.strictEqual(F.describe(null, "f".repeat(64)), "expected unknown, found " + "f".repeat(64));
    assert.strictEqual(F.describe("a".repeat(64), null), "expected " + "a".repeat(64) + ", found unknown");
    console.log("PASS: describe() produces actionable mismatch details");
}

testVectors();
testAgainstNodeCrypto();
testOfBytes();
testMatches();
testDescribe();
console.log("image-fingerprint: all tests passed");
