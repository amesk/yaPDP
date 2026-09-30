#!/usr/bin/env node
/**
 * Front-panel lamp end-to-end test (puppeteer + real Chromium).
 *
 * A panel lamp is lit by putting the .lit class on its lens element, and
 * updateLights() (src/pdp11.js) writes only the lamps whose bit DIFFERS from the
 * mask it keeps of "what the DOM shows lit right now". Those two sides are a
 * contract no unit test can see: the model can have a lamp lit while the screen
 * shows it dark. That is exactly how the DATA PATHS lamp went missing when the
 * panel turned red — the mask started at "all lamps lit" (the old CSS painted
 * every lamp lit by default) while the new CSS starts every lens dark, so every
 * lamp that was supposed to be lit already at the first frame was skipped and
 * stayed dark.
 *
 * This suite measures the real page over ALL 64 lamps (22 address, 16 data, 26
 * status), because the lamp that gets noticed is rarely the only one:
 *
 *   1. after load, every lamp's .lit class agrees with its bit in the panel
 *      masks — all 64, and the masks are what updateLights() itself keeps;
 *   2. DATA PATHS (s22) is lit on a powered machine (the reported regression);
 *   3. LAMP TEST lights all 64 and switching it off returns the hardware state;
 *   4. switching the machine off turns every lamp off;
 *   5. the computed style of a lit lamp really is the lit red, the dome and the
 *      halo, and an unlit one really is the dark lens (the class has to be
 *      connected to the palette, or a "lit" lamp would still look dead).
 *
 * Run with:  node tests/e2e-panel-lamps.js
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

// A fresh console with the machine powered on, so the panel has lamps to show.
const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: false,
    vt11: false,
    teletypeSpeed: "fast",
    powerOn: true,
    autoBoot: false
};

// The three lamp groups, in the order initPanel() wires them (src/pdp11.js).
const GROUPS = [
    { prefix: "a", count: 22, mask: "addressLights" },
    { prefix: "d", count: 16, mask: "displayLights" },
    { prefix: "s", count: 26, mask: "statusLights" }
];
const TOTAL = GROUPS.reduce((n, g) => n + g.count, 0); // 64

const PANEL_NAV = '.nav-btn[data-page="panel"]';
const LAMP_TEST = ".switch.white"; // LAMP TEST, see src/pdp11-panel.js

let failures = 0;

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

// Read every lamp's .lit class next to the mask the panel keeps, plus the switch
// positions the masks are derived from.
function readPanel(page) {
    return page.evaluate((groups) => {
        const lamps = [];
        for (const g of groups) {
            for (let i = 0; i < g.count; i++) {
                const id = g.prefix + i;
                const el = document.getElementById(id);
                lamps.push({
                    id, group: g.prefix,
                    present: !!el,
                    lit: !!(el && el.classList.contains("lit"))
                });
            }
        }
        const masks = {};
        for (const g of groups) masks[g.prefix] = panel[g.mask] >>> 0;
        return {
            lamps,
            masks,
            power: panel.powerSwitch,
            lampTest: panel.lampTest
        };
    }, GROUPS);
}

// Lamps whose .lit class disagrees with the panel's own mask: the model says one
// thing and the screen shows another.
function disagreements(state) {
    const bad = [];
    for (const lamp of state.lamps) {
        if (!lamp.present) {
            bad.push(lamp.id + ": missing from the DOM");
            continue;
        }
        const bit = (state.masks[lamp.group] & (1 << Number(lamp.id.slice(1)))) !== 0;
        if (bit !== lamp.lit) {
            bad.push(lamp.id + (bit
                ? ": lit in the panel but dark on screen"
                : ": dark in the panel but lit on screen"));
        }
    }
    return bad;
}

const litIds = (state) => state.lamps.filter((l) => l.lit).map((l) => l.id);

// Computed paint of one lamp (used to prove the class is wired to the palette).
function readPaint(page, id) {
    return page.evaluate((lampId) => {
        const el = document.getElementById(lampId);
        const cs = getComputedStyle(el);
        return {
            id: lampId,
            lit: el.classList.contains("lit"),
            backgroundImage: cs.backgroundImage,
            backgroundColor: cs.backgroundColor,
            boxShadow: cs.boxShadow
        };
    }, id);
}

async function main() {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const pageErrors = [];

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on("pageerror", (e) => pageErrors.push(String(e)));

        await page.evaluateOnNewDocument((seed) => {
            try {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (err) { /* ignore storage errors */ }
        }, CFG);

        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "domcontentloaded", timeout: 180000 });
        await page.waitForFunction(() => window.LoadingGate && window.LoadingGate.isDone(),
            { timeout: 180000 });
        // src/pdp11.js declares `var panel` (a window property) but `const CPU`,
        // which is NOT on window — a top-level const lives in the script's global
        // lexical scope. So the page is probed through the bare identifiers, which
        // the scope chain of an evaluated function resolves either way.
        await page.waitForFunction(
            () => typeof updateLights === "function" && typeof panel === "object" &&
                typeof CPU === "object",
            { timeout: 60000 });

        // Show the operator's panel: the lamps are the page under test.
        await page.click(PANEL_NAV);
        await sleep(200);

        // Sync once so the DOM cannot simply be a frame behind the model.
        await page.evaluate(() => updateLights());

        // ---- 1. Every lamp agrees with the panel's own mask ----------------
        let state = await readPanel(page);
        check(`all ${TOTAL} lamps are in the DOM`,
            state.lamps.every((l) => l.present),
            "missing: " + state.lamps.filter((l) => !l.present).map((l) => l.id).join(", "));
        check(`the machine is powered on (powerSwitch ${state.power})`, state.power >= 0);

        let bad = disagreements(state);
        check(`all ${TOTAL} lamps show exactly what the panel has lit`,
            bad.length === 0,
            `${bad.length} disagree: ${bad.join("; ")} | lit on screen: ${litIds(state).length}`);

        // ---- 2. The reported lamp: DATA PATHS on a powered machine ---------
        const paths = state.lamps.find((l) => l.id === "s22");
        check("DATA PATHS (s22) is lit on a powered machine",
            !!(paths && paths.lit), "s22: " + JSON.stringify(paths));

        // ---- 3. LAMP TEST lights everything -------------------------------
        await page.click(LAMP_TEST);
        await page.evaluate(() => updateLights());
        const tested = await readPanel(page);
        check(`LAMP TEST lights all ${TOTAL} lamps`,
            tested.lampTest === 1 && tested.lamps.every((l) => l.lit),
            `lampTest ${tested.lampTest}, lit ${litIds(tested).length}/${TOTAL}`);

        const painted = await readPaint(page, "a21");
        check("a lit lamp paints the lit red, the dome and the halo",
            /gradient/.test(painted.backgroundImage) &&
            (painted.boxShadow.match(/inset/g) || []).length === 2 &&
            /rgba?\(255, 40, 0/.test(painted.boxShadow),
            JSON.stringify(painted));

        // ---- ... and switching it off returns the hardware state -----------
        await page.click(LAMP_TEST);
        await page.evaluate(() => updateLights());
        state = await readPanel(page);
        bad = disagreements(state);
        check("switching LAMP TEST off restores the hardware state",
            state.lampTest === 0 && bad.length === 0 && state.lamps.some((l) => !l.lit),
            `lampTest ${state.lampTest}, lit ${litIds(state).length}/${TOTAL}, ` +
            `disagree: ${bad.join("; ")}`);

        // ---- 4. Power off clears every lamp -------------------------------
        await page.evaluate(() => { panel.powerSwitch = -1; updateLights(); });
        const off = await readPanel(page);
        check("powering the machine off turns every lamp off",
            off.lamps.every((l) => !l.lit),
            "still lit: " + litIds(off).join(", "));

        const dark = await readPaint(page, "a21");
        check("an unlit lamp paints the dark lens (no gradient left)",
            dark.backgroundImage === "none" && dark.backgroundColor === "rgb(14, 5, 0)",
            JSON.stringify(dark));

        check("no page errors while driving the panel",
            pageErrors.length === 0, pageErrors.join(" | "));
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "panel-lamps: all tests passed"
        : `panel-lamps: ${failures} check(s) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("panel-lamps: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
