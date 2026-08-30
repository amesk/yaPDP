#!/usr/bin/env node
/**
 * headless-machine.js — boot a guest OS on the NEW headless stack
 * (refactor stages 0-3), WITHOUT iopage.js.
 *
 * The machine is assembled from the core base classes + devices:
 *
 *   Machine (core/machine.js)
 *     ├─ Bus        (core/bus.js)          — I/O page (register/access/poll)
 *     ├─ ConsoleDL11 (devices/dl11.js)      — console at 17777560, vec 060
 *     ├─ Rk11        (devices/rk11.js)      — disk controller at 17777400
 *     └─ DiskService (devices/disk-service.js)
 *          └─ mountDrive("rk0.dsk", { readBlock, writeBlock }) — FILE provider
 *
 * The real CPU (src/pdp11.js) is loaded into a VM sandbox exactly like
 * headless-boot.js, but instead of iopage.js the sandbox gets a thin
 * `iopage` ADAPTER delegating to our Bus:
 *
 *   sandbox.iopage = {
 *       access, poll, reset, register,        → machine.bus
 *       scheduleCallback, processPendingCallbacks → shared pending queue
 *   }
 *
 * The CPU loop (pdp11Processor) calls iopage.processPendingCallbacks()
 * and iopage.poll() every instruction batch, so disk completions and
 * device interrupts run in CPU context — same contract as iopage.js.
 *
 * CLI usage:  node tools/headless-machine.js [image.zst] [url-name] [boot-cmd] [prompt]
 * Programmatic: const { bootHeadless } = require("./headless-machine.js");
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { Machine } = require("../src/core/machine.js");
const { NodeIO } = require("../src/core/io.js");
const { ConsoleDL11 } = require("../src/devices/dl11.js");
const { Rk11 } = require("../src/devices/rk11.js");
const { CpuRegs } = require("../src/devices/cpu-regs.js");
const { PtrPtp } = require("../src/devices/ptr11.js");
const { Kw11 } = require("../src/devices/kw11.js");
const { IO_BLOCKSIZE } = require("../src/devices/disk-service.js");

const REPO = path.resolve(__dirname, "..");

// ----------------------------------------------------------------------
// Minimal DOM/UI stubs — only what pdp11-panel.js / pdp11.js touch at
// module top-level (same set as headless-boot.js).
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * mapUnibus — 1:1 copy of the iopage.js helper. The CPU object is passed
 * in (const declarations in a vm context are not sandbox properties, so
 * sb.CPU would be undefined).
 */
function mapUnibus(CPU, ba) {
  const IOBASE_22BIT = 0o17760000;
  let index = (ba >>> 13) & 0x1f;
  if (index < 31) {
    if (CPU.MMR3 & 0x20) {
      ba = (CPU.unibusMap[index] + (ba & 0x1fff)) & 0x3fffff;
    }
  } else {
    ba |= IOBASE_22BIT;
  }
  return ba;
}

/**
 * bootHeadless — boot a guest OS on the new headless stack.
 *
 * @param {object} opts
 *   image     path to the (optionally .zst) image, default media/rk1.dsk.zst
 *   urlName   logical disk url, default rk0.dsk (RK11 drive 0)
 *   bootCmd   command typed at the bootloader prompt, default "BOOT RK0\r"
 *   waitFor   prompt marker regexp, default "."
 *   timeoutMs overall budget, default 90000
 * @returns {Promise<{out, stats, halt, evalIn}>}
 */
