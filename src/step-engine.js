/**
 * yaPDP — Shared step-execution engine for QuickBoot and Snapshots
 *
 * Extracted from src/quickboot.js so both QuickBoot and Snapshots can run
 * scenario steps (send, ctrlD, wait, waitFor) without code duplication.
 *
 * Pure engine — no UI, no DOM. All browser dependencies are accessed through
 * typeof-guarded globals so the module is unit-testable in Node.
 *
 * Must be loaded AFTER osboot.js (OSBoot.stringToBytes) and BEFORE quickboot.js
 * and snapshots.js.
 */
"use strict";

var StepEngine = (function () {
    // Console output sniffer: iopage.js feeds every console character through
    // window.__consoleOutputHook; we keep the tail so prompt-waiting steps can
    // detect "login:" etc. instead of guessing timings.
    var MAX_BUFFER = 4096;
    var outputBuffer = "";

    // Wait budget for a prompt; after this the step is sent anyway so the
    // sequence never stalls on a guest that does not print the expected text.
    var WAIT_TIMEOUT_MS = 45000;
    var WAIT_POLL_MS = 200;

    // ------------------------------------------------------------------
    // Output buffer
    // ------------------------------------------------------------------

    function pushOutput(ch) {
        outputBuffer += String.fromCharCode(ch & 0x7F);
        if (outputBuffer.length > MAX_BUFFER) {
            outputBuffer = outputBuffer.slice(outputBuffer.length - MAX_BUFFER);
        }
    }

    function clearOutput() {
        outputBuffer = "";
    }

    function outputContains(needle) {
        return !!needle && outputBuffer.indexOf(needle) !== -1;
    }

    // ------------------------------------------------------------------
    // Pure helpers
    // ------------------------------------------------------------------

    // Console bytes for one scenario step: plain text + Enter, or ^D (4).
    function stepBytes(step) {
        if (step && step.ctrlD) return [4];
        var text = (step && step.send) ? step.send : "";
        return OSBoot.stringToBytes(text).concat([13]);
    }

    // Put the operator's console controls into the state a boot needs.
    // Returns the actions taken, so the contract is testable without a DOM.
    function consoleWorkingState(state, api) {
        var done = [];
        if (!state || !api) return done;
        if (state.ttyMode !== "line" && typeof api.setTtyMode === "function") {
            api.setTtyMode("line");
            done.push("line");
        }
        if ((state.readerMode === "start" || state.readerMode === "auto") &&
            typeof api.setReaderMode === "function") {
            api.setReaderMode("stop");
            done.push("reader-stop");
        }
        return done;
    }

    // Wipe the operator console buffers so every boot starts "on a fresh page":
    // the teletype paper and LP11 paper are cleared, and every VT52 screen
    // (console + user terminals) is cleared.
    function clearConsole() {
        var g60 = (typeof window !== "undefined") ? window.g60printer : null;
        if (g60 && typeof g60.clear === "function") g60.clear();
        // Rewind the ASR paper tape so the boot banner punches onto a fresh
        // tape, matching the "on a fresh page" teletype paper reset.
        if (typeof window !== "undefined" && window.paperTape &&
            typeof window.paperTape.clear === "function") {
            window.paperTape.clear();
        }
        if (typeof window !== "undefined" && window.lp11G60Printer &&
            typeof window.lp11G60Printer.clear === "function") {
            window.lp11G60Printer.clear();
        }
        if (typeof window !== "undefined" && typeof window.vt52Get === "function") {
            for (var u = 0; u <= 2; u++) {
                var t = window.vt52Get(u);
                if (t && typeof t.clearScreen === "function") t.clearScreen();
            }
        }
    }

    // ------------------------------------------------------------------
    // Sending bytes to the machine
    // ------------------------------------------------------------------

    function sendBytes(bytes) {
        // In-page feature: use the internal bridge; the legacy window
        // surface is ?bridge=1-gated for external tooling.
        var bridge = (typeof window !== "undefined") ? window.__yapdpBridge : null;
        if (bridge && bridge.dlReceiveQueue) {
            bridge.dlReceiveQueue(0, bytes);
        } else if (typeof window !== "undefined" &&
                   typeof window.dlReceiveQueue === "function") {
            window.dlReceiveQueue(0, bytes);
        }
    }

    // ------------------------------------------------------------------
    // Step execution
    // ------------------------------------------------------------------

    // First step (boot) needs extra time for the @ prompt to appear.
    function delayFor(index, base) {
        return (index === 0) ? base * 2 : base;
    }

    // Wait for a prompt to appear in the console output, then send the step.
    // Calls onDone() when the step is sent, or onCancel() when cancelled.
    function waitForPrompt(step, ctx, onDone, onCancel) {
        var startedAt = Date.now();
        var waitTimeoutMs = ctx.waitTimeoutMs || WAIT_TIMEOUT_MS;
        var waitPollMs = ctx.waitPollMs || WAIT_POLL_MS;

        function poll() {
            if (typeof ctx.isCancelled === "function" && ctx.isCancelled()) {
                if (typeof onCancel === "function") onCancel();
                return;
            }
            if (outputContains(step.waitFor) ||
                Date.now() - startedAt > waitTimeoutMs) {
                // Prompt seen (or timed out): optionally settle, then send the
                // input and move on.
                var settle = step.wait || 0;
                setTimeout(function () {
                    if (typeof ctx.isCancelled === "function" && ctx.isCancelled()) {
                        if (typeof onCancel === "function") onCancel();
                        return;
                    }
                    sendBytes(stepBytes(step));
                    setTimeout(function () {
                        if (typeof onDone === "function") onDone();
                    }, ctx.stepDelayMs || 800);
                }, settle);
                return;
            }
            setTimeout(poll, waitPollMs);
        }
        poll();
    }

    // Run a sequence of steps asynchronously. Returns a Promise that resolves
    // when all steps are done (or the sequence is cancelled).
    //
    // ctx:
    //   sendBytes       — function(bytes), required
    //   outputContains  — function(needle) -> bool, required for waitFor
    //   isCancelled     — function() -> bool, optional
    //   onDone          — function(), optional, called after all steps
    //   stepDelayMs     — number, optional, default 800
    //   waitTimeoutMs   — number, optional, default 45000
    //   waitPollMs      — number, optional, default 200
    function runSteps(steps, ctx) {
        return new Promise(function (resolve) {
            var stepIndex = 0;

            function next() {
                if (typeof ctx.isCancelled === "function" && ctx.isCancelled()) {
                    resolve();
                    return;
                }
                if (stepIndex >= steps.length) {
                    if (typeof ctx.onDone === "function") ctx.onDone();
                    resolve();
                    return;
                }
                var step = steps[stepIndex];
                var idx = stepIndex;
                stepIndex++;

                if (step.wait) {
                    // Pure delay step (no input): e.g. let a guest settle before
                    // the next prompt (BSD 2.9's getty flushes input received
                    // before it finished opening the console).
                    setTimeout(function () {
                        if (typeof ctx.isCancelled === "function" && ctx.isCancelled()) {
                            resolve();
                            return;
                        }
                        next();
                    }, step.wait);
                } else if (step.waitFor) {
                    waitForPrompt(step, ctx, function () {
                        next();
                    }, function () {
                        resolve();
                    });
                } else {
                    setTimeout(function () {
                        if (typeof ctx.isCancelled === "function" && ctx.isCancelled()) {
                            resolve();
                            return;
                        }
                        sendBytes(stepBytes(step));
                        next();
                    }, delayFor(idx, ctx.stepDelayMs || 800));
                }
            }
            next();
        });
    }

    // ------------------------------------------------------------------
    // Install the console output hook
    // ------------------------------------------------------------------
    // Capture console output for prompt-waiting steps (called by iopage.js).
    // In-page feature: install through the internal bridge; falls back to
    // the legacy window.__consoleOutputHook surface when no bridge exists.
    var bridge = (typeof window !== "undefined") ? window.__yapdpBridge : null;
    if (bridge && bridge.setOutputHook) {
        bridge.setOutputHook(pushOutput);
    } else if (typeof window !== "undefined") {
        window.__consoleOutputHook = pushOutput;
    }

    return {
        stepBytes: stepBytes,
        consoleWorkingState: consoleWorkingState,
        clearConsole: clearConsole,
        clearOutput: clearOutput,
        outputContains: outputContains,
        sendBytes: sendBytes,
        runSteps: runSteps,
        WAIT_TIMEOUT_MS: WAIT_TIMEOUT_MS,
        WAIT_POLL_MS: WAIT_POLL_MS,
    };
})();