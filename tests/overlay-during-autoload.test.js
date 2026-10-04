#!/usr/bin/env node
/**
 * Overlay-during-autoload tests: the trap that had no exit.
 *
 * The autoload owns the machine while it types, and its input gate swallows
 * every click outside the toast (`src/quickboot.js` gateEvent). A dialog the
 * SYSTEM raises on its own — the first-run hint, a refused snapshot — used to
 * appear regardless, so it was visible but undismissable: its button was eaten
 * by the gate, and the toast's "Take control!" sat underneath it. The only way
 * out was waiting for the 45 s prompt timeout, or reloading.
 *
 * What is pinned here:
 *
 *   1. `QuickBoot.arrivedByDeepLink()` recognises a ?boot= launch, including
 *      one whose parameter was consumed and is now carried by the pending key;
 *   2. the first-run hint stands down on such a launch, and marks itself seen
 *      (the gallery tile IS the onboarding);
 *   3. `QuickBoot.yieldToOperator()` stops the autoload when one is running,
 *      and is a no-op otherwise;
 *   4. both system-raised dialogs call it BEFORE they appear — the first-run
 *      hint and the refused-snapshot dialog — so the operator can dismiss them.
 *
 * The sources are driven in a VM sandbox (same seam style as
 * tests/quickboot-input-gate.test.js): the modules are the real ones, the DOM
 * is a recording stand-in.
 *
 * Run with:  node tests/overlay-during-autoload.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const QUICKBOOT = path.join(ROOT, "src", "quickboot.js");
const ONBOARDING = path.join(ROOT, "src", "onboarding.js");
const SNAPSHOTS = path.join(ROOT, "src", "snapshots.js");

const qbSrc = fs.readFileSync(QUICKBOOT, "utf8");
const onSrc = fs.readFileSync(ONBOARDING, "utf8");
const snSrc = fs.readFileSync(SNAPSHOTS, "utf8");

function extractBlock(src, startMarker, tail) {
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, "marker not found: " + startMarker);
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
                    assert.strictEqual(rest, tail, "bad tail after " + startMarker);
                    return src.slice(start, i + 1 + tail.length);
                }
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

// --- A QuickBoot sandbox with the pieces the seam needs ----------------
function fakeEl() {
    return {
        style: {}, value: "", textContent: "", innerHTML: "",
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, getAttribute: () => null,
    };
}

function loadQuickBoot(search, pendingKeyValue) {
    const store = pendingKeyValue == null
        ? { getItem: () => null, setItem() {}, removeItem() {} }
        : { getItem: (k) => (k === "yapdp.quickboot.pending" ? pendingKeyValue : null),
            setItem() {}, removeItem() {} };

    const doc = {
        addEventListener() {}, removeEventListener() {},
        getElementById: () => null, createElement: fakeEl,
        body: fakeEl(), readyState: "complete",
    };
    const sandbox = {
        console, setTimeout, clearTimeout, Date, Promise, JSON, Math, Object,
        Uint8Array, Array, Error, String, Number,
        window: { localStorage: store },
        document: doc,
        location: { search, pathname: "/pdp11.html", hash: "", reload() {} },
    };
    sandbox.window.document = doc;
    sandbox.window.location = sandbox.location;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "osboot.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "step-engine.js"), "utf8"), sandbox);
    vm.runInContext(qbSrc, sandbox);
    return sandbox;
}

function testArrivedByDeepLink() {
    // A plain launch.
    assert.strictEqual(loadQuickBoot("").QuickBoot.arrivedByDeepLink(), false,
        "a launch with no parameter is not a deep link");

    // The parameter is present.
    assert.strictEqual(loadQuickBoot("?boot=rk1").QuickBoot.arrivedByDeepLink(), true,
        "?boot= is a deep link");

    // The parameter was consumed (replaceState) but a boot is pending: the
    // reload that a profile change triggers must still read as a deep link.
    assert.strictEqual(
        loadQuickBoot("", "rk1").QuickBoot.arrivedByDeepLink(), true,
        "a pending key means this launch IS the deferred deep-link boot");

    // Some other parameter is not a deep link.
    assert.strictEqual(loadQuickBoot("?core=1").QuickBoot.arrivedByDeepLink(), false,
        "an unrelated parameter is not a deep link");
    console.log("PASS: arrivedByDeepLink() sees the parameter and the pending key");
}

function testYieldToOperator() {
    const sb = loadQuickBoot("?boot=rk1");
    const Q = sb.QuickBoot;

    // A ?boot= launch starts the autoload by itself, so by the time the hint
    // would run, the machine is already owned: that is exactly the state the
    // trap grew from. The yield must stop it and hand control back.
    assert.strictEqual(Q.isAutoloading(), true,
        "a deep-link launch leaves the autoload running (the precondition)");
    assert.strictEqual(Q.yieldToOperator(), true,
        "yielding during a running autoload stops it");
    assert.strictEqual(Q.isAutoloading(), false,
        "…and the machine is the operator's again");

    // Idempotent: a second yield has nothing left to stop.
    assert.strictEqual(Q.yieldToOperator(), false,
        "a second yield is a no-op");
    console.log("PASS: yieldToOperator() stops a running autoload and is idempotent");
}

// --- The two system-raised dialogs must yield BEFORE they appear ------
function testDialogsYieldFirst() {
    // The first-run hint: show() calls yieldToOperator before it paints.
    {
        const show = extractBlock(onSrc, "function show()");
        const yieldIdx = show.indexOf("yieldToOperator");
        const paintIdx = show.indexOf("classList.add");
        assert.ok(yieldIdx !== -1,
            "the first-run hint must yield to the operator before it shows " +
            "(otherwise its dismiss button is dead under the input gate)");
        assert.ok(yieldIdx < paintIdx,
            "the hint must yield BEFORE it paints the overlay");
    }

    // A refused snapshot: same rule, same order.
    {
        const show = extractBlock(snSrc, "function showIncompatibleImageDialog(snap, bad)");
        const yieldIdx = show.indexOf("yieldToOperator");
        const paintIdx = show.indexOf("classList.add");
        assert.ok(yieldIdx !== -1,
            "the refused-snapshot dialog must yield to the operator before it shows");
        assert.ok(yieldIdx < paintIdx,
            "the refused-snapshot dialog must yield BEFORE it paints the overlay");
    }
    console.log("PASS: both system-raised dialogs yield before they paint");
}

function testHintStandsDownOnDeepLink() {
    // init() must skip the hint on a deep-link launch AND mark it seen, so it
    // does not appear later either.
    const init = extractBlock(onSrc, "function init()");
    assert.ok(init.indexOf("arrivedByDeepLink") !== -1,
        "the first-run hint must stand down when the launch arrived by deep link");
    assert.ok(init.indexOf("markSeen") !== -1,
        "…and record itself seen, so it does not appear on a later launch");
    const deepIdx = init.indexOf("arrivedByDeepLink");
    const showIdx = init.indexOf("show()");
    assert.ok(deepIdx < showIdx,
        "the deep-link check must come BEFORE the shouldShow/show path");
    console.log("PASS: the hint stands down on a deep-link launch and marks itself seen");
}

// --- Cross-module contract: both call sites really call QuickBoot ------
function testContractWiring() {
    for (const [name, src] of [["onboarding", onSrc], ["snapshots", snSrc]]) {
        assert.ok(/typeof QuickBoot !== "undefined"/.test(src),
            name + " must guard the QuickBoot call (it may be absent in a harness)");
        assert.ok(/typeof QuickBoot\.yieldToOperator === "function"/.test(src),
            name + " must feature-detect yieldToOperator, not assume it");
    }
    assert.ok(/yieldToOperator: yieldToOperator/.test(qbSrc),
        "QuickBoot must export yieldToOperator — it is the contract the dialogs call");
    assert.ok(/arrivedByDeepLink: arrivedByDeepLink/.test(qbSrc),
        "QuickBoot must export arrivedByDeepLink — the hint's stand-down relies on it");
    console.log("PASS: the exported contract is wired on both sides");
}

testArrivedByDeepLink();
testYieldToOperator();
testDialogsYieldFirst();
testHintStandsDownOnDeepLink();
testContractWiring();
console.log("overlay-during-autoload: all tests passed");
