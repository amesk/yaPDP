#!/usr/bin/env node
/**
 * TouchZoom modular tests.
 *
 * Loads the real production module (src/touchzoom.js) in an isolated VM context
 * and exercises the DOM-free decisions behind the two-finger zoom/pan of the
 * machine pages, plus the small structural contract that wires it into the page
 * (script tag, install call, CSS for a zoomed page).
 *
 * The module exists because a STANDALONE context — an iOS home-screen web app,
 * a desktop WebView — has no page zoom of its own: the emulator has to take the
 * gesture. Where the browser does zoom, the module steps aside, which is what
 * the visualViewport comparisons in the gesture path are for (measured in
 * tests/e2e-mobile-input.js, section 11).
 *
 * Run with:  node tests/touchzoom.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "touchzoom.js");
const PDP11_HTML = path.join(__dirname, "..", "pdp11.html");
const PDP11_APP = path.join(__dirname, "..", "src", "pdp11-app.js");
const PDP11_CSS = path.join(__dirname, "..", "css", "pdp11.css");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var TouchZoom = ...` at top level becomes a property of the sandbox.
    return sandbox.TouchZoom;
}

// Cross-realm objects (built inside the VM) compare reliably only as plain
// values, the same trick tests/mobile-input.test.js uses.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function touches(a, b) {
    return [{ clientX: a[0], clientY: a[1] }, { clientX: b[0], clientY: b[1] }];
}

function run() {
    const T = loadModule();
    assert.ok(T, "module should expose TouchZoom");
    for (const fn of ["install", "reset", "clampScale", "pinchScale", "pinchPan",
                      "clampAxis", "clampPan", "touchDistance", "touchCentroid",
                      "state", "inverseTransform"]) {
        assert.strictEqual(typeof T[fn], "function", fn + " must be exported");
    }
    assert.strictEqual(T.MAX_SCALE, 4, "the zoom ceiling is part of the contract");
    assert.ok(typeof T.PINNED_SELECTOR === "string", "the pinned blocks are named");
    assert.strictEqual(T.CONTROLS_CLASS, "touch-controls",
        "the layout flag that docks the strip is named once");
    assert.strictEqual(typeof T.updateControlsFlag, "function",
        "the flag is recomputed on page changes");

    // ---- the pinned control blocks ---------------------------------------
    // The operator controls must not grow or slide with the picture: their layer
    // carries the INVERSE of the page transform, which is a pure calculation and
    // therefore testable without a DOM.
    {
        for (const sel of ["#teletype-controls", ".lp11-console",
                           ".printer-actions", ".panel-actions",
                           ".action-more-menu"]) {
            assert.ok(T.PINNED_SELECTOR.indexOf(sel) !== -1,
                "the control block " + sel + " must be pinned");
        }
        assert.strictEqual(T.inverseTransform(1, { x: 0, y: 0 }),
            "scale(1) translate(0px, 0px)", "1:1 is the identity");
        assert.strictEqual(T.inverseTransform(2, { x: -30, y: -40 }),
            "scale(0.5) translate(30px, 40px)",
            "the inverse cancels the page's scale and pan");
        assert.strictEqual(T.inverseTransform(4, { x: 0, y: 0 }),
            "scale(0.25) translate(0px, 0px)", "a 4x zoom is undone by 1/4");
        assert.strictEqual(T.inverseTransform(0, null),
            "scale(1) translate(0px, 0px)", "a broken scale falls back to 1:1");
        assert.strictEqual(T.inverseTransform(NaN, { x: NaN, y: 5 }),
            "scale(1) translate(0px, -5px)",
            "a broken scale falls back to 1:1, the axis that is fine is kept");
    }

    // ---- clampScale: never below 1:1, never above the ceiling ------------
    {
        assert.strictEqual(T.clampScale(0.5), 1, "a pinch cannot shrink below 1:1");
        assert.strictEqual(T.clampScale(0), 1, "zero is 1:1");
        assert.strictEqual(T.clampScale(-3), 1, "a negative scale is 1:1");
        assert.strictEqual(T.clampScale(NaN), 1, "a broken scale is 1:1");
        assert.strictEqual(T.clampScale(1), 1, "1:1 stays 1:1");
        assert.strictEqual(T.clampScale(2.5), 2.5, "a zoom inside the range is kept");
        assert.strictEqual(T.clampScale(9), 4, "the ceiling clamps overshoot");
        assert.strictEqual(T.clampScale(9, 6), 6, "the ceiling is injectable");

        assert.strictEqual(T.isZoomed(1), false, "1:1 is not zoomed");
        assert.strictEqual(T.isZoomed(0.9999), false, "a rounding wobble is not a zoom");
        assert.strictEqual(T.isZoomed(1.2), true, "a real zoom is a zoom");
    }

    // ---- pinchScale: the ratio of the finger distance ---------------------
    {
        assert.strictEqual(T.pinchScale(1, 100, 200), 2,
            "twice the finger distance is twice the scale");
        assert.strictEqual(T.pinchScale(2, 100, 50), 1,
            "closing the fingers returns to 1:1, never further");
        assert.strictEqual(T.pinchScale(2, 100, 400), 4,
            "…and stops at the ceiling");
        assert.strictEqual(T.pinchScale(3, 0, 500), 3,
            "a degenerate start distance keeps the scale");
        assert.strictEqual(T.pinchScale(2, 100, NaN), 2,
            "a broken distance keeps the scale");
    }

    // ---- pinchPan: the zoom is anchored between the fingers ---------------
    // The fault this covers: growing about the page's corner threw the point the
    // operator was looking at out of view, so he had to zoom back out and pan to
    // find it again.
    {
        // 1:1 at the corner, pinch open at (100,100): the page has to move so that
        // the same machine point stays under that spot.
        assert.deepStrictEqual(plain(T.pinchPan({ x: 0, y: 0 }, 1, { x: 100, y: 100 },
            { x: 100, y: 100 }, 2)), { x: -100, y: -100 },
            "a doubled scale at (100,100) puts the origin at -100");

        // The invariant itself: local = (centroid - pan) / scale must not change.
        const local = (pan, scale, c) => [(c.x - pan.x) / scale, (c.y - pan.y) / scale];
        const before = local({ x: -50, y: -50 }, 2, { x: 100, y: 100 });
        const after = local(T.pinchPan({ x: -50, y: -50 }, 2, { x: 100, y: 100 },
            { x: 100, y: 100 }, 3), 3, { x: 100, y: 100 });
        assert.deepStrictEqual(plain(after), plain(before),
            "the machine point under the fingers does not move");

        // A two-finger DRAG (the centroid moves, the spread does not) pans the
        // page by exactly the distance the fingers travelled.
        assert.deepStrictEqual(plain(T.pinchPan({ x: 0, y: 0 }, 1, { x: 100, y: 100 },
            { x: 150, y: 120 }, 1)), { x: 50, y: 20 },
            "a drag of (+50,+20) moves the page by (+50,+20)");

        // Broken input must not produce a NaN transform.
        assert.deepStrictEqual(plain(T.pinchPan(null, 0, null, null, 0)),
            { x: 0, y: 0 }, "nothing sane in, nothing moves");
        const guarded = plain(T.pinchPan({ x: 0, y: 0 }, 1, { x: 100, y: 100 },
            { x: 100, y: 100 }, NaN));
        assert.ok(isFinite(guarded.x) && isFinite(guarded.y),
            "a broken scale still yields a finite pan");
    }

    // ---- pan clamping: the picture may never leave its own box ------------
    {
        // scale 2 over a 400x300 box: the pan may run from -400/-300 to 0.
        assert.strictEqual(T.clampAxis(20, 400, 2), 0, "no gap on the left/top");
        assert.strictEqual(T.clampAxis(-100, 400, 2), -100, "panning inside is kept");
        assert.strictEqual(T.clampAxis(-500, 400, 2), -400, "the far edge stops the pan");
        assert.strictEqual(T.clampAxis(-100, 400, 1), 0, "at 1:1 there is nothing to pan");
        assert.strictEqual(T.clampAxis(NaN, 400, 2), 0, "a broken pan is no pan");

        assert.deepStrictEqual(plain(T.clampPan({ x: -10, y: 10 }, 2, 400, 300)),
            { x: -10, y: 0 }, "each axis is clamped on its own");
        assert.deepStrictEqual(plain(T.clampPan(null, 2, 400, 300)),
            { x: 0, y: 0 }, "a missing pan is no pan");
    }

    // ---- the touch geometry ----------------------------------------------
    {
        assert.strictEqual(T.touchDistance(touches([0, 0], [30, 40])), 50,
            "the distance is the hypotenuse, not one axis");
        assert.strictEqual(T.touchDistance(touches([0, 0], [0, 0])), 0,
            "fingers on the same spot have no distance");
        assert.strictEqual(T.touchDistance([{ clientX: 1, clientY: 1 }]), 0,
            "one finger has no distance");

        assert.deepStrictEqual(plain(T.touchCentroid(touches([100, 200], [110, 240]))),
            { x: 105, y: 220 }, "the centroid is the middle of the fingers");
        assert.deepStrictEqual(plain(T.touchCentroid([])), { x: 0, y: 0 },
            "no fingers, no centroid");
    }

    // ---- installed state is 1:1 with nothing to undo ----------------------
    {
        assert.deepStrictEqual(plain(T.state()),
            { scale: 1, pan: { x: 0, y: 0 }, page: null },
            "before install the module holds nothing");
        assert.strictEqual(T.install({ document: null }), false,
            "install without a document is a no-op");
        assert.strictEqual(T.install({}), false,
            "install without a DOM (Node) is a no-op");
    }

    // ---- structural: the page wires the module in ------------------------
    {
        const html = fs.readFileSync(PDP11_HTML, "utf8");
        const app = fs.readFileSync(PDP11_APP, "utf8");
        const css = fs.readFileSync(PDP11_CSS, "utf8");
        const touchAt = html.indexOf("src='src/touchzoom.js'");
        assert.ok(touchAt !== -1, "pdp11.html must load src/touchzoom.js");
        assert.ok(html.indexOf("src='src/mobile-input.js'") < touchAt,
            "touchzoom.js loads after mobile-input.js (it asks isCoarse)");
        assert.ok(touchAt < html.indexOf("src='src/pdp11-app.js'"),
            "touchzoom.js loads before pdp11-app.js (the app installs it)");
        assert.ok(app.indexOf("TouchZoom.install()") !== -1,
            "pdp11-app.js must install the gesture layer");
        assert.ok(/\.page\.touch-zoomed\s*\{[^}]*overflow:\s*hidden/.test(css),
            "css/pdp11.css must keep a zoomed page from spilling");
        // The controls dock as the FIRST row and the round floating buttons move
        // below the strip — but only while a page actually has those controls.
        assert.ok(/body\.touch-gestures\.touch-controls\s+\.console-reboot[\s\S]{0,160}?top:\s*calc\(var\(--touch-strip-h\)/
            .test(css), "the round buttons must follow the control strip down");
        assert.ok(/body\.touch-gestures\s*\{[^}]*--touch-strip-h:\s*0px/.test(css),
            "…and stay at the top where there is no strip");
    }

    console.log("touchzoom.test.js: all tests passed");
}

run();
