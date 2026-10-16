#!/usr/bin/env node
"use strict";

const assert = require("assert");
require("../src/emulation-control.js");
const { Kw11 } = require("../src/devices/kw11.js");

function run() {
    const intervals = new Map();
    let nextId = 0;
    const io = {
        setInterval: function (fn, delay) {
            const id = ++nextId;
            intervals.set(id, { fn: fn, delay: delay });
            return id;
        },
        clearInterval: function (id) { intervals.delete(id); }
    };
    const machine = {
        io: io,
        host: { cpu: { interruptRequested: 0, runState: 0 } }
    };
    const clock = new Kw11(machine, "pause-test", { tickMs: 20 });

    assert.strictEqual(intervals.size, 1, "KW11 starts its virtual clock");
    global.EmulationControl.pause();
    assert.strictEqual(intervals.size, 0, "pause stops KW11 ticks");

    clock.reset();
    assert.strictEqual(intervals.size, 0,
        "reset while paused must not restart the virtual clock");

    global.EmulationControl.resume();
    assert.strictEqual(intervals.size, 1, "resume restarts one KW11 timer");
    global.EmulationControl.pause();
    global.EmulationControl.resume();
    assert.strictEqual(intervals.size, 1,
        "repeated pause/resume leaves exactly one timer");

    global.EmulationControl.pause();
    console.log("kw11-pause.test.js: all tests passed");
}

run();
