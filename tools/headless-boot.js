#!/usr/bin/env node
/**
 * headless-boot.js — boot a guest OS in pure Node (no browser, no puppeteer).
 *
 * Loads the real emulator sources (pdp11-panel.js, bootcode.js, pdp11.js,
 * fpp.js, iopage.js) into a VM sandbox with minimal DOM/UI stubs, mounts a
 * disk image straight from the file system via DataLoader.mount(), issues a
 * boot command through the console receive queue and waits for a prompt
 * marker.
 *
 * This is the first brick of the headless machine layer: the devices run
 * without the DOM. The browser layer (DataLoader fetch, drag & drop,
 * IndexedDB) is replaced here by a direct file mount — exactly the
 * "file provider" side of the mountDisk({readBlock, writeBlock}) interface.
 *
 * CLI usage:
 *   node tools/headless-boot.js [image.zst] [url-name] [boot-command] [prompt]
 *
 *   node tools/headless-boot.js                      # rk1.dsk, BOOT RK1, "."
 *   node tools/headless-boot.js media/rk0.dsk.zst rk0.dsk "boot rk0\nunix\n" "login:"
 *
 * Programmatic usage (used by tests/headless-boot.test.js):
 *   const { bootRT11 } = require("./headless-boot.js");
 *   const { out } = await bootRT11();
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.resolve(__dirname, "..");

// ----------------------------------------------------------------------
// Minimal DOM/UI stubs — only what the module top-level touches
// ----------------------------------------------------------------------
function makeStubs() {
  const noop = () => {};
  const el = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop },
    appendChild: noop, addEventListener: noop, removeEventListener: noop,
    getContext: () => ({ fillRect: noop, drawImage: noop, clearRect: noop,
      measureText: () => ({ width: 0 }), fillText: noop, setTransform: noop,
      scale: noop, save: noop, restore: noop, beginPath: noop, moveTo: noop,
      lineTo: noop, stroke: noop, arc: noop, fill: noop, translate: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
      putImageData: noop, getImageData: () => ({ data: [] }),
      canvas: { width: 0, height: 0 } }),
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0,
    focus: noop, blur: noop, setAttribute: noop, remove: noop,
    value: "", textContent: "", innerHTML: "", checked: false,
    append: noop, removeChild: noop, querySelector: () => null,
    querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0,
    width: 0, height: 0, dataset: {},
  });
  const document = {
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], createElement: el, createElementNS: el,
    addEventListener: noop, removeEventListener: noop,
    body: el(), documentElement: el(), title: "", hidden: false,
  };
  const window = {
    addEventListener: noop, removeEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    navigator: { userAgent: "node-headless", platform: "node" },
    location: { href: "http://localhost:1170/pdp11.html", search: "", protocol: "http:" },
    Audio: function () {}, AudioContext: function () {},
    devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    setInterval, clearInterval, setTimeout, clearTimeout,
    fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    URL: { createObjectURL: () => "blob:headless", revokeObjectURL: noop },
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop }),
    FileReader: function () {}, Blob: function () {},
    CustomEvent: function () {}, Event: function () {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
  };
  window.window = window; window.document = document; window.self = window;
  return { window, document };
}

function buildSandbox() {
  const { window, document } = makeStubs();
  const sandbox = {
    console, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
    Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView, Map, Set,
    WeakMap, Promise, Math, Date, JSON, RegExp, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, Array,
    Object, Symbol, BigInt, Proxy, Reflect, decodeURIComponent,
    encodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    window, document,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function load(sb, relPath) {
  vm.runInContext(fs.readFileSync(path.join(REPO, relPath), "utf8"), sb,
    { filename: relPath });
}

function bytes(s) { return Array.from(s).map((c) => c.charCodeAt(0)); }
function lastLine(s) {
  const i = s.lastIndexOf("\n");
  return i === -1 ? s : s.slice(i + 1);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Boot a guest OS headlessly.
 *
 * @param {object} opts
 *   image     path to the (optionally .zst-compressed) image file, default media/rk1.dsk.zst
 *   urlName   logical URL the machine sees, default rk1.dsk
 *   bootCmd   command typed at the bootloader prompt, default "BOOT RK1\r"
 *   waitFor   prompt marker regexp (string) to wait for, default "."
 *   timeoutMs overall budget, default 90000
 *   indexedDB fake IndexedDB implementation (e.g. an in-memory stub) —
 *             enables the DiskStore write-back path; without it DiskStore
 *             degrades to memory-only, as in production Node contexts
 * @returns {Promise<{out: string, sandbox: object, stats: {bootPromptMs: number, readyMs: number}, getOut: () => string, evalIn: (code: string) => any}>}
 */
