#!/usr/bin/env node
/**
 * Hum module modular tests.
 *
 * Loads the real production module (src/hum.js) in an isolated VM context
 * and exercises its DOM/audio-free helper humLevel() plus the exported API
 * surface. The Web Audio graph itself (browser-only) is not constructed here.
 *
 * The hum maps the machine state to a background master gain:
 *   - feature disabled (hum config off)      -> 0 (silent)
 *   - machine powered off (powerSwitch < 0)  -> 0 (silent)
 *   - powered on, CPU running (STATE_RUN)    -> GAIN_RUN
 *   - powered on, halted/waiting             -> GAIN_IDLE (< GAIN_RUN)
 *
 * Run with:  node tests/hum.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "hum.js");

// CPU run states (mirror src/pdp11.js).
const STATE_RUN = 0;
const STATE_WAIT = 2;
const STATE_HALT = 3;

function loadModule() {
  const code = fs.readFileSync(SOURCE_PATH, "utf8");
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  // `var Hum = ...` at top level becomes a property of the sandbox.
  return sandbox.Hum;
}

function run() {
  const Hum = loadModule();
  assert.ok(Hum, "module should expose Hum");
  assert.ok(typeof Hum.humLevel === "function", "humLevel should be a function");
  assert.ok(typeof Hum.start === "function", "start should be a function");
  assert.ok(typeof Hum.stop === "function", "stop should be a function");
  assert.ok(typeof Hum.update === "function", "update should be a function");

  // ---- gain constants ------------------------------------------------
  {
    assert.ok(Hum.GAIN_RUN > 0, "GAIN_RUN should be positive");
    assert.ok(Hum.GAIN_IDLE > 0, "GAIN_IDLE should be positive");
    assert.ok(Hum.GAIN_IDLE < Hum.GAIN_RUN,
      "idle hum should be quieter than the running hum");
  }

  // ---- disabled feature is always silent -----------------------------
  {
    assert.strictEqual(Hum.humLevel(true, STATE_RUN, false), 0,
      "disabled -> silent even while running");
    assert.strictEqual(Hum.humLevel(true, STATE_HALT, false), 0,
      "disabled -> silent even while halted");
  }

  // ---- powered off is always silent ----------------------------------
  {
    assert.strictEqual(Hum.humLevel(false, STATE_RUN, true), 0,
      "powered off -> silent while running");
    assert.strictEqual(Hum.humLevel(false, STATE_HALT, true), 0,
      "powered off -> silent while halted");
  }

  // ---- powered on maps run state to gain -----------------------------
  {
    assert.strictEqual(Hum.humLevel(true, STATE_RUN, true), Hum.GAIN_RUN,
      "running -> full hum");
    assert.strictEqual(Hum.humLevel(true, STATE_HALT, true), Hum.GAIN_IDLE,
      "halted -> idle hum");
    assert.strictEqual(Hum.humLevel(true, STATE_WAIT, true), Hum.GAIN_IDLE,
      "waiting -> idle hum");
  }

  console.log("\nAll Hum tests passed.");
}

run();
