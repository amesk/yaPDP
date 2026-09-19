#!/usr/bin/env node
/**
 * Model 33 ASR teletype E2E harness — the infrastructure SHARED by
 * tests/e2e-teletype.js (keyboard / CCU mechanics) and
 * tests/e2e-teletype-tape.js (the paper-tape path).
 *
 * Both suites drive the same machine the same way — boot RT-11 through the
 * quick-boot wizard on the teletype console, then poke the live DOM and
 * count characters actually rendered on the paper — so everything up to the
 * assertions lives here. The suites keep only their own domain helpers
 * (loadTape/tapeRows/... and outputTail) and their checks.
 *
 * Why one module: the two suites used to keep a verbatim copy of this code.
 * When #75 turned the "rk1" scenario into an ANSI/VT100 console, the config
 * in BOTH copies stopped matching the scenario's hardware profile, and the
 * wizard's deliberate reload killed each harness in turn ("Execution context
 * was destroyed") — one was fixed, the other still failed. A shared launch
 * path means a profile drift is fixed once.
 *
 * The scenario is ALWAYS "rk1tty" (RT-11 v4.0 on the Model 33 ASR), whose
 * profile below must match exactly: hardwareDirty() in src/quickboot.js
 * reloads the page when the config differs from the scenario's profile.
 * launchDevice() additionally survives such a reload instead of dying with
 * it (see there), so a future drift costs a reload, not a broken run.
 *
 * Not a test suite itself: `node tests/e2e-teletype-harness.js` prints a
 * reminder and exits 0 so a stray discovery run stays green.
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;

// The scenario both suites boot, and the config that matches its profile.
// RT-11 v4.0 on the Model 33 ASR teletype (src/osboot.js: device "rk1tty",
// the same rk1.dsk image and BOOT RK1 as the VT100/VT52 variants).
const SCENARIO = "rk1tty";

// Must EXACTLY match the scenario's hardware profile, or the quick-boot
// wizard treats the config as dirty and RELOADS the page (see
// hardwareDirty()/launch() in src/quickboot.js) — which destroys the puppeteer
// execution context mid-assertion. printer mirrors the scenario's LP11; a
// teletype has no lower-case type, hence the upper-case output.
const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: true,           // rk1tty requires the LP11
    vt11: false,             // rk1tty requires no VT11
    teletypeSpeed: "fast",   // ~30ms/char instead of authentic ~100ms
    powerOn: true,
    autoBoot: false          // the wizard issues the boot itself
};

// --- failure accounting ----------------------------------------------------

let failures = 0;

function check(name, ok, extra) {
    if (ok) {
        console.log("PASS: " + name);
    } else {
        failures++;
        console.log("FAIL: " + name + (extra ? " — " + extra : ""));
    }
}

function failureCount() {
    return failures;
}

// --- small async helpers ---------------------------------------------------

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

// --- dev server ------------------------------------------------------------

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
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "serve.js")], {
        cwd: ROOT,
        stdio: "ignore"
    });
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (await serverAlive()) return child;
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

// --- the page and its hooks ------------------------------------------------

// Open the console page with CFG seeded, and install the hooks. The seed goes
// in through evaluateOnNewDocument so it is in place before any page script
// runs (and survives the wizard's reload).
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
    await page.goto(`${BASE}/pdp11.html?${coreParam}bridge=1&cfg=teletype`,
        { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });

    await installHooks(page);

    return page;
}

// Capture generated output (same hook the wizard watches) and count ACTUALLY
// RENDERED characters (fired by g60printer.onChar after the character appears
// on the paper — unlike the generation hook, which fires ahead of the paced
// render). Split out of openPage() so a wizard reload can re-install it.
async function installHooks(page) {
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
}

// Click the magic-wand button, then the scenario option — the real user path.
//
// The wizard RELOADS the page when the scenario's hardware profile differs
// from the current config (hardwareDirty() -> window.location.reload() in
// src/quickboot.js). CFG above keeps them in step so that should not happen,
// but a reload must never take the harness down with it: the execution
// context dies, the injected output/render hooks are gone, and the run ends
// with "Execution context was destroyed". Watch for a navigation across the
// click and, if one happens, wait for the reloaded page and re-install the
// hooks before returning.
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

    // The click may have queued an intentional wizard reload. Give it a
    // moment, then wait for the page (and its hooks) to settle.
    await sleep(600);
    if (await navigated(page)) {
        await waitForHooks(page);
    }
}

// True when an evaluate() fails because the page navigated under us. Puppeteer
// reports this as "Execution context was destroyed" (or "Target closed" while
// a reload swaps the frame), which is exactly the signal we want to catch.
async function navigated(page) {
    try {
        await page.evaluate(() => 1);
        return false;
    } catch (err) {
        const msg = String((err && err.message) || err);
        return msg.indexOf("Execution context was destroyed") !== -1 ||
            msg.indexOf("Target closed") !== -1;
    }
}

// Wait for a (re)loaded page and re-install the output/render hooks the suites
// assert against. Mirrors the hook block in openPage().
async function waitForHooks(page) {
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    await installHooks(page);
}

// --- reading the machine ---------------------------------------------------

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

// --- the keyboard ----------------------------------------------------------

// Press an on-screen key by mousedown+mouseup (the real activation path —
// mouseup only fires activateKey() when the key is 'down' from the press).
// The key is identified by its `_def` model (src/pdp11-app.js): { code } for a
// character, { label } for a legend, or a SHIFTED code, which latches SHIFT
// first — exactly like the real Model 33.
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

// Press a special key (space/shift/ctrl/cr/break/...) by its `_def.special`.
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

// Type a command on the on-screen keyboard, one key per character, then CR.
// Throws when a character has no key (better than a silently short command).
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

module.exports = {
    ROOT,
    PORT,
    BASE,
    SCENARIO,
    CFG,
    check,
    failureCount,
    sleep,
    waitFor,
    serverAlive,
    ensureServer,
    openPage,
    installHooks,
    launchDevice,
    navigated,
    waitForHooks,
    outputContains,
    outputLength,
    waitStable,
    paperText,
    paperCount,
    pressKey,
    pressSpecial,
    typeOnKeyboard
};

// Not a suite: a bare run just reminds the reader where the suites live.
if (require.main === module) {
    console.log("tests/e2e-teletype-harness.js is shared infrastructure — " +
        "run tests/e2e-teletype.js or tests/e2e-teletype-tape.js instead.");
}
