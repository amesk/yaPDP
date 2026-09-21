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
 *   5. typing that an IME COMPOSES is delivered keystroke by keystroke, and the
 *      commit does not send it twice (simulated through CDP's IME API);
 *   6. the special-key bar: built on a touch device only, its ↵ and ^C keys send
 *      the right bytes, CTRL latches and clears, and it keeps the keyboard on
 *      the terminal it types into;
 *   7. re-applying the switch does not install a second bridge (every CONFIG
 *      Apply re-runs applyVT52TextMode);
 *   8. controls: a terminal STARTED in canvas mode has its bridge at once; a
 *      fine-pointer desktop gets no bar and no bridge; and on a phone frame the
 *      page declares a mobile viewport, lays out at the device width, applies
 *      the mobile stylesheet and ACCEPTS a zoom (a phone can pinch it).
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

// opts.touch === false opens a plain desktop page (the control for everything
// the mobile layer must NOT do there); opts.viewport overrides the window size
// (the phone geometry check); opts.mobile makes Chromium a MOBILE device, which
// is where a missing <meta name="viewport"> shows: the layout viewport then
// falls back to ~980px and the phone layout never matches.
async function openPage(browser, cfg, opts) {
    const page = await browser.newPage();
    const touch = !opts || opts.touch !== false;
    // Touch emulation is exactly what the app detects: MobileInput.isCoarse()
    // answers true from the emulated maxTouchPoints (or pointer: coarse). The
    // viewport stays desktop-sized so the tube is laid out as in the other e2e
    // suites — the responsive layout has its own test (tests/mobile-css.test.js).
    const size = (opts && opts.viewport) || { width: 1400, height: 900 };
    await page.setViewport({
        width: size.width, height: size.height, hasTouch: touch,
        isMobile: !!(opts && opts.mobile)
    });
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

// How big a page scale a page ACCEPTS. A synthetic pinch gesture cannot be
// measured in this headless build — the control page in section 10 does not zoom
// to one either — so the zoom POLICY is measured the way the browser exposes it:
// a page that allows zoom takes the scale, one that forbids it clamps to 1.
async function pageScaleAfter(page, factor) {
    const client = await page.createCDPSession();
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: factor });
    await sleep(200);
    const scale = await page.evaluate(() =>
        window.visualViewport ? window.visualViewport.scale : -1);
    await client.detach();
    return scale;
}