async function bootRT11(opts = {}) {
  const image = opts.image || "media/rk1.dsk.zst";
  const urlName = opts.urlName || "rk1.dsk";
  const bootCmd = opts.bootCmd || "BOOT RK1\r";
  const waitFor = opts.waitFor || ".";
  const timeoutMs = opts.timeoutMs || 90000;

  const sb = buildSandbox();
  if (opts.indexedDB) sb.indexedDB = opts.indexedDB;
  load(sb, "assets/vendor/fzstd.js");
  load(sb, "src/pdp11-panel.js");
  load(sb, "src/bootcode.js");
  load(sb, "src/pdp11.js");
  load(sb, "src/fpp.js");
  load(sb, "src/dataloader.js"); // DataLoader moved out of iopage.js (refactor)
  load(sb, "src/iopage.js");

  // Mount the image straight from the file system — no fetch, no UI.
  const zst = fs.readFileSync(path.join(REPO, image));
  const raw = sb.fzstd.decompress(new Uint8Array(zst));
  sb.DataLoader.mount(urlName, raw);

  // Capture console output through the existing hook.
  let out = "";
  const prev = sb.window.__consoleOutputHook;
  sb.window.__consoleOutputHook = function (ch) {
    if (typeof prev === "function") prev(ch);
    out += String.fromCharCode(ch & 0x7f);
  };

  const t0 = Date.now();
  let bootPromptMs = -1;
  let readyMs = -1;

  // Start the machine: load bootcode, PC=BOOTBASE, run.
  sb.boot();

  // The bootloader banner is empty ("@" only); wait for the "@" prompt.
  while (out.indexOf("@") === -1) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for bootloader prompt\n" + out);
    await sleep(50);
  }
  bootPromptMs = Date.now() - t0;
  sb.window.dlReceiveQueue(0, bytes(bootCmd));

  // Wait for the guest prompt marker at line start.
  const re = new RegExp("^" + waitFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s]*$", "m");
  while (!re.test(out)) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for prompt '" + waitFor + "'\n" + out);
    await sleep(100);
  }
  readyMs = Date.now() - t0;

  return {
    out, sandbox: sb, stats: { bootPromptMs, readyMs }, getOut: () => out,
    evalIn: (code) => vm.runInContext(code, sb),
    // Stop the CPU loop (runState = HALT). The pdp11Processor timer keeps
    // firing but stops executing instructions — call this when done with a
    // machine so several emulators don't compete for CPU in one process.
    halt: () => vm.runInContext("CPU.runState = CPU.STATE_HALT", sb),
  };
}

// ----------------------------------------------------------------------
// CLI entry
// ----------------------------------------------------------------------
if (require.main === module) {
  const [image, urlName, bootCmd, waitFor] = process.argv.slice(2);
  bootRT11({
    image: image || undefined,
    urlName: urlName || undefined,
    bootCmd: bootCmd ? bootCmd + "\r" : undefined,
    waitFor: waitFor || undefined,
  }).then(({ out, stats }) => {
    console.log("bootloader @ prompt: " + stats.bootPromptMs + "ms");
    console.log("guest prompt:        " + stats.readyMs + "ms");
    console.log("--- console output ---\n" + out);
    process.exit(0);
  }).catch((e) => {
    console.error("FAIL:", e.message);
    process.exit(1);
  });
}

module.exports = { bootRT11 };
