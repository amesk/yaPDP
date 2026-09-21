#!/usr/bin/env node
/**
 * yaPDP on-screen keyboard end-to-end test (puppeteer + real Chromium).
 *
 * A touch device has no physical keyboard, so every terminal grows an invisible
 * <textarea> bridge (src/mobile-input.js) that a tap on the tube focuses —
 * focusing an editable element is what raises the SYSTEM keyboard. The bridge
 * lives in one helper (installCanvasMobileKeyboard, src/pdp11-app.js) and the
 * CONFIG → DEVELOPMENT "VT52 text mode" switch is applied LIVE, without a
 * reload.
 *
 * The fault this file guards:
 *   a terminal STARTED in text mode, with the switch then turned OFF, kept a
 *   canvas that was visible and interactive, the physical-keyboard handlers
 *   installed — and no bridge, because only initVT52Page()'s canvas branch ever
 *   created one. Tapping the tube raised nothing for the rest of the session,
 *   and nothing in the DOM said why: the missing element was invisible by
 *   design.
 *
 * Checks:
 *   1. text mode ON: the terminal IS a real textarea (canvas hidden), and no
 *      canvas bridge exists — nothing to bridge while the textarea is focused;
 *   2. turning the CONFIG option OFF (the user's own gesture: uncheck +
 *      `change`) puts the canvas back AND installs the bridge;
 *   3. tapping the tube focuses THAT terminal's bridge — the gesture that asks
 *      the browser for the keyboard;
 *   4. what the keyboard types reaches the right DL11 unit (console = 0,
 *      TT1 = 1) as the same 7-bit bytes a physical key produces;
 *   5. re-applying the switch does not install a second bridge (every CONFIG
 *      Apply re-runs applyVT52TextMode);
 *   6. control: a terminal STARTED in canvas mode has its bridge from the first
 *      moment, with no switch touched.
 *
 * Run with:  node tests/e2e-mobile-input.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;

// The arrangement the fault needed: a VT52 console plus one VT52 user terminal,
// STARTED in text mode, so the switch can be turned off live afterwards.
const CFG_TEXT_MODE = {
    consoleType: "vt52",
    userTerminals: 1,
    userTerminalTypes: ["vt52"],
    printer: false,
    vt11: false,
    teletypeSpeed: "fast",
    powerOn: true,
    autoBoot: false,
    vt52TextMode: true
};

// Control: the same machine, canvas from the start.
const CFG_CANVAS = Object.assign({}, CFG_TEXT_MODE, { vt52TextMode: false });

const CONSOLE = {
    page: "page-vt52-console",
    canvas: "vt52-console-screen",
    textarea: "console_vt52_textarea"
};
const TT1 = { page: "page-vt52", canvas: "vt52-screen", textarea: "tty1_textarea" };

let failures = 0;
const pageErrors = [];

// --- helpers ---------------------------------------------------------------

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

async function openPage(browser, cfg) {
    const page = await browser.newPage();
    // Touch emulation is exactly what the app detects: MobileInput.isCoarse()
    // answers true from the emulated maxTouchPoints (or pointer: coarse). The
    // viewport stays desktop-sized so the tube is laid out as in the other e2e
    // suites — the responsive layout has its own test (tests/mobile-css.test.js).
    await page.setViewport({ width: 1400, height: 900, hasTouch: true });
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, cfg);

    await page.goto(`${BASE}/pdp11.html?bridge=1`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function" &&
        typeof window.applyVT52TextMode === "function",
        { timeout: 30000 });
    return page;
}

async function showPage(page, pageId) {
    await page.evaluate((id) => {
        const ov = document.getElementById("modal-overlay");
        if (ov) { ov.classList.remove("visible"); ov.style.display = "none"; }
        window.switchPage(id.replace(/^page-/, ""));
    }, pageId);
    await sleep(1200);
}

// What a terminal's two rendering paths look like right now, and whether the
// tap-to-focus bridge exists on its canvas.
function readTerminal(page, spec) {
    return page.evaluate((s) => {
        const canvas = document.getElementById(s.canvas);
        const ta = document.getElementById(s.textarea);
        const bridge = canvas ? canvas.__yapdpMobileBridge : null;
        return {
            canvasDisplay: canvas ? getComputedStyle(canvas).display : "(no canvas)",
            textareaDisplay: ta ? getComputedStyle(ta).display : "(no textarea)",
            hasBridge: !!(bridge && bridge.element),
            bridgeFocused: !!(bridge && bridge.element &&
                document.activeElement === bridge.element)
        };
    }, spec);
}

// The gesture itself: a tap in the middle of the tube. A tap Chrome does not
// turn into a click proves nothing about the bridge, so the plain click the
// same listener answers is used as the fallback.
async function tapTube(page, spec) {
    const point = await page.evaluate((s) => {
        const canvas = document.getElementById(s.canvas);
        const crt = canvas ? canvas.parentElement : null;
        if (!crt) return null;
        const q = crt.getBoundingClientRect();
        return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) };
    }, spec);
    if (!point) return null;
    await page.touchscreen.tap(point.x, point.y);
    await sleep(300);
    let state = await readTerminal(page, spec);
    if (!state.bridgeFocused) {
        await page.mouse.click(point.x, point.y);
        await sleep(400);
        state = await readTerminal(page, spec);
    }
    return { point: point, focused: state.bridgeFocused };
}

// Count what the emulator actually received, per unit, by wrapping the internal
// bridge the page itself uses (same seam the paste and quick-boot features take).
async function installByteSpy(page) {
    await page.evaluate(() => {
        const bridge = window.__yapdpBridge;
        window.__kbBytes = [];
        if (!bridge || bridge.__kbSpied) return;
        const orig = bridge.dlReceiveQueue.bind(bridge);
        bridge.__kbSpied = true;
        bridge.dlReceiveQueue = function (unit, bytes) {
            window.__kbBytes.push({
                unit: unit,
                bytes: Array.prototype.slice.call(bytes || [])
            });
            return orig(unit, bytes);
        };
    });
}

function flattenForUnit(entries, unit) {
    return entries
        .filter((e) => e.unit === unit)
        .reduce((acc, e) => acc.concat(e.bytes), []);
}

function check(name, cond, extra) {
    if (cond) {
        console.log("PASS: " + name);
    } else {
        failures++;
        console.log("FAIL: " + name + (extra ? " — " + extra : ""));
    }
}

async function artifact(page, name) {
    try {
        require("fs").mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({
            path: path.join(ARTIFACTS, "e2e-mobile-input-" + name + ".png"), type: "png"
        });
    } catch (err) { /* best effort */ }
}

