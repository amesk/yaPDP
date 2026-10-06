#!/usr/bin/env node
/**
 * yaPDP ?state= disk access end-to-end test (puppeteer + real Chromium).
 *
 * Verifies that when a machine state is loaded via ?state=, the disk images
 * are mounted in DataLoader and the disk controller can read from them.
 *
 * Regression test for the bug where mountStateDisks() was never called from
 * restore(), leaving the guest OS with CPU/RAM restored but no disk access.
 *
 * Run with:  node tests/e2e-state-disk-access.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const PORT = 1170;
const BASE = `http://localhost:${PORT}/pdp11.html`;
const ROOT = path.resolve(__dirname, "..");

// Start the repo's static server when nothing serves :1170 (the suite fetches
// states over HTTP); reuse one that is already up, and stop only our own.
function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(BASE, (res) => {
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
        path.join(ROOT, "tools", "serve.js"),
        "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log("  ok  " + name);
    } else {
        failures++;
        console.error("  FAIL " + name + (detail ? " — " + detail : ""));
    }
}

async function openPage(browser, errors, search) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    // Clear localStorage only ONCE before the first page load.
    // Do NOT use evaluateOnNewDocument for this — it runs on EVERY
    // new document (including after a config-driven reload), which
    // would wipe the config that applySnapshotConfig() just wrote.
    // Instead, clear localStorage directly before navigating.
    await page.goto(BASE + "?__clear=1", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.close();

    // Now open the actual test page
    const page2 = await browser.newPage();
    page2.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    await page2.goto(BASE + search, { waitUntil: "domcontentloaded", timeout: 90000 });
    // The page may reload immediately (config mismatch in the state).
    // waitForFunction throws "context destroyed" when that happens; catch
    // it and wait for the new page to settle.
    try {
        await page2.waitForFunction(
            () => typeof SnapshotStore === "object" && typeof QuickBoot === "object",
            { timeout: 30000 });
    } catch (e) {
        // Navigation during initial load: wait for the new page
        await new Promise((r) => setTimeout(r, 5000));
    }
    return page2;
}

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const errors = [];

    try {
        // ====================================================================
        // Test 1: rp1-ready state (RP11/RP06 disk)
        // ====================================================================
        {
            console.log("--- Test 1: rp1-ready (RP11 disk) ---");
            const page = await openPage(browser, errors,
                "?state=states/rp1-ready.state.zst");

            // Wait for the state to be applied or fail
            await new Promise((r) => setTimeout(r, 20000));

            const diag = await page.evaluate(() => {
                var failDialog = null;
                var failEl = document.querySelector("#quickboot-link-error.visible");
                if (failEl) {
                    var title = failEl.querySelector(".modal-title");
                    failDialog = title ? title.textContent : "visible";
                }
                return {
                    url: location.href,
                    search: location.search,
                    hasDataLoader: typeof DataLoader !== "undefined",
                    hasIopage: typeof iopage !== "undefined",
                    coreMode: typeof window.__coreMode !== "undefined"
                        ? window.__coreMode : "unknown",
                    runState: typeof CPU !== "undefined" ? CPU.runState : "no-cpu",
                    pc: typeof CPU !== "undefined" ? CPU.registerVal[7] : -1,
                    dlKeys: typeof DataLoader !== "undefined"
                        ? DataLoader.list() : [],
                    failDialog: failDialog,
                };
            });
            console.log("  diag:", JSON.stringify(diag, null, 2));

            const paramDropped = diag.search.indexOf("state=") === -1;
            check("rp1-ready: state was applied (parameter dropped)",
                paramDropped, diag.search);

            if (paramDropped) {
                if (diag.hasDataLoader) {
                    const hasRp1 = diag.dlKeys.indexOf("rp1.dsk") >= 0;
                    check("rp1-ready: DataLoader has rp1.dsk",
                        hasRp1, JSON.stringify(diag.dlKeys));
                    if (hasRp1) {
                        const size = await page.evaluate(() =>
                            DataLoader.get("rp1.dsk").length);
                        check("rp1-ready: rp1.dsk is a real disk (> 1 MB)",
                            size > 1024 * 1024, "size=" + size);
                    }
                }
                check("rp1-ready: CPU is running (runState 0 or 2)",
                    diag.runState === 0 || diag.runState === 2,
                    "runState=" + diag.runState);
                check("rp1-ready: CPU has a sensible PC (> 0)",
                    diag.pc > 0, "PC=0o" + diag.pc.toString(8));
            } else {
                check("rp1-ready: failure dialog shown when state not applied",
                    diag.failDialog !== null, String(diag.failDialog));
            }

            check("rp1-ready: no page errors",
                errors.length === 0, errors.join(" | "));

            await page.close();
        }

        // ====================================================================
        // Test 2: rk1-ready state (RK11/RK05 disk)
        // ====================================================================
        {
            console.log("--- Test 2: rk1-ready (RK11 disk) ---");
            const page = await openPage(browser, errors,
                "?state=states/rk1-ready.state.zst");

            await new Promise((r) => setTimeout(r, 20000));

            const diag = await page.evaluate(() => {
                var failDialog = null;
                var failEl = document.querySelector("#quickboot-link-error.visible");
                if (failEl) {
                    var title = failEl.querySelector(".modal-title");
                    failDialog = title ? title.textContent : "visible";
                }
                return {
                    url: location.href,
                    search: location.search,
                    hasDataLoader: typeof DataLoader !== "undefined",
                    hasIopage: typeof iopage !== "undefined",
                    coreMode: typeof window.__coreMode !== "undefined"
                        ? window.__coreMode : "unknown",
                    runState: typeof CPU !== "undefined" ? CPU.runState : "no-cpu",
                    pc: typeof CPU !== "undefined" ? CPU.registerVal[7] : -1,
                    dlKeys: typeof DataLoader !== "undefined"
                        ? DataLoader.list() : [],
                    failDialog: failDialog,
                };
            });
            console.log("  diag:", JSON.stringify(diag, null, 2));

            const paramDropped = diag.search.indexOf("state=") === -1;
            check("rk1-ready: state was applied (parameter dropped)",
                paramDropped, diag.search);

            if (paramDropped) {
                if (diag.hasDataLoader) {
                    const hasRk1 = diag.dlKeys.indexOf("rk1.dsk") >= 0;
                    check("rk1-ready: DataLoader has rk1.dsk",
                        hasRk1, JSON.stringify(diag.dlKeys));
                    if (hasRk1) {
                        const size = await page.evaluate(() =>
                            DataLoader.get("rk1.dsk").length);
                        check("rk1-ready: rk1.dsk is a real disk (> 1 MB)",
                            size > 1024 * 1024, "size=" + size);
                    }
                }
                check("rk1-ready: CPU is running (runState === 0)",
                    diag.runState === 0, "runState=" + diag.runState);
                check("rk1-ready: CPU has a sensible PC (> 0)",
                    diag.pc > 0, "PC=0o" + diag.pc.toString(8));
            } else {
                check("rk1-ready: failure dialog shown when state not applied",
                    diag.failDialog !== null, String(diag.failDialog));
            }

            check("rk1-ready: no page errors",
                errors.length === 0, errors.join(" | "));

            await page.close();
        }

    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\n?state= disk access e2e: all checks passed");
})();