/**
 * yaPDP — CPU halt notice classifier
 *
 * Turns the event the emulator core publishes (CPU.haltReason, see
 * notifyCpuHalt() in src/pdp11.js) into the one operator-facing notice the UI
 * shows: whether the machine stopped for a real reason, how loud to be about
 * it, and what the operator can do next.
 *
 * Why a separate module: the core must stay UI-agnostic (it only says "the
 * machine stopped, here is the PC/PSW"), while the wording, the severity and
 * the recovery hint are decisions of the presentation layer. Keeping them in a
 * DOM-free module makes the policy unit-testable in Node — the same split as
 * src/toasts.js and src/imgerror.js.
 *
 * Classification:
 *   runaway-trap                    -> error   (unrecoverable trap recursion)
 *   halt-instruction, pc <= 4       -> error   (trapped into an empty vector)
 *   halt-instruction, pc >  4       -> warning (the guest stopped itself)
 *   step === true                   -> nothing (the operator pressed STEP)
 *
 * Anything the machine legitimately does while merely idle — a guest sitting
 * in WAIT at its prompt, e.g. the XXDP monitor — never reaches this module: the
 * core publishes only self-halts, not WAIT transitions.
 *
 * Public surface: window.HaltNotice (browser) and module.exports
 * { HaltNotice } (Node tests). Must be loaded BEFORE src/toasts.js and
 * src/pdp11-app.js, which consume it.
 */
"use strict";

var HaltNotice = (function () {

    // One dedup key for every stop: repeated halts extend the visible notice
    // instead of stacking copies of the same message (see toasts.js dedup).
    var KEY = "cpu-halt";

    // Empty-vector stops are near zero: vector 2/4 are read from an empty
    // kernel area, so the PC left behind is 0, 2 or 4.
    var DEAD_END_PC = 4;

    // PDP-11 addresses are octal in DEC documentation and in the core's own
    // "HALT at ..." log line, so the notice speaks the same dialect.
    function octal(n, width) {
        var s = (n >>> 0).toString(8);
        while (s.length < (width || 6)) s = "0" + s;
        return s;
    }

    /**
     * Classify one halt event.
     * @param {?{reason:string, pc:number, psw:number, step:boolean}} info
     *        CPU.haltReason as published by the core (null when none).
     * @returns {?{text:string, category:string, key:string}} null = stay quiet
     */
    function haltNotice(info) {
        if (!info || typeof info !== "object") return null;

        // The panel STEP switch halts by design after one instruction.
        if (info.step) return null;

        var pc = (typeof info.pc === "number") ? info.pc : 0;
        var at = " at " + octal(pc);

        if (info.reason === "runaway-trap") {
            return {
                text: "Machine stopped: unrecoverable trap" + at +
                    ". Press RESET or boot again.",
                category: "error",
                key: KEY
            };
        }

        if (info.reason === "halt-instruction" && pc <= DEAD_END_PC) {
            return {
                text: "Machine halted" + at +
                    " — the CPU trapped into an empty vector. " +
                    "Press RESET or boot again.",
                category: "error",
                key: KEY
            };
        }

        if (info.reason === "halt-instruction") {
            return {
                text: "Machine halted" + at +
                    ". Press CONT to continue, or RESET to reboot.",
                category: "warning",
                key: KEY
            };
        }

        // Unknown reason: report the stop rather than swallow it, but do not
        // claim to know what it was.
        return {
            text: "Machine stopped" + at + ". Press RESET or boot again.",
            category: "warning",
            key: KEY
        };
    }

    return {
        KEY: KEY,
        DEAD_END_PC: DEAD_END_PC,
        octal: octal,
        haltNotice: haltNotice
    };
})();

if (typeof window !== "undefined") window.HaltNotice = HaltNotice;
if (typeof module !== "undefined" && module.exports) {
    module.exports = { HaltNotice: HaltNotice };
}
