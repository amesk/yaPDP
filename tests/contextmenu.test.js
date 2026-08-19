#!/usr/bin/env node
/**
 * Global context-menu suppression modular tests.
 *
 * Loads the real production module (src/contextmenu.js) in an isolated VM
 * context and exercises its DOM-free helper with a stub window:
 *   - block()       — installs a `contextmenu` handler that cancels the menu
 *   - bare sandbox  — module loads cleanly without window/document
 *
 * Run with:  node tests/contextmenu.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "contextmenu.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var ContextMenu = ...` at top level becomes a property of the sandbox.
    return sandbox.ContextMenu;
}

// A window-like stub that records installed listeners and lets tests fire
// synthetic events that count preventDefault() calls.
function makeWindowStub() {
    const listeners = {};
    let prevented = 0;
    return {
        win: {
            addEventListener(type, handler) {
                listeners[type] = handler;
            }
        },
        // Fire the listener registered for `type` with a fresh cancellable event.
        fire(type) {
            const event = { prevented: false, preventDefault() { this.prevented = true; } };
            if (listeners[type]) listeners[type](event);
            if (event.prevented) prevented++;
            return event;
        },
        preventedCount() {
            return prevented;
        }
    };
}

function run() {
    const CM = loadModule();
    assert.ok(CM, "module should expose ContextMenu");

    // ---- bare sandbox must load without window/document --------------
    assert.strictEqual(CM.block(undefined), false,
        "no handler installed in a bare environment");

    // ---- block() installs a cancelling contextmenu handler -----------
    {
        const stub = makeWindowStub();
        assert.strictEqual(CM.block(stub.win), true,
            "handler installed on a window-like object");

        const event = stub.fire("contextmenu");
        assert.strictEqual(event.prevented, true,
            "contextmenu event must be prevented");
        assert.strictEqual(stub.preventedCount(), 1,
            "preventDefault must be called on the contextmenu event");
    }

    // ---- block() with a window lacking addEventListener --------------
    {
        assert.strictEqual(CM.block({}), false,
            "no handler installed without addEventListener");
    }

    console.log("contextmenu.test.js: all tests passed");
}

run();
