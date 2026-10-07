#!/usr/bin/env node
/**
 * Toast notifications tests.
 *
 * toasts.js is a DOM-independent notification subsystem: the window injects a
 * DOM/CSS adapter, and the module only owns the queue, the timing and the
 * categories. Its contract is:
 *   - show() is a silent no-op until configure(adapter) runs;
 *   - configure() mounts the adapter once;
 *   - a single toast is shown for its duration, then hidden;
 *   - a new toast preempts the active one (the preempted toast is restored
 *     first — a stack of preemptions);
 *   - a preempted toast is restored only for its REMAINING time (deadline -
 *     now), and is dropped entirely if its deadline has already passed;
 *   - categories carry default durations (info 3000, warning 4000, error 5000);
 *   - clear() cancels everything and hides.
 *
 * The module is pure Node: nothing here touches document. The clock and
 * timers are replaced through the __setTimers test hook so the queue can be
 * driven deterministically. Run with: node tests/toasts.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "src", "toasts.js");

function loadToasts() {
    // Fresh instance per load so the adapter/queue start empty.
    delete require.cache[require.resolve(MODULE)];
    return require(MODULE).Toasts;
}

// Deterministic clock + timer scheduler.
function fakeTimers() {
    const state = { now: 0, nextId: 1, scheduled: [] };   // scheduled: { id, at, fn }
    return {
        now: function () { return state.now; },
        set: function (fn, ms) {
            const id = state.nextId++;
            state.scheduled.push({ id: id, at: state.now + ms, fn: fn });
            return id;
        },
        clear: function (id) {
            state.scheduled = state.scheduled.filter(function (t) { return t.id !== id; });
        },
        advance: function (ms) {
            state.now += ms;
            const due = state.scheduled
                .filter(function (t) { return t.at <= state.now; })
                .sort(function (a, b) { return a.at - b.at; });
            state.scheduled = state.scheduled.filter(function (t) { return t.at > state.now; });
            due.forEach(function (t) { t.fn(); });
        }
    };
}

function fakeAdapter() {
    return {
        mountCalls: 0,
        updates: [],
        showCalls: 0,
        hideCalls: 0,
        mount: function () { this.mountCalls++; },
        update: function (state) { this.updates.push({ text: state.text, category: state.category }); },
        show: function () { this.showCalls++; },
        hide: function () { this.hideCalls++; }
    };
}

// ------------------------------------------------------------------
function testNoAdapterIsNoop() {
    const toasts = loadToasts();
    assert.strictEqual(toasts.show({ text: "x" }), null,
        "show() before configure is a silent no-op");
    assert.doesNotThrow(function () { toasts.show({ text: "x" }); });
    assert.doesNotThrow(function () { toasts.clear(); });
}

function testConfigureMountsAdapter() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    toasts.configure(adapter);
    assert.strictEqual(adapter.mountCalls, 1, "configure calls mount() once");
    assert.strictEqual(toasts.show({ text: "hi" }) !== null, true,
        "show() works once configured");
}

function testSingleToastLifecycle() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    const clock = fakeTimers();
    toasts.__setTimers(clock);
    toasts.configure(adapter);

    toasts.show({ text: "Saved", category: "info" });
    assert.deepStrictEqual(adapter.updates, [{ text: "Saved", category: "info" }]);
    assert.strictEqual(adapter.showCalls, 1);
    assert.strictEqual(adapter.hideCalls, 0, "not hidden before the duration elapses");

    clock.advance(2999);
    assert.strictEqual(adapter.hideCalls, 0, "still visible one ms before the deadline");
    clock.advance(1);
    assert.strictEqual(adapter.hideCalls, 1, "hidden exactly at the deadline");
}

function testPreemptionRestoresRemainder() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    const clock = fakeTimers();
    toasts.__setTimers(clock);
    toasts.configure(adapter);

    // A owes 10000ms of visibility.
    toasts.show({ text: "A", duration: 10000 });
    clock.advance(1000);

    // B preempts A and shows for its full 3000ms.
    toasts.show({ text: "B", duration: 3000 });
    assert.deepStrictEqual(adapter.updates.map(function (u) { return u.text; }), ["A", "B"]);

    // B expires at t=4000; A is still owed time (deadline 10000), so it is
    // restored for the remaining 6000ms.
    clock.advance(3000);
    assert.deepStrictEqual(adapter.updates.map(function (u) { return u.text; }), ["A", "B", "A"],
        "the preempted toast is restored after the preemptor finishes");
    assert.strictEqual(adapter.showCalls, 3);

    clock.advance(6000);
    assert.strictEqual(adapter.hideCalls, 1, "hidden after the restored toast finishes");
}

function testExpiredPreemptedIsDropped() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    const clock = fakeTimers();
    toasts.__setTimers(clock);
    toasts.configure(adapter);

    // A owes 3000ms (deadline t=3000).
    toasts.show({ text: "A", duration: 3000 });
    clock.advance(1000);

    // B preempts A and shows until t=5000. By then A's deadline (3000) has
    // passed, so A must NOT be restored.
    toasts.show({ text: "B", duration: 4000 });
    clock.advance(4000);

    assert.deepStrictEqual(adapter.updates.map(function (u) { return u.text; }), ["A", "B"],
        "an expired preempted toast is dropped, not restored");
    assert.strictEqual(adapter.hideCalls, 1, "queue drained -> hidden");
}

function testDefaultDurationsByCategory() {
    const cases = [
        { category: "info", ms: 3000 },
        { category: "warning", ms: 4000 },
        { category: "error", ms: 5000 },
        { category: "bogus", ms: 3000 }          // unknown falls back to info
    ];

    cases.forEach(function (c) {
        const toasts = loadToasts();
        const adapter = fakeAdapter();
        const clock = fakeTimers();
        toasts.__setTimers(clock);
        toasts.configure(adapter);

        toasts.show({ text: "x", category: c.category });
        clock.advance(c.ms - 1);
        assert.strictEqual(adapter.hideCalls, 0, c.category + ": visible before deadline");
        clock.advance(1);
        assert.strictEqual(adapter.hideCalls, 1, c.category + ": hidden at deadline");
    });
}

function testExplicitDurationOverridesDefault() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    const clock = fakeTimers();
    toasts.__setTimers(clock);
    toasts.configure(adapter);

    toasts.show({ text: "x", category: "error", duration: 1000 });
    clock.advance(1000);
    assert.strictEqual(adapter.hideCalls, 1, "explicit duration wins over the category default");
}

function testClearCancelsEverything() {
    const toasts = loadToasts();
    const adapter = fakeAdapter();
    const clock = fakeTimers();
    toasts.__setTimers(clock);
    toasts.configure(adapter);

    toasts.show({ text: "A", duration: 5000 });
    toasts.show({ text: "B", duration: 5000 });   // A preempted into the queue
    toasts.clear();

    assert.strictEqual(adapter.hideCalls, 1, "clear hides immediately");
    assert.strictEqual(adapter.updates.length, 2, "no further updates after clear");

    clock.advance(10000);
    assert.strictEqual(adapter.updates.length, 2, "cleared queue never restores");
    assert.strictEqual(adapter.hideCalls, 1, "no extra hide after clear");
}

// ------------------------------------------------------------------
function main() {
    testNoAdapterIsNoop();
    testConfigureMountsAdapter();
    testSingleToastLifecycle();
    testPreemptionRestoresRemainder();
    testExpiredPreemptedIsDropped();
    testDefaultDurationsByCategory();
    testExplicitDurationOverridesDefault();
    testClearCancelsEverything();
    console.log("toasts: all tests passed");
}

main();
