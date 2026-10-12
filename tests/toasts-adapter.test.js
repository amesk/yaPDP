#!/usr/bin/env node
/**
 * Toast error/warning adapter tests.
 *
 * The UI layer (src/pdp11-app.js) exposes two user-facing hooks that modules
 * call instead of relying on console alone:
 *   - window.__yapdpReportError(text, key)   -> Toasts.show({ category: "error" })
 *   - window.__yapdpReportWarning(text, key) -> Toasts.show({ category: "warning" })
 *
 * The adapter is extracted straight from the REAL source (src/pdp11-app.js)
 * with a brace-balancing extractor and run in an isolated VM context against a
 * fake window + Toasts, so the test exercises the production code rather than a
 * copy. The optional key is forwarded verbatim so the toasts.js dedup can
 * extend one toast instead of spamming.
 *
 * Run with:  node tests/toasts-adapter.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const APP_PATH = path.join(ROOT, "src", "pdp11-app.js");

function read(p) {
    return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

// ------------------------------------------------------------------
// Extract the initErrorReporter IIFE: "(function initErrorReporter() { ... })();"
// The brace-balancing extractor tracks both braces and the trailing ");".
// ------------------------------------------------------------------
function extractIife(src, name) {
    const marker = "(function " + name + "() {";
    const start = src.indexOf(marker);
    if (start === -1) {
        throw new Error("marker not found: " + marker);
    }
    const braceOpen = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                // Expect the closing ")();" right after the final brace.
                const tail = src.slice(i + 1, i + 5);
                if (tail !== ")();") {
                    throw new Error("unexpected IIFE tail for: " + name + " got " + JSON.stringify(tail));
                }
                return src.slice(start, i + 5);
            }
        }
    }
    throw new Error("unbalanced braces for: " + name);
}

// Load the adapter into a sandbox with a fake window + Toasts.
function loadAdapter() {
    const src = read(APP_PATH);
    const calls = [];
    const sandbox = {
        window: {},
        Toasts: {
            show: function (opts) { calls.push(opts); }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(extractIife(src, "initErrorReporter"), sandbox);
    return { sandbox: sandbox, calls: calls };
}

// ------------------------------------------------------------------
function testErrorHook() {
    const { sandbox, calls } = loadAdapter();
    assert.strictEqual(typeof sandbox.window.__yapdpReportError, "function",
        "__yapdpReportError must be installed");
    sandbox.window.__yapdpReportError("boom", "k");
    assert.strictEqual(calls.length, 1, "error hook must call Toasts.show once");
    assert.strictEqual(calls[0].text, "boom", "error hook forwards text");
    assert.strictEqual(calls[0].category, "error", "error hook forwards category=error");
    assert.strictEqual(calls[0].key, "k", "error hook forwards key");
}

function testWarningHook() {
    const { sandbox, calls } = loadAdapter();
    assert.strictEqual(typeof sandbox.window.__yapdpReportWarning, "function",
        "__yapdpReportWarning must be installed");
    sandbox.window.__yapdpReportWarning("careful", "w");
    assert.strictEqual(calls.length, 1, "warning hook must call Toasts.show once");
    assert.strictEqual(calls[0].text, "careful", "warning hook forwards text");
    assert.strictEqual(calls[0].category, "warning", "warning hook forwards category=warning");
    assert.strictEqual(calls[0].key, "w", "warning hook forwards key");
}

function testKeyOptional() {
    const { sandbox, calls } = loadAdapter();
    sandbox.window.__yapdpReportError("no key");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].key, undefined, "key is optional and forwarded as-is");
}

function testMissingToastsIsNoop() {
    const src = read(APP_PATH);
    const sandbox = { window: {} };   // no Toasts at all
    vm.createContext(sandbox);
    vm.runInContext(extractIife(src, "initErrorReporter"), sandbox);
    assert.doesNotThrow(function () {
        sandbox.window.__yapdpReportError("x", "k");
        sandbox.window.__yapdpReportWarning("y", "k");
    }, "hooks are silent no-ops when Toasts is missing");
}

// ------------------------------------------------------------------
function main() {
    testErrorHook();
    testWarningHook();
    testKeyOptional();
    testMissingToastsIsNoop();
    console.log("toasts-adapter: all tests passed");
}

main();
