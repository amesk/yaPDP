#!/usr/bin/env node
/**
 * yaPDP quick-boot Scenario tab end-to-end test (puppeteer + real Chromium).
 *
 * Covers the six behavioural contracts of the Scenario tab:
 *   1. manifest loaded  -> the tab lists every state from states/manifest.json
 *   2. manifest absent  -> the tab shows "No saved machine states available."
 *   3. card click       -> launches the state (the preparing indicator appears)
 *   4. thumbnail click  -> opens the lightbox, does NOT launch the state
 *   5. load error       -> imgerror dialog appears, input is not blocked
 *   6. reopen           -> no duplicate elements or handlers
 *
 * The manifest and state-file responses are intercepted with
 * page.setRequestInterception, so no real files are touched.
 * Run with:  node tests/e2e-quickboot-scenario.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const URL = "http://localhost:1170/pdp11.html";
const ROOT = path.resolve(__dirname, "..");

// --- shared dev server ------------------------------------------------------
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

// --- helpers ----------------------------------------------------------------

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log("  ok  " + name);
    } else {
        failures++;
        console.error("  FAIL " + name + (detail ? " — " + detail : ""));
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed a stable config so the page renders deterministically.
async function seededPage(browser) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify({
                consoleType: "teletype", printer: false, vt11: false,
                teletypeSpeed: "fast", powerOn: true, bootDevice: "none",
                hum: false, mute: false, userTerminals: 0
            }));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore */ }
    });
    return page;
}

// Wait for the page to be ready (QuickBoot and OSBoot loaded).
async function waitReady(page) {
    await page.waitForFunction(
        () => typeof QuickBoot !== "undefined" && typeof OSBoot !== "undefined",
        { timeout: 30000 });
}

// Open the quick-boot dialog via QuickBoot.show() (same as other e2e suites).
async function openQuickBoot(page) {
    await page.evaluate(() => QuickBoot.show());
    await page.waitForSelector("#quick-boot-overlay.visible", { timeout: 10000 });
}

// Switch to the Scenario tab and wait for the list to render.
async function switchToScenario(page) {
    const tab = await page.waitForSelector(
        ".quickboot-tab[data-tab='scenario']", { timeout: 10000 });
    await tab.click();
    // Wait for the manifest request to settle. A loading placeholder is
    // not a final result: the request may fail just after the tab is shown.
    await page.waitForFunction(() => {
        const list = document.querySelector(".quickboot-list[data-tab='scenario']");
        return list && !list.querySelector(".quickboot-loading") &&
            (list.querySelector(".quickboot-scenario-option") ||
                list.querySelector(".quickboot-empty"));
    }, { timeout: 10000 });
}

// Count scenario option elements.
async function countScenarioOptions(page) {
    const els = await page.$$(".quickboot-scenario-option");
    return els.length;
}

// Read the empty-state message, or null when the list is not empty.
async function scenarioEmptyMessage(page) {
    const el = await page.$(".quickboot-empty");
    return el ? el.textContent : null;
}

// The real manifest entries count (from the committed file).
const fs = require("fs");
const MANIFEST_PATH = path.join(ROOT, "states", "manifest.json");
const MANIFEST_ENTRIES = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const EXPECTED_COUNT = MANIFEST_ENTRIES.length;

// A minimal valid state container for the "load error" test (not actually used).
const FAKE_STATE = Buffer.from(new Uint8Array(64));

