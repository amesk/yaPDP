#!/usr/bin/env node
/**
 * Landing lightbox fit contract.
 *
 * The React lightbox on the landing page (landing/src/components/Lightbox.tsx)
 * must size its screenshot from the space LEFT OVER by the top bar and the
 * caption block, never from a fixed share of the viewport height. A vh-based
 * cap ignored the caption + launch button, so on short viewports (a 1080p
 * screen at 125% Windows display scaling leaves ~864 CSS px of height) the
 * "Run this demo" button was pushed below the fold and clipped.
 *
 * The contract guarded here:
 *   • the overlay is a three-row grid — auto (top bar) / minmax(...,1fr)
 *     (image) / auto (caption + launch action) — with a scroll fallback;
 *   • the screenshot carries no vh-based max-height and instead fills the
 *     remaining row (max-h-full);
 *   • the launch action stays in normal flow, so it can never be positioned
 *     outside the visible area.
 *
 * These are string checks on the production source, so the test stays fast and
 * needs no browser.
 *
 * Run with:  node tests/landing-lightbox-fit.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const LIGHTBOX = path.join(
    __dirname, "..", "landing", "src", "components", "Lightbox.tsx");

/** Returns the className of the first `className="..."` after `marker`. */
function classAfter(source, marker) {
    const at = source.indexOf(marker);
    assert.ok(at !== -1, "marker not found in Lightbox.tsx: " + marker);
    const match = /className="([^"]*)"/.exec(source.slice(at));
    assert.ok(match, "no className after marker: " + marker);
    return match[1];
}

function run() {
    const src = fs.readFileSync(LIGHTBOX, "utf8");

    // ---- The overlay lays out in three grid rows ------------------------
    const overlay = classAfter(src, 'role="dialog"');

    assert.ok(
        /grid-rows-\[auto_minmax\(\d+(?:\.\d+)?rem,1fr\)_auto\]/.test(overlay),
        "the lightbox overlay must size its rows as " +
        "auto / minmax(...,1fr) / auto — got: " + overlay);
    assert.ok(
        overlay.indexOf("justify-between") === -1,
        "the overlay must not use justify-between: it pins the caption to the " +
        "viewport edge instead of letting the image shrink");
    assert.ok(
        overlay.indexOf("overflow-y-auto") !== -1,
        "the overlay needs a scroll fallback for viewports too short for the " +
        "caption alone");

    // ---- The screenshot fills the leftover row --------------------------
    const img = classAfter(src, "<img");

    assert.ok(
        !/max-h-\[[^\]]*vh\]/.test(img),
        "the screenshot must not cap its height in vh — the caption block is " +
        "not accounted for and the launch button gets clipped");
    assert.ok(
        img.indexOf("max-h-full") !== -1,
        "the screenshot must be capped by the grid row (max-h-full)");
    assert.ok(
        img.indexOf("object-contain") !== -1,
        "the screenshot must keep its aspect ratio (object-contain)");

    // ---- The image wrapper has a definite height ------------------------
    const wrapper = classAfter(src, 'onClick={(e) => e.stopPropagation()}');
    assert.ok(
        wrapper.indexOf("h-full") !== -1,
        "the image wrapper needs h-full so max-h-full on the <img> resolves " +
        "against the grid row");

    // ---- The launch action stays in flow --------------------------------
    const launch = classAfter(src, "aria-label={launchLabel ||");
    assert.ok(
        !/(^|\s)absolute(\s|$)/.test(launch) && launch.indexOf("bottom-") === -1,
        "the launch button must stay in normal flow under the caption — " +
        "absolute positioning is what hid it off-screen before: " + launch);

    console.log("landing-lightbox-fit.test.js: all tests passed");
}

run();
