#!/usr/bin/env node
/**
 * Step-engine autoload orchestration: the prompt wait and its timeout fallback.
 *
 * The step engine types a scenario step and can wait for the guest to print a
 * prompt first (see StepEngine.waitForPrompt in src/step-engine.js). The budget
 * matters: a guest that never prints the expected text must not stall the
 * sequence forever, and the step must still be sent.
 *
 * What is pinned here:
 *
 *   1. the prompt never appears -> after WAIT_TIMEOUT_MS the step is sent ONCE
 *      and the chain moves on. The wait polls (WAIT_POLL_MS), it does not spin,
 *      and it does not give up early;
 *   2. the prompt appears -> the step goes out at once, with no polling at all;
 *   3. an abort (isCancelled returns true mid-wait) -> nothing is sent, and no
 *      timer keeps the sequence alive;
 *   4. a step carrying both wait and waitFor -> the send is delayed by `wait`
 *      once the prompt is seen.
 *
 * No browser and no real clock: waitForPrompt is extracted from the source the
 * way tests/quickboot-console.test.js extracts consoleWorkingState, and driven
 * from a VM sandbox with a fake timer queue, so a 45-second budget is verified
 * in microseconds and without flakiness.
 *
 * Run with:  node tests/quickboot-wait.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "step-engine.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

// The budget the production code uses: read from the source rather than
// restated, so a change there is a test failure here, not a silent drift.
function sourceNumber(name) {
    const m = new RegExp("var " + name + "\\s*=\\s*(\\d+)").exec(SOURCE);
    assert.ok(m, name + " not found in src/step-engine.js");
    return parseInt(m[1], 10);
}

// Brace-balancing extractor for one top-level function (same trick as
// tests/quickboot-console.test.js).
function extractBlock(src, startMarker) {
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, "marker not found: " + startMarker);
    const braceOpen = src.indexOf("{", start);
    assert.ok(braceOpen !== -1, "no opening brace for: " + startMarker);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

// A deterministic clock: setTimeout queues callbacks, run() drains them in due
// order and moves the (fake) wall clock, so Date.now() inside the module and
// the timers it schedules agree with each other.
function makeClock() {
    let now = 0;
    let seq = 0;
    const queue = [];
    return {
        now: function () { return now; },
        setTimeout: function (fn, ms) {
            queue.push({ at: now + (ms || 0), seq: seq++, fn: fn });
        },
        pending: function () { return queue.length; },
        // Runs every timer due at or before untilMs; returns how many ran.
        run: function (untilMs) {
            let ran = 0;
            for (;;) {
                if (!queue.length) return ran;
                queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
                const next = queue[0];
                if (untilMs !== undefined && next.at > untilMs) return ran;
                queue.shift();
                now = next.at;
                ran++;
                next.fn();
                assert.ok(ran < 100000, "runaway timer loop");
            }
        }
    };
}

// Load waitForPrompt into a sandbox with the dependencies it reads from its
// closure, all of them observable.
function loadWaitForPrompt(deps) {
    const clock = deps.clock;
    const sandbox = {
        console,
        Date: { now: function () { return clock.now(); } },
        setTimeout: clock.setTimeout,
        WAIT_TIMEOUT_MS: deps.timeoutMs,
        WAIT_POLL_MS: deps.pollMs,
        outputContains: deps.outputContains,
        sendBytes: deps.sendBytes,
        stepBytes: deps.stepBytes,
    };
    vm.createContext(sandbox);
    const fn = vm.runInContext(
        extractBlock(SOURCE, "function waitForPrompt") + "\nwaitForPrompt",
        sandbox);
    return { waitFor: fn, sandbox: sandbox };
}

function harness(options) {
    const clock = makeClock();
    const sent = [];
    const advanced = [];
    const timeoutMs = sourceNumber("WAIT_TIMEOUT_MS");
    const pollMs = sourceNumber("WAIT_POLL_MS");
    let promptSeen = !!options.promptSeen;
    let cancelled = false;
    const loaded = loadWaitForPrompt({
        clock: clock,
        timeoutMs: timeoutMs,
        pollMs: pollMs,
        outputContains: function () { return promptSeen; },
        sendBytes: function (bytes) { sent.push(bytes); },
        stepBytes: function (step) { return [step.send]; },
    });
    return {
        clock: clock,
        sent: sent,
        advanced: advanced,
        timeoutMs: timeoutMs,
        pollMs: pollMs,
        prompt: function () { promptSeen = true; },
        start: function (steps, index, base) {
            var step = steps[index];
            var ctx = {
                isCancelled: function () { return cancelled; },
                outputContains: function () { return promptSeen; },
                sendBytes: function (bytes) { sent.push(bytes); },
                stepDelayMs: base,
                waitTimeoutMs: timeoutMs,
                waitPollMs: pollMs,
            };
            loaded.waitFor(step, ctx,
                function onDone() { advanced.push(index + 1); },
                function onCancel() { /* cancelled */ }
            );
        },
        abort: function () { cancelled = true; },
        wait: loaded.waitFor
    };
}

