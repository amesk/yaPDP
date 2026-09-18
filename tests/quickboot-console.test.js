#!/usr/bin/env node
/**
 * Quick-boot console preparation tests.
 *
 * The wizard types its steps straight into the MACHINE (the DL11 receive
 * queue), but everything the machine answers is printed only while the CCU is
 * on LINE: with the teletype left in OFF or LOCAL the paper stays blank and a
 * perfectly booted guest reads as a hung machine. consoleWorkingState() is the
 * pure decision that puts the operator's controls right before a boot, so it is
 * verified here without a DOM — the source text is scraped out of
 * src/quickboot.js and driven from a VM sandbox, exactly like the other pure
 * helpers (see tests/punchtape.test.js).
 *
 * Run with:  node tests/quickboot-console.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "quickboot.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
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
      if (depth === 0) {
        if (tail) {
          const rest = src.slice(i + 1, i + 1 + tail.length);
          if (rest !== tail) {
            throw new Error("expected tail '" + tail + "' after " + startMarker);
          }
          return src.slice(start, i + 1 + tail.length);
        }
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error("unbalanced braces for: " + startMarker);
}

function loadSource() {
  return fs.readFileSync(SOURCE_PATH, "utf8");
}

function loadConsoleWorkingState() {
  const src = loadSource();
  const fn = extractBlock(src, "function consoleWorkingState", "");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + "\n; this.consoleWorkingState = consoleWorkingState;", sandbox);
  return sandbox.consoleWorkingState;
}

// Compare element-by-element with strictEqual: deepStrictEqual would fail
// because the helper runs in an isolated VM realm and its array prototype
// differs from the main realm's Array.prototype even though the values are
// identical (the same pitfall as tests/punchtape.test.js).
function assertList(actual, expected, desc) {
  assert.strictEqual(actual.length, expected.length,
    desc + " (expected " + JSON.stringify(expected) + ", got " +
    JSON.stringify(actual) + ")");
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(actual[i], expected[i],
      desc + ": item " + i + " (expected " + JSON.stringify(expected) +
      ", got " + JSON.stringify(actual) + ")");
  }
}

// A recording stand-in for the console controls: every call is appended to
// `calls` as "<name>:<argument>".
function recorder(state) {
  const calls = [];
  return {
    state: state || {},
    calls: calls,
    api: {
      setTtyMode: function (mode) { calls.push("setTtyMode:" + mode); },
      setReaderMode: function (mode) { calls.push("setReaderMode:" + mode); }
    }
  };
}

function testConsoleWorkingState() {
  const prepare = loadConsoleWorkingState();

  // The CCU must end up on LINE: off line the machine's own output never
  // reaches the teletype paper (g60ConsoleWrite only prints on LINE).
  for (const mode of ["off", "local"]) {
    const rec = recorder({ ttyMode: mode, readerMode: "stop" });
    const done = prepare(rec.state, rec.api);
    assertList(rec.calls, ["setTtyMode:line"],
      "CCU in '" + mode + "' must be switched to LINE before the boot");
    assertList(done, ["line"],
      "the action list must report the CCU switch");
  }

  // Already on LINE: nothing to correct, and nothing to report.
  {
    const rec = recorder({ ttyMode: "line", readerMode: "stop" });
    const done = prepare(rec.state, rec.api);
    assertList(rec.calls, [], "a console already on LINE must not be touched");
    assertList(done, [], "no actions for an already good console");
  }

  // A feeding tape must be stopped: START runs continuously, and in AUTO the
  // guest's own X-ON can start it — either way its bytes would land in the
  // middle of the boot. STOP and FREE never feed, so the operator's lever stays.
  for (const mode of ["start", "auto"]) {
    const rec = recorder({ ttyMode: "line", readerMode: mode });
    const done = prepare(rec.state, rec.api);
    assertList(rec.calls, ["setReaderMode:stop"],
      "reader in '" + mode + "' must be stopped before the boot");
    assertList(done, ["reader-stop"],
      "the action list must report the reader stop");
  }
  for (const mode of ["stop", "free"]) {
    const rec = recorder({ ttyMode: "line", readerMode: mode });
    const done = prepare(rec.state, rec.api);
    assertList(rec.calls, [], "reader in '" + mode + "' must be left alone");
    assertList(done, [], "no actions for an idle reader");
  }

  // Both wrong at once: both are corrected, the CCU first (the line switch is
  // what makes the boot visible; the tape stop can print nothing).
  {
    const rec = recorder({ ttyMode: "local", readerMode: "start" });
    const done = prepare(rec.state, rec.api);
    assertList(rec.calls, ["setTtyMode:line", "setReaderMode:stop"],
      "both the CCU and the reader must be corrected");
    assertList(done, ["line", "reader-stop"],
      "the action list must report both");
  }

  // Defensive: no console controls (headless / core build) and no state.
  {
    const none = prepare({ ttyMode: "local", readerMode: "start" },
      { setTtyMode: null, setReaderMode: null });
    assertList(none, [], "a missing control must be skipped, not thrown on");
    assertList(prepare(null, null), [], "no state: no actions");
    assertList(prepare({}, {}), [], "an empty api: no actions");
  }

  console.log("quickboot-console: OK (the wizard's console preparation)");
}

// The decision only helps if the wizard actually asks for it, so the call site
// is pinned too: launch() must run consoleWorkingState() with the live CCU and
// reader state before it reboots and types.
function testLaunchWiring() {
  const src = loadSource();
  const launch = extractBlock(src, "function launch(device, force)", "");
  assert.ok(/\bconsoleWorkingState\s*\(/.test(launch),
    "launch() must run consoleWorkingState() before it types the boot:\n" + launch);
  assert.ok(/ttyMode\s*:\s*window\.ttyMode/.test(launch),
    "launch() must pass the live CCU mode to consoleWorkingState():\n" + launch);
  assert.ok(/readerMode\s*:\s*window\.ttyReaderMode/.test(launch),
    "launch() must pass the live reader mode to consoleWorkingState():\n" + launch);
  assert.ok(/setTtyMode\s*:/.test(launch) && /setReaderMode\s*:/.test(launch),
    "launch() must hand both console controls to consoleWorkingState():\n" + launch);

  // The preparation has to happen BEFORE the reboot and the typed steps.
  const prepareAt = launch.indexOf("consoleWorkingState(");
  const bootAt = launch.indexOf("boot()");
  assert.ok(bootAt !== -1 && prepareAt < bootAt,
    "the console must be prepared before the machine is rebooted");
  const runAt = launch.indexOf("runSteps(");
  assert.ok(runAt !== -1 && prepareAt < runAt,
    "the console must be prepared before the boot steps are typed");

  console.log("quickboot-console-wiring: OK (launch() prepares the console)");
}

testConsoleWorkingState();
testLaunchWiring();
