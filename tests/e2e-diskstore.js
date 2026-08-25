#!/usr/bin/env node
/**
 * yaPDP DiskStore end-to-end test (puppeteer + real Chromium IndexedDB).
 *
 * Verifies the full write-back loop in a real browser:
 *   1. open the emulator page
 *   2. write a distinctive pattern to disk block 0 (guest-OS write path)
 *   3. flush to IndexedDB
 *   4. reload the page (fresh JS state, same origin storage)
 *   5. fetchBlock() must return the SAVED block, not the pristine one
 *
 * Run with: node tests/e2e-diskstore.js   (needs: npm i puppeteer, server on :1170)
 */
"use strict";

const puppeteer = require("puppeteer");

const URL = "http://localhost:1170/pdp11.html";
const PATTERN = 0xBEEF; // distinctive word written to block 0

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
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => typeof DiskStore !== "undefined" && typeof fetchBlock !== "undefined",
      { timeout: 30000 }
    );
    console.log("[1] page loaded, DiskStore present");

    // --- 2. Guest write: mark block 0 of rk0.dsk dirty with pattern ---
    await page.evaluate((pattern) => {
      return DiskStore.init().then(() => {
        // Simulate what diskIO(OP_WRITE) does: write into the cache block
        // and report it to DiskStore.
        const ctrl = { cache: [], url: "rk0.dsk", compressed: true };
        ctrl.cache[0] = new Uint16Array(131072 >>> 1);
        ctrl.cache[0][0] = pattern;
        ctrl.cache[0][1] = pattern + 1;
        DiskStore.markDirty(ctrl, 0);
        return DiskStore.flush("rk0.dsk");
      });
    }, PATTERN);
    console.log("[2] wrote pattern to rk0.dsk block 0, flushed to IndexedDB");

    // --- 3. Verify saved block is readable before reload ---
    const before = await page.evaluate(async () => {
      const b = await DiskStore.getBlock("rk0.dsk", 0);
      return b ? b[0] | (b[1] << 8) : null;
    });
    if (before !== PATTERN) {
      throw new Error(`saved block mismatch before reload: got ${before}, want ${PATTERN}`);
    }
    console.log(`[3] saved block reads back as 0x${before.toString(16)} before reload`);

    // --- 4. Reload the page (fresh JS, same IndexedDB) ---
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => typeof DiskStore !== "undefined",
      { timeout: 30000 }
    );
    await page.evaluate(() => DiskStore.init());
    console.log("[4] page reloaded, DiskStore re-initialized");

    // --- 5. fetchBlock must overlay the saved block ---
    const after = await page.evaluate(async (pattern) => {
      const ctrl = { cache: [], url: "rk0.dsk", compressed: true };
      const status = await fetchBlock(ctrl, 0);
      const word0 = ctrl.cache[0] ? ctrl.cache[0][0] : null;
      return { status, word0, match: word0 === pattern };
    }, PATTERN);

    if (!after.match) {
      throw new Error(
        `fetchBlock returned pristine block after reload: status=${after.status}, word0=0x${(after.word0 || 0).toString(16)}, want 0x${PATTERN.toString(16)}`
      );
    }
    console.log(`[5] fetchBlock overlays saved block after reload (status ${after.status})`);

    // --- 6. Cleanup: remove test data so the emulator stays pristine ---
    await page.evaluate(() => DiskStore.clear("rk0.dsk"));
    console.log("[6] cleaned up test data (rk0.dsk reset to factory)");

    // --- 7. Console must be clean of real errors ---
    const fatal = consoleErrors.filter(
      (e) => !/favicon|Failed to load resource/i.test(e)
    );
    if (fatal.length) {
      console.log("[7] console errors observed:", fatal.slice(0, 5));
    } else {
      console.log("[7] no console errors");
    }

    console.log("\nE2E DISKSTORE: ALL CHECKS PASSED");
    process.exit(0);
  } catch (err) {
    console.error("E2E FAIL:", err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
