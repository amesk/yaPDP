#!/usr/bin/env node
/**
 * yaPDP — StateEnvelope unit tests.
 *
 * Tests the text envelope format for sharing .state.zst via GitHub Gist.
 * Runs in Node without a browser.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { StateEnvelope } = require(path.join(__dirname, "..", "src", "state-envelope.js"));

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log("  ok  " + name);
    } else {
        failures++;
        console.error("  FAIL " + name + (detail ? " — " + detail : ""));
    }
}

// --- 1. Encode/decode round-trip with a small buffer ----------------------
(function testRoundTrip() {
    console.log("\n=== 1. Encode/decode round-trip ===");

    var input = new Uint8Array([0x59, 0x41, 0x50, 0x44, 0x50, 0x53, 0x54, 0x41]); // "YAPDPSTA"
    var encoded = StateEnvelope.encode(input);
    check("1a: encoded is a string", typeof encoded === "string");
    check("1b: encoded starts with marker", encoded.startsWith(StateEnvelope.MARKER + "\n"));

    var decoded = StateEnvelope.decode(encoded);
    check("1c: decoded is Uint8Array", decoded instanceof Uint8Array);
    check("1d: decoded length matches", decoded.length === input.length);
    var match = true;
    for (var i = 0; i < input.length; i++) {
        if (decoded[i] !== input[i]) { match = false; break; }
    }
    check("1e: decoded content matches", match);
})();

// --- 2. Encode/decode with a real .state.zst file -------------------------
(function testRealFile() {
    console.log("\n=== 2. Real .state.zst round-trip ===");

    var statePath = path.join(__dirname, "..", "states", "rk1-ready.state.zst");
    if (!fs.existsSync(statePath)) {
        console.log("  SKIP: no rk1-ready.state.zst found");
        return;
    }

    var original = fs.readFileSync(statePath);
    var input = new Uint8Array(original);
    var encoded = StateEnvelope.encode(input);
    check("2a: encoded is a string", typeof encoded === "string");
    check("2b: encoded has marker", encoded.startsWith(StateEnvelope.MARKER + "\n"));
    check("2c: encoded has base64 content", encoded.length > StateEnvelope.MARKER.length + 2);

    var decoded = StateEnvelope.decode(encoded);
    check("2d: decoded is Uint8Array", decoded instanceof Uint8Array);
    check("2e: decoded length matches original", decoded.length === original.length);

    var match = true;
    for (var i = 0; i < original.length; i++) {
        if (decoded[i] !== original[i]) { match = false; break; }
    }
    check("2f: decoded content matches original", match);
})();

// --- 3. isEnvelope --------------------------------------------------------
(function testIsEnvelope() {
    console.log("\n=== 3. isEnvelope ===");

    check("3a: valid envelope returns true",
        StateEnvelope.isEnvelope(StateEnvelope.MARKER + "\nAA==") === true);
    check("3b: plain text returns false",
        StateEnvelope.isEnvelope("hello world") === false);
    check("3c: marker without newline returns false",
        StateEnvelope.isEnvelope(StateEnvelope.MARKER) === false);
    check("3d: empty string returns false",
        StateEnvelope.isEnvelope("") === false);
    check("3e: number returns false",
        StateEnvelope.isEnvelope(42) === false);
})();

// --- 4. decode invalid input ----------------------------------------------
(function testDecodeInvalid() {
    console.log("\n=== 4. Decode invalid input ===");

    check("4a: decode plain text returns null",
        StateEnvelope.decode("hello world") === null);
    check("4b: decode empty string returns null",
        StateEnvelope.decode("") === null);
    check("4c: decode marker-only returns null",
        StateEnvelope.decode(StateEnvelope.MARKER + "\n") === null);
    check("4d: decode invalid base64 returns null",
        StateEnvelope.decode(StateEnvelope.MARKER + "\n!!!invalid!!!") === null);
})();

// --- 5. Line wrapping -----------------------------------------------------
(function testLineWrapping() {
    console.log("\n=== 5. Line wrapping ===");

    // Create a buffer large enough to span multiple lines (76-char wrap).
    var size = 200;
    var input = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
        input[i] = i & 0xff;
    }
    var encoded = StateEnvelope.encode(input);
    var lines = encoded.split("\n");
    check("5a: first line is marker", lines[0] === StateEnvelope.MARKER);
    // Each data line should be at most 76 characters.
    var allWrapped = true;
    for (var j = 1; j < lines.length; j++) {
        if (lines[j].length > 76) { allWrapped = false; break; }
    }
    check("5b: all data lines are <= 76 chars", allWrapped);

    var decoded = StateEnvelope.decode(encoded);
    check("5c: round-trip matches", decoded !== null && decoded.length === input.length);
})();

// --- 6. Large buffer (1 MB) -----------------------------------------------
(function testLargeBuffer() {
    console.log("\n=== 6. Large buffer (1 MB) ===");

    var size = 1024 * 1024; // 1 MB
    var input = new Uint8Array(size);
    // Fill with a pattern.
    for (var i = 0; i < size; i++) {
        input[i] = (i * 7 + 13) & 0xff;
    }
    var encoded = StateEnvelope.encode(input);
    check("6a: encoded is a string", typeof encoded === "string");
    check("6b: encoded has reasonable length",
        encoded.length > size * 1.3 && encoded.length < size * 1.5);

    var decoded = StateEnvelope.decode(encoded);
    check("6c: decoded is Uint8Array", decoded instanceof Uint8Array);
    check("6d: decoded length matches", decoded.length === size);

    // Spot-check a few positions.
    var ok = true;
    for (var i = 0; i < size; i += 100003) {
        if (decoded[i] !== input[i]) { ok = false; break; }
    }
    check("6e: spot-check passes", ok);
})();

// --- Main ----------------------------------------------------------------
console.log("\nStateEnvelope tests:");
if (failures) {
    console.error("\n" + failures + " test(s) failed");
    process.exit(1);
}
console.log("\nAll tests passed");
process.exit(0);