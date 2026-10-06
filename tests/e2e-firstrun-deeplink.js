#!/usr/bin/env node
/**
 * yaPDP first-run e2e: a gallery link must not trap the visitor.
 *
 * The one path this suite exists for is the one every other suite skips: a
 * FIRST launch (clean storage) that arrives on a deep link. The other suites
 * seed `yapdp.onboarding.v1 = "done"` so the hint stays out of their way —
 * which is exactly why the trap shipped unnoticed:
 *
 *   ?boot=<device> starts the autoload, the autoload's input gate swallows
 *   every click outside its toast, the first-run hint appears anyway, and the
 *   visitor can dismiss neither the hint (gate eats the click) nor the autoload
 *   (its "Take control!" button sits under the hint). The only exit was a 45 s
 *   timeout or a reload.
 *
 * What is pinned, in a real browser, with clean storage:
 *
 *   1. a deep link does NOT raise the first-run hint, and records it seen;
 *   2. the autoload runs and the machine is typed into (the link still works);
 *   3. a plain first launch (no deep link) STILL raises the hint — the fix must
 *      not trade one broken path for another;
 *   4. the hint's own dismiss is reachable on that plain launch.
 *
 * Run with:  node tests/e2e-firstrun-deeplink.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const BASE = "http://localhost:1170/pdp11.html";
const ONBOARDING_KEY = "yapdp.onboarding.v1";

const ROOT = path.resolve(__dirname, "..");

// --- shared dev server ------------------------------------------------------
// The suite needs a server on :1170 (the page and its media come from it).
// Start our own when nothing serves the port and stop it on the way out;
// reuse one that is already up (the shared server tools/validate.js starts).
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

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log("  ok  " + name);
    } else {
        failures++;
        console.error("  FAIL " + name + (detail ? " — " + detail : ""));
    }
}

async function poll(page, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (await page.evaluate(predicate)) return true;
        } catch (e) { /* navigating: context gone, retry */ }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 150));
    }
}

// A page whose storage is EMPTY — the first-run state, which is the whole
// point. Nothing is seeded: no onboarding flag, no config.
async function firstRunPage(browser, errors) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.evaluateOnNewDocument(() => {
        try { localStorage.clear(); } catch (e) { /* ignore */ }
    });
    return page;
}

function snapshot(page) {
    return page.evaluate(() => {
        const hint = document.querySelector("#modal-overlay.visible");
        return {
            hintVisible: !!hint,
            // The hint's own overlay id is "modal-overlay"; a deep link may
            // instead have the wizard's or the toast's elements around.
            toast: !!document.querySelector("#quick-boot-balloon.visible"),
            autoloading: !!(window.QuickBoot && window.QuickBoot.isAutoloading &&
                window.QuickBoot.isAutoloading()),
            flag: (function () {
                try { return localStorage.getItem("yapdp.onboarding.v1"); } catch (e) { return null; }
            })(),
            search: location.search
        };
    });
}

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const errors = [];

    try {
        // --- 1. First launch BY DEEP LINK: no hint, boot runs ------------
        {
            const page = await browser.newPage();
            page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
            await page.evaluateOnNewDocument(() => {
                try { localStorage.clear(); } catch (e) { /* ignore */ }
            });
            await page.goto(BASE + "?boot=rk0",
                { waitUntil: "domcontentloaded", timeout: 90000 });

            const booted = await poll(page, () => window.QuickBoot &&
                typeof window.QuickBoot.isAutoloading === "function" &&
                (window.QuickBoot.isAutoloading() ||
                 document.querySelector("#quick-boot-balloon.visible")), 60000);
            check("?boot= on a clean launch still starts the autoload", booted);

            const state = await snapshot(page);
            check("?boot= on a clean launch does NOT raise the first-run hint",
                state.hintVisible === false, JSON.stringify(state));
            check("the hint is recorded as seen (the gallery tile IS the onboarding)",
                state.flag === "done", String(state.flag));
            check("no page errors on the deep-link first launch",
                errors.length === 0, errors.join(" | "));
            await page.close();
        }

        // --- 2. Plain first launch: the hint MUST still appear -----------
        {
            const page = await browser.newPage();
            page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
            await page.evaluateOnNewDocument(() => {
                try { localStorage.clear(); } catch (e) { /* ignore */ }
            });
            await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });

            const hinted = await poll(page, () =>
                !!document.querySelector("#modal-overlay.visible"), 30000);
            check("a plain first launch STILL raises the first-run hint", hinted);
            check("no autoload runs on a plain launch",
                (await snapshot(page)).autoloading === false);

            // --- 3. The hint is dismissable -------------------------------
            const dismissed = await page.evaluate(() => {
                const btn = document.querySelector(
                    "#modal-overlay.visible .modal-close, #modal-overlay.visible button");
                if (!btn) return false;
                btn.click();
                return !document.querySelector("#modal-overlay.visible");
            });
            check("the hint's dismiss button really closes it", dismissed);
            await page.close();
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\nfirst-run deep-link e2e: all checks passed");
})();
