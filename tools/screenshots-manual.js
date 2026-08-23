#!/usr/bin/env node
/**
 * yaPDP — User-manual screenshot generator.
 *
 * Renders every emulator page through puppeteer-core and saves viewport
 * screenshots into assets/images/manual/ so the user manual (manual.html)
 * can illustrate each page with a real picture.
 *
 * puppeteer-core drives the locally installed Edge/Chrome (no Chromium
 * download). The repository's own static server (tools/serve.js) is started
 * on a private port for the duration of the run, so the emulator loads its
 * media over HTTP exactly like in production.
 *
 * Usage:
 *   node tools/screenshots-manual.js
 *   npm run screenshots:manual
 *
 * Output: assets/images/manual/<name>.png
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "images", "manual");
const PORT = 11790;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// --- Config seeded into localStorage (merged over Config.DEFAULTS) -------
// Run A: Model 33 ASR teletype console + every optional peripheral enabled.
const CFG_TTY = {
    consoleType: "teletype",
    userTerminals: 2,
    printer: true,
    vt11: true,
    teletypeSpeed: "fast", // accelerate the console echo for the boot banner
    powerOn: true,         // machine powered on at startup
    autoBoot: true         // start the default bootstrap -> prints "Boot>"
};
// Run B: DECscope VT52 as the operator console.
const CFG_VT52 = Object.assign({}, CFG_TTY, { consoleType: "vt52" });

// --- Sample content injected so the illustrations look alive -------------
const SAMPLE_TTY1 = [
    "2.11 BSD UNIX  PDP-11/70  tty1",
    "",
    "login: root",
    "# ls -l /usr",
    "total 6",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 bin",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 games",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 include",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 lib",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 local",
    "drwxr-xr-x  2 root  wheel   512 Sep  2 14:31 man",
    "# "
].join("\n");

const SAMPLE_TTY2 = [
    "RSX-11M-PLUS V4.6  BL86  tty2",
    "",
    "> hello, operator",
    "MCR> show time",
    "14:31:52  02-SEP-26",
    "MCR> "
].join("\n");

const SAMPLE_LP11 = [
    "              L P 1 1   L I N E   P R I N T E R   -   J O B   L I S T I N G",
    "",
    "              /usr/src/cmd   -   2.11BSD source listing",
    "",
    "              total 846",
    "              -rw-rw-rw-  1 bin     wheel    39518 Sep  2 14:31 cc.c",
    "              -rw-rw-rw-  1 bin     wheel    22184 Sep  2 14:31 cpp.c",
    "              -rw-rw-rw-  1 bin     wheel    11062 Sep  2 14:31 ccom.c",
    "              -rw-rw-rw-  1 bin     wheel    14224 Sep  2 14:31 cgram.y",
    "              -rw-rw-rw-  1 bin     wheel     6178 Sep  2 14:31 c0.c",
    "              -rw-rw-rw-  1 bin     wheel     3942 Sep  2 14:31 c1.c",
    "              -rw-rw-rw-  1 bin     wheel    12872 Sep  2 14:31 c2.c",
    "",
    "              End of listing"
].join("\n");

// --- Inject helpers (run inside the page context) ------------------------

// Feed sample text into a VT52 terminal unit (0 = console, 1/2 = user tty).
async function vt52Text(page, unit, text) {
    await page.evaluate((u, s) => {
        if (typeof window.vt52Write === "function") window.vt52Write(u, s);
    }, unit, text);
}

// Print a sample job on the LP11 line-printer paper.
async function lp11Text(page, text) {
    await page.evaluate((s) => {
        const p = window.lp11G60Printer;
        if (p && typeof p.writeString === "function") {
            p.writeString(s);
            if (typeof p.flush === "function") p.flush();
        }
    }, text);
}

// --- Shot lists -----------------------------------------------------------
// `wait` is the settle delay (ms) after switching pages / injecting content,
// letting paced printing and layout animations finish before the capture.
const SHOTS_TTY = [
    { page: "panel",        file: "panel.png",               wait: 1500 },
    { page: "teletype",     file: "console-teletype.png",    wait: 1800 },
    { page: "vt52",         file: "terminal-vt52.png",       wait: 2000, prep: (p) => vt52Text(p, 1, SAMPLE_TTY1) },
    { page: "vt52-2",       file: "terminal-vt52-2.png",     wait: 2000, prep: (p) => vt52Text(p, 2, SAMPLE_TTY2) },
    { page: "printer",      file: "printer.png",             wait: 3500, prep: (p) => lp11Text(p, SAMPLE_LP11) },
    { page: "vt11",         file: "vt11.png",                wait: 1500 },
    { page: "storage",      file: "storage.png",             wait: 1500 },
    { page: "config",       file: "config.png",              wait: 1500 },
    { page: "instructions", file: "info.png",                wait: 1500 }
];

const SHOTS_VT52 = [
    { page: "vt52-console", file: "console-vt52.png",        wait: 1800 }
];

// Floating UI buttons captured as crisp close-ups (deviceScaleFactor 2), so
// the "Buttons, Shortcuts & Indicators" section can show the actual widgets.
const BUTTON_SHOTS = [
    { id: "#quick-boot-btn", file: "btn-magicwand.png" },
    { id: "#reboot-btn",     file: "btn-reboot.png" },
    { id: "#mute-btn",       file: "btn-mute.png" },
    { id: "#fullscreen-btn", file: "btn-fullscreen.png" }
];

// --- Utilities ------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

// Resolve an installed Edge/Chrome for puppeteer-core.
function findBrowserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ].filter(Boolean);
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

async function launchBrowser() {
    const executablePath = findBrowserExecutable();
    if (executablePath) {
        return puppeteer.launch({ executablePath, headless: true });
    }
    for (const channel of ["msedge", "chrome"]) {
        try {
            return await puppeteer.launch({ channel, headless: true });
        } catch (err) { /* try the next channel */ }
    }
    throw new Error(
        "No Edge/Chrome found. Install one or set PUPPETEER_EXECUTABLE_PATH."
    );
}

