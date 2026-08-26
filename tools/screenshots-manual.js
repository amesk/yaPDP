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
 *   node tools/screenshots-manual.js            # all shots
 *   node tools/screenshots-manual.js panel      # only the 'panel' shot (file
 *                                               # name without the .png suffix)
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
// Run C: Lunar Lander profile — teletype console, VT11 display on, no printer.
// autoboot is off because the quick-boot wizard reboots the machine itself.
const CFG_LANDER = Object.assign({}, CFG_TTY, {
    consoleType: "teletype",
    printer: false,
    vt11: true,
    autoBoot: false
});

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

// Activate one CONFIG tab (equipment | visual | behaviour | development) by
// clicking its tab button; the app wires the click listener in initConfigTabs.
async function selectConfigTab(page, name) {
    await page.evaluate((n) => {
        const btn = document.getElementById("config-tab-" + n);
        if (btn && typeof btn.click === "function") btn.click();
    }, name);
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
    // The VT11 page is captured separately with Lunar Lander running (see
    // captureVt11Lander), so the illustration shows a real landing scene.
    { page: "storage",      file: "storage.png",             wait: 1500 },
    // Config page: one screenshot per tab. Equipment is the tallest form, so
    // it gets a taller viewport; the other tabs capture at standard height.
    { page: "config",       file: "config-equipment.png",    wait: 1500, height: 950, prep: (p) => selectConfigTab(p, "equipment") },
    { page: "config",       file: "config-visual.png",       wait: 1500, prep: (p) => selectConfigTab(p, "visual") },
    { page: "config",       file: "config-behaviour.png",    wait: 1500, prep: (p) => selectConfigTab(p, "behaviour") },
    { page: "config",       file: "config-development.png",  wait: 1500, prep: (p) => selectConfigTab(p, "development") },
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
    { id: "#state-btn",      file: "btn-state.png" },
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
    // Sandboxed CI/container environments (no unprivileged user namespaces)
    // need --no-sandbox; opt in via PUPPETEER_NO_SANDBOX=1 so desktop runs
    // keep the default sandbox.
    const args = process.env.PUPPETEER_NO_SANDBOX ? ["--no-sandbox"] : [];
    if (executablePath) {
        return puppeteer.launch({ executablePath, headless: true, args });
    }
    for (const channel of ["msedge", "chrome"]) {
        try {
            return await puppeteer.launch({ channel, headless: true, args });
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
            // A shot may override the viewport height (e.g. the tall Config
            // form); re-layout before switching so the target page uses it.
            await page.setViewport({
                width: VIEWPORT.width,
                height: shot.height || VIEWPORT.height
            });
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
async function captureButtons(browser, wants) {
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

    for (const b of BUTTON_SHOTS.filter((x) => wants(x.file))) {
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

// Capture the modal dialogs / overlays the manual documents: the first-run
// onboarding hint, the quick-boot picker + autoloading balloon, the image-load
// failure dialog, the Bootstrap now! power-off guard, the unapplied-config
// leave warning and the reboot confirmation. Each opens a fresh emulator page
// so the overlay state is deterministic.
async function captureDialogs(browser, wants) {
    // Powered-off variant for the Bootstrap now! power-off guard.
    const CFG_POWEROFF = Object.assign({}, CFG_TTY, { powerOn: false, autoBoot: false });

    // Open a fresh emulator page with the given config; seeds the onboarding
    // "seen" flag unless opts.firstRun is set (so the welcome overlay shows).
    async function open(cfg, opts) {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        await page.evaluateOnNewDocument((seed) => {
            try {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
                if (seed.onboarding) {
                    localStorage.setItem("yapdp.onboarding.v1", "done");
                } else {
                    // First run: every scenario tab shares one browser-local
                    // storage for the same origin, so a "seen" flag written by
                    // an earlier page would otherwise suppress the overlay.
                    // Explicitly drop it to guarantee a genuine first launch.
                    localStorage.removeItem("yapdp.onboarding.v1");
                }
            } catch (err) { /* ignore storage errors */ }
        }, { cfg, onboarding: !(opts && opts.firstRun) });
        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 60000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        try {
            await page.evaluate(() => document.fonts.ready);
        } catch (err) { /* ignore */ }
        await sleep(2500);
        return page;
    }

    async function snap(page, file, wait) {
        try {
            await sleep(wait || 600);
            await page.screenshot({ path: path.join(OUT_DIR, file), type: "png" });
            console.log(`  saved ${file}`);
        } catch (err) {
            console.error(`  FAILED ${file}: ${err.message}`);
        } finally {
            await page.close();
        }
    }

    console.log("\n== dialogs & overlays ==");

    // 1. First-run onboarding hint (fresh profile, no "seen" flag).
    if (wants("dialog-onboarding")) {
        const page = await open(CFG_POWEROFF, { firstRun: true });
        await snap(page, "dialog-onboarding.png", 1500);
    }

    // 2. Quick-boot picker listing every guest OS.
    if (wants("dialog-quickboot")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => {
            const btn = document.getElementById("quick-boot-btn");
            if (btn) btn.click();
        });
        await snap(page, "dialog-quickboot.png", 800);
    }

    // 3. "Autoloading in progress" balloon while the wizard types the boot.
    if (wants("dialog-autoload")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => {
            const btn = document.getElementById("quick-boot-btn");
            if (btn) btn.click();
        });
        await sleep(400);
        await page.evaluate(() => {
            const opt = document.querySelector(".quickboot-option");
            if (opt) opt.click();
        });
        await snap(page, "dialog-autoload.png", 1000);
    }

    // 4. Image load failure dialog (Offered "Open Storage").
    if (wants("dialog-imgerror")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => {
            if (typeof window.reportImageLoadError === "function") {
                window.reportImageLoadError("rp1.dsk", "network");
            }
        });
        await snap(page, "dialog-imgerror.png", 600);
    }

    // 5. Bootstrap now! power-off guard (machine must be powered on).
    if (wants("dialog-poweroff")) {
        const page = await open(CFG_POWEROFF);
        await page.evaluate(() => window.switchPage("panel"));
        await sleep(400);
        await page.evaluate(() => {
            const btn = document.getElementById("panel-boot-btn");
            if (btn) btn.click();
        });
        await snap(page, "dialog-poweroff.png", 600);
    }

    // 6. Unapplied-configuration leave warning (dirty form, no Apply yet).
    if (wants("dialog-config-leave")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => window.switchPage("config"));
        await sleep(400);
        await page.evaluate(() => {
            const cb = document.getElementById("config-upperCaseOnly");
            if (cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
            if (typeof window.configConfirmLeave === "function") {
                window.configConfirmLeave(function () {}, function () {});
            }
        });
        await snap(page, "dialog-config-leave.png", 600);
    }

    // 7. Reboot confirmation dialog.
    if (wants("dialog-reboot")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => {
            const btn = document.getElementById("reboot-btn");
            if (btn) btn.click();
        });
        await snap(page, "dialog-reboot.png", 600);
    }

    // 8. Machine-state dialog (STATE button) with one freshly saved state.
    if (wants("dialog-state")) {
        const page = await open(CFG_TTY);
        await page.evaluate(() => {
            const btn = document.getElementById("state-btn");
            if (btn) btn.click();
        });
        await sleep(400);
        await page.evaluate(() => {
            const save = document.getElementById("snap-save");
            if (save) save.click();
        });
        await snap(page, "dialog-state.png", 900);
    }
}

// Capture the VT11 Display page with Lunar Lander running. The quick-boot
// wizard selects the "lander" paper tape, reboots and types "boot pr"; the
// landing scene then draws on the vector display over the following seconds.
async function captureVt11Lander(browser) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, { cfg: CFG_LANDER });

    console.log("\n== VT11 Lunar Lander ==");
    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    try {
        await page.evaluate(() => document.fonts.ready);
    } catch (err) { /* ignore */ }
    await sleep(2500);

    // Open the quick-boot picker and launch Lunar Lander.
    await page.evaluate(() => {
        const btn = document.getElementById("quick-boot-btn");
        if (btn) btn.click();
    });
    await sleep(500);
    await page.evaluate(() => {
        const opt = document.querySelector(
            '.quickboot-option[data-quickboot-device="lander"]');
        if (opt) opt.click();
    });

    // Wait until the wizard switches to the Display page (or time out), then
    // give the vector display a couple of minutes to draw the terrain and the
    // landing module. Moving the mouse across the window keeps the page
    // painting, so the VT11 vector updates become visible.
    let onDisplay = false;
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        onDisplay = await page.evaluate(() => {
            const p = document.getElementById("page-vt11");
            return !!(p && p.classList.contains("active"));
        });
        if (onDisplay) break;
    }
    if (onDisplay) {
        const total = 150000; // ~2.5 minutes of vector drawing
        const steps = 60;
        for (let i = 0; i < steps; i++) {
            await page.mouse.move(
                80 + ((i * 97) % 1100),
                80 + ((i * 71) % 620));
            await sleep(Math.round(total / steps));
        }
    }

    try {
        await page.evaluate(() => window.switchPage("vt11"));
        await sleep(1500);
        const file = path.join(OUT_DIR, "vt11.png");
        await page.screenshot({ path: file, type: "png" });
        console.log(`  saved vt11.png (${Math.round(fs.statSync(file).size / 1024)} kB)`);
    } catch (err) {
        console.error(`  FAILED vt11.png: ${err.message}`);
    }
    await page.close();
}

