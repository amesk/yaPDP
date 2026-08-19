#!/usr/bin/env node
/**
 * VT11 vector-graphics display modular tests.
 *
 * Loads the real production module (src/vt11.js) in an isolated VM context
 * (same pattern as tests/dl11-recv.test.js) and verifies the register-level
 * behaviour and the CONFIG gating introduced for the "Display" page:
 *   - the VT11 block is registered at 17772000 ONLY when Config.vt11 is on;
 *   - DSR reads 0x8000 (stopped) after power-on and after reset();
 *   - reading DPC returns the current display program counter;
 *   - writing DPC initialises the renderer and starts the processor
 *     (the DSR stop bit is cleared) and stores the even word address;
 *   - poll() reports IPL 4 and the 0320/0324 vectors;
 *   - reset() restores the stopped state and clears DPC;
 *   - the view transform is applied to the drawing context (BG) only, not the
 *     compositing context (FG) — guards against a double transform that would
 *     desync the light pen from the mouse.
 *
 * The helper globals the device relies on (insertData, requestInterrupt) are
 * extracted verbatim from src/iopage.js so the test never drifts from the
 * production code. DOM/timers are stubbed — the renderer only touches them
 * when a DPC write starts the processor loop, which never actually runs here.
 *
 * Run with:  node tests/vt11.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const VT11_SOURCE = path.join(__dirname, "..", "src", "vt11.js");
const IOPAGE_SOURCE = path.join(__dirname, "..", "src", "iopage.js");

// VT11 register block base (17772000).
const VT11_BASE = 0o17772000;
const DPC = 0o17772000; // Display Program Counter
const DSR = 0o17772002; // Display Status Register

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function
// (same implementation as tests/dl11-recv.test.js).
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
    const start = src.indexOf(startMarker);
    if (start === -1) {
        throw new Error("marker not found: " + startMarker);
    }
    const braceOpen = src.indexOf("{", start);
    if (braceOpen === -1) {
        throw new Error("no opening brace for: " + startMarker);
    }
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                if (tail) {
                    const rest = src.slice(i + 1, i + 1 + tail.length);
                    if (rest !== tail) {
                        throw new Error("expected tail '" + tail + "' after " + startMarker);
                    }
                    return src.slice(start, i + 1 + tail.length);
                }
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

// Stub DOM element used by the VT11 renderer (canvas / stats panel / label).
// When trackContexts is given, every getContext() result is recorded so tests
// can assert which context receives the renderer's view transform.
function makeEl(trackContexts) {
    return {
        style: {},
        checked: false,
        textContent: "",
        children: [],
        addEventListener: function () {},
        appendChild: function (child) {
            this.children.push(child);
            return child;
        },
        getContext: function () {
            // Transform-tracking stub: the renderer assigns stroke/fill/font
            // props on BG and calls translate/scale when the transform is on.
            const ctx = {
                translateCalls: 0,
                scaleCalls: 0,
                translate: function (x, y) {
                    this.translateCalls++;
                    this.translateX = x;
                    this.translateY = y;
                },
                scale: function (x, y) {
                    this.scaleCalls++;
                    this.scaleX = x;
                    this.scaleY = y;
                },
            };
            if (trackContexts) trackContexts.push(ctx);
            return ctx;
        },
        width: 0,
        height: 0,
    };
}

// Fresh sandbox with a stubbed iopage that captures registrations.
// opts.vt11 controls the Config flag that gates device registration.
function loadVT11(opts) {
    const src = fs.readFileSync(VT11_SOURCE, "utf8");
    const iopageSrc = fs.readFileSync(IOPAGE_SOURCE, "utf8");
    const insertData = extractBlock(iopageSrc, "function insertData", "");
    const requestInterrupt = extractBlock(iopageSrc, "function requestInterrupt", "");

    const registrations = [];
    const container = makeEl(opts.trackContexts);

    const sandbox = {};
    sandbox.CPU = { interruptRequested: 0, runState: 0 };
    sandbox.STATE_WAIT = 3;
    sandbox.STATE_RUN = 1;
    sandbox.trap = function () { return -1; };
    sandbox.Config = { get: function () { return { vt11: !!opts.vt11 }; } };
    sandbox.iopage = {
        register: function (address, count, device) {
            registrations.push({ address: address, count: count, device: device });
        },
    };
    sandbox.readWordByPhysical = function () { return -1; };
    sandbox.document = {
        body: makeEl(opts.trackContexts),
        getElementById: function (id) { return id === "vt11" ? container : null; },
        createElement: function () { return makeEl(opts.trackContexts); },
        createTextNode: function (t) { return { textContent: t }; },
    };
    // Timers must NOT actually run the VT11 processor loop.
    sandbox.setTimeout = function () { return 1; };
    sandbox.setInterval = function () { return 1; };

    vm.createContext(sandbox);
    vm.runInContext(
        insertData + "\n" + requestInterrupt + "\n" + src,
        sandbox
    );
    return { sandbox: sandbox, registrations: registrations };
}

function run() {
    // ------------------------------------------------------------------
    // Test 1: CONFIG gating — registered only when vt11 is enabled.
    // ------------------------------------------------------------------
    {
        const off = loadVT11({ vt11: false });
        assert.strictEqual(off.registrations.length, 0,
            "vt11 off -> device must NOT be registered");

        const on = loadVT11({ vt11: true });
        assert.strictEqual(on.registrations.length, 1,
            "vt11 on -> device registered exactly once");
        const reg = on.registrations[0];
        assert.strictEqual(reg.address, VT11_BASE,
            "registered at the standard VT11 base 17772000");
        assert.strictEqual(reg.count, 4, "4-byte register block");
        assert.strictEqual(typeof reg.device.access, "function", "access handler present");
        assert.strictEqual(typeof reg.device.poll, "function", "poll handler present");
        assert.strictEqual(typeof reg.device.reset, "function", "reset handler present");
    }

    // ------------------------------------------------------------------
    // Test 2: DSR reads 0x8000 (stopped) after power-on.
    // ------------------------------------------------------------------
    {
        const t = loadVT11({ vt11: true });
        const dev = t.registrations[0].device;
        assert.strictEqual(dev.access(DSR, -1, false), 0x8000,
            "DSR starts stopped (stop bit 15 set)");
    }

    // ------------------------------------------------------------------
    // Test 3: reading DPC returns the current display program counter.
    // ------------------------------------------------------------------
    {
        const t = loadVT11({ vt11: true });
        const dev = t.registrations[0].device;
        assert.strictEqual(dev.access(DPC, -1, false), 0,
            "DPC initial value is 0");
    }

    // ------------------------------------------------------------------
    // Test 4: writing DPC stores the address and starts the processor.
    // ------------------------------------------------------------------
    {
        const t = loadVT11({ vt11: true });
        const dev = t.registrations[0].device;
        dev.access(DPC, 0o1000, false);
        assert.strictEqual(dev.access(DPC, -1, false), 0o1000,
            "DPC holds the written display-list address");
        const dsr = dev.access(DSR, -1, false);
        assert.strictEqual(dsr & 0x8000, 0,
            "writing DPC clears the stop bit (processor started)");
    }

    // ------------------------------------------------------------------
    // Test 5: poll — IPL 4, nothing pending, vector 0320 when taken empty.
    // ------------------------------------------------------------------
    {
        const t = loadVT11({ vt11: true });
        const dev = t.registrations[0].device;
        assert.strictEqual(dev.poll(false), 4 << 5,
            "poll reports IPL 4 with no interrupt pending");
        assert.strictEqual(dev.poll(true), 0o320,
            "empty poll(true) returns vector 0320");
    }

    // ------------------------------------------------------------------
    // Test 6: reset restores the stopped state and clears DPC.
    // ------------------------------------------------------------------
    {
        const t = loadVT11({ vt11: true });
        const dev = t.registrations[0].device;
        dev.access(DPC, 0o1000, false); // start the processor
        dev.reset();
        assert.strictEqual(dev.access(DPC, -1, false), 0,
            "reset clears DPC");
        assert.strictEqual(dev.access(DSR, -1, false), 0x8000,
            "reset restores the stopped state");
    }

    // ------------------------------------------------------------------
    // Test 7: the view transform is applied to the drawing context only.
    // Regression guard for the "inner screen padding" change: applying the
    // transform to the compositing context (ctxFG) too scaled/padded the
    // composited image a second time and desynced the light pen from the
    // mouse, so hovering over a vector never produced a pen hit.
    // ------------------------------------------------------------------
    {
        const trackContexts = [];
        const t = loadVT11({ vt11: true, trackContexts: trackContexts });
        const dev = t.registrations[0].device;
        dev.access(DPC, 0o1000, false); // triggers renderer.initDOM()
        assert.strictEqual(trackContexts.length, 2,
            "renderer creates exactly two canvas contexts (BG + FG)");
        const ctxBG = trackContexts[0];
        const ctxFG = trackContexts[1];
        assert.ok(ctxBG.translateCalls >= 1 && ctxBG.scaleCalls >= 1,
            "drawing context (BG) receives the view transform");
        assert.strictEqual(ctxFG.translateCalls, 0,
            "compositing context (FG) must stay untransformed");
        assert.strictEqual(ctxFG.scaleCalls, 0,
            "compositing context (FG) must stay unscaled");
    }

    console.log("vt11 tests: all passed");
}

try {
    run();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