function run() {
    assert.ok(SOURCE.indexOf("function waitForPrompt") !== -1,
        "src/step-engine.js has no waitForPrompt — the extractor marker is stale");

    // --- 1. the prompt never appears: send after the budget, once ---------
    {
        const h = harness({ promptSeen: false });
        const steps = [{ send: "boot rk0" }, { send: "unix" }, { send: "root", waitFor: "login:" }];
        h.start(steps, 2, 800);

        // Not before the budget: polling must not fire the step early.
        const spentEarly = h.clock.run(h.timeoutMs - 1);
        assert.strictEqual(h.sent.length, 0,
            "the step was sent before the wait budget ran out");
        assert.ok(spentEarly >= 1, "the wait did not poll at all");

        // Past the budget: sent exactly once, then the chain advances.
        h.clock.run(h.timeoutMs + h.pollMs * 2 + 800);
        assert.deepStrictEqual(h.sent, [["root"]],
            "a timed-out wait must send the step exactly once");
        assert.deepStrictEqual(h.advanced, [3],
            "a timed-out wait must move the sequence on");

        // And it polls on its own cadence instead of spinning: the number of
        // iterations is bounded by the budget and the poll interval.
        const polls = Math.floor(h.timeoutMs / h.pollMs);
        assert.ok(spentEarly <= polls + 2,
            "the wait polled more often than the interval allows: " + spentEarly);
    }

    // --- 2. the prompt arrives: send at once, no polling ------------------
    {
        const h = harness({ promptSeen: true });
        const steps = [{ send: "boot rk0" }, { send: "root", waitFor: "login:" }];
        h.start(steps, 1, 800);
        const ran = h.clock.run(h.timeoutMs);
        assert.deepStrictEqual(h.sent, [["root"]],
            "a prompt that is already there must release the step immediately");
        assert.deepStrictEqual(h.advanced, [2], "the sequence must move on");
        // One send timer plus the post-send settle timer — no poll iterations.
        assert.ok(ran <= 2, "a seen prompt must not poll: " + ran + " timer(s)");
    }

    // --- 3. an abort mid-wait: nothing sent, nothing left pending ---------
    {
        const h = harness({ promptSeen: false });
        const steps = [{ send: "boot rk0" }, { send: "root", waitFor: "login:" }];
        h.start(steps, 1, 800);
        h.clock.run(h.pollMs * 3);       // let it poll a few times
        h.abort();                        // e.g. imgerror.js aborts the autoload
        h.clock.run(h.timeoutMs * 3);     // well past the budget
        assert.deepStrictEqual(h.sent, [],
            "an aborted autoload must not type anything");
        assert.deepStrictEqual(h.advanced, [], "an aborted autoload must not continue");
        assert.strictEqual(h.clock.pending(), 0,
            "an aborted autoload must not leave timers running");
    }

    // --- 4. wait + waitFor: the send is delayed by `wait` once seen -------
    {
        const h = harness({ promptSeen: true });
        const steps = [null, { send: "root", wait: 500, waitFor: "login:" }];
        h.start(steps, 1, 800);
        h.clock.run(499);
        assert.deepStrictEqual(h.sent, [], "the settle delay was ignored");
        h.clock.run(500);
        assert.deepStrictEqual(h.sent, [["root"]], "the step must go after the settle");
    }

    console.log("quickboot-wait: all tests passed (budget " + sourceNumber("WAIT_TIMEOUT_MS") +
        " ms, poll " + sourceNumber("WAIT_POLL_MS") + " ms)");
}

run();
