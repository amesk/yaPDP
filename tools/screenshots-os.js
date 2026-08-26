#!/usr/bin/env node
/**
 * yaPDP — Guest-OS screenshot generator.
 *
 * Boots each guest operating system through the same quick-boot wizard a
 * user would use (opens the magic-wand picker and clicks the scenario), lets
 * the boot sequence reach its ready state, optionally types a demo command so
 * the shot looks alive, and saves a PNG with a configured file name and
 * resolution into assets/images/os/.
 *
 * Unlike screenshots-manual.js (which captures static emulator pages), this
 * tool captures the emulator in the middle of running a real guest OS, so it
 * drives the console exactly like quickboot.js does:
 *   - readiness is detected by wrapping window.__consoleOutputHook (the same
 *     hook iopage.js feeds for every console character) and waiting for a
 *     per-OS marker ("#", "RT-11", "*O "...);
 *   - demo commands are typed through window.dlReceiveQueue(0, bytes), the
 *     same queue the physical keyboard uses.
 *
 * Each scenario seeds a config that exactly matches the OS hardware profile
 * (see OS_CFG), so the wizard sees no profile change and skips its reload
 * path — the boot starts immediately on the loaded page.
 *
 * Usage:
 *   node tools/screenshots-os.js            # all shots
 *   node tools/screenshots-os.js bsd        # only the 'bsd' shot (file name
 *                                           # without .png, or a device key)
 *   npm run screenshots:os
 *
 * Output: assets/images/os/<file>.png
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const consoleWait = require("./console-wait");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "images", "os");
const PORT = 11790;
const BASE = `http://127.0.0.1:${PORT}`;

// Default capture resolution; a shot may override width/height.
const WIDTH = 1280;
const HEIGHT = 800;

// --- Guest OS boot / demo scenarios --------------------------------------
// `device`     — quick-boot scenario key (see src/osboot.js BOOT_SCENARIOS)
// `file`       — output PNG file name
// `width/height` — capture resolution for this shot
// `readyWhen`  — console marker meaning "the OS is up"; the tool waits for it
//                after the wizard types the boot sequence. null = special
//                handling (Lunar Lander draws on the VT11, not the console).
// `extra`      — demo commands typed after readiness, each followed by Enter
// `settle`     — extra wait (ms) after the last command before the capture

// BASIC-11 demo program: a tiny banner loop, then RUN so the shot shows real
// BASIC output, not just the "*O " prompt.
const BASIC_PROGRAM = [
    '10 PRINT "YA PDP-11/70"',
    "20 FOR I = 1 TO 5",
    "30 PRINT I, I * I",
    "40 NEXT I",
    "50 END",
    "RUN"
];

const OS_SHOTS = [
    // Unix V5: punch the boot banner and `cal 8 2026` onto paper tape, so
    // the tape spool is visible in the shot. The shell prompt "#" can also
    // appear inside kernel boot text, so it is only accepted after "login:"
    // (auto-login has completed and the shell really is up).
    { device: "rk0",    file: "unix_v5.png",      width: WIDTH, height: HEIGHT,
        readyWhen: "#", readyAfter: "login:", extra: ["cal 8 2026"], settle: 6000, punch: true },
    { device: "rp1",    file: "bsd.png",          width: WIDTH, height: HEIGHT,
        readyWhen: "#", readyAfter: "login:", extra: ["man cal"], settle: 10000 },
    // RT-11: it is logically booted within a couple of seconds, but the
    // teletype prints the whole boot (~500 chars) at teletype speed, so we
    // wait until the console output stops growing (`stable`) — by then the
    // paper shows the full boot and the "." prompt.
    { device: "rk1",    file: "rt11.png",         width: WIDTH, height: HEIGHT,
        readyWhen: null, stable: 2500, extra: [], settle: 1500 },
    // RT-11 on a DECscope VT52 operator console — same rk1 image, different
    // look, so the carousel shows both console types.
    { device: "rk1vt52", file: "rt11-vt52.png",   width: WIDTH, height: HEIGHT,
        readyWhen: null, stable: 2500, extra: [], settle: 1500 },
    // XXDP+ diagnostics: answer the date prompt with 09-SEP-78, then wait
    // for the "." monitor prompt (console output stability).
    { device: "rk3",    file: "xxdp.png",         width: WIDTH, height: HEIGHT,
        readyWhen: "ENTER DATE", extra: ["09-SEP-78"],
        stableAfterExtra: 2500, settle: 1500 },
    // BASIC-11: engage the punch before boot so the program and its RUN
    // output are duplicated onto the paper tape, making the tape visible.
    { device: "basic",  file: "basic.png",        width: WIDTH, height: HEIGHT,
        readyWhen: "*O", extra: BASIC_PROGRAM, settle: 5000, punch: true },
    { device: "lander", file: "lunar-lander.png", width: WIDTH, height: HEIGHT,
        readyWhen: null, extra: [], settle: 0 }
];

// Machine profile seeded per device — mirrors the `hardware` block of each
// OSBoot scenario so the wizard's hardwareDirty() check passes and no reload
// is triggered mid-run. Shared keys (fast teletype, powered on, no autoboot)
// are merged in captureOS().
const OS_CFG = {
    rk0:    { consoleType: "teletype", printer: false, vt11: false },
    rp1:    { consoleType: "vt52",     printer: true,  vt11: false },
    rk1:    { consoleType: "teletype", printer: true,  vt11: false },
    rk1vt52: { consoleType: "vt52",    printer: true,  vt11: false },
    rk3:    { consoleType: "teletype", printer: false, vt11: false },
    basic:  { consoleType: "teletype", printer: false, vt11: false },
    lander: { consoleType: "teletype", printer: false, vt11: true }
};

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

// Poll `fn` until it returns true or the timeout (ms) elapses.
async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

// --- Page-side helpers ----------------------------------------------------

// Open a fresh emulator page seeded with a config that exactly matches the
// OS hardware profile, and wrap the console-output hook so we can watch for
// the OS readiness marker.
async function openPage(browser, shot) {
    const page = await browser.newPage();
    await page.setViewport({ width: shot.width, height: shot.height });

    const cfg = Object.assign({
        consoleType: "teletype",
        userTerminals: 0,
        printer: false,
        vt11: false,
        // Fast teletype speed: the paper prints at ~30ms/char instead of
        // ~100ms (authentic), so the whole boot prints ~3x quicker and the
        // shots generate faster. The screenshot still shows a normal teletype.
        teletypeSpeed: "fast",
        powerOn: true,         // machine powered on at startup
        autoBoot: false        // the wizard issues the boot itself
    }, OS_CFG[shot.device] || {});

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, { cfg });

    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    try {
        await page.evaluate(() => document.fonts.ready);
    } catch (err) { /* fonts API may be missing in headless */ }

    // Wrap the generation + render hooks (see tools/console-wait.js) so the
    // capture can wait until the paced paper render has fully printed the boot.
    await consoleWait.installConsoleHooks(page);

    return page;
}

