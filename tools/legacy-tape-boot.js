#!/usr/bin/env node
/**
 * legacy-tape-boot.js — boot a magtape through the LEGACY iopage stack
 * (?core=0) in pure Node, without Chromium (the e2e suites need a browser).
 *
 * tools/headless-boot.js loads the real sources (pdp11-panel, bootcode,
 * pdp11, fpp, dataloader, diskstore, iopage) into a VM sandbox with DOM
 * stubs, so a tape mounted into DataLoader drives iopage.js's TM11 ->
 * diskIO -> fetchBlock path exactly like the browser does — the path the
 * "read past the end of a mounted image" fix touches (#62).
 *
 * Usage:
 *   node tools/legacy-tape-boot.js [image.tap|.zst] [url.tap] [BOOT CMD] [marker]
 *   node tools/legacy-tape-boot.js media/tm0.tap.zst tm0.tap "BOOT TM0" ROLLIN
 */
"use strict";
const fs = require("fs");
const zlib = require("zlib");
const { bootRT11 } = require("./headless-boot.js");

const IMAGE = process.argv[2] || "media/tm0.tap.zst";
const URL = process.argv[3] || "tm0.tap";
const BOOT = process.argv[4] || "BOOT TM0";
const MARKER = process.argv[5] || "ROLLIN";

function readImage(file) {
  const bytes = fs.readFileSync(file);
  if (file.endsWith(".zst")) {
    return new Uint8Array(zlib.zstdDecompressSync(bytes));
  }
  return new Uint8Array(bytes);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  // bootRT11 always types a boot command itself; a blank one just gets the
  // bootloader prompt out of the way (bootCmd = " " is truthy, so the
  // default "BOOT RK1" is not substituted). waitFor "@" matches the bare
  // prompt line that is already on screen, so this returns at once and the
  // machine keeps running under our control.
  const r = await bootRT11({ bootCmd: " \r", waitFor: "@", timeoutMs: 60000 });
  try {
    const raw = readImage(IMAGE);
    // Mount the tape where iopage.js looks for it (DataLoader by logical url).
    // Called from the host so the bytes are not serialised into the VM.
    r.sandbox.DataLoader.mount(URL, raw);
    console.log("[legacy] mounted " + URL + " (" + raw.length + " bytes) on ?core=0 stack");

    const before = r.getOut().length;
    const bridge = r.sandbox.window.__yapdpBridge;
    const inject = (bridge && bridge.dlReceiveQueue) || r.sandbox.window.dlReceiveQueue;
    const type = (text) => inject(0, Array.from(text + "\r").map((c) => c.charCodeAt(0) & 0x7f));

    // The bootloader prompt is printed character by character; typing too
    // early loses the first character and the command is rejected. Retry a
    // few times instead of racing the console.
    let seen = false;
    let t0 = 0;
    for (let attempt = 0; attempt < 3 && !seen; attempt++) {
      await sleep(attempt === 0 ? 800 : 1200);
      const from = r.getOut().length;
      type(BOOT);
      t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (r.getOut().slice(from).includes(MARKER)) { seen = true; break; }
        await sleep(100);
      }
    }
    const tail = r.getOut().slice(before);
    console.log("--- console (legacy iopage) ---\n" + tail);
    if (!seen) {
      console.error("FAIL: marker '" + MARKER + "' never appeared");
      process.exit(2);
    }
    console.log("OK: legacy stack reached '" + MARKER + "' in " + (Date.now() - t0) + "ms");
  } finally {
    r.halt();
  }
}

run().then(() => process.exit(0)).catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
