#!/usr/bin/env node
/**
 * ActionOverflow modular tests.
 *
 * Loads the real production module (src/action-overflow.js) in an isolated VM
 * context and checks the decisions rather than the DOM work:
 *   • which command strips it watches (the Model 33, the LP11 console, the
 *     printer and the front panel — every operator command row the touch layout
 *     docks as a strip, so an overflow is handled on EVERY page, not only the
 *     teletype's);
 *   • the markup hooks (the .action-secondary class, the More button and menu
 *     classes) the module and the stylesheet agree on;
 *   • the pure overflow rule (scrollWidth vs clientWidth, with a rounding
 *     tolerance) that decides whether a strip has to fold.
 *
 * The DOM behaviour (moving the commands, opening/closing the menu, the
 * measurement) is exercised end to end on a touch emulation.
 *
 * Run with:  node tests/action-overflow.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "action-overflow.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.ActionOverflow;
}

function run() {
    const A = loadModule();
    assert.ok(A, "module should expose ActionOverflow");
    for (const fn of ["install", "destroy", "sync", "overflows", "closeAll"]) {
        assert.strictEqual(typeof A[fn], "function", fn + " must be exported");
    }
    assert.strictEqual(typeof A.isInstalled, "function", "isInstalled must be exported");
    assert.strictEqual(typeof A.isCollapsed, "function", "isCollapsed must be exported");

    // ---- the watched command strips --------------------------------------
    {
        assert.ok(Array.isArray(A.STRIPS), "STRIPS must be a list");
        const selectors = A.STRIPS.map((s) => s.selector);
        for (const sel of ["#teletype-controls", ".lp11-console",
                           ".printer-actions", ".panel-actions"]) {
            assert.ok(selectors.indexOf(sel) !== -1,
                "the command strip " + sel + " must be watched");
        }
        assert.strictEqual(new Set(selectors).size, selectors.length,
            "no strip is watched twice");
        A.STRIPS.forEach((s) => {
            assert.strictEqual(typeof s.buttonClass, "string",
                s.selector + " must name the class its buttons wear");
        });
    }

    // ---- the markup hooks the module and the CSS share -------------------
    {
        assert.strictEqual(A.SECONDARY_CLASS, "action-secondary",
            "the rare commands are marked action-secondary");
        assert.strictEqual(A.MORE_CLASS, "action-more",
            "the More button class is named once");
        assert.strictEqual(A.MORE_HIDDEN_CLASS, "action-more-hidden",
            "the hidden-More class is named once");
        assert.strictEqual(A.MENU_CLASS, "action-more-menu",
            "the menu class is named once");
        assert.strictEqual(A.MENU_OPEN_CLASS, "action-more-open",
            "the open-menu class is named once");
    }

    // ---- the overflow rule ----------------------------------------------
    {
        assert.strictEqual(A.overflows(200, 100), true, "twice the width overflows");
        assert.strictEqual(A.overflows(100, 100), false, "an exact fit does not");
        assert.strictEqual(A.overflows(101, 100), false,
            "a rounding pixel is tolerated");
        assert.strictEqual(A.overflows(102, 100), true,
            "a real command is not tolerated");
        assert.strictEqual(A.overflows(101, 100, 0), true,
            "the tolerance is a parameter");
        assert.strictEqual(A.overflows(0, 0), false, "a hidden strip never overflows");
        assert.strictEqual(A.overflows(200, 0), false, "a hidden strip never overflows");
        assert.strictEqual(A.overflows(NaN, 100), false, "a non-number does not overflow");
        assert.strictEqual(A.overflows("300", "100"), true, "numeric strings are coerced");
        assert.ok(A.OVERFLOW_TOLERANCE >= 0, "the default tolerance is published");
    }

    // ---- install is a no-op without a DOM or a coarse pointer ------------
    {
        assert.strictEqual(A.install({}), null, "install without a DOM does nothing");
        assert.strictEqual(A.install({ document: null }), null, "…and without a document");
        // No MobileInput in the sandbox: a desktop (no coarse pointer) is left
        // completely alone — it must not build anything.
        assert.strictEqual(
            A.install({ document: { body: {}, createElement: () => ({}) } }),
            null, "a desktop is left alone");
        A.destroy();      // must not throw without a prior install
        A.closeAll();
        assert.strictEqual(A.isInstalled(), false, "nothing was installed");
    }

    console.log("action-overflow.test.js: all tests passed");
}

run();