// Launch the quick-boot wizard for a device by clicking the magic-wand
// button and then the matching scenario option — the same interaction the
// manual screenshot generator uses for Lunar Lander.
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

// Type text followed by Enter into the operator console, exactly like the
// wizard does (window.dlReceiveQueue(0, bytes)).
async function typeText(page, text) {
    await page.evaluate((t) => {
        const bytes = [];
        for (let i = 0; i < t.length; i++) bytes.push(t.charCodeAt(i) & 0x7F);
        bytes.push(13); // Enter
        if (typeof window.dlReceiveQueue === "function") {
            window.dlReceiveQueue(0, bytes);
        }
    }, text);
}

// Whether the accumulated console output contains the readiness marker.
async function outputContains(page, needle) {
    return page.evaluate((n) => {
        return !!(window.__osShotOutput &&
            window.__osShotOutput.indexOf(n) !== -1);
    }, needle);
}

// Whether the accumulated console output contains `needle` at or after the
// LAST occurrence of `after`. Used for markers that can legitimately appear
// early (e.g. "#" inside boot text) but should only be trusted once a
// specific milestone (e.g. "login:") has been reached.
async function outputContainsAfter(page, needle, after) {
    return page.evaluate((n, a) => {
        const out = window.__osShotOutput || "";
        const start = a ? out.lastIndexOf(a) : 0;
        return start !== -1 && out.indexOf(n, start) !== -1;
    }, needle, after);
}

