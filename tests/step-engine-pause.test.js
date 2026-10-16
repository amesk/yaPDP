#!/usr/bin/env node
/**
 * The shared step engine must suspend its host timers while global emulation
 * pause is active, including prompt-wait budgets.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "step-engine.js"), "utf8");

function makeClock() {
    let now = 0;
    let sequence = 0;
    const timers = [];
    return {
        now: function () { return now; },
        setTimeout: function (fn, delay) {
            const timer = { id: ++sequence, at: now + Math.max(0, Number(delay) || 0), fn: fn, cancelled: false };
            timers.push(timer);
            return timer.id;
        },
        clearTimeout: function (id) {
            const timer = timers.find(function (item) { return item.id === id; });
            if (timer) timer.cancelled = true;
        },
        advanceTo: function (target) {
            let count = 0;
            for (;;) {
                timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
                const index = timers.findIndex(function (item) { return !item.cancelled && item.at <= target; });
                if (index === -1) break;
                const timer = timers.splice(index, 1)[0];
                now = timer.at;
                timer.fn();
                count++;
                assert.ok(count < 10000, "runaway timer loop");
            }
            now = target;
        }
    };
}

function loadEngine(clock) {
    const handlers = {};
    const control = {
        paused: false,
        isPaused: function () { return this.paused; },
        register: function (name, handler) { handlers[name] = handler; },
        pause: function () {
            if (this.paused) return;
            this.paused = true;
            Object.keys(handlers).forEach(function (name) { handlers[name].pause(); });
        },
        resume: function () {
            if (!this.paused) return;
            this.paused = false;
            Object.keys(handlers).forEach(function (name) { handlers[name].resume(); });
        }
    };
    const sandbox = {
        console: console,
        Date: { now: function () { return clock.now(); } },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        EmulationControl: control,
        OSBoot: { stringToBytes: function (value) { return Array.from(value).map(function (c) { return c.charCodeAt(0); }); } }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: "src/step-engine.js" });
    return { engine: sandbox.StepEngine, control: control };
}

function testScheduledStepSuspends() {
    const clock = makeClock();
    const loaded = loadEngine(clock);
    const sent = [];
    loaded.engine.runSteps([{ send: "boot" }], {
        sendBytes: function (bytes) { sent.push(bytes); },
        outputContains: function () { return false; },
        stepDelayMs: 800
    });

    clock.advanceTo(500);
    loaded.control.pause();
    clock.advanceTo(5000);
    assert.strictEqual(sent.length, 0, "a paused machine must not receive the boot command");

    loaded.control.resume();
    clock.advanceTo(6099);
    assert.strictEqual(sent.length, 0, "the step delay must resume with its remaining time");
    clock.advanceTo(6100);
    assert.strictEqual(sent.length, 1, "the boot command must be sent after the remaining delay");
}

function testPromptBudgetSuspends() {
    const clock = makeClock();
    const loaded = loadEngine(clock);
    const sent = [];
    loaded.engine.runSteps([{ send: "root", waitFor: "login:" }], {
        sendBytes: function (bytes) { sent.push(bytes); },
        outputContains: function () { return false; },
        stepDelayMs: 100,
        waitTimeoutMs: 1000,
        waitPollMs: 200
    });

    clock.advanceTo(400);
    loaded.control.pause();
    clock.advanceTo(5000);
    assert.strictEqual(sent.length, 0, "the prompt wait must not time out while paused");

    loaded.control.resume();
    clock.advanceTo(5799);
    assert.strictEqual(sent.length, 0, "the prompt budget must exclude paused time");
    clock.advanceTo(5800);
    assert.strictEqual(sent.length, 1, "the timeout fallback must run after the remaining active-time budget");
}

testScheduledStepSuspends();
testPromptBudgetSuspends();
console.log("step-engine-pause: all tests passed");
