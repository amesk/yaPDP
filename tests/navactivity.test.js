#!/usr/bin/env node
/**
 * NavActivity module unit tests.
 *
 * Loads the real production module (src/navactivity.js) in an isolated VM
 * context with a fake window/document/timers, then exercises:
 *   • the pure page-mapping helpers (pageForConsole / pageForTerminal);
 *   • pulse() lighting the .nav-led element and the auto-off timer;
 *   • pulse() re-arming the timer (continuous output keeps the lamp on);
 *   • the pulseConsole() / pulseTerminal() convenience wrappers.
 *
 * The blink visual itself is pure CSS (css/pdp11.css) and is covered by
 * tests/nav-led-css.test.js.
 *
 * Run with:  node tests/navactivity.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "navactivity.js");

// Build a fake DOM: each sidebar page maps to a button with a .nav-led
// element whose classList is observable for assertions. Only the real
// output-capable pages exist, so unknown pages correctly resolve to null.
const KNOWN_PAGES = new Set(["teletype", "vt52-console", "vt52", "vt52-2", "printer"]);

function makeLed() {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    has: (c) => classes.has(c),
  };
}

function loadModule() {
  const code = fs.readFileSync(SOURCE_PATH, "utf8");
  const buttons = {};
  let timerId = 0;
  const pending = new Map();
  const cleared = [];

  const sandbox = {
    console,
    window: {},
    document: {
      querySelector(sel) {
        const m = sel.match(/data-page="([^"]+)"/);
        if (!m || !KNOWN_PAGES.has(m[1])) return null;
        if (!buttons[m[1]]) {
          const led = makeLed();
          buttons[m[1]] = {
            led,
            querySelector: (s) => (s === ".nav-led" ? led : null),
          };
        }
        return buttons[m[1]];
      },
    },
    setTimeout(fn, ms) {
      const id = ++timerId;
      // Mimic a real timer: firing removes the entry from the pending map.
      const wrapped = function () {
        pending.delete(id);
        fn();
      };
      pending.set(id, { fn: wrapped, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      pending.delete(id);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const NavActivity = sandbox.window.NavActivity;
  return {
    NavActivity,
    buttons,
    pending,
    cleared,
  };
}

function run() {
  const { NavActivity, buttons, pending, cleared } = loadModule();

  assert.ok(NavActivity, "module should expose window.NavActivity");
  assert.ok(typeof NavActivity.pulse === "function", "pulse should be a function");
  assert.ok(typeof NavActivity.set === "function", "set should be a function");
  assert.ok(typeof NavActivity.pulseConsole === "function", "pulseConsole should be a function");
  assert.ok(typeof NavActivity.pulseTerminal === "function", "pulseTerminal should be a function");
  assert.ok(typeof NavActivity.pageForConsole === "function", "pageForConsole should be a function");
  assert.ok(typeof NavActivity.pageForTerminal === "function", "pageForTerminal should be a function");

  // ---- the lamp must stay lit ~0.5s after the last pulse ----------------
  assert.strictEqual(NavActivity.LED_MS, 500, "LED_MS should be 500ms");

  // ---- pure console mapping ---------------------------------------------
  {
    assert.strictEqual(NavActivity.pageForConsole("teletype"), "teletype",
      "teletype console -> teletype button");
    assert.strictEqual(NavActivity.pageForConsole("vt52"), "vt52-console",
      "vt52 console -> vt52-console button");
    assert.strictEqual(NavActivity.pageForConsole(undefined), "teletype",
      "missing console type -> teletype button");
    assert.strictEqual(NavActivity.pageForConsole(null), "teletype",
      "null console type -> teletype button");
  }

  // ---- pure terminal mapping --------------------------------------------
  {
    assert.strictEqual(NavActivity.pageForTerminal(1), "vt52",
      "unit 1 -> vt52 (TTY 1) button");
    assert.strictEqual(NavActivity.pageForTerminal(2), "vt52-2",
      "unit 2 -> vt52-2 (TTY 2) button");
  }

  // ---- pulse() lights the lamp and schedules the auto-off timer ---------
  {
    NavActivity.pulse("teletype");
    assert.strictEqual(buttons.teletype.led.has("on"), true,
      "pulse('teletype') must add the .on class");
    assert.strictEqual(pending.size, 1, "one auto-off timer must be scheduled");

    // Firing the timer turns the lamp off.
    const [id, timer] = pending.entries().next().value;
    assert.strictEqual(timer.ms, NavActivity.LED_MS, "timer must fire after LED_MS");
    timer.fn();
    assert.strictEqual(buttons.teletype.led.has("on"), false,
      "auto-off timer must remove the .on class");
    assert.strictEqual(pending.size, 0, "timer must be removed from the map");
  }

  // ---- continuous output re-arms the timer (lamp stays on) --------------
  {
    NavActivity.pulse("vt52");
    const first = pending.keys().next().value;
    assert.strictEqual(buttons.vt52.led.has("on"), true, "pulse must light the lamp");

    NavActivity.pulse("vt52"); // another byte arrives before the first timer fires
    assert.strictEqual(cleared.includes(first), true,
      "a second pulse must clear the first auto-off timer");
    assert.strictEqual(pending.size, 1, "only the re-armed timer should remain");
    assert.strictEqual(buttons.vt52.led.has("on"), true,
      "lamp stays lit while output keeps arriving");
  }

  // ---- set() toggles the lamp explicitly (ticker-driven devices) --------
  {
    // set(page, true) lights the lamp and cancels any pending auto-off timer.
    NavActivity.pulse("vt52"); // schedules an auto-off timer
    assert.strictEqual(pending.size, 1, "pulse must schedule an auto-off timer");
    NavActivity.set("vt52", true);
    assert.strictEqual(buttons.vt52.led.has("on"), true,
      "set(page, true) must light the lamp");
    assert.strictEqual(pending.size, 0,
      "set(page, true) must cancel the pending auto-off timer");

    // set(page, false) turns the lamp off.
    NavActivity.set("vt52", false);
    assert.strictEqual(buttons.vt52.led.has("on"), false,
      "set(page, false) must turn the lamp off");

    // set() must also cancel a timer armed just before the toggle.
    NavActivity.pulse("teletype");
    assert.strictEqual(pending.size, 1, "pulse must re-arm a timer");
    NavActivity.set("teletype", false);
    assert.strictEqual(buttons.teletype.led.has("on"), false,
      "set(page, false) after a pulse must turn the lamp off");
    assert.strictEqual(pending.size, 0,
      "set(page, false) must cancel the pending auto-off timer");
  }

  // ---- pulseConsole() routes by console type ----------------------------
  {
    NavActivity.pulseConsole("vt52");
    assert.strictEqual(buttons["vt52-console"].led.has("on"), true,
      "pulseConsole('vt52') must light the vt52-console button");
    NavActivity.pulseConsole("teletype");
    assert.strictEqual(buttons.teletype.led.has("on"), true,
      "pulseConsole('teletype') must light the teletype button");
  }

  // ---- pulseTerminal() routes by unit -----------------------------------
  {
    NavActivity.pulseTerminal(1);
    assert.strictEqual(buttons.vt52.led.has("on"), true,
      "pulseTerminal(1) must light the TTY 1 button");
    NavActivity.pulseTerminal(2);
    assert.strictEqual(buttons["vt52-2"].led.has("on"), true,
      "pulseTerminal(2) must light the TTY 2 button");
  }

  // ---- unknown/missing pages are safe no-ops ----------------------------
  {
    NavActivity.pulse("does-not-exist"); // must not throw
    NavActivity.pulse("");               // must not throw
    NavActivity.pulse(null);             // must not throw
    assert.strictEqual(buttons["does-not-exist"], undefined,
      "no button should be created for an unknown page");
  }

  console.log("\nAll NavActivity tests passed.");
}

run();