// --- Main -----------------------------------------------------------------

(async function main() {
    let server = null;
    let browser = null;
    try {
        // Optional CLI selector: a file name without the .png suffix. When
        // given, only the matching screenshot is generated, so the slow Lunar
        // Lander capture does not force the whole manual batch.
        const selector = (process.argv[2] || "").toLowerCase().replace(/\.png$/, "");
        function wants(name) {
            return !selector ||
                name.toLowerCase().replace(/\.png$/, "") === selector;
        }

        fs.mkdirSync(OUT_DIR, { recursive: true });
        server = await ensureServer();
        browser = await launchBrowser();

        const shotsTTY = SHOTS_TTY.filter((s) => wants(s.file));
        const shotsVT52 = SHOTS_VT52.filter((s) => wants(s.file));
        if (shotsTTY.length) {
            await captureScenario(browser, CFG_TTY, shotsTTY, "teletype console");
        }
        if (shotsVT52.length) {
            await captureScenario(browser, CFG_VT52, shotsVT52, "VT52 console");
        }
        if (BUTTON_SHOTS.some((b) => wants(b.file))) {
            await captureButtons(browser, wants);
        }
        if (wants("dialog-onboarding") || wants("dialog-quickboot") ||
            wants("dialog-autoload") || wants("dialog-imgerror") ||
            wants("dialog-poweroff") || wants("dialog-config-leave") ||
            wants("dialog-reboot") || wants("dialog-state")) {
            await captureDialogs(browser, wants);
        }
        if (wants("vt11")) {
            await captureVt11Lander(browser);
        }

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
