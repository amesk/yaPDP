#!/usr/bin/env node
/**
 * yaPDP guest-OS boot end-to-end test (puppeteer + real Chromium).
 *
 * Boots real guest operating systems through the quick-boot wizard exactly
 * the way a user would (magic-wand picker -> scenario click) and asserts
 * each one reaches its ready state:
 *
 *   rk0    Unix V5   — auto-login typed by the wizard, shell "#" after "login:"
 *   rk1    RT-11     — "." monitor prompt after the boot output settles
 *   rp1    BSD 2.11  — auto-login typed by the wizard, shell "#" after "login:"
 *   basic  BASIC-11  — "*O " BASIC prompt
 *
 * Readiness is detected on the GENERATED console output (the same
 * window.__consoleOutputHook the quick-boot wizard itself watches), so the
 * test also covers the wizard's prompt-aware typing logic end to end. A
 * failure saves an artifact screenshot and the console tail to
 * tests/artifacts/ for diagnosis.
 *
 * Run with:  node tests/e2e-osboot.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;

// Device -> config that EXACTLY matches the OSBoot scenario's `hardware`
// block (mirrors tools/screenshots-os.js OS_CFG). Seeding it means the
// wizard sees no profile change, skips its reload path and the boot starts
// on the loaded page with our console hooks still installed.
const GUESTS = [
    { device: "rk0",   name: "Unix V5",
        cfg: { consoleType: "teletype", printer: false, vt11: false },
        readyWhen: "#", readyAfter: "login:", timeout: 120000 },
    { device: "rk1",   name: "RT-11",
        cfg: { consoleType: "teletype", printer: true, vt11: false },
        stable: 2500, prompt: ".", timeout: 120000 },
    { device: "rp1",   name: "BSD 2.11",
        cfg: { consoleType: "vt52", printer: true, vt11: false },
        readyWhen: "#", readyAfter: "login:", timeout: 180000 },
    { device: "basic", name: "BASIC-11",
        cfg: { consoleType: "teletype", printer: false, vt11: false },
        readyWhen: "*O ", timeout: 90000 },
];

let failures = 0;

// --- helpers ---------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(`${BASE}/pdp11.html`, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
}

// Start the repo's static server unless something already serves the port.
async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [
        path.join(ROOT, "tools", "serve.js"),
        "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await sleep(200);
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

// --- page helpers -----------------------------------------------------------

async function openPage(browser, guest) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const cfg = Object.assign({
        consoleType: "teletype",
        userTerminals: 0,
        printer: false,
        vt11: false,
        teletypeSpeed: "fast",   // ~30ms/char instead of authentic ~100ms
        powerOn: true,
        autoBoot: false          // the wizard issues the boot itself
    }, guest.cfg);

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, cfg);

    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });

    // Wrap the generation hook AFTER load (the wizard reads it dynamically
    // per character, so our wrapper keeps it working) — same as
    // tools/console-wait.js, inlined here to keep this file self-contained.
    await page.evaluate(() => {
        if (window.__osHooksInstalled) return;
        window.__osHooksInstalled = true;
        window.__osShotOutput = "";
        const genHook = window.__consoleOutputHook;
        window.__consoleOutputHook = function (ch) {
            if (typeof genHook === "function") genHook(ch);
            window.__osShotOutput += String.fromCharCode(ch & 0x7F);
            if (window.__osShotOutput.length > 8192) {
                window.__osShotOutput = window.__osShotOutput.slice(-8192);
            }
        };
    });

    return page;
}

// Click the magic-wand button, then the scenario option — the real user path.
async function launchDevice(page, device) {
    await page.evaluate(() => {
        const btn = document.getElementById("quick-boot-btn");
        if (btn) btn.click();
    });
    await sleep(500);
    const clicked = await page.evaluate((d) => {
        const opt = document.querySelector(
            '.quickboot-option[data-quickboot-device="' + d + '"]');
        if (opt) { opt.click(); return true; }
        return false;
    }, device);
    if (!clicked) throw new Error(`quick-boot option not found for ${device}`);
}

async function outputContains(page, needle) {
    return page.evaluate((n) => {
        return !!(window.__osShotOutput &&
            window.__osShotOutput.indexOf(n) !== -1);
    }, needle);
}

// `needle` must appear at/after the LAST occurrence of `after` — for markers
// that can legitimately occur early (e.g. "#" inside kernel boot text) but
// only count once a milestone ("login:") was reached.
async function outputContainsAfter(page, needle, after) {
    return page.evaluate((n, a) => {
        const out = window.__osShotOutput || "";
        const start = a ? out.lastIndexOf(a) : 0;
        return start !== -1 && out.indexOf(n, start) !== -1;
    }, needle, after);
}

async function outputLength(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

async function outputTail(page, n) {
    return page.evaluate((count) => (window.__osShotOutput || "").slice(-count), n);
}

// Wait until the generated output stops growing for `stableMs` — RT-11 is
// logically booted in seconds but prints its whole ~500-char boot at
// teletype speed, so the "." prompt only shows once printing settles.
async function waitStable(page, stableMs, timeout) {
    const startedAt = Date.now();
    let last = await outputLength(page);
    let lastChanged = Date.now();
    while (Date.now() - startedAt < timeout) {
        await sleep(500);
        const len = await outputLength(page);
        if (len !== last) {
            last = len;
            lastChanged = Date.now();
        } else if (Date.now() - lastChanged >= stableMs) {
            return true;
        }
    }
    return false;
}

// --- one guest ---------------------------------------------------------------

async function bootGuest(browser, guest) {
    const pageErrors = [];
    const page = await openPage(browser, guest);
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    try {
        await launchDevice(page, guest.device);

        let ok = false;
        if (guest.stable) {
            ok = await waitStable(page, guest.stable, guest.timeout);
            if (ok) {
                const tail = await outputTail(page, 300);
                ok = tail.trimEnd().endsWith(guest.prompt);
            }
        } else {
            ok = await waitFor(
                () => guest.readyAfter
                    ? outputContainsAfter(page, guest.readyWhen, guest.readyAfter)
                    : outputContains(page, guest.readyWhen),
                guest.timeout);
        }

        if (ok && pageErrors.length) {
            console.log(`  ok  ${guest.name} booted (${guest.device}) ` +
                `— but ${pageErrors.length} page error(s)`);
        }
        if (!ok) {
            failures++;
            console.error(`  FAIL ${guest.name} (${guest.device}): ` +
                `ready marker not seen within ${guest.timeout / 1000}s`);
        } else if (!pageErrors.length) {
            console.log(`  ok  ${guest.name} booted (${guest.device})`);
        }

        if (pageErrors.length) {
            failures++;
            console.error("  FAIL page errors:\n    " + pageErrors.join("\n    "));
        }

        if (!ok || pageErrors.length) {
            fs.mkdirSync(ARTIFACTS, { recursive: true });
            const shot = path.join(ARTIFACTS,
                `e2e-osboot-${guest.device}-fail.png`);
            await page.screenshot({ path: shot, type: "png" });
            const tail = await outputTail(page, 600);
            console.error(`  artifact: ${shot}`);
            console.error("  console tail:\n" +
                tail.split("\n").map((l) => "    | " + l).join("\n"));
        }
    } finally {
        await page.close();
    }
}

// --- main --------------------------------------------------------------------

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"],
    });
    try {
        for (const guest of GUESTS) {
            await bootGuest(browser, guest);
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    const passed = GUESTS.length - failures;
    console.log(`\n${passed}/${GUESTS.length} guest OS(es) booted`);
    if (failures) {
        console.error(`e2e-osboot: ${failures} failure(s)`);
        process.exit(1);
    }
    console.log("e2e-osboot: ALL CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