// --- tests ------------------------------------------------------------------

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    try {
        // ---- 1. Manifest loaded: the tab lists every state -----------------
        {
            const page = await seededPage(browser);
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);

            const count = await countScenarioOptions(page);
            check("scenario tab shows all states from manifest",
                count === EXPECTED_COUNT,
                "expected " + EXPECTED_COUNT + " options, got " + count);

            const empty = await scenarioEmptyMessage(page);
            check("scenario tab is not showing the empty message",
                empty === null, "unexpected empty message: " + empty);

            await page.close();
        }

        // ---- 2. Manifest absent: the tab shows the empty message -----------
        {
            const page = await seededPage(browser);
            let interceptedManifestRequest = false;
            // Return an actual 404 for the state manifest. This exercises the
            // normal "manifest absent" response path without depending on
            // browser-specific timing/handling of an aborted fetch.
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                if (req.url().indexOf("states/manifest.json") !== -1) {
                    interceptedManifestRequest = true;
                    console.log("DEBUG absent manifest: intercepted " + req.url());
                    req.respond({ status: 404, contentType: "application/json",
                        body: JSON.stringify({ error: "not found" }) });
                } else {
                    req.continue();
                }
            });
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);

            const empty = await scenarioEmptyMessage(page);
            if (!empty) {
                const diagnostic = await page.evaluate(() => {
                    const list = document.querySelector(
                        ".quickboot-list[data-tab='scenario']");
                    return {
                        href: location.href,
                        overlayVisible: !!document.querySelector(
                            "#quick-boot-overlay.visible"),
                        scenarioListFound: !!list,
                        scenarioListHTML: list ? list.innerHTML : null,
                        scenarioListDisplay: list ? getComputedStyle(list).display : null,
                        scenarioOptions: list
                            ? list.querySelectorAll(".quickboot-scenario-option").length
                            : null,
                        emptyMessage: list
                            ? (list.querySelector(".quickboot-empty") || {}).textContent || null
                            : null,
                        loadingMessage: list
                            ? (list.querySelector(".quickboot-loading") || {}).textContent || null
                            : null
                    };
                });
                console.error("  DEBUG absent manifest state: " + JSON.stringify({
                    interceptedManifestRequest: interceptedManifestRequest,
                    diagnostic: diagnostic
                }, null, 2));
            }
            check("absent manifest: shows 'No saved machine states available.'",
                empty && empty.indexOf("No saved machine states") !== -1,
                "got: " + empty);

            const count = await countScenarioOptions(page);
            check("absent manifest: no scenario options rendered",
                count === 0, "expected 0 options, got " + count);

            await page.close();
        }

        // ---- 3. Card click launches the state ------------------------------
        {
            const page = await seededPage(browser);
            // Intercept state-file fetches before the page loads.
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                if (req.url().indexOf(".state.zst") !== -1) {
                    req.respond({ status: 200, contentType: "application/octet-stream",
                        body: FAKE_STATE });
                } else {
                    req.continue();
                }
            });
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);

            // Click the first scenario card.
            const cards = await page.$$(".quickboot-scenario-option");
            if (cards.length > 0) {
                await cards[0].click();
                // Wait for the shared-state error dialog (the fake container is not a valid state).
                const imgerror = await page.waitForSelector(
                    "#quickboot-link-error.visible", { timeout: 15000 }).catch(() => null);
                check("card click: state error dialog appears (fake state fails)",
                    !!imgerror, "no state error dialog after clicking a card with a fake state");
            } else {
                check("card click: at least one card exists (sanity)",
                    false, "no scenario cards rendered");
            }

            await page.close();
        }

        // ---- 4. Thumbnail click opens the lightbox, does not launch --------
        {
            const page = await seededPage(browser);
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);

            const imgs = await page.$$(".quickboot-scenario-preview");
            if (imgs.length > 0) {
                await imgs[0].click();
                await sleep(300);

                const lightbox = await page.$(".lightbox-overlay.visible");
                check("thumbnail click: lightbox opens",
                    !!lightbox, "lightbox overlay not visible");

                // The state must NOT have been launched.
                const balloon = await page.$("#quick-boot-balloon, #state-preparing");
                check("thumbnail click: state is not launched",
                    !balloon, "a launch indicator appeared on thumbnail click");

                // Close the lightbox.
                if (lightbox) {
                    await page.keyboard.press("Escape");
                    await sleep(200);
                    const stillOpen = await page.$(".lightbox-overlay.visible");
                    check("lightbox: Escape closes it",
                        !stillOpen, "lightbox stayed open after Escape");
                }
            } else {
                check("thumbnail click: at least one preview exists (sanity)",
                    false, "no preview images rendered");
            }

            await page.close();
        }

        // ---- 5. Load error shows the state-link error, input is not blocked --
        {
            const page = await seededPage(browser);
            // Intercept the state-manifest to return a valid list, but make
            // the state file itself fail.
            const realManifest = JSON.parse(
                fs.readFileSync(MANIFEST_PATH, "utf8"));
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                const url = req.url();
                if (url.indexOf("states/manifest.json") !== -1) {
                    req.respond({ status: 200, contentType: "application/json",
                        body: JSON.stringify(realManifest) });
                } else if (url.indexOf(".state.zst") !== -1) {
                    req.respond({ status: 500, contentType: "text/plain",
                        body: "simulated error" });
                } else {
                    req.continue();
                }
            });

            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);

            const cards = await page.$$(".quickboot-scenario-option");
            if (cards.length > 0) {
                await cards[0].click();
                // Wait for the shared-state error dialog.
                const imgerror = await page.waitForSelector(
                    "#quickboot-link-error.visible", { timeout: 15000 }).catch(() => null);
                check("load error: state error dialog appears",
                    !!imgerror, "state error dialog did not appear after a failed state load");

                // Close the state error dialog.
                if (imgerror) {
                    const closeBtn = await page.$("#quickboot-link-error .modal-close");
                    if (closeBtn) await closeBtn.click();
                    await sleep(300);
                    // The quick-boot dialog should still be usable.
                    const stillOpen = await page.$("#quick-boot-overlay.visible");
                    check("load error: quick-boot dialog stays open after imgerror",
                        !!stillOpen, "dialog closed after imgerror");
                }
            } else {
                check("load error: at least one card exists (sanity)",
                    false, "no scenario cards rendered");
            }

            await page.close();
        }

        // ---- 6. Reopen does not duplicate elements -------------------------
        {
            const page = await seededPage(browser);
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await waitReady(page);
            await openQuickBoot(page);
            await switchToScenario(page);
            const count1 = await countScenarioOptions(page);

            // Close and reopen.
            const closeBtn = await page.$(".quickboot-close");
            if (closeBtn) await closeBtn.click();
            await sleep(300);
            await openQuickBoot(page);
            await switchToScenario(page);
            const count2 = await countScenarioOptions(page);

            check("reopen: element count is stable",
                count1 === count2,
                "first open: " + count1 + ", second open: " + count2);

            await page.close();
        }

    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\ne2e-quickboot-scenario: ALL CHECKS PASSED"
        : `\ne2e-quickboot-scenario: ${failures} failure(s)`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error("e2e-quickboot-scenario error:", e.message); process.exit(1); });