#!/usr/bin/env node
/**
 * Promo-video shot scenarios tests (structural + pure helpers).
 *
 * The demo-reel generator (tools/record-video.js + tools/assemble-video.js)
 * is driven by plain data: the VIDEO_SHOTS list and the CLIPS reel order.
 * This test pins the new "BASIC-11 from the ASR tape" clip so the setup can
 * neither silently drop out of the capture list nor drift off the integer-only
 * promise:
 *   1. Pure: extracts the BASIC_TAPE_LINES array and the linesToTapeBytes()
 *      helper straight from tools/record-video.js and verifies the program
 *      uses integer-valued math only (no FPP built-ins, no fractional
 *      numbers, and no TAB()/integer %-vars — both rejected by this
 *      BASIC-11 V007A build) and that the tape bytes are CR-terminated (the
 *      DEC BASIC-11 line editor needs CR, a plain LF file would not terminate
 *      lines).
 *   2. Structural: string checks that the basic-tape shot is present in
 *      VIDEO_SHOTS, that the capture feeds the tape through the ASR reader
 *      without animating the keys (raw queue restored), and that the reel
 *      CLIPS list registers basic-tape.webm.
 *
 * Run with:  node tests/video-shots.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const RECORD_PATH = path.join(__dirname, "..", "tools", "record-video.js");
const ASSEMBLE_PATH = path.join(__dirname, "..", "tools", "assemble-video.js");

// ------------------------------------------------------------------
// Minimal brace/bracket-balancing extractors for the pure pieces.
// ------------------------------------------------------------------

// Extract a top-level `const NAME = [ ... ];` array literal and evaluate it.
// The array contains only string literals, so this is safe; the vm context
// never touches the module's requires (puppeteer-stream etc.).
function extractArrayLiteral(src, name) {
  const start = src.indexOf("const " + name + " = [");
  if (start === -1) throw new Error("const array not found: " + name);
  const open = src.indexOf("[", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(open, i + 1);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext("globalThis.__value = " + literal + ";", sandbox);
  return sandbox.__value;
}

// Extract a top-level `function NAME(...) { ... }` (brace-balanced) and run it
// in a fresh vm context; the sandbox ends up with NAME as a callable.
function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error("function not found: " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, i + 1), sandbox);
  return sandbox[name];
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const recordSrc = fs.readFileSync(RECORD_PATH, "utf8");
const assembleSrc = fs.readFileSync(ASSEMBLE_PATH, "utf8");

const BASIC_TAPE_LINES = extractArrayLiteral(recordSrc, "BASIC_TAPE_LINES");
const linesToTapeBytes = extractFunction(recordSrc, "linesToTapeBytes");

// --- 1. Pure: the tape program is integer-only ---------------------------

assert.ok(Array.isArray(BASIC_TAPE_LINES) && BASIC_TAPE_LINES.length > 0,
  "BASIC_TAPE_LINES must be a non-empty array");
assert.strictEqual(BASIC_TAPE_LINES[BASIC_TAPE_LINES.length - 1], "RUN",
  "the tape must end with RUN so the program executes after reading");

const program = BASIC_TAPE_LINES.join("\n");
// FPP built-ins must not appear so the demo never touches the FPU.
const FPP_TOKENS = ["SIN", "COS", "SQR", "EXP", "LOG", "ATN", "ABS", "INT", "RND"];
for (const token of FPP_TOKENS) {
  assert.ok(!new RegExp("\\b" + token + "\\b").test(program),
    "program must not use the FPP built-in " + token);
}
assert.ok(!program.includes("."),
  "program must not contain fractional numbers (integer math only)");
// This BASIC-11 V007A build rejects integer %-variables (I% is an illegal
// name, ERROR 1) and TAB() (ERROR 123) — the tape program must avoid both,
// so integer-valued math is done with real variables + leading-space loops.
assert.ok(!/%/.test(program), "program must not use integer %-variables");
assert.ok(!/\bTAB\b/.test(program), "program must not use TAB()");

// --- 2. Pure: the tape bytes are CR-terminated ---------------------------

const bytes = linesToTapeBytes(BASIC_TAPE_LINES);
assert.ok(Array.isArray(bytes) && bytes.length > 0,
  "linesToTapeBytes must produce a byte array");
assert.ok(!bytes.includes(10),
  "tape must not contain LF bytes (BASIC-11 line input is CR-terminated)");
assert.ok(bytes.includes(13), "tape must contain CR terminators");
assert.strictEqual(bytes[bytes.length - 1], 13, "tape must end with a CR");
// Every source line maps to text + CR, in order.
assert.strictEqual(bytes.length,
  BASIC_TAPE_LINES.join("").length + BASIC_TAPE_LINES.length,
  "bytes = program text + one CR per line");

// --- 3. Structural: the basic-tape shot is wired into the capture ---------

assert.ok(recordSrc.includes('file: "basic-tape.webm"'),
  "VIDEO_SHOTS must contain the basic-tape.webm shot");
assert.ok(recordSrc.includes("tape: BASIC_TAPE_LINES"),
  "the basic-tape shot must feed BASIC_TAPE_LINES through the ASR reader");
assert.ok(recordSrc.includes('readyWhen: "*O"'),
  "the basic-tape shot waits for the BASIC-11 '*O' prompt");
assert.ok(recordSrc.includes('setReaderMode("auto")'),
  "the capture must start the ASR reader in AUTO mode");
assert.ok(recordSrc.includes("loadBytes"),
  "the capture must load the tape into the reader");
assert.ok(recordSrc.includes("__dlReceiveQueueRaw = orig"),
  "installTeletypeKeyFeeder must keep the raw queue reachable");
assert.ok(recordSrc.includes("function disableTeletypeKeyVisuals"),
  "a helper must restore the raw queue so tape bytes do not animate keys");

// --- 3b. Pure: the front-panel RK05 bootstrap words -----------------------

const PANEL_BOOT_WORDS = extractArrayLiteral(recordSrc, "PANEL_BOOT_WORDS");
assert.ok(Array.isArray(PANEL_BOOT_WORDS) && PANEL_BOOT_WORDS.length === 12,
  "PANEL_BOOT_WORDS must be a 12-word array");
// The verified rk1 bootstrap: MOV #177412,R0 / MOV #020000,(R0) / CLR -(R0)
// / MOV #-256,-(R0) / MOV #5,-(R0) / TSTB (R0) / BPL .-2 / CLR PC.
const expectedWords = [
  0o012700, 0o177412, 0o012710, 0o020000, 0o005040, 0o012740,
  0o177400, 0o012740, 0o000005, 0o105710, 0o100376, 0o005007
];
// The literal is evaluated in a fresh vm realm, so its Array prototype differs
// from ours — copy it into a native array before comparing element-by-element.
assert.deepStrictEqual(Array.from(PANEL_BOOT_WORDS), expectedWords,
  "PANEL_BOOT_WORDS must match the verified rk1 bootstrap");
// The word count must stay at -256 (one RK05 block = 512 bytes): reading
// 1024 bytes would overwrite the loader itself at 001000 (byte 512).
assert.ok(expectedWords.includes(0o177400),
  "the bootstrap must use RKWK=-256 (0o177400), not -512");

// --- 3c. Structural: the front-panel shot is wired in ---------------------

assert.ok(recordSrc.includes('file: "rt11-panel-boot.webm"'),
  "VIDEO_SHOTS must contain the rt11-panel-boot.webm shot");
assert.ok(recordSrc.includes("rk1panel"),
  "the shot device key 'rk1panel' must be registered in VIDEO_SHOTS/OS_CFG");
assert.ok(recordSrc.includes("function capturePanelBoot"),
  "a capturePanelBoot function must drive the front-panel toggle-in");
assert.ok(recordSrc.includes("toggleInPanelBootstrap"),
  "capturePanelBoot must toggle in the loader via the panel switches");
assert.ok(recordSrc.includes('data-action="loadAdrs"'),
  "the capture must press LOAD ADRS on the panel");
assert.ok(recordSrc.includes('data-action="deposit"'),
  "the capture must press DEP on the panel");
assert.ok(recordSrc.includes('data-action="start"'),
  "the capture must press START on the panel");
assert.ok(recordSrc.includes('data-action="enableHalt"'),
  "the capture must press ENABLE/HALT on the panel");
assert.ok(recordSrc.includes('consoleType"][value="vt52"'),
  "the capture must select the VT52 console on the CONFIG page");
assert.ok(recordSrc.includes('#panel-sticker-btn'),
  "the capture must press the Help Me! button to show the bootstrap sticker");
assert.ok(recordSrc.lastIndexOf('#panel-sticker-btn') < recordSrc.lastIndexOf('toggleInPanelBootstrap('),
  "the Help Me! sticker must be shown before the bootstrap is toggled in");

// --- 4. Structural: the reel registers the clip ---------------------------

assert.ok(assembleSrc.includes('"basic-tape.webm"'),
  "CLIPS must register the basic-tape.webm clip in the reel");
assert.ok(assembleSrc.includes('"rt11-panel-boot.webm"'),
  "CLIPS must register the rt11-panel-boot.webm clip in the reel");

// --- 5. Structural: individual clips explain what they demonstrate --------

// The standalone MP4 must show a labelled title card (the same slide the
// reel uses) right after the product intro, so the viewer knows what the
// demo shows — not just the intro straight into the clip.
assert.ok(assembleSrc.includes("genSlide(nSlide, clip.title"),
  "exportIndividual must render a labelled title card for the clip");
assert.ok(assembleSrc.includes('"_slide.webm"'),
  "the individual-export pipeline must include the title slide");
assert.ok(assembleSrc.includes("sans: true"),
  "the individual clip card must use the intro's sans-serif subtitle style");
assert.ok(assembleSrc.includes("size: 68"),
  "the individual clip card description must be sized up");
assert.ok(assembleSrc.includes("const CLIP_SLIDE_MS = SLIDE_MS * 3;"),
  "the individual clip description must be held ~3x longer than the reel cards");
assert.ok(assembleSrc.includes("CLIP_SLIDE_MS / 1000"),
  "exportIndividual must use the longer clip title-card duration");
assert.ok(assembleSrc.includes("scanlines: true"),
  "the individual clip card must overlay the CRT scanlines like the intro");
assert.ok(assembleSrc.includes("opts.scanlines ? scanlineVf()"),
  "genSlide must apply scanlineVf() when opts.scanlines is set");

console.log("All video-shot scenario tests passed.");