// Current length of the captured console output.
async function outputLength(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

// Wait until the console output stops growing for `stableMs` (the teletype
// has finished printing), or the timeout elapses. Some OSes are logically
// booted long before their paper output has fully printed (RT-11 prints its
// whole ~500-char boot at teletype speed), so a fixed settle after an early
// marker captures a half-printed screen.
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

// --- Captures -------------------------------------------------------------

// One console-based guest OS: boot via the wizard, wait for the ready
// marker, type the demo commands, settle and capture.
async function captureConsoleOS(browser, shot) {
    const page = await openPage(browser, shot);
    try {
        // Engage the paper-tape punch before booting so the boot banner and
        // the demo command are duplicated onto the tape (visible in the shot).
        if (shot.punch) {
            await page.evaluate(() => {
                if (typeof window.setTtyPunch === "function") {
                    window.setTtyPunch(true);
                }
            });
            await sleep(300);
        }
        await launchDevice(page, shot.device);

        if (shot.readyWhen) {
            // Wait for the OS prompt in the GENERATED output (e.g. "#" after
            // login, "*O " for BASIC); the render is drained below.
            const ok = await waitFor(
                () => shot.readyAfter
                    ? outputContainsAfter(page, shot.readyWhen, shot.readyAfter)
                    : outputContains(page, shot.readyWhen), 90000);
            if (!ok) {
                console.error(`  WARN: readiness marker '${shot.readyWhen}' not seen`);
            }
            // Let the wizard finish its own trailing input (e.g. BASIC's
            // empty Enter after "*O ") before we type demo commands.
            await sleep(1500);
        }

        // Drain the paper: wait until every generated character has actually
        // been rendered at the authentic teletype pace, so the shot shows the
        // full boot and the final prompt instead of cutting mid-print.
        const drained = await consoleWait.waitRenderStable(page,
            shot.stable || 2500, 120000);
        if (!drained) {
            console.error("  WARN: console did not finish rendering the boot");
        }

        for (const cmd of shot.extra || []) {
            await typeText(page, cmd);
            await sleep(700);
        }

        if (shot.stableAfterExtra) {
            // Wait for the demo-command response to be fully rendered.
            const ok = await consoleWait.waitRenderStable(page,
                shot.stableAfterExtra, 120000);
            if (!ok) {
                console.error("  WARN: console did not finish rendering the response");
            }
        }

        await sleep(shot.settle || 2000);

        const file = path.join(OUT_DIR, shot.file);
        await page.screenshot({ path: file, type: "png" });
        const kb = Math.round(fs.statSync(file).size / 1024);
        console.log(`  saved ${shot.file} (${kb} kB)`);
    } finally {
        await page.close();
    }
}

// Lunar Lander draws on the VT11 vector display, not the console. Boot it
// through the wizard, wait for the Display page, let the vector drawing
// settle (moving the mouse keeps the page painting), then capture.
async function captureLander(browser, shot) {
    const page = await openPage(browser, shot);
    try {
        await launchDevice(page, "lander");

        let onDisplay = false;
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            onDisplay = await page.evaluate(() => {
                const p = document.getElementById("page-vt11");
                return !!(p && p.classList.contains("active"));
            });
            if (onDisplay) break;
        }
        if (!onDisplay) {
            throw new Error("Lunar Lander did not switch to the Display page");
        }

        // Wait for the game to start drawing on the green-phosphor canvas —
        // terrain vectors appear — then let the lander module descend into
        // view before capturing.
        let started = false;
        for (let i = 0; i < 90; i++) {
            await sleep(1000);
            started = await page.evaluate(() => {
                const c = document.querySelector("#vt11 canvas");
                if (!c) return false;
                try {
                    const ctx = c.getContext("2d");
                    const d = ctx.getImageData(0, 0, c.width, c.height).data;
                    let lit = 0;
                    // Green-phosphor vectors: bright green pixels.
                    for (let i = 0; i < d.length && lit <= 500; i += 4) {
                        if (d[i + 1] > 80) lit++;
                    }
                    return lit > 500;
                } catch (err) {
                    return false;
                }
            });
            if (started) break;
        }
        if (!started) {
            console.error("  WARN: no content detected on the VT11 canvas");
        }

        // Give the lander module time to descend and the scene to settle.
        // Moving the mouse across the window keeps the page painting.
        const total = 45000; // ~45 s of vector drawing
        const steps = 45;
        for (let i = 0; i < steps; i++) {
            await page.mouse.move(
                80 + ((i * 97) % 1100),
                80 + ((i * 71) % 620));
            await sleep(Math.round(total / steps));
        }
        await page.evaluate(() => window.switchPage("vt11"));
        await sleep(1500);

        const file = path.join(OUT_DIR, shot.file);
        await page.screenshot({ path: file, type: "png" });
        const kb = Math.round(fs.statSync(file).size / 1024);
        console.log(`  saved ${shot.file} (${kb} kB)`);
    } finally {
        await page.close();
    }
}

// --- Main -----------------------------------------------------------------

(async function main() {
    let server = null;
    let browser = null;
    try {
        // Optional CLI selector: a file name without the .png suffix or a
        // device key. When given, only the matching shot is generated, so a
        // slow shot (e.g. Lunar Lander) does not force the whole batch.
        const selector = (process.argv[2] || "").toLowerCase().replace(/\.png$/, "");

        fs.mkdirSync(OUT_DIR, { recursive: true });
        server = await ensureServer();
        browser = await launchBrowser();

        for (const shot of OS_SHOTS.filter((s) =>
            !selector || s.file === selector + ".png" || s.device === selector)) {
            console.log(`\n== ${shot.device} -> ${shot.file} ==`);
            try {
                if (shot.device === "lander") {
                    await captureLander(browser, shot);
                } else {
                    await captureConsoleOS(browser, shot);
                }
            } catch (err) {
                console.error(`  FAILED ${shot.file}: ${err.message}`);
            }
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
