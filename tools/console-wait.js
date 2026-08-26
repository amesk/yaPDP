#!/usr/bin/env node
/**
 * yaPDP — Shared "wait until the console output is actually rendered" helpers
 * for the Puppeteer screenshot/video generators.
 *
 * The console-output hook (window.__consoleOutputHook, fed by iopage.js at
 * GENERATION time) reports characters as soon as the guest OS produces them,
 * which runs far ahead of the teletype's paced paper render. Waiting on that
 * hook alone makes captures cut mid-print.
 *
 * This module adds a RENDER hook (window.__consoleRenderHook, fed by the
 * console's onChar in pdp11-app.js whenever a character is REALLY printed on
 * the paper) and helpers to wait until the render has caught up — so screenshots
 * and recordings always show the full boot / final prompt.
 *
 * Used by tools/screenshots-os.js and tools/record-video.js.
 */
"use strict";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrap the generation + render hooks on a fresh page (idempotent) so callers
// can read {generated, rendered} counters. Must run AFTER pdp11-app.js has
// loaded (the render hook is undefined before that), i.e. after page.goto().
async function installConsoleHooks(page) {
    await page.evaluate(() => {
        if (window.__osHooksInstalled) return;
        window.__osHooksInstalled = true;

        window.__osShotOutput = "";
        window.__osRenderCount = 0;

        // Generation hook: every console character the guest produces.
        const genHook = window.__consoleOutputHook;
        window.__consoleOutputHook = function (ch) {
            if (typeof genHook === "function") genHook(ch);
            window.__osShotOutput += String.fromCharCode(ch & 0x7F);
            if (window.__osShotOutput.length > 8192) {
                window.__osShotOutput = window.__osShotOutput.slice(-8192);
            }
        };

        // Render hook: every character actually printed on the paper.
        const renderHook = window.__consoleRenderHook;
        window.__consoleRenderHook = function (ch) {
            if (typeof renderHook === "function") renderHook(ch);
            window.__osRenderCount++;
        };
    });
}

// Current {generated, rendered} character counters.
async function consoleState(page) {
    return page.evaluate(() => ({
        generated: (window.__osShotOutput || "").length,
        rendered: window.__osRenderCount || 0
    }));
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

// Wait until the RENDERED character count stops growing for `stableMs` — the
// paper/terminal has finished printing everything that was generated. This is
// the reliable signal (the generation hook cannot tell render progress).
// `onProgress(rendered, generated)` is called roughly every 10 s so callers
// can show that a slow authentic-pace print is still making progress.
async function waitRenderStable(page, stableMs, timeout, onProgress) {
    const startedAt = Date.now();
    let last = 0;
    let lastChanged = Date.now();
    let ticks = 0;
    while (Date.now() - startedAt < timeout) {
        await sleep(500);
        ticks++;
        const cur = await page.evaluate(() => (window.__osRenderCount || 0));
        if (onProgress && ticks % 20 === 0) {
            const gen = await page.evaluate(() =>
                (window.__osShotOutput || "").length);
            onProgress(cur, gen);
        }
        if (cur !== last) {
            last = cur;
            lastChanged = Date.now();
        } else if (Date.now() - lastChanged >= stableMs) {
            return true;
        }
    }
    return false;
}

// Wait until every generated character has been rendered (rendered >= generated).
async function waitRenderCaughtUp(page, timeout) {
    return waitFor(async () => {
        const s = await consoleState(page);
        return s.rendered >= s.generated;
    }, timeout);
}

module.exports = {
    sleep,
    installConsoleHooks,
    consoleState,
    waitFor,
    waitRenderStable,
    waitRenderCaughtUp
};