async function bootHeadless(opts = {}) {
  const image = opts.image || "media/rk1.dsk.zst";
  const urlName = opts.urlName || "rk0.dsk";
  const bootCmd = opts.bootCmd || "BOOT RK0\r";
  const waitFor = opts.waitFor || ".";
  const timeoutMs = opts.timeoutMs || 90000;

  const sb = buildSandbox();

  // CPU + panel + bootcode + FPU (everything except iopage.js).
  load(sb, "assets/vendor/fzstd.js");
  load(sb, "src/pdp11-panel.js");
  load(sb, "src/bootcode.js");
  load(sb, "src/pdp11.js");
  load(sb, "src/fpp.js");

  // const/let declarations in a vm context are not sandbox properties;
  // reach the CPU object through runInContext instead.
  const CPU = vm.runInContext("CPU", sb);
  const pendingCallbacks = [];

  // --- Host glue: CPU-side services for Bus / devices / DiskService ---
  const host = {
    cpu: CPU,
    get psw() { return CPU.PSW; },
    get pir() { return CPU.PIR; },
    priorityMask: 0o340,
    pswAddress: 0o17777776,
    maxMemory: vm.runInContext("MAX_MEMORY", sb),
    readPSW: () => sb.readPSW(),
    writePSW: (v) => sb.writePSW(v),
    trap: (v, e) => {
      if (process.env.DEBUG_TRAP) {
        console.log("TRAP vector=" + v.toString(8) + " code=" + e.toString(8) +
          " pc=" + (typeof CPU !== "undefined" && CPU.registerVal ? CPU.registerVal[7].toString(8) : "?"));
      }
      return (typeof sb.trap === "function" ? sb.trap(v, e) : -1);
    },
    // Memory access for disk DMA (mapUnibus + physical access; I/O
    // addresses route through iopage.access → our bus adapter).
    busReadWord: (ba) => sb.readWordByPhysical(mapUnibus(CPU, ba)),
    busWriteWord: (ba, data) => sb.writeWordByPhysical(mapUnibus(CPU, ba), data & 0xFFFF),
    writeByteByPhysical: (a, d) => sb.writeByteByPhysical(a, d),
    mapUnibus: (ba) => mapUnibus(CPU, ba),
    // Callback scheduling: same queue the sandbox iopage adapter drains
    // from the CPU loop (processPendingCallbacks), so disk completions
    // run in CPU context.
    scheduleCallback: (fn, ...args) => pendingCallbacks.push({ fn, args }),
  };

  const machine = new Machine({}, host, new NodeIO({}));
  const io = machine.io;

  // --- Console DL11: output collector + bridge hook ---
  let out = "";
  const prevHook = sb.window.__consoleOutputHook;
  const consoleDev = new ConsoleDL11(machine, "console", {
    unit: 0,
    vector: 0o60,
    regions: [{ address: 0o17777560, count: 4 }],
    onOutput: (ch) => {
      out += String.fromCharCode(ch & 0x7f);
    },
  });
  machine.addDevice(consoleDev);
  consoleDev.install();
  // The bridge contract: window.dlReceiveQueue feeds the console device,
  // window.__consoleOutputHook chains to the previous hook (if any).
  sb.window.dlReceiveQueue = (unit, byteArray) => consoleDev.receive(byteArray);
  consoleDev.installOutputHook((ch) => {
    if (typeof prevHook === "function") prevHook(ch);
  });

  // --- RK11 with a FILE provider (the "get the bytes" layer in Node) ---
  const rk = new Rk11(machine, "rk0", {
    regions: [{ address: 0o17777400, count: 8 }],
  });
  machine.addDevice(rk);
  rk.install();

  // --- Core CPU registers (PIR/PSW/stack limit, 11/70 size regs) ---
  const cpuRegs = new CpuRegs(machine, "cpu-regs", {
    cpuType: 70,
    regions: [
      { address: 0o17777770, count: 4 },
      { address: 0o17777760, count: 4 },
    ],
  });
  machine.addDevice(cpuRegs);
  cpuRegs.install();

  // --- KW11-P line clock (50 Hz) — the boot ROM WAITs on its tickle ---
  const kw = new Kw11(machine, "kw11", {
    regions: [{ address: 0o17777546, count: 4 }],
  });
  machine.addDevice(kw);
  kw.install();

  // --- PTR11/PTP11 paper tape (reader vector 070, punch 074) ---
  const ptr = new PtrPtp(machine, "ptr", {
    regions: [{ address: 0o17777550, count: 4 }],
  });
  machine.addDevice(ptr);
  ptr.install();

  const zst = fs.readFileSync(path.join(REPO, image));
  const raw = sb.fzstd.decompress(new Uint8Array(zst));
  machine.mountDrive(urlName, {
    readBlock: async (n) => {
      const start = n * IO_BLOCKSIZE;
      if (start >= raw.length) return new Uint8Array(0);
      return raw.subarray(start, Math.min(start + IO_BLOCKSIZE, raw.length));
    },
    writeBlock: async () => { /* headless: writes are discarded (read-only boot) */ },
  });

  // --- sandbox iopage adapter: the CPU's only view of the I/O page ---
  sb.iopage = {
    access: (pa, d, b) => machine.bus.access(pa, d, b),
    poll: () => machine.bus.poll(),
    reset: () => machine.bus.reset(),
    register: () => {}, // devices register via their classes
    scheduleCallback: (fn, ...args) => pendingCallbacks.push({ fn, args }),
    processPendingCallbacks: () => {
      while (pendingCallbacks.length) {
        const { fn, args } = pendingCallbacks.shift();
        fn(...args);
      }
    },
  };

  // --- Start: load bootcode, PC=BOOTBASE, run (pdp11.js boot()) ---
  const t0 = Date.now();
  let bootPromptMs = -1;
  let readyMs = -1;
  sb.boot();
  let lastTick = 0;

  while (out.indexOf("@") === -1) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for bootloader prompt\n" + out);
    // Optional diagnostics: sample the CPU while waiting.
    const tickInterval = opts.debugTickInterval || 500;
    if (typeof opts.debugTick === "function" && Date.now() - lastTick > tickInterval) {
      lastTick = Date.now();
      const pc = vm.runInContext("CPU.registerVal[7].toString(8)", sb);
      const rs = vm.runInContext("CPU.runState", sb);
      opts.debugTick({ out, pc, runState: rs, evalIn: (c) => vm.runInContext(c, sb) });
    }
    await sleep(50);
  }
  bootPromptMs = Date.now() - t0;
  sb.window.dlReceiveQueue(0, bytes(bootCmd));

  const re = new RegExp("^" + waitFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s]*$", "m");
  while (!re.test(out)) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for prompt '" + waitFor + "'\n" + out);
    const tickInterval = opts.debugTickInterval || 500;
    if (typeof opts.debugTick === "function" && Date.now() - lastTick > tickInterval) {
      lastTick = Date.now();
      const pc = vm.runInContext("CPU.registerVal[7].toString(8)", sb);
      const rs = vm.runInContext("CPU.runState", sb);
      opts.debugTick({ out, pc, runState: rs, evalIn: (c) => vm.runInContext(c, sb) });
    }
    await sleep(100);
  }
  readyMs = Date.now() - t0;

  return {
    out, stats: { bootPromptMs, readyMs }, getOut: () => out,
    evalIn: (code) => vm.runInContext(code, sb),
    machine,
    halt: () => vm.runInContext("CPU.runState = CPU.STATE_HALT", sb),
  };
}

// ----------------------------------------------------------------------
// CLI entry
// ----------------------------------------------------------------------
if (require.main === module) {
  const [image, urlName, bootCmd, waitFor] = process.argv.slice(2);
  bootHeadless({
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

module.exports = { bootHeadless };
