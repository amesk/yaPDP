#!/usr/bin/env node
/**
 * G60Printer flushCharBuffer() modular tests.
 *
 * Extracts the pure flushCharBuffer() helper straight from the real source
 * (src/g60printer.js) so the test exercises the production formula rather
 * than a copy, then runs it in an isolated VM context (same pattern as
 * tests/paper-geometry.test.js).
 *
 * flushCharBuffer() is the engine behind the public G60Printer.flush() API,
 * which is called on machine reboot / front-panel HALT / console ^C so a
 * runaway program's teletype output backlog stops printing immediately.
 *
 * Run with:  node tests/g60printer-flush.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "g60printer.js");

// ------------------------------------------------------------------
// Minimal brace-balancing extractor for a single top-level function.
// ------------------------------------------------------------------
function extractBlock(src, startMarker, tail) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error("marker not found: " + startMarker);
  }
  const braceOpen = src.indexOf("{", start);
  if (braceOpen === -1) {
    throw new Error("no opening brace for: " + startMarker);
  }
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

// Load a fresh sandboxed copy of flushCharBuffer() with its two closure
// dependencies (charBuffer, charPrintTimer) exposed as context globals, so the
// extracted production function operates on them exactly as in G60Printer.
function loadFlush() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const flush = extractBlock(src, "function flushCharBuffer", "");
  const sandbox = { clearTimeout: function () { /* no-op stub */ } };
  sandbox.charBuffer = [];
  sandbox.charPrintTimer = null;
  vm.createContext(sandbox);
  vm.runInContext(flush + "\n; this.flush = flushCharBuffer;", sandbox);
  return sandbox;
}

function run() {
  // 1. A pending backlog with an active pacing timer is fully discarded.
  const s1 = loadFlush();
  s1.charBuffer = ["H", "E", "L", "L", "O"];
  s1.charPrintTimer = 123; // arbitrary timer id
  s1.flush();
  assert.strictEqual(s1.charBuffer.length, 0, "backlog should be emptied");
  assert.strictEqual(s1.charPrintTimer, null, "pacing timer should be cleared");

  // 2. A large runaway backlog (the infinite PRINT "HELLO" case) is emptied.
  const s2 = loadFlush();
  s2.charBuffer = new Array(100000).fill("X");
  s2.charPrintTimer = 7;
  s2.flush();
  assert.strictEqual(s2.charBuffer.length, 0, "runaway backlog should be emptied");

  // 3. Flushing an already-empty buffer (no timer) is a safe no-op.
  const s3 = loadFlush();
  s3.charBuffer = [];
  s3.charPrintTimer = null;
  s3.flush();
  assert.strictEqual(s3.charBuffer.length, 0, "empty buffer stays empty");

  // 4. A real setTimeout id is cleared when one is pending.
  const s4 = loadFlush();
  let cleared = false;
  s4.clearTimeout = function () { cleared = true; };
  s4.charBuffer = ["A"];
  s4.charPrintTimer = 42;
  s4.flush();
  assert.strictEqual(cleared, true, "pending timer must be cancelled");
  assert.strictEqual(s4.charPrintTimer, null, "timer reference reset to null");

  console.log("g60printer flush tests: all passed");
}

try {
  run();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
