#!/usr/bin/env node
/**
 * Model 33 ASR teletype end-to-end test (puppeteer + real Chromium).
 *
 * Exercises the console teletype exactly the way an operator would — the
 * page is loaded with the teletype console, RT-11 is booted through the
 * quick-boot wizard, and then the MECHANICS are asserted on the live DOM:
 *
 *   1. boot output is really rendered on the paper (not just generated):
 *      #g60printer paper text contains the boot banner and the "." prompt,
 *      and the render hook (fired per actually-rendered character) counts
 *      hundreds of characters.
 *   2. on-screen keyboard input: clicking D/I/R/SYS etc. echoes on the
 *      paper and the guest executes the command ("Free blocks" appears).
 *   3. BREAK key: the machine survives an operator break and keeps
 *      accepting input afterwards.
 *   4. punch ON: output is duplicated onto the paper tape
 *      (#punchtape__body grows).
 *   5. CCU OFF: the unit is powered down — a key press neither echoes
 *      nor reaches the guest (output stops growing).
 *
 * The teletype is the most hook-dense part of the emulator (keyboard ->
 * dlReceiveQueue, rendering -> g60printer onChar, prompt-waiting ->
 * __consoleOutputHook, tape drain -> onConsoleInputDrained), so this suite
 * is the regression net for the headless-machine refactor of iopage.js.
 *
 * Run with:  node tests/e2e-teletype.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;

const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: true,           // must EXACTLY match the rk1 (RT-11) wizard
    vt11: false,             // scenario hardware block or the wizard reloads
    teletypeSpeed: "fast",   // ~30ms/char instead of authentic ~100ms
    powerOn: true,
    autoBoot: false          // the wizard issues the boot itself
};

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

async function openPage(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, CFG);

    // E2E_CORE=1 exercises the refactored machine layer (?core=1) instead
    // of the monolithic iopage.js — the same UI expectations must hold.
    const coreParam = process.env.E2E_CORE ? "core=1&" : "";
    await page.goto(`${BASE}/pdp11.html?${coreParam}cfg=teletype`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });

    // Capture generated output (same hook the wizard watches) and count
    // ACTUALLY RENDERED characters (fired by g60printer.onChar after the
    // character appears on the paper — unlike the generation hook, which
    // fires ahead of the paced render).
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
        window.__osRenderCount = 0;
        const renderHook = window.__consoleRenderHook;
        window.__consoleRenderHook = function (ch) {
            if (typeof renderHook === "function") renderHook(ch);
            window.__osRenderCount++;
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

async function outputLength(page) {
    return page.evaluate(() => (window.__osShotOutput || "").length);
}

// Wait until the generated output stops growing for `stableMs` (RT-11 is
// logically booted in seconds but prints its whole boot at teletype speed).
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

// --- teletype mechanics -----------------------------------------------------

// Text currently visible on the console paper (what the operator sees).
// The console G60Printer is constructed without an idPrefix, so it owns the
// legacy unprefixed ids ("paper", "paper_printarea"); the LP11 printer uses
// "lp11"-prefixed ids and never collides.
//
// NOTE: the paper renders spaces as non-breaking spaces (U+00A0) so column
// positions survive in the DOM — normalize them before matching text.
function paperText(page) {
    return page.evaluate(() => {
        const el = document.getElementById("paper_printarea");
        return el ? el.textContent.replace(/\u00A0/g, " ") : "";
    });
}

function paperCount(page, needle) {
    return page.evaluate((n) => {
        const el = document.getElementById("paper_printarea");
        const txt = el ? el.textContent.replace(/\u00A0/g, " ") : "";
        return (txt.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    }, needle);
}

// Press an on-screen key by mousedown+mouseup (the real activation path —
// mouseup only fires activateKey() when the key is 'down' from the press).
// Shifted glyphs (e.g. "*" lives on the ":" key) latch SHIFT first — the
// latch trips on the next keypress, exactly like the real Model 33.
async function pressKey(page, key) {
    return page.evaluate((k) => {
        const keys = document.querySelectorAll("#punchkeyboard .m33-key, #punchkeyboard .m33-space");
        const fire = (el) => {
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        };
        for (const el of keys) {
            const d = el._def;
            if (!d || d.special) continue;
            if (k.code !== undefined && d.code === k.code) { fire(el); return true; }
            if (k.label !== undefined && d.label === k.label) { fire(el); return true; }
        }
        for (const el of keys) {
            const d = el._def;
            if (!d || d.special) continue;
            if (k.code !== undefined && d.shiftCode === k.code) {
                for (const s of keys) {
                    if (s._def && s._def.special === "shift") { fire(s); break; }
                }
                fire(el);
                return true;
            }
        }
        return false;
    }, key);
}

async function pressSpecial(page, special) {
    return page.evaluate((s) => {
        const keys = document.querySelectorAll("#punchkeyboard .m33-key, #punchkeyboard .m33-space");
        for (const el of keys) {
            const d = el._def;
            if (d && d.special === s) {
                el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                return true;
            }
        }
        return false;
    }, special);
}

// Type a command on the on-screen keyboard, one key per character.
async function typeOnKeyboard(page, text) {
    for (const ch of text) {
        if (ch === " ") {
            const ok = await pressSpecial(page, "space");
            if (!ok) throw new Error("no SPACE bar on the on-screen keyboard");
        } else {
            const ok = await pressKey(page, { code: ch.charCodeAt(0) });
            if (!ok) throw new Error(`no on-screen key for character ${JSON.stringify(ch)}`);
        }
        await sleep(20);
    }
    const ok = await pressSpecial(page, "cr");
    if (!ok) throw new Error("no RETURN key on the on-screen keyboard");
}

// --- checks ----------------------------------------------------------------

function check(name, cond, extra) {
    if (cond) {
        console.log("PASS: " + name);
    } else {
        failures++;
        console.log("FAIL: " + name + (extra ? " — " + extra : ""));
    }
}

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    try {
        const page = await openPage(browser);

        // ---- 1. Boot prints on the paper --------------------------------
        await launchDevice(page, "rk1");
        if (!await waitStable(page, 2500, 120000)) {
            throw new Error("RT-11 did not reach its prompt (output: " +
                JSON.stringify(await outputTail(page, 200)) + ")");
        }
        check("boot output reaches the \".\" prompt (generated)",
            await outputContains(page, "."));
        // The paper renders at teletype pace (~30ms/char), which lags the
        // generated output — wait until the rendered paper catches up.
        check("boot banner really rendered on the paper",
            await waitFor(async () =>
                (await paperText(page)).indexOf("RT-11") !== -1, 30000),
            "paper starts with: " + JSON.stringify((await paperText(page)).slice(0, 60)));
        check("prompt rendered on the paper",
            await waitFor(async () => {
                const txt = await paperText(page);
                return txt.indexOf("\n.") !== -1 || txt.trimEnd().endsWith(".");
            }, 30000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-60)));
        // The "." prompt appears on the paper ahead of the paced render;
        // let the render queue drain before counting (renders are paced at
        // ~30ms/char, so this also covers slower machines).
        await waitFor(async () => {
            const a = await page.evaluate(() => window.__osRenderCount);
            await sleep(400);
            const b = await page.evaluate(() => window.__osRenderCount);
            return b === a;
        }, 15000);
        const renderCount = await page.evaluate(() => window.__osRenderCount);
        check("hundreds of characters actually rendered (render hook)",
            renderCount > 100, "renderCount=" + renderCount);

        // ---- 2. On-screen keyboard: echo + guest executes ---------------
        // DIR SYS*.* prints ~250 chars (~8s at fast speed) — a real command
        // with a distinctive footer we can wait for on the paper.
        const before = await paperCount(page, "Free blocks");
        await typeOnKeyboard(page, "DIR SYS*.*");
        check("keyboard input echoed on the paper",
            await waitFor(async () =>
                (await paperText(page)).indexOf("DIR SYS*.*") !== -1, 15000),
            "paper tail: " + JSON.stringify((await paperText(page)).slice(-80)));
        check("guest executed the typed command (Free blocks printed again)",
            await waitFor(async () =>
                (await paperCount(page, "Free blocks")) > before, 60000),
            "Free blocks count: " + (await paperCount(page, "Free blocks")));

        // ---- 3. BREAK key ----------------------------------------------
        const breakOk = await pressSpecial(page, "break");
        check("BREAK key exists on the keyboard", breakOk);
        await sleep(1000);
        const before2 = await paperCount(page, "Free blocks");
        await typeOnKeyboard(page, "DIR SYS*.*");
        check("machine keeps working after operator BREAK",
            await waitFor(async () =>
                (await paperCount(page, "Free blocks")) > before2, 60000),
            "Free blocks count after BREAK: " +
                (await paperCount(page, "Free blocks")));

        // ---- 4. Punch ON: output duplicated onto the tape ---------------
        await page.evaluate(() => {
            const btn = document.getElementById("punch-on");
            if (btn) btn.click();
        });
        await sleep(300);
        const tapeBefore = await page.evaluate(() => {
            const el = document.getElementById("punchtape__body");
            return el ? el.childElementCount : 0;
        });
        const before3 = await paperCount(page, "Free blocks");
        await typeOnKeyboard(page, "DIR SYS*.*");
        await waitFor(async () =>
            (await paperCount(page, "Free blocks")) > before3, 60000);
        await sleep(1500); // let the punch catch up with the print queue
        const tapeAfter = await page.evaluate(() => {
            const el = document.getElementById("punchtape__body");
            return el ? el.childElementCount : 0;
        });
        check("punch ON duplicates output onto the paper tape",
            tapeAfter > tapeBefore,
            "tape rows: " + tapeBefore + " -> " + tapeAfter);

        // ---- 5. CCU OFF: unit powered down ------------------------------
        await page.evaluate(() => {
            const off = document.querySelector('[data-tty-mode="off"]');
            if (off) off.click();
        });
        await sleep(300);
        const ttyMode = await page.evaluate(() => window.ttyMode);
        check("CCU switch moved to OFF", ttyMode === "off", "ttyMode=" + ttyMode);
        const paperLenBefore = (await paperText(page)).length;
        const outLenBefore = await outputLength(page);
        await typeOnKeyboard(page, "ZZZ");
        await sleep(2000);
        const paperLenAfter = (await paperText(page)).length;
        const outLenAfter = await outputLength(page);
        check("key presses do not echo while OFF",
            paperLenAfter === paperLenBefore,
            "paper: " + paperLenBefore + " -> " + paperLenAfter);
        check("no output reaches the guest while OFF",
            outLenAfter === outLenBefore,
            "output: " + outLenBefore + " -> " + outLenAfter);
        // restore LINE for any later manual inspection
        await page.evaluate(() => {
            const line = document.querySelector('[data-tty-mode="line"]');
            if (line) line.click();
        });

        // ---- 6. LOCAL: echo prints, guest does not receive --------------
        await page.evaluate(() => {
            const loc = document.querySelector('[data-tty-mode="local"]');
            if (loc) loc.click();
        });
        await sleep(300);
        const paperLenB2 = (await paperText(page)).length;
        const outLenB2 = await outputLength(page);
        await typeOnKeyboard(page, "HI");
        await sleep(2000);
        const paperLenA2 = (await paperText(page)).length;
        const outLenA2 = await outputLength(page);
        check("LOCAL echoes on the paper",
            paperLenA2 > paperLenB2,
            "paper: " + paperLenB2 + " -> " + paperLenA2);
        check("LOCAL does not deliver to the guest",
            outLenA2 === outLenB2,
            "output: " + outLenB2 + " -> " + outLenA2);
        await page.evaluate(() => {
            const line = document.querySelector('[data-tty-mode="line"]');
            if (line) line.click();
        });
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\nE2E TELETYPE: ALL CHECKS PASSED"
        : `\nE2E TELETYPE: ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

// outputTail helper used in error messages
async function outputTail(page, n) {
    return page.evaluate((count) => (window.__osShotOutput || "").slice(-count), n);
}

main().catch((e) => {
    console.error("E2E TELETYPE ERROR:", e.message);
    process.exit(1);
});
