#!/usr/bin/env node
/**
 * yaPDP startup layout-shift regression test (puppeteer + real Chromium).
 *
 * The loading gate (src/loading-gate.js, #77) hides the startup staircase
 * behind an overlay: the page no longer visibly assembles itself on a slow
 * link. That is the point — and also the risk. The gate made the shift
 * INVISIBLE, not impossible, so a future change to how the artwork is painted
 * (the inlined-<svg> experiment that showed the machine at its natural size,
 * outside the rig, is the worked example) could ship without any test saying
 * so: npm test pins the markers and the stylesheet contract, never the
 * geometry of what is actually drawn.
 *
 * This suite measures what the user would see:
 *
 *   1. FIRST visit, throttled (Slow 3G, cache disabled): the cumulative
 *      layout shift up to the moment the gate lifts stays inside the Core Web
 *      Vitals budget (0.1) — and, separately, inside the strict "the swap is
 *      invisible" budget (0.01) this project holds itself to.
 *   2. BETWEEN the gate lifting and the artwork settling there is no second
 *      shift: the rig and the backdrop boxes, and the rig scale, are identical
 *      after the overlay is gone as they are one settle-period later. A
 *      fallback→artwork swap would move them.
 *   3. REPEAT visit served from cache skips the overlay quickly and is just as
 *      stable — the gate must not flash for a warm visitor.
 *
 * CLS in headless Chromium is timing-sensitive, so the budget is decided on the
 * MEDIAN of several throttled runs, not on a single sample.
 *
 * Run with:  node tests/e2e-startup-cls.js
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

// Slow 3G, as DevTools describes it (the #77 reproduction recipe).
const SLOW_3G = {
    offline: false,
    downloadThroughput: (400 * 1024) / 8,   // 400 kbps
    uploadThroughput: (400 * 1024) / 8,
    latency: 400                            // ms
};

// Core Web Vitals "good" threshold, and the strict budget this project holds
// itself to for "the fallback→artwork swap must be invisible".
const CLS_CWV_BUDGET = 0.1;
const CLS_STRICT_BUDGET = 0.01;

// A fresh console with a fresh power-on view: the artwork passes run for the
// console the config names, so the measured page is the one a user lands on.
const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: false,
    vt11: false,
    teletypeSpeed: "fast",
    powerOn: false,
    autoBoot: false
};

let failures = 0;
const pageErrors = [];

function check(name, cond, extra) {
    if (cond) {
        console.log("PASS: " + name);
    } else {
        failures++;
        console.log("FAIL: " + name + (extra ? " — " + extra : ""));
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        path.join(ROOT, "tools", "serve.js"), "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await sleep(200);
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
}

// The observer has to be installed BEFORE any layout happens, so this goes in
// through evaluateOnNewDocument. Shifts are attributed to a source only when
// the browser can name one; we keep the raw entries for the message.
const CLS_COLLECTOR = `
    window.__cls = { value: 0, entries: [], gateLiftShift: null };
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (e.hadRecentInput) continue;
                window.__cls.value += e.value;
                window.__cls.entries.push({ value: +e.value.toFixed(5),
                    sources: (e.sources || []).map((s) => s.node &&
                        (s.node.id || s.node.className || s.node.nodeName)).filter(Boolean).slice(0, 3) });
            }
        }).observe({ type: "layout-shift", buffered: true });
    } catch (err) { window.__cls.error = String(err); }
    // The gate announces its lift; freeze the CLS reached at that instant so
    // "before" and "after" can be told apart.
    document.addEventListener("yapdp:ready", () => {
        window.__cls.gateLiftShift = window.__cls.value;
    });
`;

// Geometry of the console the user is looking at: the rig box, the artwork
// backdrop box (both must be equal — the artwork is stretched to the rig), and
// the scale the page derived from the artwork markers.
function readConsoleGeometry(page) {
    return page.evaluate(() => {
        const rig = document.getElementById("teletype-rig");
        const backdrop = document.getElementById("tty-backdrop");
        if (!rig || !backdrop) return null;
        const box = (el) => {
            const q = el.getBoundingClientRect();
            return [Math.round(q.left), Math.round(q.top),
                Math.round(q.width), Math.round(q.height)];
        };
        return {
            rig: box(rig),
            backdrop: box(backdrop),
            scale: rig.style.getPropertyValue("--tty-scale") || "(unset)",
            transform: rig.style.transform || "(none)",
            viewport: [window.innerWidth, window.innerHeight]
        };
    });
}

// One visit. `throttled` sets Slow 3G and disables the cache (the cold visit
// #77 describes); otherwise the browser is warm and cacheable.
async function visit(browser, { throttled }) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, CFG);
    await page.evaluateOnNewDocument(CLS_COLLECTOR);

    const client = await page.target().createCDPSession();
    await client.send("Network.enable");
    if (throttled) {
        await client.send("Network.setCacheDisabled", { cacheDisabled: true });
        await client.send("Network.emulateNetworkConditions", SLOW_3G);
    } else {
        await client.send("Network.setCacheDisabled", { cacheDisabled: false });
        await client.send("Network.clearBrowserCache");
        await client.send("Network.emulateNetworkConditions", {
            offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0
        });
    }

    const startedAt = Date.now();
    await page.goto(`${BASE}/pdp11.html`, { waitUntil: "domcontentloaded", timeout: 180000 });
    const loadMs = Date.now() - startedAt;

    // The overlay must lift on its own (or via its ceiling), never stay. Time
    // it from the moment the gate module exists, not from the navigation: on
    // Slow 3G the navigation itself is minutes-long (7 MB at 400 kbps) and says
    // nothing about the gate. `gateStartedAt` is stamped by the gate itself.
    await page.waitForFunction(() => window.__yapdpGateStartedAt > 0,
        { timeout: 180000 });
    const gateStartedAt = await page.evaluate(() => window.__yapdpGateStartedAt);
    await page.waitForFunction(
        () => window.LoadingGate && window.LoadingGate.isDone(), { timeout: 180000 });
    const gateMs = Date.now() - gateStartedAt;

    const atLift = await page.evaluate(() => ({
        cls: window.__cls.value,
        atLift: window.__cls.gateLiftShift,
        entries: window.__cls.entries.slice(-6)
    }));

    // Show the console page BEFORE measuring geometry. The rig is display:none
    // on the Panel, and installTeletypeScaling() deliberately skips a hidden
    // page (offsetWidth 0 means "nothing to fit yet") — so measuring there
    // would assert a scale the page is not supposed to have. This is also the
    // real operator path: land, then open the console.
    await page.evaluate(() => {
        if (typeof window.switchPage === "function") window.switchPage("teletype");
    });
    await sleep(400);
    const geometryAtLift = await readConsoleGeometry(page);
    const shiftOnShow = await page.evaluate(() => ({
        cls: window.__cls.value, entries: window.__cls.entries.slice(-6)
    }));

    // Let the page settle, then re-measure: anything the artwork still had to
    // do would show up as a moved box or a changed scale.
    await sleep(2500);
    const settled = await page.evaluate(() => ({
        cls: window.__cls.value, entries: window.__cls.entries.slice(-6)
    }));
    const geometrySettled = await readConsoleGeometry(page);

    await page.close();
    return { gateMs, loadMs, atLift, shiftOnShow, settled, geometryAtLift, geometrySettled };
}

function median(nums) {
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    try {
        // ---- 1. Cold, throttled visits: measure the shift budget ------------
        const RUNS = 3;
        const coldResults = [];
        for (let i = 0; i < RUNS; i++) {
            coldResults.push(await visit(browser, { throttled: true }));
        }

        const clsAfterLift = coldResults.map((r) => r.atLift.atLift ?? r.atLift.cls);
        const clsTotal = coldResults.map((r) => r.settled.cls);
        const gateMs = coldResults.map((r) => r.gateMs);

        const medianAtLift = median(clsAfterLift);
        const medianTotal = median(clsTotal);

        console.log("  cold runs (3): CLS at gate lift = " +
            clsAfterLift.map((v) => v.toFixed(4)).join(", "));
        console.log("                 CLS settled     = " +
            clsTotal.map((v) => v.toFixed(4)).join(", "));
        console.log("                 gate lifted at  = " +
            gateMs.map((v) => v + "ms").join(", ") + " (median " +
            median(gateMs) + "ms)");

        // The gate has a 15 s ceiling by design; allow slack for the throttle.
        check("cold visits lift the gate well inside its ceiling (25s)",
            median(gateMs) < 25000,
            "median gate window " + median(gateMs) + "ms (whole load: " +
            coldResults.map((r) => r.loadMs).join(", ") + "ms)");

        check("startup shift stays inside the Core Web Vitals budget (0.1)",
            medianTotal <= CLS_CWV_BUDGET,
            "median CLS " + medianTotal.toFixed(4) + " > " + CLS_CWV_BUDGET +
            " | entries: " + JSON.stringify(coldResults[0].settled.entries));

        check("the fallback→artwork swap is invisible (strict CLS 0.01)",
            medianTotal <= CLS_STRICT_BUDGET,
            "median CLS " + medianTotal.toFixed(4) + " > " + CLS_STRICT_BUDGET +
            " — something moves after the gate lifts; entries: " +
            JSON.stringify(coldResults[0].settled.entries));

        // ---- 2. Nothing moves between the lift and the settle ---------------
        // A fallback→artwork swap shows up here even when the CLS number is
        // small: the rig box or the derived scale would differ.
        for (let i = 0; i < coldResults.length; i++) {
            const r = coldResults[i];
            const a = r.geometryAtLift, b = r.geometrySettled;
            const same = a && b &&
                JSON.stringify(a.rig) === JSON.stringify(b.rig) &&
                JSON.stringify(a.backdrop) === JSON.stringify(b.backdrop) &&
                a.scale === b.scale;
            check(`run ${i + 1}: the machine does not move after the gate lifts`,
                same,
                "at lift " + JSON.stringify(a) + " vs settled " + JSON.stringify(b));
            check(`run ${i + 1}: the artwork is stretched to the rig (no phantom box)`,
                a && JSON.stringify(a.rig) === JSON.stringify(a.backdrop),
                "rig " + JSON.stringify(a && a.rig) + " vs backdrop " +
                JSON.stringify(a && a.backdrop));
            check(`run ${i + 1}: the rig was scaled to the window`,
                a && a.scale !== "(unset)",
                "scale " + (a && a.scale) + " — a rig at its natural 1452px width " +
                "overflows a 1400px viewport");
            // Opening the console is where an artwork regression would show: the
            // rig becomes visible, the fit runs, the overlay is already gone.
            const beforeShow = r.atLift.cls, afterShow = r.shiftOnShow.cls;
            check(`run ${i + 1}: opening the console adds no layout shift`,
                (afterShow - beforeShow) <= CLS_STRICT_BUDGET,
                "shift on show " + (afterShow - beforeShow).toFixed(4) +
                " | entries: " + JSON.stringify(r.shiftOnShow.entries));
        }

        // ---- 3. Warm visit: the gate must not flash ------------------------
        const warm = await visit(browser, { throttled: false });
        console.log("  warm visit: gate lifted at " + warm.gateMs + "ms, " +
            "CLS " + warm.settled.cls.toFixed(4));
        check("a repeat visit leaves the overlay quickly",
            warm.gateMs < 8000, "took " + warm.gateMs + "ms");
        check("a repeat visit is just as stable (strict CLS 0.01)",
            warm.settled.cls <= CLS_STRICT_BUDGET,
            "CLS " + warm.settled.cls.toFixed(4) + " | entries: " +
            JSON.stringify(warm.settled.entries));

        check("no page errors", pageErrors.length === 0,
            pageErrors.slice(0, 3).join(" | "));
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\ne2e-startup-cls: ALL CHECKS PASSED"
        : `\ne2e-startup-cls: ${failures} failure(s)`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error("e2e-startup-cls error:", e.message); process.exit(1); });
