#!/usr/bin/env node
/**
 * compare-shots stats() unit tests.
 *
 * The screenshot diff helper (tools/compare-shots.js) decides whether a
 * regenerated PNG really changed or merely moved by a sub-pixel; that decision
 * is the pure stats() function. This test pins its arithmetic on synthetic
 * RGBA buffers, so the tool's classification can be trusted without decoding
 * real images (no `sharp` needed here).
 *
 * Run with:  node tests/compare-shots.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const assert = require("assert");

const { stats } = require(path.join(__dirname, "..", "tools", "compare-shots.js"));

/** A solid RGBA image of the given colour, as stats() consumes it. */
function solid(w, h, rgb) {
    const raw = Buffer.alloc(w * h * 4);
    for (let i = 0; i < raw.length; i += 4) {
        raw[i] = rgb[0];
        raw[i + 1] = rgb[1];
        raw[i + 2] = rgb[2];
        raw[i + 3] = 255;
    }
    return { w: w, h: h, raw: raw };
}

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

test("identical images differ in nothing", () => {
    const s = stats(solid(4, 4, [10, 20, 30]), solid(4, 4, [10, 20, 30]));
    assert.strictEqual(s.size, false);
    assert.strictEqual(s.pct, 0);
    assert.strictEqual(s.strong, 0);
    assert.strictEqual(s.maxDelta, 0);
    assert.strictEqual(s.meanDelta, 0);
});

test("a differing dimension is reported as a size change", () => {
    const s = stats(solid(4, 4, [0, 0, 0]), solid(4, 5, [0, 0, 0]));
    assert.deepStrictEqual(s, { size: true });
});

test("one strongly changed pixel is a strong, but tiny, difference", () => {
    const a = solid(10, 10, [0, 0, 0]); // 100 px
    const b = solid(10, 10, [0, 0, 0]);
    b.raw[0] = 100; // one channel of the first pixel, delta 100 (> 32)
    const s = stats(a, b);
    assert.strictEqual(s.diffPixels, 1);
    assert.strictEqual(s.pct, 1);          // 1 of 100 pixels
    assert.strictEqual(s.strong, 1);
    assert.strictEqual(s.strongPct, 1);
    assert.strictEqual(s.maxDelta, 100);
    assert.strictEqual(s.meanDelta, 100);
});

test("a faint change counts as differing but not as strong", () => {
    const a = solid(10, 10, [0, 0, 0]);
    const b = solid(10, 10, [0, 0, 0]);
    b.raw[0] = 10; // delta 10 (<= 32): noticeable to the tool, not to a human
    const s = stats(a, b);
    assert.strictEqual(s.diffPixels, 1);
    assert.strictEqual(s.strong, 0);
    assert.strictEqual(s.maxDelta, 10);
});

test("mean delta averages over differing pixels only", () => {
    const a = solid(2, 2, [0, 0, 0]); // 4 px
    const b = solid(2, 2, [0, 0, 0]);
    b.raw[0] = 40;  // pixel 0, delta 40
    b.raw[4] = 20;  // pixel 1, delta 20
    const s = stats(a, b);
    assert.strictEqual(s.diffPixels, 2);
    assert.strictEqual(s.pct, 50);
    assert.strictEqual(s.meanDelta, 30);
    assert.strictEqual(s.maxDelta, 40);
    assert.strictEqual(s.total, 4);
});

console.log("\n" + passed + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
