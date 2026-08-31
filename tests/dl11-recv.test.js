#!/usr/bin/env node
/**
 * DL11 console terminal receive-path modular tests.
 *
 * Extracts the real dl11() device emulation (plus its insertData() and
 * requestInterrupt() helpers) straight from src/iopage.js and runs it in an
 * isolated VM context (same pattern as tests/paper-geometry.test.js).
 *
 * These tests verify that a ^C (ETX, 0x03) typed on the operator console is
 * delivered to the guest exactly like real DL11 hardware:
 *   - RCSR DONE is set and RBUF holds 0x03 (polling mode);
 *   - when RCSR IE is enabled a receive interrupt at vector 60 is requested,
 *     and iopage.poll()/poll(true) hands it to the CPU;
 *   - reading RBUF clears DONE and lets the next character through.
 *
 * Run with:  node tests/dl11-recv.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "iopage.js");

const RCSR = 0o17777560;
const RBUF = 0o17777562;
const DL_RCSR_DONE = 0x80;
const DL_RCSR_IE = 0x40;
const DL_VECTOR = 0o60;
const DL_PRIORITY = 4 << 5; // 128

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

// Fresh sandbox containing a real dl11() console device (unit 0, vector 60)
// with only the helpers it needs stubbed.
function loadConsole() {
  const src = fs.readFileSync(SOURCE_PATH, "utf8");
  const dl11 = extractBlock(src, "function dl11(vt52Unit, deviceVector)", "");
  const insertData = extractBlock(src, "function insertData", "");
  const requestInterrupt = extractBlock(src, "function requestInterrupt", "");

  const sandbox = {};
  sandbox.CPU = { interruptRequested: 0, runState: 0, PSW: 0, registerVal: [0] };
  sandbox.STATE_WAIT = 3;
  sandbox.trap = function () { return -1; };
  sandbox.window = sandbox; // console exposes window.dlReceiveQueue
  sandbox.document = { getElementById: function () { return null; } };
  sandbox.Config = { get: function () { return null; } };
  sandbox.vt52Initialize = function () { return null; };
  sandbox.vt52Write = function () { return null; };
  sandbox.vt52Get = function () { return null; };
  sandbox.setTimeout = setTimeout;

  vm.createContext(sandbox);
  vm.runInContext(
    insertData + "\n" + requestInterrupt + "\n" + dl11 +
      "\n; this.dev = dl11(0, 0o60);",
    sandbox
  );
  return sandbox;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  // ------------------------------------------------------------------
  // Test 1: polling mode — ^C sets DONE, RBUF holds 0x03, no interrupt.
  // ------------------------------------------------------------------
  const s1 = loadConsole();
  const dev = s1.dev;
  s1.CPU.interruptRequested = 0;
  s1.window.__yapdpBridge.dlReceiveQueue(0, [3]);
  await delay(20);

  let rcsr = dev.access(RCSR, -1, false);
  assert.ok(rcsr & DL_RCSR_DONE, "polling ^C should set RCSR DONE");
  assert.ok(!(rcsr & DL_RCSR_IE), "IE must not be set yet");

  const pending1 = dev.poll(false);
  assert.strictEqual(pending1 & 1, 0, "no interrupt pending without IE");

  const rbuf = dev.access(RBUF, -1, false);
  assert.strictEqual(rbuf, 3, "RBUF should hold the ^C byte 0x03");
  rcsr = dev.access(RCSR, -1, false);
  assert.ok(!(rcsr & DL_RCSR_DONE), "reading RBUF clears DONE");

  // ------------------------------------------------------------------
  // Test 2: interrupt mode — RCSR IE + ^C raises receive vector 60.
  // ------------------------------------------------------------------
  const s2 = loadConsole();
  const dev2 = s2.dev;
  dev2.access(RCSR, DL_RCSR_IE, false); // enable receive interrupts
  s2.CPU.interruptRequested = 0;
  s2.window.__yapdpBridge.dlReceiveQueue(0, [3]);
  await delay(20);

  assert.strictEqual(s2.CPU.interruptRequested, 1, "requestInterrupt must be raised");

  const rcsr2 = dev2.access(RCSR, -1, false);
  assert.ok(rcsr2 & DL_RCSR_DONE, "interrupt-mode ^C sets DONE");

  const pending2 = dev2.poll(false);
  assert.strictEqual(pending2 & 1, 1, "receive interrupt must be pending");
  // Device poll returns priority already in PSW format (bits 5-7 = mask 0xE0).
  assert.strictEqual(pending2 & 0xE0, DL_PRIORITY, "receive priority is 4");

  const vec = dev2.poll(true);
  assert.strictEqual(vec, DL_VECTOR, "receive interrupt uses vector 60");

  // ------------------------------------------------------------------
  // Test 3: typeahead — a second byte is delivered after RBUF is read.
  // ------------------------------------------------------------------
  const s3 = loadConsole();
  const dev3 = s3.dev;
  s3.window.__yapdpBridge.dlReceiveQueue(0, [3, 4]); // ^C then ^D
  await delay(20);
  assert.strictEqual(dev3.access(RBUF, -1, false), 3, "first byte is ^C");
  await delay(20);
  assert.strictEqual(dev3.access(RBUF, -1, false), 4, "second byte is ^D after RBUF read");

  console.log("dl11 receive tests: all passed");
}

try {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
