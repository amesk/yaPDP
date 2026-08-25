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

const URL = "http://localhost:1170/pdp11.html";

(async () => {
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
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    // --- 1. Open the emulator ---
    // Enable the LP11 printer in the persisted config BEFORE the page loads:
    // iopage.js registers the device at load time based on __config.printer.
    await page.evaluateOnNewDocument(() => {
      try {
        var k = "yapdp.config.v1";
        var cfg = null;
        try { cfg = JSON.parse(localStorage.getItem(k)); } catch (e) { cfg = null; }
        if (!cfg || typeof cfg !== "object") cfg = {};
        cfg.printer = true;
        localStorage.setItem(k, JSON.stringify(cfg));
      } catch (e) { /* ignore */ }
    });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
      { timeout: 30000 }
    );
    console.log("[1] page loaded, SnapshotStore + CPU present");

    // --- 2. Power on and let the machine run (CPU executes instructions) ---
    await page.evaluate(() => {
      // Force auto-boot on and power the machine on so the CPU actually
      // executes code (boot() copies the bootstrap into memory and RUNs).
      if (typeof Config !== "undefined" && typeof Config.set === "function") {
        var cfg = Config.get() || {};
        cfg.autoBoot = true;
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

    const snapId = await page.evaluate(async () => {
      const snap = await SnapshotStore.save("e2e test");
      return snap.id;
    });
    console.log(`[3] snapshot saved: ${snapId}`);

    const before = await page.evaluate(() => ({
      pc: CPU.registerVal[7],
      sp: CPU.registerVal[6],
      ps: CPU.PSW,
      mem100: CPU.memory[100],
      mem1000: CPU.memory[1000],
      memSize: CPU.memory.length,
      devices: iopage.snapshotDevices(),
      punchtape: (window.paperTape && window.paperTape.snapshot) ? window.paperTape.snapshot() : null,
      lp11: (window.lp11G60Printer && window.lp11G60Printer.snapshot) ? window.lp11G60Printer.snapshot() : null,
      onlineLedOff: (() => { const led = document.getElementById("lp11-online-led"); return led ? led.classList.contains("off") : null; })(),
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
    });
    await page.evaluate(() => {
      if (window.paperTape && window.paperTape.clear) window.paperTape.clear();
    });
    console.log("[4] machine state mutated (PC=0x7777, mem 0xDEAD, RK11 CSR=0x9999, tape cleared)");

    // --- 5. Load: pending key + reload ---
    await page.evaluate((id) => SnapshotStore.load(id), snapId);
    // load() calls location.reload(); wait for the fresh page
    await page.waitForFunction(
      () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
      { timeout: 30000 }
    );
    // init() runs on DOMContentLoaded of the new page; give it a moment
    await new Promise((r) => setTimeout(r, 1500));
    console.log("[5] page reloaded, pending snapshot applied");

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
      lp11: (window.lp11G60Printer && window.lp11G60Printer.snapshot) ? window.lp11G60Printer.snapshot() : null,
      onlineLedOff: (() => { const led = document.getElementById("lp11-online-led"); return led ? led.classList.contains("off") : null; })(),
      tapeRows: (() => {
        const body = document.getElementById("punchtape__body");
        return body ? body.childNodes.length : -1;
      })(),
      pending: (() => { try { return localStorage.getItem("yapdp-pending-snapshot"); } catch (e) { return "n/a"; } })(),
    }));

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
      ["punchtape bytes", after.punchtape && after.punchtape.buffer.length,
                          before.punchtape && before.punchtape.buffer.length],
      ["tape DOM rows", after.tapeRows, (before.punchtape && before.punchtape.buffer) ? before.punchtape.buffer.length : -1],
      ["LP11 rows", after.lp11 ? after.lp11.rows.length : -1,
                    before.lp11 ? before.lp11.rows.length : -1],
      ["LP11 has text", after.lp11 && after.lp11.rows.some(r => r.text && r.text.indexOf("HELLO") !== -1),
                        before.lp11 && before.lp11.rows.some(r => r.text && r.text.indexOf("HELLO") !== -1)],
      ["LP11 pagePos", after.lp11 ? after.lp11.pagePos : -1,
                       before.lp11 ? before.lp11.pagePos : -1],
      ["LP11 ONLINE led off", after.onlineLedOff, before.onlineLedOff],
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
      ok = false;
    } else {
      console.log("[7] no console errors");
    }

    // --- 8. Cleanup test snapshot ---
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("[8] test snapshot removed");

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
  }
})();
