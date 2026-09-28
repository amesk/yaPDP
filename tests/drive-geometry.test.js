#!/usr/bin/env node
/**
 * DriveGeometry modular tests.
 *
 * Pins the image ↔ controller compatibility table (src/drive-geometry.js):
 * an image whose size is not one of the controller's geometry sizes must be
 * refused, while the unchecked controllers (UDA50/MSCP, TM11 magtape) accept
 * anything. The size arithmetic mirrors the device geometry in
 * src/devices/rk11.js, rl11.js and rp11.js.
 *
 * Run with:  node tests/drive-geometry.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const assert = require("assert");

const { DriveGeometry } = require(path.join(__dirname, "..", "src", "drive-geometry.js"));

// Mirrors of the device geometry tables.
const RK05 = 406 * 12 * 512;             // rk11.js: 406 tracks x 12 sectors x 512 B
const RL01 = 512 * 40 * 256;             // rl11.js: 512 tracks x 40 sectors x 256 B
const RL02 = 1024 * 40 * 256;            // rl11.js: 1024 tracks x 40 sectors x 256 B
const RP04 = 411 * 19 * 22 * 512;        // rp11.js: 411 cylinders x 19 surfaces x 22 x 512 B
const RP06 = 815 * 19 * 22 * 512;        // rp11.js: 815 cylinders x 19 surfaces x 22 x 512 B

let passed = 0;
let failures = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("  ok  " + name);
    } catch (err) {
        failures++;
        console.error("FAIL  " + name);
        console.error("      " + (err && err.message));
    }
}

test("prefix/name/label resolve from a drive id", () => {
    assert.strictEqual(DriveGeometry.prefixOf("rk2"), "rk");
    assert.strictEqual(DriveGeometry.prefixOf("rp1"), "rp");
    assert.strictEqual(DriveGeometry.nameOf("rl0"), "RL11");
    assert.strictEqual(DriveGeometry.labelOf("rp1"), "RP04/RP06");
    assert.strictEqual(DriveGeometry.labelOf("ra0"), "");
});

test("an RK05 image fits RK drives", () => {
    assert.deepStrictEqual(DriveGeometry.check("rk0", RK05), { ok: true, reason: "" });
    assert.deepStrictEqual(DriveGeometry.check("rk7", RK05), { ok: true, reason: "" });
});

test("an RP06 image is refused on RK (RK05-only) and explains why", () => {
    const r = DriveGeometry.check("rk0", RP06);
    assert.strictEqual(r.ok, false);
    assert.ok(/RK11/.test(r.reason), "reason names the controller: " + r.reason);
    assert.ok(/RK05/.test(r.reason), "reason names the drive model: " + r.reason);
    assert.ok(/166\./.test(r.reason), "reason reports the image size: " + r.reason);
});

test("RL01 and RL02 images both fit RL drives; an RK05 does not", () => {
    assert.ok(DriveGeometry.check("rl0", RL01).ok);
    assert.ok(DriveGeometry.check("rl1", RL02).ok);
    assert.strictEqual(DriveGeometry.check("rl2", RK05).ok, false);
});

test("RP04 and RP06 images fit RP drives; only RP06 fits rp0/rp1 presets", () => {
    assert.ok(DriveGeometry.check("rp2", RP04).ok);
    assert.ok(DriveGeometry.check("rp1", RP06).ok);
    assert.strictEqual(DriveGeometry.check("rp0", RL02).ok, false);
});

test("UDA50 and TM11 are unchecked (no fixed geometry)", () => {
    assert.ok(DriveGeometry.check("ra0", 123).ok);
    assert.ok(DriveGeometry.check("tm0", 999999999).ok);
    assert.strictEqual(DriveGeometry.sizesFor("ra0"), null);
    assert.strictEqual(DriveGeometry.sizesFor("tm1"), null);
});

test("an unknown drive id and an unknown size are not blocked", () => {
    assert.ok(DriveGeometry.check("xx0", 123).ok);
    assert.ok(DriveGeometry.check("rk0", null).ok);
    assert.ok(DriveGeometry.check("rk0", undefined).ok);
});

test("sizesFor returns a copy (callers cannot mutate the table)", () => {
    const a = DriveGeometry.sizesFor("rk0");
    a.push(1);
    assert.strictEqual(DriveGeometry.sizesFor("rk0").length, 1);
});

console.log("\n" + passed + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