// One key of the special-key bar, pressed the way an operator presses it: a
// real tap, or a real click on a page opened without touch emulation.
async function clickKey(page, keyId, touch) {
    const point = await page.evaluate((id) => {
        const b = document.querySelector('.mobile-key[data-key="' + id + '"]');
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) };
    }, keyId);
    if (!point) return false;
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await sleep(250);
    return true;
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

        // ---- 5. the special-key bar -----------------------------------------
        // Enter and Ctrl+letter are the two things a phone's own keyboard cannot
        // deliver (an IME action, and a modifier the OS keyboard never sets), so
        // the bar sends them itself — through the same DL11 path a physical key
        // takes, and to the terminal whose page is on screen.
        await showPage(page, CONSOLE.page);
        const bar = await page.evaluate(() => {
            const el = document.getElementById("mobile-keys");
            if (!el) return null;
            return {
                keys: Array.prototype.map.call(el.querySelectorAll(".mobile-key"),
                    (b) => b.getAttribute("data-key")),
                pageTarget: !!MobileInput.findTarget("page-vt52-console")
            };
        });
        check("the special-key bar is built on a touch device",
            !!bar && bar.keys.length > 0, JSON.stringify(bar));
        check("it offers CR, ESC, TAB, BS, RUBOUT and the control codes",
            !!bar && ["cr", "esc", "tab", "bs", "rub", "ctrl", "c", "d", "z", "s", "q"]
                .every((id) => bar.keys.indexOf(id) !== -1),
            bar && JSON.stringify(bar.keys));
        check("the terminal on screen is registered as the bar's target",
            !!bar && bar.pageTarget === true, JSON.stringify(bar));

        // The ↵ key, tapped: the CR an IME action used to swallow.
        await installByteSpy(page);
        await page.evaluate(() => { window.__kbBytes = []; });
        const tappedCr = await clickKey(page, "cr", true);
        const crBytes = await page.evaluate(() => window.__kbBytes);
        check("the bar's ↵ sends CR to the console's DL11 unit",
            tappedCr === true && JSON.stringify(flattenForUnit(crBytes, 0)) === "[13]",
            JSON.stringify(crBytes));

        // ^C on a key of its own, with no keyboard involved at all.
        await page.evaluate(() => { window.__kbBytes = []; });
        await clickKey(page, "c");
        const cBytes = await page.evaluate(() => window.__kbBytes);
        check("the bar's ^C sends 0x03",
            JSON.stringify(flattenForUnit(cBytes, 0)) === "[3]",
            JSON.stringify(cBytes));

        // The CTRL latch: tap CTRL, then type one character on the SYSTEM
        // keyboard, and that character is sent as its control code.
        await page.evaluate(() => { window.__kbBytes = []; });
        await clickKey(page, "ctrl");
        const latched = await page.evaluate(() => {
            const btn = document.querySelector('.mobile-key[data-key="ctrl"]');
            return {
                latched: MobileInput.isCtrlLatched(),
                lit: !!btn && btn.classList.contains("active")
            };
        });
        check("CTRL latches and its key lights up",
            latched.latched === true && latched.lit === true, JSON.stringify(latched));
        await page.keyboard.type("c");
        await sleep(300);
        const afterLatch = await page.evaluate(() => ({
            bytes: window.__kbBytes,
            stillLatched: MobileInput.isCtrlLatched()
        }));
        check("a latched 'c' is sent as 0x03 and the latch clears",
            JSON.stringify(flattenForUnit(afterLatch.bytes, 0)) === "[3]" &&
            afterLatch.stillLatched === false,
            JSON.stringify(afterLatch));

        // The bar must not take the keyboard away from the terminal.
        const focusAfterKeys = await page.evaluate(() => {
            const el = document.activeElement;
            return el ? { cls: el.className, tag: el.tagName } : null;
        });
        check("the bar keeps the keyboard on the terminal",
            !!focusAfterKeys && focusAfterKeys.tag === "TEXTAREA" &&
            focusAfterKeys.cls === "mobile-input",
            JSON.stringify(focusAfterKeys));

        // ---- 5b. typing while the IME composes ------------------------------
        // Android keyboards (GBoard) compose the word before committing it: the
        // characters live in the backing store, `input` fires with
        // isComposing=true, and only the commit carries the final string. Held
        // back until that commit, the machine saw NOTHING while the operator
        // typed — the line appeared in one burst when Enter committed the
        // composition, and that very Enter was the IME action, so the command
        // still needed a second one. Simulated here through CDP's IME API, which
        // is the same event sequence a real keyboard produces.
        await page.evaluate(() => { window.__kbBytes = []; });
        await page.evaluate((spec) => {
            const canvas = document.getElementById(spec.canvas);
            if (canvas && canvas.__yapdpMobileBridge) canvas.__yapdpMobileBridge.focus();
        }, CONSOLE);
        const cdp = await page.createCDPSession();
        await cdp.send("Input.imeSetComposition",
            { text: "d", selectionStart: 1, selectionEnd: 1 });
        await sleep(200);
        await cdp.send("Input.imeSetComposition",
            { text: "di", selectionStart: 2, selectionEnd: 2 });
        await sleep(200);
        const composingBytes = await page.evaluate(() => window.__kbBytes);
        await cdp.send("Input.insertText", { text: "di" });
        await sleep(250);
        const committedBytes = await page.evaluate(() => window.__kbBytes);
        await cdp.detach();
        check("characters typed while the IME composes reach the machine as they are typed",
            JSON.stringify(flattenForUnit(composingBytes, 0)) === "[100,105]",
            JSON.stringify(composingBytes));
        check("and the commit does not send them a second time",
            JSON.stringify(flattenForUnit(committedBytes, 0)) === "[100,105]",
            JSON.stringify(committedBytes));

        // ---- 5c. the bar belongs to the VT52/VT100 pages ---------------------
        // The Model 33 draws its own keycaps (CTRL/SHIFT/REPT/BREAK/HERE IS live
        // on the punch keyboard), so it needs neither the bar nor the system
        // keyboard; the Panel/Printer/Config pages have nothing to type into.
        await showPage(page, "page-teletype");
        // The check reads the RENDERED result, not the class: the first version
        // asserted only that the class was set, and the bar stayed on screen
        // because the `display: flex` rule out-specified the `hidden` state.
        const readBar = () => page.evaluate(() => {
            const bar = document.getElementById("mobile-keys");
            return {
                exists: !!bar,
                cls: !!bar && bar.classList.contains("hidden"),
                display: bar ? getComputedStyle(bar).display : "(no bar)",
                height: bar ? Math.round(bar.getBoundingClientRect().height) : -1
            };
        });
        const barAway = await readBar();
        check("the special-key bar really leaves the Model 33 page",
            barAway.exists === true && barAway.display === "none" && barAway.height === 0,
            JSON.stringify(barAway));

        const paperPoint = await page.evaluate(() => {
            const paper = document.getElementById("g60printer") ||
                document.getElementById("punchkeypane");
            if (!paper) return null;
            const q = paper.getBoundingClientRect();
            return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + 24) };
        });
        if (paperPoint) await page.touchscreen.tap(paperPoint.x, paperPoint.y);
        await sleep(300);
        const teletypeFocus = await page.evaluate(() => {
            const el = document.activeElement;
            return el ? (el.className || el.tagName) : "(none)";
        });
        check("a tap on the Model 33 paper raises no system keyboard",
            teletypeFocus.indexOf("mobile-input") === -1, JSON.stringify(teletypeFocus));

        // The front panel has nothing to type into either — the page the operator
        // noticed the bar on.
        await showPage(page, "page-panel");
        const barOnPanel = await readBar();
        check("and it is gone from the Panel page too",
            barOnPanel.display === "none" && barOnPanel.height === 0,
            JSON.stringify(barOnPanel));

        await showPage(page, CONSOLE.page);
        const barBack = await readBar();
        check("while it is really back on the VT52/VT100 pages",
            barBack.display === "flex" && barBack.height > 20, JSON.stringify(barBack));

        // ---- 6. re-applying must not multiply the bridges -------------------
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

        // ---- 7. control: canvas from the first moment -----------------------
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

        // ---- 8. control: a desktop gets none of this ------------------------
        const desktop = await openPage(browser, CFG_CANVAS, { touch: false });
        await showPage(desktop, CONSOLE.page);
        const desktopState = await desktop.evaluate(() => ({
            coarse: MobileInput.isCoarse(),
            bar: !!document.getElementById("mobile-keys"),
            bridges: document.querySelectorAll("textarea.mobile-input").length,
            bodyClass: document.body.classList.contains("mobile-keys-on"),
            gestures: document.body.classList.contains("touch-gestures")
        }));
        check("a fine-pointer device is not treated as touch",
            desktopState.coarse === false, JSON.stringify(desktopState));
        check("a desktop gets no special-key bar, no invisible bridge and no touch gestures",
            desktopState.bar === false && desktopState.bridges === 0 &&
            desktopState.bodyClass === false && desktopState.gestures === false,
            JSON.stringify(desktopState));
        await desktop.close();

        // ---- 9. control: the phone geometry --------------------------------
        // The strip is part of the bottom stack, so it must sit BELOW the
        // navigation bar and the floating controls at 390x844 — the one thing a
        // desktop-sized viewport cannot show.
        const phone = await openPage(browser, CFG_CANVAS,
            { viewport: { width: 390, height: 844 } });
        await showPage(phone, CONSOLE.page);
        const geom = await phone.evaluate(() => {
            const bar = document.getElementById("mobile-keys");
            const sidebar = document.querySelector(".app-sidebar");
            const zoom = document.getElementById("zoom-btn");
            const b = bar.getBoundingClientRect();
            const s = sidebar.getBoundingClientRect();
            const z = zoom ? zoom.getBoundingClientRect() : null;
            return {
                barDisplay: getComputedStyle(bar).display,
                barHeight: Math.round(b.height),
                barGapToBottom: Math.round(window.innerHeight - b.bottom),
                sidebarGap: Math.round(b.top - s.bottom),
                sidebarRow: getComputedStyle(sidebar).flexDirection,
                zoomGap: z ? Math.round(b.top - z.bottom) : null
            };
        });
        check("on a phone the strip is docked at the very bottom edge",
            geom.barDisplay === "flex" && geom.barGapToBottom === 0 && geom.barHeight > 20,
            JSON.stringify(geom));
        check("the navigation bar stays above the strip",
            geom.sidebarRow === "row" && geom.sidebarGap >= 0, JSON.stringify(geom));
        check("and the floating controls clear it too",
            geom.zoomGap === null || geom.zoomGap >= 0, JSON.stringify(geom));
        await phone.screenshot({
            path: path.join(ARTIFACTS, "e2e-mobile-keys-phone.png"), type: "png"
        }).catch(() => { });
        await phone.close();

        // ---- 10. the phone frame: the viewport meta and the zoom it allows ----
        // The page carried NO <meta name="viewport"> at all, so a real phone laid
        // it out at the ~980px desktop width: the mobile block never matched and
        // the browser treated the page as a non-zoomable desktop fallback.
        // Chromium is told to be a mobile device here (isMobile), which is what
        // exposes it.
        const phoneFrame = await openPage(browser, CFG_CANVAS,
            { viewport: { width: 390, height: 844 }, mobile: true });
        const frame = await phoneFrame.evaluate(() => {
            const meta = document.querySelector('meta[name="viewport"]');
            const content = meta ? meta.getAttribute("content") : null;
            const sidebar = document.querySelector(".app-sidebar");
            return {
                meta: content,
                layoutWidth: window.innerWidth,
                sidebarRow: getComputedStyle(sidebar).flexDirection,
                scale: window.visualViewport ? window.visualViewport.scale : 1
            };
        });
        check("the emulator page declares a mobile viewport",
            !!frame.meta && /width=device-width/.test(frame.meta), JSON.stringify(frame));
        check("so a phone lays the page out at the device width, not at 980px",
            frame.layoutWidth <= 430, JSON.stringify(frame));
        check("and the mobile stylesheet really applies there",
            frame.sidebarRow === "row", JSON.stringify(frame));
        check("nothing forbids pinch-zoom (no user-scalable=no)",
            !frame.meta || !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(frame.meta),
            JSON.stringify(frame));

        const emulatorScale = await pageScaleAfter(phoneFrame, 1.5);
        check("and the page really accepts a zoom (a phone can pinch it)",
            Math.abs(emulatorScale - 1.5) < 0.01, `scale ${emulatorScale}`);

        // The control that keeps the check above honest: the same command on a
        // page whose viewport forbids zoom is clamped to 1.
        const locked = await browser.newPage();
        await locked.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
        await locked.setContent('<meta name="viewport" content="width=device-width, ' +
            'initial-scale=1, user-scalable=no"><body>locked</body>');
        const lockedScale = await pageScaleAfter(locked, 1.5);
        check("a viewport that forbids zoom is clamped (so the check means something)",
            Math.abs(lockedScale - 1) < 0.01, `scale ${lockedScale}`);
        await locked.close();

        // ---- the bottom stack is one piece ----------------------------------
        // The navigation bar must SIT on the special-key bar (no dead band), and
        // the round floating buttons must clear the navigation bar. This is where
        // the two definitions of "the bottom of the window" (the flow column's
        // 100vh vs the current visual viewport a fixed element anchors to) used to
        // disagree by 26px, dropping the buttons half-way onto the bar.
        const bottomStack = () => phoneFrame.evaluate(() => {
            const box = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                if (getComputedStyle(el).display === "none") return { hidden: true };
                const q = el.getBoundingClientRect();
                return { top: Math.round(q.top), bottom: Math.round(q.bottom) };
            };
            return {
                vh: window.innerHeight,
                nav: box(".app-sidebar"),
                keys: box("#mobile-keys"),
                buttons: [box("#mute-btn"), box("#fullscreen-btn"), box("#zoom-btn")]
                    .filter((b) => b && !b.hidden)
            };
        });
        const clearOfNav = (s) => s.buttons.length > 0 &&
            s.buttons.every((b) => b.bottom <= s.nav.top - 6);

        const withBar = await bottomStack();
        check("on a phone the navigation bar sits on the key bar with no dead band",
            Math.abs(withBar.nav.bottom - withBar.keys.top) <= 2,
            JSON.stringify({ nav: withBar.nav, keys: withBar.keys }));
        check("and the round buttons clear the navigation bar",
            clearOfNav(withBar),
            JSON.stringify({ nav: withBar.nav, buttons: withBar.buttons }));

        await showPage(phoneFrame, "page-panel");
        const withoutBar = await bottomStack();
        check("with the bar off its pages the navigation bar reaches the bottom edge",
            withoutBar.keys.hidden === true &&
            Math.abs(withoutBar.nav.bottom - withoutBar.vh) <= 2,
            JSON.stringify({ nav: withoutBar.nav, vh: withoutBar.vh }));
        check("and the round buttons clear it there too",
            clearOfNav(withoutBar),
            JSON.stringify({ nav: withoutBar.nav, buttons: withoutBar.buttons }));

        await phoneFrame.screenshot({
            path: path.join(ARTIFACTS, "e2e-mobile-keys-phone-frame.png"), type: "png"
        }).catch(() => { });
        await phoneFrame.close();

        // ---- 11. two-finger zoom & pan (a standalone context) ---------------
        // A standalone web app — an iOS home-screen app, a desktop WebView — has
        // no page zoom of its own, so the emulator takes the gesture over: the
        // module scales and pans the ACTIVE MACHINE PAGE. Raw touch events are
        // dispatched here, the path a real finger takes (a synthesised pinch does
        // nothing in this build, measured in section 10). The already-open touch
        // page is reused: one more browser page per check is a minute of nobody's
        // time, and the gesture maths does not depend on the window size.
        await showPage(page, CONSOLE.page);
        const touch = await page.createCDPSession();
        const twoFingers = (spread, dy) => ([
            { x: 195 - spread, y: 400 + (dy || 0), id: 1, radiusX: 6, radiusY: 6, force: 1 },
            { x: 195 + spread, y: 400 + (dy || 0), id: 2, radiusX: 6, radiusY: 6, force: 1 }
        ]);
        const activePageStyle = () => page.evaluate(() => {
            const p = document.querySelector(".page.active");
            return p ? (p.style.transform || "") : "(no page)";
        });
        const scaleOf = (style) => {
            const m = /scale\(([\d.]+)\)/.exec(style);
            return m ? parseFloat(m[1]) : 1;
        };

        await touch.send("Input.dispatchTouchEvent",
            { type: "touchStart", touchPoints: twoFingers(30) });
        await sleep(80);
        await touch.send("Input.dispatchTouchEvent",
            { type: "touchMove", touchPoints: twoFingers(60) });
        await sleep(150);
        const zoomedStyle = await activePageStyle();
        check("two fingers zoom the machine page (standalone gestures)",
            scaleOf(zoomedStyle) > 1.5, zoomedStyle);

        // The zoom is anchored BETWEEN THE FINGERS: the machine point under the
        // centroid (195,400 here — the fingers spread about it) must still be
        // under it. Growing about the page's corner instead throws that point out
        // of view, and the operator has to re-pan after every pinch.
        const zoomState = await page.evaluate(() => TouchZoom.state());
        const localX = (195 - zoomState.pan.x) / zoomState.scale;
        const localY = (400 - zoomState.pan.y) / zoomState.scale;
        check("and it is anchored between the fingers, not at the corner",
            Math.abs(localX - 195) < 8 && Math.abs(localY - 400) < 8,
            JSON.stringify({
                scale: zoomState.scale, pan: zoomState.pan,
                local: [Math.round(localX), Math.round(localY)]
            }));

        await touch.send("Input.dispatchTouchEvent",
            { type: "touchMove", touchPoints: twoFingers(60, -80) });
        await sleep(150);
        const pannedStyle = await activePageStyle();
        check("and dragging the same two fingers pans the picture",
            pannedStyle !== zoomedStyle && /translate\(/.test(pannedStyle), pannedStyle);

        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(80);
        check("the picture stays zoomed after the fingers lift",
            (await activePageStyle()) === pannedStyle);

        // The operator controls of the machine are NOT part of the picture: they
        // live in the pin layer, whose inverse transform keeps them at their own
        // size and place. On a touch device they are the FIRST row — the machine's
        // own controls above the application's round chrome — so the round buttons
        // are pushed below the strip.
        const readRects = () => page.evaluate(() => {
            const rect = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const q = el.getBoundingClientRect();
                return { x: Math.round(q.x), y: Math.round(q.y),
                         w: Math.round(q.width), h: Math.round(q.height) };
            };
            const controls = document.querySelector("#teletype-controls");
            return {
                controls: rect("#teletype-controls"),
                inLayer: !!(controls && controls.closest(".touch-pin")),
                reboot: rect("#reboot-btn"),
                quick: rect("#quick-boot-btn"),
                flagged: document.body.classList.contains("touch-controls")
            };
        });
        await showPage(page, "page-teletype");
        const rectsBefore = await readRects();
        await touch.send("Input.dispatchTouchEvent",
            { type: "touchStart", touchPoints: twoFingers(30) });
        await sleep(80);
        await touch.send("Input.dispatchTouchEvent",
            { type: "touchMove", touchPoints: twoFingers(60) });
        await sleep(150);
        const rectsAfter = await readRects();
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

        check("the teletype's operator controls were moved into the pin layer",
            rectsBefore.inLayer === true, JSON.stringify(rectsBefore.controls));
        check("and they keep their place and size while the machine zooms",
            !!rectsBefore.controls && !!rectsAfter.controls &&
            rectsBefore.controls.x === rectsAfter.controls.x &&
            rectsBefore.controls.y === rectsAfter.controls.y &&
            rectsBefore.controls.w === rectsAfter.controls.w &&
            rectsBefore.controls.h === rectsAfter.controls.h,
            JSON.stringify({ before: rectsBefore.controls, after: rectsAfter.controls }));

        const overlaps = (a, b) => !!a && !!b &&
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const visible = (r) => !!r && r.w > 0 && r.h > 0;
        const pinGeom = {
            controls: rectsAfter.controls,
            quick: rectsBefore.quick,
            reboot: rectsBefore.reboot
        };
        check("the machine's controls are the top row, the round buttons the next one",
            rectsBefore.flagged === true &&
            visible(pinGeom.controls) && visible(pinGeom.reboot) && visible(pinGeom.quick) &&
            pinGeom.controls.y < pinGeom.reboot.y && pinGeom.controls.y < pinGeom.quick.y &&
            !overlaps(pinGeom.controls, pinGeom.reboot) &&
            !overlaps(pinGeom.controls, pinGeom.quick),
            JSON.stringify(pinGeom));

        // Leaving the machine page must not leave a zoomed page behind.
        await showPage(page, "page-config");
        const afterLeave = await page.evaluate(() =>
            document.getElementById("page-vt52-console").style.transform || "");
        check("leaving the machine page resets the view", afterLeave === "",
            JSON.stringify(afterLeave));

        // A page whose machine has no controls of its own (a VT52 tube) must not
        // leave the round buttons pushed down for a strip that is not there.
        await showPage(page, CONSOLE.page);
        const onTube = await readRects();
        check("a page without machine controls keeps the round buttons at the top",
            onTube.flagged === false && visible(onTube.reboot) && onTube.reboot.y < 20,
            JSON.stringify(onTube));

        // A form page is the browser's business: the module must stay out of it.
        // (The page is set here rather than inherited from the check above, so the
        // block stands on its own.)
        await showPage(page, "page-config");
        await touch.send("Input.dispatchTouchEvent",
            { type: "touchStart", touchPoints: twoFingers(30) });
        await sleep(80);
        await touch.send("Input.dispatchTouchEvent",
            { type: "touchMove", touchPoints: twoFingers(70) });
        await sleep(150);
        const configStyle = await activePageStyle();
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        check("a form page (CONFIG) is left to the browser",
            configStyle === "", JSON.stringify(configStyle));

        const layer = await page.evaluate(() => ({
            installed: document.body.classList.contains("touch-gestures"),
            api: typeof TouchZoom !== "undefined" &&
                typeof TouchZoom.install === "function"
        }));
        check("and the gesture layer is installed on a touch device",
            layer.installed === true && layer.api === true, JSON.stringify(layer));

        await touch.detach();

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