// --- main ------------------------------------------------------------------

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    try {
        const page = await openPage(browser, CFG_TEXT_MODE);

        // ---- 0. the emulation really is seen as a touch device ---------------
        const coarse = await page.evaluate(() =>
            typeof MobileInput !== "undefined" && MobileInput.isCoarse());
        check("the emulated device is detected as touch-only", coarse === true);

        // ---- 1. started in text mode: a textarea, and no canvas bridge -------
        await showPage(page, CONSOLE.page);
        const textMode = await readTerminal(page, CONSOLE);
        check("text mode shows the plain textarea and hides the canvas",
            textMode.textareaDisplay === "block" && textMode.canvasDisplay === "none",
            JSON.stringify(textMode));
        check("text mode installs no canvas bridge (the textarea is the input)",
            textMode.hasBridge === false, JSON.stringify(textMode));

        // ---- 2. the CONFIG switch, turned off live --------------------------
        // Exactly the user's gesture: uncheck and let the page handle `change`,
        // which persists the setting and applies it without a reload.
        const flipped = await page.evaluate(() => {
            const el = document.getElementById("config-vt52TextMode");
            if (!el) return { ok: false, reason: "no checkbox" };
            el.checked = false;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, stored: !!Config.get().vt52TextMode };
        });
        check("the CONFIG text-mode checkbox is wired and responds",
            flipped.ok === true && flipped.stored === false, JSON.stringify(flipped));
        await sleep(500);

        const canvasMode = await readTerminal(page, CONSOLE);
        check("turning the option off puts the canvas CRT back",
            canvasMode.canvasDisplay === "block" && canvasMode.textareaDisplay === "none",
            JSON.stringify(canvasMode));
        check("turning the option off INSTALLS the canvas keyboard bridge",
            canvasMode.hasBridge === true, JSON.stringify(canvasMode));

        // ---- 3. the tap that raises the keyboard ----------------------------
        const tapped = await tapTube(page, CONSOLE);
        check("a tap on the tube focuses that terminal's bridge",
            !!(tapped && tapped.focused), JSON.stringify(tapped && tapped.focused));

        // ---- 4. the typed bytes reach the guest's console -------------------
        await installByteSpy(page);
        await page.keyboard.type("AB");
        await page.keyboard.press("Enter");
        await sleep(500);
        const consoleBytes = flattenForUnit(await page.evaluate(() => window.__kbBytes), 0);
        check("the on-screen keyboard delivers its bytes to DL11 unit 0",
            JSON.stringify(consoleBytes) === "[65,66,13]",
            JSON.stringify(consoleBytes));

        // The bridge is per terminal: TT1's tube focuses TT1's bridge, and its
        // bytes go to unit 1 — the console must not see them.
        await showPage(page, TT1.page);
        const tt1 = await readTerminal(page, TT1);
        check("TT1 has a canvas bridge of its own", tt1.hasBridge === true,
            JSON.stringify(tt1));
        const tt1Tap = await tapTube(page, TT1);
        check("a tap on TT1's tube focuses TT1's bridge",
            !!(tt1Tap && tt1Tap.focused), JSON.stringify(tt1Tap && tt1Tap.focused));
        await page.evaluate(() => { window.__kbBytes = []; });
        await page.keyboard.type("Z");
        await sleep(500);
        const allBytes = await page.evaluate(() => window.__kbBytes);
        check("TT1's bytes go to DL11 unit 1, not to the console",
            JSON.stringify(flattenForUnit(allBytes, 1)) === "[90]" &&
            flattenForUnit(allBytes, 0).length === 0,
            JSON.stringify(allBytes));

        // ---- 5. re-applying must not multiply the bridges -------------------
        const repeats = await page.evaluate((spec) => {
            const count = () => document.querySelectorAll("textarea.mobile-input").length;
            const canvas = document.getElementById(spec.canvas);
            const firstElement = canvas.__yapdpMobileBridge.element;
            const before = count();
            window.applyVT52TextMode(false);
            window.applyVT52TextMode(false);
            return {
                before: before,
                after: count(),
                sameElement: canvas.__yapdpMobileBridge.element === firstElement
            };
        }, CONSOLE);
        check("re-applying the switch keeps one bridge per terminal",
            repeats.before === repeats.after && repeats.sameElement === true,
            JSON.stringify(repeats));

        // ---- 6. control: canvas from the first moment -----------------------
        const control = await openPage(browser, CFG_CANVAS);
        await showPage(control, CONSOLE.page);
        const controlState = await readTerminal(control, CONSOLE);
        check("a terminal started in canvas mode has its bridge without touching the switch",
            controlState.canvasDisplay === "block" && controlState.hasBridge === true,
            JSON.stringify(controlState));
        const controlTap = await tapTube(control, CONSOLE);
        check("and its tube focuses the bridge on the first tap",
            !!(controlTap && controlTap.focused), JSON.stringify(controlTap && controlTap.focused));
        await control.close();

        // ---- page errors ----------------------------------------------------
        check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
        if (pageErrors.length) await artifact(page, "errors");
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\ne2e-mobile-input: ALL CHECKS PASSED"
        : `\ne2e-mobile-input: ${failures} failure(s)`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
