#!/usr/bin/env node
/**
 * HaltNotice classifier unit tests.
 *
 * The core publishes a structured stop event (CPU.haltReason, see
 * notifyCpuHalt() in src/pdp11.js) and must not decide how loud the UI is about
 * it. src/halt-notice.js owns that policy; this test pins the whole table:
 *
 *   runaway-trap                -> error   (unrecoverable trap recursion)
 *   halt-instruction, pc <= 4   -> error   (trapped into an empty vector)
 *   halt-instruction, pc <= 4 with no Boot ROM (bootDevice 'none')
 *                               -> warning (nothing was there to run)
 *   halt-instruction, pc >  4   -> warning (the guest stopped itself)
 *   step === true               -> nothing (the operator pressed STEP)
 *
 * The pc > 4 case is the XXDP one: a "hard" diagnostic (docs/
 * xxdp-diagnostics.md) stays silent on a fault and HALTs with an address
 * (EKBCD1 halts at pc = 10 octal). The operator must be told, and told what to
 * press next — but the emulator is not broken, so the category is a warning,
 * not an error.
 *
 * Run with:  node tests/halt-notice.test.js
 * Exit code 0 = passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { HaltNotice } = require("../src/halt-notice.js");

const notice = HaltNotice.haltNotice;

// --- API surface ------------------------------------------------------------
assert.strictEqual(typeof notice, "function", "haltNotice() is exported");
assert.strictEqual(typeof HaltNotice.octal, "function", "octal() is exported");
assert.ok(HaltNotice.KEY, "the dedup key is exported");

// --- nothing to say ---------------------------------------------------------
assert.strictEqual(notice(null), null, "no stop recorded -> no notice");
assert.strictEqual(notice(undefined), null, "undefined -> no notice");
assert.strictEqual(notice("runaway-trap"), null,
    "a bare string is not an event and must not be guessed at");

// --- the panel STEP switch halts by design ----------------------------------
assert.strictEqual(
    notice({ reason: "halt-instruction", pc: 0o10, psw: 0, step: true }), null,
    "a halt caused by the STEP switch is expected and stays silent");

// --- runaway trap: fatal, unrecoverable -------------------------------------
{
    const n = notice({ reason: "runaway-trap", pc: 0o1234, psw: 0, step: false });
    assert.strictEqual(n.category, "error", "runaway trap is an error");
    assert.ok(/unrecoverable trap/.test(n.text), "it names the cause: " + n.text);
    assert.ok(/001234/.test(n.text), "it carries the octal PC: " + n.text);
    assert.ok(/RESET/.test(n.text), "it says how to recover: " + n.text);
    assert.strictEqual(n.key, HaltNotice.KEY, "one dedup key for every stop");
}

// --- empty-vector dead ends: fatal (boot ROM jumped to 0, vector never set) --
[0, 2, 4].forEach(function (pc) {
    const n = notice({ reason: "halt-instruction", pc: pc, psw: 0, step: false });
    assert.strictEqual(n.category, "error", "pc " + pc.toString(8) + " is a dead end");
    assert.ok(/empty vector/.test(n.text), "it explains the dead end: " + n.text);
});

// --- the same dead end with an EMPTY Boot ROM socket is not a fault ----------
// CONFIG bootDevice 'none' means the board is missing by the operator's choice:
// a machine that stops at 000002 there has nothing to run, it is not broken.
{
    const withBootRom = { get: () => ({ bootDevice: "interactive@" }) };
    global.Config = withBootRom;
    try {
        const n = notice({ reason: "halt-instruction", pc: 2, psw: 0, step: false });
        assert.strictEqual(n.category, "error",
            "a configured Boot ROM that dead-ends is still an error");
        assert.ok(/empty vector/.test(n.text), "it keeps the dead-end wording");
        assert.strictEqual(HaltNotice.noBootDevice(), false,
            "a configured ROM is not 'no boot device'");
    } finally { delete global.Config; }

    global.Config = { get: () => ({ bootDevice: "none" }) };
    try {
        const n = notice({ reason: "halt-instruction", pc: 2, psw: 0, step: false });
        assert.strictEqual(n.category, "warning",
            "an empty socket is a warning, not an emulator fault");
        assert.ok(/no boot device/i.test(n.text),
            "it names the missing board: " + n.text);
        assert.ok(!/empty vector/.test(n.text),
            "the developer phrase is gone: " + n.text);
        assert.ok(/Bootstrap now!/.test(n.text),
            "it offers the real way out: " + n.text);
        assert.strictEqual(n.key, HaltNotice.KEY, "one dedup key for every stop");
        assert.strictEqual(HaltNotice.noBootDevice(), true,
            "bootDevice 'none' is reported as an empty socket");
    } finally { delete global.Config; }

    // No Config at all (Node, unit-test page): assume a ROM is configured and
    // keep the louder wording rather than hiding a real crash.
    assert.strictEqual(HaltNotice.noBootDevice(), false,
        "an absent Config must not be read as 'no boot device'");
    assert.strictEqual(
        notice({ reason: "halt-instruction", pc: 2, psw: 0, step: false }).category,
        "error", "absent Config keeps the empty-vector error");
}

// --- an ordinary guest halt: loud enough to notice, not an emulator fault ----
[0o10, 0o1000, 0o177777].forEach(function (pc) {
    const n = notice({ reason: "halt-instruction", pc: pc, psw: 0o340, step: false });
    assert.strictEqual(n.category, "warning",
        "pc " + pc.toString(8) + " is a guest halt, not a crash");
    assert.ok(/CONT/.test(n.text), "it offers CONT as the way out: " + n.text);
    assert.ok(n.text.indexOf(HaltNotice.octal(pc)) !== -1,
        "it carries the octal PC " + HaltNotice.octal(pc) + ": " + n.text);
});

// --- XXDP shape: EKBCD1 stops at pc = 10 (octal) ----------------------------
{
    const n = notice({ reason: "halt-instruction", pc: 0o10, psw: 0, step: false });
    assert.ok(/000010/.test(n.text),
        "the XXDP halt address is padded like the core's own log line: " + n.text);
}

// --- unknown reason: never swallow a stop, never pretend to understand it ---
{
    const n = notice({ reason: "something-new", pc: 0o20, psw: 0, step: false });
    assert.strictEqual(n.category, "warning", "an unknown stop is still reported");
    assert.ok(/Machine stopped/.test(n.text), "with neutral wording: " + n.text);
}

// --- octal formatting -------------------------------------------------------
assert.strictEqual(HaltNotice.octal(0), "000000", "zero pads to six digits");
assert.strictEqual(HaltNotice.octal(0o10), "000010", "octal, not decimal");
assert.strictEqual(HaltNotice.octal(0o177777), "177777", "a full 16-bit address");

console.log("halt-notice: all tests passed");
