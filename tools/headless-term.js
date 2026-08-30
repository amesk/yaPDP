#!/usr/bin/env node
/**
 * headless-term.js — interactive RT-11 terminal on the NEW headless stack
 * (no browser, no puppeteer, no iopage.js).
 *
 * The rt11-term functionality, rebuilt on the refactored machine layer:
 * boots a guest OS via bootHeadless(), then gives an operator console —
 * stdin lines go to the guest through the ConsoleDL11 device, guest
 * output streams to stdout, and ":commands" drive the paper tape
 * (:mount/:export/:status) and the session (:quit).
 *
 * Usage:
 *   node tools/headless-term.js [image.zst] [url-name] [boot-cmd]
 *
 * Example:
 *   node tools/headless-term.js                    # rk1.dsk, BOOT RK0
 *   node tools/headless-term.js media/rk0.dsk.zst rk0.dsk "BOOT RK0"
 */
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { bootHeadless } = require("./headless-machine.js");
const { IO_BLOCKSIZE } = require("../src/devices/disk-service.js");

const REPO = path.resolve(__dirname, "..");

function bytes(s) { return Array.from(s).map((c) => c.charCodeAt(0)); }

async function main() {
  const [image, urlName, bootCmd] = process.argv.slice(2);
  const opts = {
    image: image || "media/rk1.dsk.zst",
    urlName: urlName || "rk0.dsk",
    bootCmd: bootCmd ? bootCmd + "\r" : "BOOT RK0\r",
    timeoutMs: 60000,
  };

  // Mount the punch/export target: the machine's disk service is shared,
  // so the paper-tape reader can also read local .ptap files via the same
  // file provider (length = tape size for end-of-tape).
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  // Boot with a streaming output hook: instead of buffering until the
  // prompt, print everything as it arrives.
  let booted = false;
  const boot = await (async () => {
    // bootHeadless buffers `out`; for a live terminal we wrap the console
    // onOutput. Simplest: run bootHeadless as-is (fast boot, ~1.5s), then
    // start the interactive loop; subsequent guest output is captured by
    // wrapping the hook AFTER boot via the returned machine.
    const r = await bootHeadless(opts);
    booted = true;
    process.stdout.write(r.out.replace(/@/, "RT-11 ready.\n@"));
    return r;
  })();

  // Wire live output: install a chained hook on the console device so
  // every character the guest prints after boot streams to stdout.
  const consoleDev = boot.machine.findDevice("console");
  consoleDev.installOutputHook((ch) => {
    process.stdout.write(String.fromCharCode(ch & 0x7f));
  });

  // Rewind / mount helpers.
  const ptr = boot.machine.findDevice("ptr");
  const disk = boot.machine.disk;

  function mountTape(file) {
    const p = path.resolve(REPO, file);
    if (!fs.existsSync(p)) {
      console.error("headless-term: no such tape: " + file);
      return;
    }
    const buf = fs.readFileSync(p);
    disk.mountDrive(path.basename(file), {
      readBlock: async (n) => {
        const start = n * IO_BLOCKSIZE;
        if (start >= buf.length) return new Uint8Array(0);
        return buf.subarray(start, Math.min(start + IO_BLOCKSIZE, buf.length));
      },
      writeBlock: async () => {},
      length: buf.length,
    });
    if (ptr) ptr.loadTape(path.basename(file));
    console.log("headless-term: mounted " + path.basename(file) +
      " (" + buf.length + " bytes)");
  }

  console.log("RT-11 terminal on the headless stack. :help for commands.");

  const prompt = () => { if (rl.terminal) rl.setPrompt(""); rl.prompt(); };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(":")) {
      boot.machine.findDevice("console").receive(bytes(line + "\r"));
      return;
    }
    const [cmd, arg] = [trimmed.slice(1).split(/\s+/)[0], trimmed.slice(1).split(/\s+/).slice(1).join(" ")];
    switch (cmd) {
      case "mount":
        if (!arg) { console.error("usage: :mount <file.ptap>"); break; }
        mountTape(arg);
        break;
      case "export": {
        if (!ptr) { console.error("no paper-tape device"); break; }
        const out = ptr.punchBytes();
        if (!arg) { console.error("usage: :export <file.ptap>"); break; }
        fs.writeFileSync(path.resolve(REPO, arg), Buffer.from(out));
        console.log("headless-term: exported " + out.length + " bytes -> " + arg);
        ptr.clearPunch();
        break;
      }
      case "status":
        console.log("tape: " + (ptr && ptr.ptControlblock ? ptr.ptControlblock.url : "none") +
          " | punch buffer: " + (ptr ? ptr.punchBytes().length : 0) + " bytes");
        break;
      case "quit":
      case "exit":
        rl.close();
        boot.halt();
        process.exit(0);
        break;
      case "help":
        console.log("  lines         -> guest console");
        console.log("  :mount <file>  load a paper tape into the reader");
        console.log("  :export <file> save the punched output and clear it");
        console.log("  :status        show tape + punch state");
        console.log("  :quit          shut down");
        break;
      default:
        console.error("unknown command: :" + cmd + " (:help)");
    }
    prompt();
  });

  rl.on("close", () => { boot.halt(); process.exit(0); });
  prompt();
}

main().catch((e) => {
  console.error("headless-term error:", e.message);
  process.exit(1);
});
