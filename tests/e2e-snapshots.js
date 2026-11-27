#!/usr/bin/env node
/**
 * yaPDP SnapshotStore end-to-end test (puppeteer + real Chromium).
 *
 * Verifies the full save/restore loop in a real browser:
 *   1. open the emulator page
 *   2. run the machine briefly (boot a real OS image)
 *   3. save a snapshot (CPU + RAM captured, gzip, IndexedDB)
 *   4. mutate CPU state / RAM heavily
 *   5. load the snapshot (pending key + page reload)
 *   6. verify CPU registers and RAM match the saved state
 *
 * Run with: node tests/e2e-snapshots.js  (needs puppeteer, server on :1170)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

// E2E_CORE=1 exercises the refactored machine layer (?core=1).
const URL = "http://localhost:1170/pdp11.html"
    + (process.env.E2E_CORE ? "?core=1" : "");

const ROOT = path.resolve(__dirname, "..");

// --- shared dev server ------------------------------------------------------
// The suite needs a server on :1170 (the page and its media come from it).
// Start our own when nothing serves the port and stop it on the way out;
// reuse one that is already up (the shared server tools/validate.js starts).
const SERVE_URL = "http://localhost:1170/pdp11.html";
function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(SERVE_URL, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
}

async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [
        path.join(ROOT, "tools", "serve.js"), "--port", "1170"
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error("Static server did not start on port 1170");
}

(async () => {
  const server = await ensureServer();
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("[t=" + Date.now() + "] " + (err && err.stack ? err.stack.split("\n").slice(0,14).join(" ~ ") : String(err))));

    // --- 1. Open the emulator ---
    // Enable the LP11 printer in the persisted config BEFORE the page loads:
    // iopage.js registers the device at load time based on __config.printer.
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(window, "__trapTrace", { value: { depth: 0, events: [] }, writable: true, configurable: true });
      } catch (e) {}
      try {
        var k = "yapdp.config.v1";
        var cfg = null;
        try { cfg = JSON.parse(localStorage.getItem(k)); } catch (e) { cfg = null; }
        if (!cfg || typeof cfg !== "object") cfg = {};
        cfg.printer = true;
        cfg.consoleType = "vt52";
        cfg.userTerminals = 1;
        cfg.vt11 = true;
        localStorage.setItem(k, JSON.stringify(cfg));
      } catch (e) { /* ignore */ }
    });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
      { timeout: 30000 }
    );
    console.log("[1] page loaded, SnapshotStore + CPU present, t0=" + Date.now());

    // --- 2. Power on and let the machine run (CPU executes instructions) ---
    await page.evaluate(() => {
      // Force the interactive Boot ROM and power the machine on so the CPU
      // actually executes code (boot() copies the bootstrap into memory and
      // RUNs).
      if (typeof Config !== "undefined" && typeof Config.set === "function") {
        var cfg = Config.get() || {};
        cfg.bootDevice = "interactive@";
        Config.set(cfg);
      }
      if (typeof boot === "function") {
        boot(); // default bootstrap -> STATE_RUN
      } else if (typeof CPU !== "undefined") {
        CPU.runState = 0; // STATE_RUN
      }
    });
    await new Promise((r) => setTimeout(r, 4000));
    const ranState = await page.evaluate(() => ({
      pc: CPU.registerVal[7],
      runState: CPU.runState,
    }));
    console.log(`[2] machine ran: PC=0o${ranState.pc.toString(8)} runState=${ranState.runState}`);

    // --- 3. Save a snapshot ---
    // Punch a visible paper tape ("HI" + CR) so the snapshot carries tape data.
    await page.evaluate(() => {
      if (window.paperTape && window.paperTape.punchChar) {
        window.paperTape.punchChar(0x48); // H
        window.paperTape.punchChar(0x49); // I
        window.paperTape.punchChar(0x0D); // CR
      }
    });
    console.log("[3] punched tape: H I CR");

    // Print two lines on the LP11 paper, then exercise the operator keys:
    // PAPER FEED (line feed) advances one line, TOP OF FORM (form feed)
    // ejects to the next page. The snapshot must carry the printed paper.
    await page.evaluate(() => {
      const lp = window.lp11G60Printer;
      if (lp) {
        // Line 1: "HELLO LP11" then LF via println()
        "HELLO LP11".split("").forEach((ch) => lp.printChar(ch));
        lp.println();
        // Line 2: "SECOND LINE"
        "SECOND LINE".split("").forEach((ch) => lp.printChar(ch));
        lp.println();
        // Operator keys: PAPER FEED (line feed) then TOP OF FORM (form feed)
        if (window.lp11PaperFeed) window.lp11PaperFeed();
        if (window.lp11TopOfForm) window.lp11TopOfForm();
      }
    });
    console.log("[3] LP11 paper: 2 lines + PAPER FEED + TOP OF FORM");
    // Printing is animated (charBuffer + timers): wait until the mechanism
    // drains so the snapshot captures the finished paper.
    await page.waitForFunction(() => {
      const lp = window.lp11G60Printer;
      return !lp || typeof lp.isBusy !== "function" || !lp.isBusy();
    }, { timeout: 15000 });
    console.log("[3] LP11 idle (paper printed)");
    // Operator key: take the printer OFF LINE. The snapshot must carry the
    // OFF LINE state and the panel LED/key must reflect it after reload.
    await page.evaluate(() => {
      if (window.lp11OnLine) window.lp11OnLine();
    });
    await page.waitForFunction(() => {
      const led = document.getElementById("lp11-online-led");
      return led && led.classList.contains("off");
    }, { timeout: 5000 });
    console.log("[3] LP11 taken OFF LINE");

    // Model 33 ASR state: preserve an armed punch head, an X-OFF-paused
    // AUTO reader, and a substantial pending character queue across the
    // same IndexedDB save/reload path exercised below.
    await page.evaluate(() => {
      window.paperTape.clear();
      window.paperTape.punchChar(0x41); // A
      window.paperTape.punchChar(0x42); // B
      window.paperTape.backspace();     // BSP: B is inside the punch mechanism
      window.tapeReader.loadBytes(new Uint8Array([0x31, 0x32, 0x33, 0x34]));
      window.setReaderMode("start");
      // Keep the print queue pending long enough for SnapshotStore.save()
      // to capture it; the restored queue must continue printing afterwards.
      for (var i = 0; i < 300; i++) window.g60printer.printChar("R");
    });
    // Give START enough time to advance the reader to a non-zero position,
    // then park it in AUTO with DC3 latched before capturing the snapshot.
    await page.waitForFunction(() => window.tapeReader.snapshot().pos >= 2,
      { timeout: 5000 });
    await page.evaluate(() => {
      window.setReaderMode("stop");
      window.setTtyReaderXoffPaused(true);
      window.setReaderMode("auto");
      window.setTtyPunchState({ enabled: false, relHeld: false });
    });
    await page.waitForFunction(() => {
      const r = window.tapeReader.snapshot();
      return r && r.mode === "auto" && r.xoffPaused === true && r.pos >= 2;
    }, { timeout: 5000 });
    console.log("[3] Model 33 ASR prepared: punch BSP, AUTO/X-OFF reader, pending print queue");

    // VT52 console (unit 0): print a couple of lines via the terminal so the
    // screen buffer (and hardcopy scrollback) carry content. ESC [2J clears,
    // then two lines with a cursor move in between.
    await page.evaluate(() => {
      const term = window.vt52Get ? window.vt52Get(0) : null;
      if (term) {
        // Clear screen + home (VT52: ESC H)
        window.vt52Write(0, "\x1bH");
        window.vt52Write(0, "VT52 LINE ONE\r\n");
        window.vt52Write(0, "VT52 LINE TWO");
      }
    });
    console.log("[3] VT52 console: 2 lines written");
    await page.evaluate(async () => {
      const base = 0o2000;
      const saved = [
        CPU.memory[base / 2],
        CPU.memory[base / 2 + 1],
        CPU.memory[base / 2 + 2]
      ];
      CPU.memory[base / 2] = 0x1000 | 0x4000 | 800;
      CPU.memory[base / 2 + 1] = 500;
      CPU.memory[base / 2 + 2] = 0xF000 | 0x404;
      iopage.access(0o17772000, base, false);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      CPU.memory[base / 2] = saved[0];
      CPU.memory[base / 2 + 1] = saved[1];
      CPU.memory[base / 2 + 2] = saved[2];
      window.__vt11SavedWords = saved;
    });
    console.log("[3] VT11 display program started");

    // VT11 vector display: build a tiny display program in RAM (a vector
    // from (100,100) to (900,600), intensify bit set) and start it by
    // writing the DPC register. The processor loop runs in-page and draws
    // onto the CRT canvas, which the snapshot must capture.

    const savedSnapshot = await page.evaluate(async () => {
      const snap = await SnapshotStore.save("e2e test");
      return {
        id: snap.id,
        teletypeQueueLength: snap.teletypepaper &&
          Array.isArray(snap.teletypepaper.charBuffer)
          ? snap.teletypepaper.charBuffer.length : -1
      };
    });
    const snapId = savedSnapshot.id;
    console.log(`[3] snapshot saved: ${snapId}; Model 33 queued chars=${savedSnapshot.teletypeQueueLength}`);
    if (savedSnapshot.teletypeQueueLength <= 0) {
      throw new Error("SnapshotStore.save did not capture the pending Model 33 character queue");
    }

    const before = await page.evaluate(() => ({
      pc: CPU.registerVal[7],
      sp: CPU.registerVal[6],
      ps: CPU.PSW,
      mem100: CPU.memory[100],
      mem1000: CPU.memory[1000],
      memSize: CPU.memory.length,
      devices: iopage.snapshotDevices(),
      punchtape: (window.paperTape && window.paperTape.snapshot) ? window.paperTape.snapshot() : null,
      readertape: (window.tapeReader && window.tapeReader.snapshot) ? window.tapeReader.snapshot() : null,
      asrPunch: window.getTtyPunchState(),
      teletype: (window.g60printer && window.g60printer.snapshot) ? window.g60printer.snapshot() : null,
      lp11: (window.lp11G60Printer && window.lp11G60Printer.snapshot) ? window.lp11G60Printer.snapshot() : null,
      onlineLedOff: (() => { const led = document.getElementById("lp11-online-led"); return led ? led.classList.contains("off") : null; })(),
      vt52: (window.vt52SnapshotAll && window.vt52SnapshotAll()) || null,
      vt11: (window.iopage && window.iopage.snapshotDevices) ? (window.iopage.snapshotDevices()["17772000"] || null) : null,
    }));
    console.log(
      `[3] captured: PC=0o${before.pc.toString(8)} SP=0o${before.sp.toString(8)} ` +
      `PSW=${before.ps} mem[100]=0x${before.mem100.toString(16)} mem[1000]=0x${before.mem1000.toString(16)}`
    );

    // --- 4. Mutate state heavily ---
    await page.evaluate(() => {
      CPU.registerVal[7] = 0x7777;
      CPU.registerVal[6] = 0x6666;
      CPU.PSW = 0x1f;
      for (let i = 0; i < 500; i++) CPU.memory[i] = 0xDEAD;
      // Mutate device registers: RK11 CSR, DL11 RCSR, TM11 MTS
      iopage.restoreDevices({
        "17777400": { rkcs: 0x9999, rker: 0, rkds: 0, rkwc: 0, rkba: 0, rkda: 0, iMask: 0 },
        "17777560": { rcsr: 0x7777, rbuf: 0, xcsr: 0, xbuf: 0, xdelay: 0, iMask: 0, typeAhead: [], receiverBusy: false, pasteCR: true }
      });
      window.__mutateMmu = { en: CPU.mmuEnable, mmr0: CPU.MMR0, mmr3: CPU.MMR3, pc: CPU.registerVal[7], runState: CPU.runState };
    });
    await page.evaluate(() => {
      if (window.paperTape && window.paperTape.clear) window.paperTape.clear();
      window.setTtyPunchState({ enabled: false, relHeld: true });
    });
    const mmuAtMutate = await page.evaluate(() => window.__mutateMmu || null);
    console.log("[4] machine state mutated (PC=0x7777, mem 0xDEAD, RK11 CSR=0x9999, tape cleared) t=" + Date.now() +
      " mmuEnable=" + (mmuAtMutate ? mmuAtMutate.en : "?") + " MMR0=" + (mmuAtMutate ? mmuAtMutate.mmr0.toString(8) : "?") +
      " MMR3=" + (mmuAtMutate ? mmuAtMutate.mmr3.toString(8) : "?") + " pcBefore=" + (mmuAtMutate ? mmuAtMutate.pc.toString(8) : "?") +
      " runState=" + (mmuAtMutate ? mmuAtMutate.runState : "?"));

    // --- 5. Load: pending key + reload ---
    await page.evaluate((id) => SnapshotStore.load(id), snapId);
    // load() calls location.reload(); wait for the fresh page
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
      { timeout: 30000 }
    );
    // init() runs on DOMContentLoaded of the new page; give it a moment
    await new Promise((r) => setTimeout(r, 1500));
    console.log("[5] page reloaded, pending snapshot applied, t=" + Date.now());

    // --- 6. Verify restored state ---
    const after = await page.evaluate(() => ({
      pc: CPU.registerVal[7],
      sp: CPU.registerVal[6],
      ps: CPU.PSW,
      mem100: CPU.memory[100],
      mem1000: CPU.memory[1000],
      memSize: CPU.memory.length,
      devices: iopage.snapshotDevices(),
      punchtape: (window.paperTape && window.paperTape.snapshot) ? window.paperTape.snapshot() : null,
      readertape: (window.tapeReader && window.tapeReader.snapshot) ? window.tapeReader.snapshot() : null,
      asrPunch: window.getTtyPunchState(),
      teletype: (window.g60printer && window.g60printer.snapshot) ? window.g60printer.snapshot() : null,
      lp11: (window.lp11G60Printer && window.lp11G60Printer.snapshot) ? window.lp11G60Printer.snapshot() : null,
      onlineLedOff: (() => { const led = document.getElementById("lp11-online-led"); return led ? led.classList.contains("off") : null; })(),
      vt52: (window.vt52SnapshotAll && window.vt52SnapshotAll()) || null,
      vt11: (window.iopage && window.iopage.snapshotDevices) ? (window.iopage.snapshotDevices()["17772000"] || null) : null,
      tapeRows: (() => {
        const body = document.getElementById("punchtape__body");
        return body ? body.childNodes.length : -1;
      })(),
      punchOnActive: (() => { const b = document.getElementById("punch-on"); return !!b && b.classList.contains("active"); })(),
      punchRelActive: (() => { const b = document.getElementById("punch-rel"); return !!b && b.classList.contains("active"); })(),
      pending: (() => { try { return localStorage.getItem("yapdp-pending-snapshot"); } catch (e) { return "n/a"; } })(),
    }));

    // Rebuild terminal text from the sparse screen buffer ({c,a} cells).
    const vt52ScreenText = (state) => (state.screen || [])
      .map(row => (row || []).map(cell => String.fromCharCode(cell.c)).join(""))
      .join("\n");

    const checks = [
      ["PC", after.pc, before.pc],
      ["SP", after.sp, before.sp],
      ["PSW", after.ps, before.ps],
      ["mem[100]", after.mem100, before.mem100],
      ["mem[1000]", after.mem1000, before.mem1000],
      ["mem size", after.memSize, before.memSize],
      ["RK11 rkcs", after.devices["17777400"] && after.devices["17777400"].rkcs,
                     before.devices["17777400"] && before.devices["17777400"].rkcs],
      ["DL11 rcsr", after.devices["17777560"] && after.devices["17777560"].rcsr,
                     before.devices["17777560"] && before.devices["17777560"].rcsr],
      ["TM11 mts", after.devices["17772520"] && after.devices["17772520"].mts,
                   before.devices["17772520"] && before.devices["17772520"].mts],
      ["punch armedDepth", after.punchtape && after.punchtape.armedDepth,
                           before.punchtape && before.punchtape.armedDepth],
      ["reader tape bytes", after.readertape && after.readertape.bytes.join(","),
                             before.readertape && before.readertape.bytes.join(",")],
      ["reader position", after.readertape && after.readertape.pos,
                           before.readertape && before.readertape.pos],
      ["reader AUTO mode", after.readertape && after.readertape.mode,
                            "auto"],
      ["reader X-OFF latch", after.readertape && after.readertape.xoffPaused,
                              true],
      ["ASR punch enabled state", after.asrPunch && after.asrPunch.enabled,
                                  before.asrPunch && before.asrPunch.enabled],
      ["ASR REL latch state", after.asrPunch && after.asrPunch.relHeld,
                              before.asrPunch && before.asrPunch.relHeld],
      ["ASR ON button artwork", after.punchOnActive, true],
      ["ASR REL button artwork", after.punchRelActive, false],
      ["teletype pending queue restored", after.teletype && after.teletype.charBuffer.length > 0,
                                          true],
      ["teletype queue retains pending R characters",
          after.teletype && after.teletype.charBuffer.every(ch => ch === "R"),
          true],
      ["punchtape bytes", after.punchtape && after.punchtape.buffer.length,
                          before.punchtape && before.punchtape.buffer.length],
      ["tape DOM rows", after.tapeRows, (before.punchtape && before.punchtape.buffer) ? before.punchtape.buffer.length - before.punchtape.armedDepth : -1],
      ["LP11 rows", after.lp11 ? after.lp11.rows.length : -1,
                    before.lp11 ? before.lp11.rows.length : -1],
      ["LP11 has text", after.lp11 && after.lp11.rows.some(r => r.text && r.text.indexOf("HELLO") !== -1),
                        before.lp11 && before.lp11.rows.some(r => r.text && r.text.indexOf("HELLO") !== -1)],
      ["LP11 pagePos", after.lp11 ? after.lp11.pagePos : -1,
                       before.lp11 ? before.lp11.pagePos : -1],
      ["LP11 ONLINE led off", after.onlineLedOff, before.onlineLedOff],
      ["VT52 units", after.vt52 ? after.vt52.length : -1,
                     before.vt52 ? before.vt52.length : -1],
      ["VT52 has LINE ONE", (after.vt52 || []).some(e => vt52ScreenText(e.state).indexOf("VT52 LINE ONE") !== -1),
                            (before.vt52 || []).some(e => vt52ScreenText(e.state).indexOf("VT52 LINE ONE") !== -1)],
      ["VT52 cursor", after.vt52 && after.vt52[0] ? after.vt52[0].state.cursorCol : -1,
                      before.vt52 && before.vt52[0] ? before.vt52[0].state.cursorCol : -1],
      ["VT11 image captured", before.vt11 && typeof before.vt11.image === "string" && before.vt11.image.length > 100,
                              true],
      ["VT11 image restored", after.vt11 && typeof after.vt11.image === "string" && after.vt11.image.length > 100,
                              true],
    ];
    let ok = true;
    for (const [name, got, want] of checks) {
      const pass = got === want;
      if (!pass) ok = false;
      console.log(`[6] ${name}: got=${got} want=${want} ${pass ? "OK" : "MISMATCH"}`);
    }
    console.log(`[6] pending key cleared: ${after.pending === null ? "OK" : "STILL SET: " + after.pending}`);
    if (after.pending !== null) ok = false;

    // --- 7. Console must be clean of real errors ---
    const fatal = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    if (fatal.length) {
      console.log("[7] console errors:", fatal.slice(0, 5));
      try {
        const tt = await page.evaluate(() => ({ d: window.__trapTrace.depth, e: window.__trapTrace.events.slice(0, 15) }));
        console.log("[7b] trap depth=" + tt.d + " events=" + tt.e.length);
        tt.e.forEach(function (x) { console.log("      #" + x.n + " vec=" + x.v.toString(8) + " mask=" + x.m.toString(8) + " PC=" + x.pc.toString(8) + " t=" + (x.t % 100000)); });
      } catch (e) { console.log("[7b] no trap trace"); }
      ok = false;
    } else {
      console.log("[7] no console errors");
    }

    // --- 8. Cleanup test snapshot ---
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    // Prove the restored X-OFF latch is behavioural, not just serialized:
    // the reader must remain at the same byte until DC1 / X-ON arrives.
    const pausedPos = await page.evaluate(() => window.tapeReader.snapshot().pos);
    await new Promise((r) => setTimeout(r, 400));
    const stillPausedPos = await page.evaluate(() => window.tapeReader.snapshot().pos);
    const held = stillPausedPos === pausedPos;
    console.log("[8] reader remains paused under restored X-OFF: " + (held ? "OK" : "FAILED"));
    if (!held) ok = false;

    await page.evaluate(() => window.g60ConsoleWrite(0x11));
    const resumed = await page.waitForFunction(
      (pos) => window.tapeReader.snapshot().pos > pos,
      { timeout: 10000 },
      pausedPos
    ).then(() => true).catch(() => false);
    console.log("[8] reader advances after X-ON: " + (resumed ? "OK" : "FAILED"));
    if (!resumed) ok = false;

    // The printer queue must not merely survive as data: it must be re-armed
    // and eventually render the pending characters onto the restored paper.
    // The default Model 33 speed is authentic (100 ms per character), so
    // a 284-character restored queue needs about 28 seconds to drain. Derive
    // the wait from the captured queue and configured speed rather than
    // failing a correct restore at an arbitrary 20-second cutoff.
    const printerQueueLength = before.teletype && Array.isArray(before.teletype.charBuffer)
      ? before.teletype.charBuffer.length : 0;
    const printerSpeed = await page.evaluate(() => Config.get().teletypeSpeed);
    const printerCharDelay = printerSpeed === "authentic" ? 100 : 30;
    const printerTimeout = Math.max(20000, printerQueueLength * printerCharDelay + 10000);
    console.log("[8] waiting for restored printer queue: " + printerQueueLength +
      " chars at " + printerSpeed + " speed (timeout " + printerTimeout + " ms)");
    const printerResumed = await page.waitForFunction(() => {
      const state = window.g60printer.snapshot();
      return state.charBuffer.length === 0 &&
        state.rows.some(row => (row.text || "").indexOf("R") !== -1);
    }, { timeout: printerTimeout }).then(() => true).catch(() => false);
    console.log("[8] restored printer queue drains onto paper: " +
      (printerResumed ? "OK" : "FAILED"));
    if (!printerResumed) ok = false;

    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("[8] test snapshot removed");

    // Test the ON latch in isolation after the queued printer output has
    // drained, so the printer cannot legitimately add bytes to the paper
    // tape while the main round-trip assertions are running.
    await page.evaluate(() => window.setTtyPunchState({ enabled: true, relHeld: false }));
    const onSnapshotId = await page.evaluate(async () => {
      const saved = await SnapshotStore.save("e2e ASR punch ON state");
      return saved.id;
    });
    await page.evaluate(() => window.setTtyPunchState({ enabled: false, relHeld: false }));
    await page.evaluate((id) => SnapshotStore.load(id), onSnapshotId);
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" &&
        typeof window.getTtyPunchState === "function",
      { timeout: 30000 }
    );
    await new Promise((r) => setTimeout(r, 1000));
    const onRestored = await page.evaluate(() => ({
      state: window.getTtyPunchState(),
      onActive: (() => { const b = document.getElementById("punch-on"); return !!b && b.classList.contains("active"); })(),
      relActive: (() => { const b = document.getElementById("punch-rel"); return !!b && b.classList.contains("active"); })()
    }));
    const onPass = onRestored.state.enabled === true &&
      onRestored.state.relHeld === false &&
      onRestored.onActive === true && onRestored.relActive === false;
    console.log("[9] ASR punch ON state survives save/restore: " + (onPass ? "OK" : "FAILED"));
    if (!onPass) ok = false;
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, onSnapshotId);

    // Exercise the complementary REL-latched state through a second complete
    // save/reload cycle. ON and REL are mutually exclusive on the real panel.
    await page.evaluate(() => window.setTtyPunchState({ enabled: false, relHeld: true }));
    const relSnapshotId = await page.evaluate(async () => {
      const saved = await SnapshotStore.save("e2e ASR REL state");
      return saved.id;
    });
    await page.evaluate(() => window.setTtyPunchState({ enabled: true, relHeld: false }));
    await page.evaluate((id) => SnapshotStore.load(id), relSnapshotId);
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" &&
        typeof window.getTtyPunchState === "function",
      { timeout: 30000 }
    );
    await new Promise((r) => setTimeout(r, 1000));
    const relRestored = await page.evaluate(() => ({
      state: window.getTtyPunchState(),
      relActive: (() => { const b = document.getElementById("punch-rel"); return !!b && b.classList.contains("active"); })(),
      onActive: (() => { const b = document.getElementById("punch-on"); return !!b && b.classList.contains("active"); })()
    }));
    const relPass = relRestored.state.enabled === false &&
      relRestored.state.relHeld === true &&
      relRestored.relActive === true && relRestored.onActive === false;
    console.log("[9] ASR REL state survives save/restore: " + (relPass ? "OK" : "FAILED"));
    if (!relPass) ok = false;

    // CCU OFF must override a malformed/older ON state on restore.
    const offInterlock = await page.evaluate(() => {
      window.setTtyMode("off");
      window.setTtyPunchState({ enabled: true, relHeld: true });
      const state = window.getTtyPunchState();
      window.setTtyMode("line");
      return state;
    });
    const offPass = offInterlock.enabled === false && offInterlock.relHeld === false;
    console.log("[9] CCU OFF interlocks ASR punch restore: " + (offPass ? "OK" : "FAILED"));
    if (!offPass) ok = false;

    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, relSnapshotId);

    if (!ok) {
      console.error("\nE2E SNAPSHOTS: FAILED");
      process.exit(1);
    }
    console.log("\nE2E SNAPSHOTS: ALL CHECKS PASSED");
    process.exit(0);
  } catch (err) {
    console.error("E2E FAIL:", err.message);
    process.exit(1);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
})();
