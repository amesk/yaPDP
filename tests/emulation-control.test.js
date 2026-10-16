#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "emulation-control.js"), "utf8");

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
