#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "emulation-control.js"), "utf8");
const appSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "pdp11-app.js"), "utf8");
const terminalSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "terminal-core.js"), "utf8");
const printerSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "g60printer.js"), "utf8");
const vt11Source = fs.readFileSync(
    path.join(__dirname, "..", "src", "vt11.js"), "utf8");
const cssSource = fs.readFileSync(
    path.join(__dirname, "..", "css", "pdp11.css"), "utf8");

function loadControl(initialValue) {
    const store = new Map();
    if (initialValue) store.set("yapdp.emulation-paused", "1");
    const events = [];
    const root = {
        sessionStorage: {
            getItem: function (key) { return store.has(key) ? store.get(key) : null; },
            setItem: function (key, value) { store.set(key, String(value)); },
            removeItem: function (key) { store.delete(key); }
        },
        CustomEvent: function (type, options) {
            this.type = type;
            this.detail = options && options.detail;
        },
        document: {
            dispatchEvent: function (event) { events.push(event); }
        },
        console: { error: function () {} }
    };
    vm.runInNewContext(source, { window: root });
    return { control: root.EmulationControl, store: store, events: events };
}

function run() {
    // Guard rails for the browser-facing input and timer paths. The integration
    // suite exercises the actual UI; these checks prevent regressions where a
    // new input route bypasses the global pause contract.
    assert.ok(appSource.includes("if (window.EmulationControl && window.EmulationControl.isPaused()) return false;"),
        "the shared terminal input bridge must discard input while paused");
    assert.ok(appSource.includes("if (!def || (window.EmulationControl && window.EmulationControl.isPaused())) return;"),
        "the Model 33 on-screen keyboard must ignore keys while paused");
    assert.ok(terminalSource.includes('window.EmulationControl.register("terminal-blink:" + unit'),
        "VT52/VT100 blink timers must subscribe to pause/resume");
    assert.ok(printerSource.includes("function pauseEmulationTimers()") &&
        printerSource.includes("function resumeEmulationTimers()"),
        "printer paper/head timers must preserve their remaining time across pause");
    assert.ok(vt11Source.includes("EmulationControl.isPaused()) return;"),
        "VT11 light-pen input must be ignored while paused");
    assert.ok(cssSource.includes("html.yapdp-emulation-paused .vt52-crt canvas") &&
        cssSource.includes("html.yapdp-emulation-paused body.crt-effects .vt52-crt::before") &&
        cssSource.includes("html.yapdp-emulation-paused body.crt-effects .vt52-crt::after") &&
        cssSource.includes("html.yapdp-emulation-paused .vt11-crt canvas") &&
        cssSource.includes("html.yapdp-emulation-paused .vt52-textarea.vt52-bell-flash") &&
        cssSource.includes("animation-play-state: paused !important;"),
        "CRT animations and visual bell must freeze while paused");
    assert.ok(cssSource.includes("animation: pause-attention 1s ease-in-out infinite;") &&
        cssSource.includes("@media (prefers-reduced-motion: reduce)"),
        "the pause button should pulse once per second unless reduced motion is preferred");

    {
        const env = loadControl(false);
        const calls = [];
        env.control.register("test-device", {
            pause: function () { calls.push("pause"); },
            resume: function () { calls.push("resume"); }
        });
        assert.strictEqual(env.control.isPaused(), false);
        assert.strictEqual(env.control.pause(), true);
        assert.strictEqual(env.control.pause(), false, "pause is idempotent");
        assert.strictEqual(env.control.isPaused(), true);
        assert.strictEqual(env.store.get("yapdp.emulation-paused"), "1");
        assert.strictEqual(env.events[0].type, "yapdp:emulation-state");
        assert.strictEqual(env.events[0].detail.paused, true);
        assert.strictEqual(env.control.resume(), true);
        assert.strictEqual(env.control.resume(), false, "resume is idempotent");
        assert.strictEqual(env.store.has("yapdp.emulation-paused"), false);
        assert.deepStrictEqual(calls, ["pause", "resume"]);
        assert.deepStrictEqual(env.events.map(function (event) {
            return [event.type, event.detail.paused];
        }), [["yapdp:emulation-state", true], ["yapdp:emulation-state", false]]);
    }

    {
        const env = loadControl(true);
        assert.strictEqual(env.control.isPaused(), true,
            "a page reload in the same tab preserves host pause");
        let paused = 0;
        env.control.register("late-device", {
            pause: function () { paused++; }
        });
        assert.strictEqual(paused, 1,
            "a device registered after reload joins the paused session");
        env.control.resume();
        assert.strictEqual(env.control.isPaused(), false);
    }

    console.log("emulation-control.test.js: all tests passed");
}

run();
