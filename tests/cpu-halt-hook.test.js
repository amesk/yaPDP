#!/usr/bin/env node
/**
 * CPU runaway-halt hook tests.
 *
 * When the emulator force-halts the CPU on trap recursion (the runaway-trap
 * guard in src/pdp11.js), the core must signal the event through an injectable
 * slot — window.__yapdpCpuHaltHook(info) — and must NOT know who listens to
 * it. The UI layer (src/pdp11-app.js) wires that slot to the operator notice.
 *
 * This test extracts the REAL notifyCpuHalt() and trap() sources from
 * src/pdp11.js (a plain browser script, not a module) and runs them in a VM with
 * a CPU primed so the guard fires, mirroring tests/reboot-cpu-state.test.js.
 * It checks:
 *   - the hook fires exactly once with a structured event: reason
 *     "runaway-trap", the octal-relevant PC and PSW, and the STEP marker;
 *   - the CPU keeps the same record in CPU.haltReason;
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

const notifySrc = extractFunction(src, "function notifyCpuHalt(reason) {");
const trapSrc = extractFunction(src, "function trap(vector, errorMask) {");

function runTrap(cpuState) {
    const cpu = Object.assign({
        runState: 0,
        trapDepth: 0,
        trapPSW: -1,
        mmuMode: 0,
        registerVal: new Uint16Array(8), // notifyCpuHalt() reads R7 (the PC)
        stepActive: 0
    }, cpuState);

    const hookCalls = [];
    const sandbox = {
        console,
        CPU: cpu,
        STATE_HALT: 3,
        // notifyCpuHalt() reports the PSW; the real one lives in pdp11.js and
        // is not part of this extraction, so pin a known value.
        readPSW: function () { return 0o340; },
        __yapdpCpuHaltHook: function (info) { hookCalls.push(info); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notifySrc + "\n" + trapSrc + "\ntrap(4, 0);", sandbox,
        { filename: PDP });
    return { cpu, hookCalls };
}

// --- positive: runaway-trap guard fires the slot -----------------------------
{
    const r = runTrap({ trapPSW: 0, mmuMode: 0, trapDepth: 8, runState: 0 });
    assert.strictEqual(r.hookCalls.length, 1, "the injectable slot fires exactly once");
    const info = r.hookCalls[0];
    assert.strictEqual(info.reason, "runaway-trap", "the event names the cause");
    assert.strictEqual(info.pc, 0, "the event carries the PC (octal-relevant)");
    assert.strictEqual(info.psw, 0o340, "the event carries the PSW");
    assert.strictEqual(info.step, false, "a trap halt is never a STEP halt");
    assert.strictEqual(r.cpu.haltReason, info,
        "the CPU keeps the very record it published (one source of truth)");
    assert.strictEqual(r.cpu.runState, 3, "the CPU is left halted (STATE_HALT)");
    assert.strictEqual(r.cpu.trapDepth, 0, "the recursion guard is reset");
}

// --- the event reports a panel STEP: the UI then stays silent ----------------
{
    const r = runTrap({ trapPSW: 0, mmuMode: 0, trapDepth: 8, runState: 4,
        stepActive: 1 });
    assert.strictEqual(r.hookCalls.length, 1, "the stop is still published");
    assert.strictEqual(r.hookCalls[0].step, true,
        "the STEP marker lets HaltNotice keep quiet (see tests/halt-notice.test.js)");
}

// --- negative: console-mode trap (trapPSW === -2) never fires the slot -------
{
    const r = runTrap({ trapPSW: -2, mmuMode: 0, trapDepth: 0, runState: 0 });
    assert.strictEqual(r.hookCalls.length, 0, "a console-mode trap does not fire the slot");
    assert.strictEqual(r.cpu.runState, 0, "the CPU keeps running (no halt)");
    assert.strictEqual(r.cpu.haltReason, undefined,
        "no stop is recorded when nothing stopped");
}

console.log("cpu-halt-hook: all tests passed");
