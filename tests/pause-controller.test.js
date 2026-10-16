"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const button = {
    attributes: {},
    handlers: {},
    title: "",
    addEventListener: function (name, fn) { this.handlers[name] = fn; },
    setAttribute: function (name, value) { this.attributes[name] = value; }
};
const events = [];
const sandbox = {
    document: {
        getElementById: function (id) { return id === "pause-btn" ? button : null; },
        dispatchEvent: function (event) { events.push(event); }
    },
    CustomEvent: function (name, options) {
        this.type = name;
        this.detail = options.detail;
    }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/pause-controller.js"), "utf8"), sandbox);

const controller = sandbox.YapdpPauseController;
assert.strictEqual(controller.isPaused(), false, "starts unpaused");

let pauseCalls = 0;
let resumeCalls = 0;
controller.register({
    pause: function () { pauseCalls++; },
    resume: function () { resumeCalls++; }
});

button.handlers.click();
assert.strictEqual(controller.isPaused(), true, "button pauses the machine");
assert.strictEqual(pauseCalls, 1, "pause participant notified once");
assert.strictEqual(button.attributes["aria-pressed"], "true", "button exposes pressed state");
assert.strictEqual(button.attributes["aria-label"], "Resume the machine", "accessible label changes");
assert.strictEqual(events[0].detail.paused, true, "pause event is dispatched");

controller.pause();
assert.strictEqual(pauseCalls, 1, "repeated pause is idempotent");

controller.resume();
assert.strictEqual(controller.isPaused(), false, "resume clears pause");
assert.strictEqual(resumeCalls, 1, "resume participant notified once");
assert.strictEqual(button.attributes["aria-pressed"], "false", "button pressed state clears");
assert.strictEqual(button.attributes["aria-label"], "Pause the machine", "accessible label resets");

controller.pause();
let latePauseCalls = 0;
controller.register({ pause: function () { latePauseCalls++; } });
assert.strictEqual(latePauseCalls, 1, "late participant immediately receives current paused state");

console.log("pause-controller tests: all passed");