// --- One scenario ---------------------------------------------------------
// Seeds the config + onboarding flag, loads pdp11.html, lets the autoboot
// banner print, then captures every requested page.
async function captureScenario(browser, cfg, shots, label) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument((c) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(c));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, cfg);

    console.log(`\n== ${label} ==`);
    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    try {
        await page.evaluate(() => document.fonts.ready);
    } catch (err) { /* fonts API may be missing in headless */ }

    // Let the autoboot bootstrap print its banner at fast teletype speed.
    await sleep(5000);

    for (const shot of shots) {
        try {
            await page.evaluate((p) => window.switchPage(p), shot.page);
            if (shot.prep) await shot.prep(page);
            await sleep(shot.wait);
            const file = path.join(OUT_DIR, shot.file);
            await page.screenshot({ path: file, type: "png" });
            const kb = Math.round(fs.statSync(file).size / 1024);
            console.log(`  saved ${shot.file} (${kb} kB)`);
        } catch (err) {
            console.error(`  FAILED ${shot.file}: ${err.message}`);
        }
    }
    await page.close();
}

// Capture the floating UI buttons (magic wand, REBOOT, mute, fullscreen) as
// individual close-ups. Runs on the Panel page where all four are visible.
async function captureButtons(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.evaluateOnNewDocument((c) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(c));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, CFG_TTY);

    console.log("\n== floating buttons ==");
    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    try {
        await page.evaluate(() => document.fonts.ready);
    } catch (err) { /* ignore */ }
    await sleep(3000);
    await page.evaluate(() => window.switchPage("panel"));
    await sleep(500);

    for (const b of BUTTON_SHOTS) {
        try {
            const el = await page.$(b.id);
            if (!el) {
                console.log(`  MISSING ${b.file} (${b.id})`);
                continue;
            }
            await el.screenshot({ path: path.join(OUT_DIR, b.file) });
            console.log(`  saved ${b.file}`);
        } catch (err) {
            console.error(`  FAILED ${b.file}: ${err.message}`);
        }
    }
    await page.close();
}

// --- Main -----------------------------------------------------------------

(async function main() {
    let server = null;
    let browser = null;
    try {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        server = await ensureServer();
        browser = await launchBrowser();

        await captureScenario(browser, CFG_TTY, SHOTS_TTY, "teletype console");
        await captureScenario(browser, CFG_VT52, SHOTS_VT52, "VT52 console");
        await captureButtons(browser);

        console.log("\nDone. Screenshots written to " +
            path.relative(ROOT, OUT_DIR) + ".");
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
    }
})();
