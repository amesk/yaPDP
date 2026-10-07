#!/usr/bin/env node
/**
 * CPU runaway-halt hook tests.
 *
 * When the emulator force-halts the CPU on trap recursion (the runaway-trap
 * guard in src/pdp11.js), the core must signal the event through an injectable
 * slot — window.__yapdpCpuHaltHook(reason) — and must NOT know who listens to
 * it. The UI layer (src/pdp11-app.js) wires that slot to the toast subsystem.
 *
 * This test extracts the REAL trap() source from src/pdp11.js (a plain browser
 * script, not a module) and runs it in a VM with a CPU primed so the guard
 * fires, mirroring tests/reboot-cpu-state.test.js. It checks:
 *   - the hook fires exactly once with reason "runaway-trap";
 *   - the CPU is left halted (STATE_HALT) with trapDepth reset;
 *   - a console-mode trap (trapPSW === -2) does NOT fire the hook.
 *
 * Run with:  node tests/cpu-halt-hook.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const PDP = path.join(ROOT, "src", "pdp11.js");

const src = fs.readFileSync(PDP, "utf8");

// Extract one top-level function by balancing braces — trap() has nested
// blocks, so a non-greedy regex would stop at the first inner "}".
function extractFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start !== -1, signature + " found in src/pdp11.js");
    let depth = 0;
    const open = source.indexOf("{", start);
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces while extracting " + signature);
}

const trapSrc = extractFunction(src, "function trap(vector, errorMask) {");

function runTrap(cpuState) {
    const cpu = Object.assign({
        runState: 0,
        trapDepth: 0,
        trapPSW: -1,
        mmuMode: 0
    }, cpuState);

    const hookCalls = [];
    const sandbox = {
        console,
        CPU: cpu,
        STATE_HALT: 3,
        __yapdpCpuHaltHook: function (reason) { hookCalls.push(reason); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(trapSrc + "\ntrap(4, 0);", sandbox, { filename: PDP });
    return { cpu, hookCalls };
}

// --- positive: runaway-trap guard fires the slot -----------------------------
{
    const r = runTrap({ trapPSW: 0, mmuMode: 0, trapDepth: 8, runState: 0 });
    assert.deepStrictEqual(r.hookCalls, ["runaway-trap"],
        "the injectable slot fires exactly once with reason 'runaway-trap'");
    assert.strictEqual(r.cpu.runState, 3, "the CPU is left halted (STATE_HALT)");
    assert.strictEqual(r.cpu.trapDepth, 0, "the recursion guard is reset");
}

// --- negative: console-mode trap (trapPSW === -2) never fires the slot -------
{
    const r = runTrap({ trapPSW: -2, mmuMode: 0, trapDepth: 0, runState: 0 });
    assert.strictEqual(r.hookCalls.length, 0, "a console-mode trap does not fire the slot");
    assert.strictEqual(r.cpu.runState, 0, "the CPU keeps running (no halt)");
}

console.log("cpu-halt-hook: all tests passed");
