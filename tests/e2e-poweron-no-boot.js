#!/usr/bin/env node
/**
 * yaPDP power-on e2e: an empty Boot ROM socket must not look like a crash.
 *
 * The bug this suite pins (reproduced by the operator, not by a unit test):
 *
 *   Reboot → Boot device = None → landing page's Reset (a reload of
 *   pdp11.html) → the operator was greeted with a red toast
 *   "Machine halted at 000002 — the CPU trapped into an empty vector."
 *
 * doReboot() persists powerOn = true, so every later load came up powered on;
 * applyMachinePower() starts boot() only when bootDevice is not 'none', and
 * src/pdp11.js starts the CPU loop on its own at page load — so with no Boot
 * ROM the CPU executed the zeroed memory, hit the HALT at 0 and published a
 * self-stop, which the halt-notice policy classifies as an ERROR (pc <= 4 =
 * "empty vector").  Nothing was broken: the machine simply had nothing to run.
 *
 * What is pinned, in a real browser:
 *
 *   1. powerOn = true + bootDevice 'none': the machine is POWERED ON but rests
 *      in HALT, publishes no stop event and raises no error toast — and it is
 *      still halted a second later (an ordinary halt-after-a-few-instructions
 *      would also report HALT, so the second sample is what makes this real);
 *   2. powerOn = true + bootDevice 'interactive@': the machine is NOT parked —
 *      the control case that stops the fix from disarming every power-on.
 *
 * Run with:  node tests/e2e-poweron-no-boot.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const SERVE_URL = "http://localhost:1170/pdp11.html";
const ROOT = path.resolve(__dirname, "..");

// CPU.runState values (src/pdp11.js): 0 RUN, 1 RESET, 2 WAIT, 3 HALT, 4 STEP.
const STATE_RUN = 0;
const STATE_WAIT = 2;
const STATE_HALT = 3;

// The config a rebooted machine carries into the next page load: doReboot()
// switches the POWER LOCK on (and persists powerOn), the operator chose "None".
const CFG_NO_ROM = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: false,
    vt11: false,
    teletypeSpeed: "fast",
    powerOn: true,
    bootDevice: "none"
};

const CFG_WITH_ROM = Object.assign({}, CFG_NO_ROM, { bootDevice: "interactive@" });

// --- shared dev server ------------------------------------------------------
// The suite needs a server on :1170 (the page and its media come from it).
// Start our own when nothing serves the port and stop it on the way out;
// reuse one that is already up (the shared server tools/validate.js starts).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One load with the given config seeded. Toasts are SAMPLED from the moment the
// navigation returns, because the spurious halt used to fire ~80 ms after the
// page started and a single look afterwards could miss the tail of it.
async function loadWith(browser, cfg, sampleMs) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, cfg);

    await page.goto(SERVE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    const toasts = [];
    const samples = [];
    const deadline = Date.now() + sampleMs;
    while (Date.now() < deadline) {
        // NOTE: `CPU` is declared with `const` in src/pdp11.js, so it is NOT a
        // property of `window` — only the bare identifier resolves here.
        const s = await page.evaluate(() => {
            const el = document.querySelector(".yapdp-toast");
            let runState = null;
            try {
                if (typeof CPU !== "undefined") runState = CPU.runState;
            } catch (e) { runState = null; }
            return {
                runState: runState,
                toastVisible: !!(el && el.classList.contains("visible")),
                toastClass: el ? el.className : "",
                toastText: el ? el.textContent : ""
            };
        });
        samples.push(s.runState);
        if (s.toastVisible) {
            toasts.push({ category: s.toastClass, text: s.toastText });
        }
        await sleep(60);
    }

    const final = await page.evaluate(() => {
        let haltReason = null;
        let runState = null;
        let powerSwitch = null;
        try {
            if (typeof CPU !== "undefined") {
                haltReason = CPU.haltReason || null;
                runState = CPU.runState;
            }
        } catch (e) { /* ignore */ }
        try {
            if (typeof panel !== "undefined") powerSwitch = panel.powerSwitch;
        } catch (e) { /* ignore */ }
        return { haltReason: haltReason, runState: runState, powerSwitch: powerSwitch };
    });

    await page.close();
    return { errors: errors, samples: samples, toasts: toasts, final: final };
}

function hasCrashToast(toasts) {
    return toasts.some((t) => /toast--error/.test(t.category) ||
        /empty vector|trapped into/i.test(t.text));
}

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    try {
        // --- 1. Powered on with NO Boot ROM: rests in HALT, no crash toast ----
        {
            const r = await loadWith(browser, CFG_NO_ROM, 2200);
            check("no page errors with no Boot ROM", r.errors.length === 0,
                r.errors.join(" | "));
            check("the machine is powered on (POWER LOCK on)",
                typeof r.final.powerSwitch === "number" && r.final.powerSwitch >= 0,
                "powerSwitch=" + r.final.powerSwitch);
            check("the machine rests in HALT (not running an empty memory)",
                r.final.runState === STATE_HALT,
                "runState=" + r.final.runState);
            check("it was halted from the start, not after executing the HALT at 0",
                r.samples.length > 0 &&
                r.samples.slice(1).every((s) => s === STATE_HALT),
                "runState samples: " + JSON.stringify(r.samples.slice(0, 12)));
            check("no stop event is published (nothing trapped)",
                r.final.haltReason === null,
                JSON.stringify(r.final.haltReason));
            check("no 'empty vector' / error toast is raised",
                !hasCrashToast(r.toasts),
                JSON.stringify(r.toasts.slice(-3)));
        }

        // --- 2. Control: a configured Boot ROM still starts and runs ---------
        {
            const r = await loadWith(browser, CFG_WITH_ROM, 1800);
            check("no page errors with an interactive Boot ROM",
                r.errors.length === 0, r.errors.join(" | "));
            check("a configured Boot ROM is NOT parked in HALT",
                r.final.runState !== STATE_HALT,
                "runState=" + r.final.runState);
            check("the loader keeps the machine working (RUN or WAIT)",
                r.final.runState === STATE_RUN || r.final.runState === STATE_WAIT,
                "runState=" + r.final.runState);
            check("the control case raises no crash toast",
                !hasCrashToast(r.toasts),
                JSON.stringify(r.toasts.slice(-3)));
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\npower-on without a Boot ROM e2e: all checks passed");
})();
