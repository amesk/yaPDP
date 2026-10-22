#!/usr/bin/env node
/**
 * Landing carousels loop, the same way the classic index.html gallery does.
 *
 * index.html builds its carousel as a circular buffer: a virtual `start` index
 * plus leading/trailing clones, so "next" on the last card shows the first and
 * "prev" on the first shows the last. The React landing used plain
 * scrollBy(+-220) on a native track, which physically stops at both ends.
 *
 * landing/src/hooks/wheelMath.js now carries the offset math for the native
 * equivalent: the track is padded with edge clones and, once a scroll settles
 * inside a clone, the offset is rewound by whole laps (count * step). What is
 * pinned here:
 *
 *   1. a step past either end rewinds to the mirrored real card;
 *   2. a half-panned drag keeps its fractional offset (no yank to a boundary);
 *   3. a long drag that overshoots several cards still lands in the real
 *      window, because the rewind is lap-based, not single-step;
 *   4. the clone run is always as wide as the viewport (it may repeat the
 *      gallery), so the rewind target is never clamped by the browser;
 *   5. a gallery narrower than its viewport does not clone (nothing to loop);
 *   6. the slide under the left edge is resolved modulo the slide count, so a
 *      click on a clone opens the right card in the lightbox;
 *   7. all three carousels share the hook and no longer scroll the track by a
 *      hard-coded 220 px on their own.
 *
 * No browser: the math module is imported directly, the components are read as
 * text (the same "read the source, drive nothing" style as
 * tests/games-gallery.test.js).
 *
 * Run with:  node tests/carousel-loop.test.js
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const MATH_PATH = path.join(ROOT, "landing", "src", "hooks", "wheelMath.js");
const HOOK_PATH = path.join(ROOT, "landing", "src", "hooks", "useWheelScroll.ts");
const COMPONENTS = ["OSCarousel.tsx", "InstantRun.tsx", "GamesCarousel.tsx"];

// The landing card is 200 px wide with a 14 px gap (w-[200px] + gap-3.5).
const STEP = 214;
const COUNT = 5;
const CLONES = 3;
const TOTAL = COUNT * STEP;
const START = CLONES * STEP; // scroll offset that shows real card 0

function near(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 0.001,
        message + " (expected " + expected + ", got " + actual + ")");
}

async function run() {
    const math = await import(pathToFileURL(MATH_PATH).href);

    // --- 1. one step past either end wraps around -------------------------
    near(math.realStartFor(CLONES, STEP), START,
        "realStartFor must return the offset of real card 0");
    near(math.wrapOffset(START + TOTAL, CLONES, COUNT, STEP), START,
        "next on the last card must rewind to the first card");
    near(math.wrapOffset(START - STEP, CLONES, COUNT, STEP), START + TOTAL - STEP,
        "prev on the first card must rewind to the last card");
    near(math.wrapOffset(START + TOTAL - STEP, CLONES, COUNT, STEP), START + TOTAL - STEP,
        "the last real card must stay put");

    // --- 2. a fractional drag keeps its position --------------------------
    near(math.wrapOffset(START + 2 * STEP + 0.4 * STEP, CLONES, COUNT, STEP),
        START + 2 * STEP + 0.4 * STEP,
        "a scroll inside the real window must not be snapped");
    near(math.wrapOffset(START + TOTAL + 0.25 * STEP, CLONES, COUNT, STEP),
        START + 0.25 * STEP,
        "a fractional overshoot past the last card must keep its fraction");

    // --- 3. long drags: the rewind is lap-based ---------------------------
    near(math.wrapOffset(START + 3 * TOTAL + 2 * STEP, CLONES, COUNT, STEP),
        START + 2 * STEP,
        "a drag several laps deep must land on the same real card");

    // --- 4. the clone run is always as wide as the viewport ---------------
    assert.strictEqual(math.cloneCountFor(COUNT, 900, STEP), 5,
        "900 / 214 rounds up to 5 clones");
    assert.strictEqual(math.cloneCountFor(COUNT, 700, STEP), 4,
        "700 / 214 rounds up to 4 clones");
    assert.strictEqual(math.cloneCountFor(20, 700, STEP), 4,
        "a long gallery only needs to fill the viewport");
    assert.strictEqual(math.cloneCountFor(1, 700, STEP), 0,
        "a single card cannot loop");
    assert.strictEqual(math.cloneCountFor(COUNT, 1184, STEP), 6,
        "a run must exceed the slide count when the viewport is wider than " +
        "one lap of cards — otherwise scrollLeft clamps short of the rewind " +
        "target and the wrap lands off-card");
    for (const viewport of [300, 640, 900, 1184, 1600]) {
        const laps = math.cloneCountFor(COUNT, viewport, STEP);
        assert.ok(laps * STEP >= viewport,
            "clone run (" + laps + " x " + STEP + " px) must cover the " +
            viewport + " px viewport");
    }

    // --- 5. a gallery that fits does not clone ----------------------------
    assert.strictEqual(math.overflows(3, 900, STEP), false,
        "3 cards (642 px) fit in 900 px: no loop");
    assert.strictEqual(math.overflows(5, 900, STEP), true,
        "5 cards (1070 px) overflow 900 px: loop");

    // --- 6. clone offsets resolve to the right real slide -----------------
    assert.strictEqual(math.indexAt(START, CLONES, COUNT, STEP), 0);
    assert.strictEqual(math.indexAt(START + 4 * STEP, CLONES, COUNT, STEP), 4);
    assert.strictEqual(math.indexAt(START + TOTAL, CLONES, COUNT, STEP), 0,
        "the trailing clone of card 0 must open card 0");
    assert.strictEqual(math.indexAt(START - STEP, CLONES, COUNT, STEP), COUNT - 1,
        "the leading clone of the last card must open the last card");

    // --- track order: [tail clones][real cards][head clones] --------------
    const items = math.wheelItems(COUNT, CLONES);
    assert.strictEqual(items.length, COUNT + 2 * CLONES,
        "the augmented track must hold the real cards plus both clone runs");
    assert.deepStrictEqual(
        { realIndex: items[0].realIndex, clone: items[0].clone },
        { realIndex: COUNT - CLONES, clone: true },
        "the track must open with the tail clones");
    assert.deepStrictEqual(
        { realIndex: items[CLONES].realIndex, clone: items[CLONES].clone },
        { realIndex: 0, clone: false },
        "the real cards must start after the tail clones");
    assert.deepStrictEqual(
        { realIndex: items[items.length - 1].realIndex, clone: items[items.length - 1].clone },
        { realIndex: CLONES - 1, clone: true },
        "the track must end with the head clones");
    assert.strictEqual(math.wheelItems(COUNT, 0).length, COUNT,
        "without clones the track is just the real cards");

    // A run longer than the gallery repeats it, still ending on the right card.
    const wide = math.wheelItems(3, 5);
    assert.strictEqual(wide.length, 3 + 2 * 5,
        "a run may repeat the gallery when the viewport is wide");
    assert.strictEqual(wide[4].realIndex, 2,
        "the tail run must end on the last real card");
    assert.strictEqual(wide[5].realIndex, 0,
        "the real cards must start right after the tail run");

    // --- 7. every carousel uses the shared hook ---------------------------
    const hook = fs.readFileSync(HOOK_PATH, "utf8");
    assert.ok(/wrapOffset\(/.test(hook),
        "the hook must rewind through wrapOffset — without it the track stops " +
        "on the last card");
    assert.ok(/data-wheel-card/.test(hook),
        "the hook measures the card pitch via [data-wheel-card]");

    for (const name of COMPONENTS) {
        const src = fs.readFileSync(
            path.join(ROOT, "landing", "src", "components", name), "utf8");
        assert.ok(/useWheelScroll\(/.test(src),
            name + ": must use the shared useWheelScroll hook");
        assert.ok(!/scrollBy\(/.test(src),
            name + ": still scrolls the track itself — the step and the loop " +
            "would then disagree with the hook's math");
        assert.ok(/data-wheel-card/.test(src),
            name + ": every rendered card must carry data-wheel-card");
    }

    console.log("carousel-loop: all tests passed (" + COMPONENTS.length +
        " carousels share the looping hook)");
}

run().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
