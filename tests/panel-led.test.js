#!/usr/bin/env node
/**
 * PanelLed module unit tests.
 *
 * Loads the real production module (src/panel-led.js) in an isolated VM
 * context with fake window/document/panel/CPU, then exercises:
 *   • the pure power-lamp mapping ledState():
 *       - powered off -> "off"  (lamp off)
 *       - powered on  -> "on"   (lamp lit — power only, not run state)
 *   • the pure run-state icon mapping runIcon():
 *       - powered off            -> "off"  (no pause / no play)
 *       - powered on, running    -> "run"  (play glyph)
 *       - powered on, halted     -> "halt" (pause glyph)
 *   • update() applying .power-on to the .nav-led and .off/.run to the
 *     .nav-run-icon, flipping them when the machine state changes;
 *   • start() installing the polling interval (idempotent).
 *
 * The visuals themselves are pure CSS (css/pdp11.css).
 *
 * Run with:  node tests/panel-led.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "panel-led.js");

// CPU run states (mirror src/pdp11.js).
const STATE_RUN = 0;
const STATE_RESET = 1;
const STATE_WAIT = 2;
const STATE_HALT = 3;
const STATE_STEP = 4;

// Build the fake environment: a mutable machine state object doubles as both
// `panel` (panel.powerSwitch) and `CPU` (CPU.runState), plus a fake DOM whose
// Panel nav button exposes an observable .nav-led and .nav-run-icon.
function loadModule(powerSwitch, runState) {
  const code = fs.readFileSync(SOURCE_PATH, "utf8");
  const state = { powerSwitch, runState };

  function makeClasses() {
    const set = new Set();
    return {
      toggle(c, force) {
        if (force) set.add(c);
        else set.delete(c);
      },
      contains: (c) => set.has(c),
    };
  }

  const ledClasses = makeClasses();
  const iconClasses = makeClasses();
  const led = { classList: ledClasses, has: (c) => ledClasses.contains(c) };
  const icon = { classList: iconClasses, has: (c) => iconClasses.contains(c) };
  const button = {
    querySelector(s) {
      if (s === ".nav-led") return led;
      if (s === ".nav-run-icon") return icon;
      return null;
    },
  };

  let intervalCalls = 0;
  const sandbox = {
    console,
    window: {},
    document: {
      querySelector(sel) {
        return sel === '.nav-btn[data-page="panel"]' ? button : null;
      },
    },
    panel: state,
    CPU: state,
    setInterval() { intervalCalls++; return intervalCalls; },
    clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    PanelLed: sandbox.window.PanelLed,
    led,
    icon,
    state,
    intervalCalls: () => intervalCalls,
  };
}

function run() {
  // ---- module API surface ------------------------------------------------
  {
    const { PanelLed } = loadModule(-1, STATE_HALT);
    assert.ok(PanelLed, "module should expose window.PanelLed");
    assert.strictEqual(typeof PanelLed.ledState, "function", "ledState should be a function");
    assert.strictEqual(typeof PanelLed.runIcon, "function", "runIcon should be a function");
    assert.strictEqual(typeof PanelLed.update, "function", "update should be a function");
    assert.strictEqual(typeof PanelLed.start, "function", "start should be a function");
    assert.strictEqual(typeof PanelLed.stop, "function", "stop should be a function");
    assert.strictEqual(PanelLed.TICK_MS, 250, "TICK_MS should be 250ms");
  }

  // ---- pure ledState(): power lamp reflects power only -------------------
  {
    const { PanelLed } = loadModule(0, STATE_HALT);
    assert.strictEqual(PanelLed.ledState(false), "off", "powered off -> off");
    assert.strictEqual(PanelLed.ledState(true), "on", "powered on -> on");
  }

  // ---- pure runIcon(): off / play / pause --------------------------------
  {
    const { PanelLed } = loadModule(0, STATE_HALT);
    assert.strictEqual(PanelLed.runIcon(false, STATE_RUN), "off",
      "powered off -> off even while running");
    assert.strictEqual(PanelLed.runIcon(false, STATE_HALT), "off",
      "powered off -> off while halted");
    assert.strictEqual(PanelLed.runIcon(true, STATE_RUN), "run", "running -> play");
    assert.strictEqual(PanelLed.runIcon(true, STATE_HALT), "halt", "halted -> pause");
    assert.strictEqual(PanelLed.runIcon(true, STATE_WAIT), "halt", "waiting -> pause");
    assert.strictEqual(PanelLed.runIcon(true, STATE_RESET), "halt", "resetting -> pause");
    assert.strictEqual(PanelLed.runIcon(true, STATE_STEP), "halt", "stepping -> pause");
  }

  // ---- update(): powered off -> lamp off, icon hidden --------------------
  {
    const { PanelLed, led, icon } = loadModule(-1, STATE_HALT);
    PanelLed.update();
    assert.strictEqual(led.has("power-on"), false, "powered off -> no power-on");
    assert.strictEqual(icon.has("off"), true, "powered off -> icon hidden");
    assert.strictEqual(icon.has("run"), false, "powered off -> no play icon");
  }

  // ---- update(): powered on + halted -> lamp lit, pause icon -------------
  {
    const { PanelLed, led, icon } = loadModule(0, STATE_HALT);
    PanelLed.update();
    assert.strictEqual(led.has("power-on"), true, "powered on -> power-on lit");
    assert.strictEqual(icon.has("off"), false, "powered on -> icon visible");
    assert.strictEqual(icon.has("run"), false, "halted -> pause icon");
  }

  // ---- update(): powered on + running -> lamp lit, play icon -------------
  {
    const { PanelLed, led, icon } = loadModule(0, STATE_RUN);
    PanelLed.update();
    assert.strictEqual(led.has("power-on"), true, "powered on -> power-on lit");
    assert.strictEqual(icon.has("run"), true, "running -> play icon");
    assert.strictEqual(icon.has("off"), false, "running -> icon visible");
  }

  // ---- update(): indicators flip when the machine state changes ----------
  {
    const { PanelLed, led, icon, state } = loadModule(0, STATE_HALT);
    PanelLed.update();
    assert.strictEqual(led.has("power-on"), true, "powered on + halted -> lamp lit");
    assert.strictEqual(icon.has("run"), false, "halted -> pause icon");
    assert.strictEqual(icon.has("off"), false, "halted -> icon visible");

    state.runState = STATE_RUN; // CPU starts running (e.g. START / CONT)
    PanelLed.update();
    assert.strictEqual(icon.has("run"), true, "running -> play icon");
    assert.strictEqual(led.has("power-on"), true, "still powered on -> lamp stays lit");

    state.runState = STATE_HALT; // CPU halts (e.g. HALT instruction)
    PanelLed.update();
    assert.strictEqual(icon.has("run"), false, "halted again -> pause icon");
    assert.strictEqual(led.has("power-on"), true, "still powered on -> lamp stays lit");

    state.powerSwitch = -1; // machine powered off
    PanelLed.update();
    assert.strictEqual(led.has("power-on"), false, "powered off -> lamp off");
    assert.strictEqual(icon.has("off"), true, "powered off -> icon hidden");
    assert.strictEqual(icon.has("run"), false, "powered off -> no play icon");
  }

  // ---- start(): installs the interval once (idempotent) ------------------
  {
    const { PanelLed, intervalCalls } = loadModule(0, STATE_RUN);
    PanelLed.start();
    assert.strictEqual(intervalCalls(), 1, "start() must install the polling interval");
    PanelLed.start();
    assert.strictEqual(intervalCalls(), 1, "start() must be idempotent");
  }

  console.log("panel-led: all tests passed");
}

run();
