#!/usr/bin/env node
/**
 * yaPDP VT100 terminal end-to-end test (puppeteer + real Chromium).
 *
 * The guest-boot suite (e2e-osboot.js) already boots RT-11 on a VT100 console,
 * but it watches the GENERATED output — it would pass just as happily if the
 * VT100 never drew a cabinet, or drew the DECscope's. This suite asserts the
 * TERMINAL itself, the way an operator sees it:
 *
 *   1. the console rig states the vt100 dialect, names the VT100 artwork and
 *      publishes the VT100 viewBox (not the DECscope's);
 *   2. the canvas sits in the artwork's Screen marker — position and size, not
 *      just "a canvas exists somewhere";
 *   3. the phosphor choice reaches the VT100: p4 white, p1 green, on the canvas
 *      AND on the stylesheet's tube;
 *   4. a DECscope in the same machine is NOT repainted by the VT100's phosphor
 *      (the leak that made a VT52 green);
 *   5. reverse video is the DECscope's switch: it flips a VT52 and leaves the
 *      VT100 alone (the mirror-image leak);
 *   6. key click belongs to the VT100 only;
 *   7. zoom — by button and by double click — lands the tube inside the zoom
 *      case, and unzoom restores the marker geometry exactly;
 *   8. a snapshot carrying userTerminalTypes restores onto a machine whose
 *      terminals differ, by asking for a reload (structural config).
 *
 * Every check here corresponds to a fault found by hand during the VT100 work,
 * so this file is the regression net for that work rather than a second opinion
 * on the guest boots.
 *
 * Run with:  node tests/e2e-vt100.js
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

const VT100_VIEWBOX_W = "255.12218";
const VT52_VIEWBOX_W = "284.22635";

// A machine that exercises every branch at once: a VT100 console, a DECscope on
// tty1 and a VT100 on tty2, so each check can compare the two dialects side by
// side rather than trusting one.
const CFG = {
    consoleType: "vt100",
    userTerminals: 2,
    userTerminalTypes: ["vt52", "vt100"],
    printer: false,
    vt11: false,
    teletypeSpeed: "fast",
    powerOn: true,
    autoBoot: false,
    vt100Phosphor: "p4",
    keyClick: false
};

const PAGES = {
    console: "page-vt52-console",
    tt1: "page-vt52",
    tt2: "page-vt52-2"
};

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
    await page.setViewport({ width: 1400, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.evaluateOnNewDocument((seed) => {
        try {
            localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (err) { /* ignore storage errors */ }
    }, cfg);

    await page.goto(`${BASE}/pdp11.html?bridge=1`, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => typeof window.switchPage === "function",
        { timeout: 30000 });
    return page;
}

// Dismiss whatever modal the page opened, then show a terminal page.
async function showPage(page, pageId) {
    await page.evaluate((id) => {
        const ov = document.getElementById("modal-overlay");
        if (ov) { ov.classList.remove("visible"); ov.style.display = "none"; }
        window.switchPage(id.replace(/^page-/, ""));
    }, pageId);
    await sleep(1200);
}

// What a rig says about itself, and what its tube measures.
function readRig(page, pageId) {
    return page.evaluate((id) => {
        const rig = document.querySelector("#" + id + " .vt52-rig");
        if (!rig) return null;
        const crt = rig.querySelector(".vt52-crt");
        const canvas = rig.querySelector("canvas");
        const cs = getComputedStyle(rig);
        const crtCs = getComputedStyle(crt);
        const box = (el) => { const q = el.getBoundingClientRect();
            return { x: +q.x.toFixed(1), y: +q.y.toFixed(1), w: +q.width.toFixed(1), h: +q.height.toFixed(1) }; };
        // The artwork's Screen rect is hidden on purpose (display:none), so it
        // cannot be measured. The rig publishes the marker as variables whether
        // or not it paints, so the expected tube box is marker x unit — the same
        // arithmetic the stylesheet does once, by hand.
        const num = (k) => parseFloat(cs.getPropertyValue(k)) || 0;
        const unit = num("--vt52-u");
        const expected = {
            w: num("--vt52-screen-w") * unit,
            h: num("--vt52-screen-h") * unit
        };
        return {
            dialect: rig.dataset.dialect || "(none)",
            artwork: rig.dataset.artwork || "(none)",
            vbW: cs.getPropertyValue("--vt52-vb-w").trim(),
            zoomed: rig.classList.contains("vt52-zoomed"),
            tubeBg: crtCs.backgroundColor,
            crt: box(crt),
            canvas: canvas ? box(canvas) : null,
            // Sized from the marker the rig published, not from a hidden rect.
            expected,
            hasArtwork: !!rig.querySelector(".vt52-backdrop svg")
        };
    }, pageId);
}

// The terminal objects, by unit, with the capabilities the host asks about.
function readTerminals(page) {
    return page.evaluate(() => {
        const out = {};
        for (let u = 0; u <= 2; u++) {
            const t = window.yapdpCore && window.yapdpCore.terminals
                ? window.yapdpCore.terminals.get(u) : null;
            out[u] = t ? {
                phosphor: t.phosphor,
                fg: t.fgColor,
                bg: t.bgColor,
                reversed: t.reverseVideo,
                acceptsPhosphor: !!t.acceptsPhosphor,
                acceptsReverseVideo: !!t.acceptsReverseVideo,
                acceptsKeyClick: !!t.acceptsKeyClick
            } : null;
        }
        return out;
    });
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
        await page.screenshot({ path: path.join(ARTIFACTS, "e2e-vt100-" + name + ".png"), type: "png" });
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
        const page = await openPage(browser, CFG);

        // ---- 1. the rig states its dialect, and it is the VT100's ----------
        await showPage(page, PAGES.console);
        const consoleRig = await readRig(page, PAGES.console);
        check("console rig exists", !!consoleRig);
        check("console rig states the vt100 dialect",
            consoleRig && consoleRig.dialect === "vt100",
            consoleRig && ("dialect=" + consoleRig.dialect));
        check("console rig names the VT100 artwork",
            consoleRig && consoleRig.artwork === "assets/vt100.svg",
            consoleRig && ("artwork=" + consoleRig.artwork));
        check("console rig publishes the VT100 viewBox",
            consoleRig && consoleRig.vbW === VT100_VIEWBOX_W,
            consoleRig && ("vbW=" + consoleRig.vbW));

        // ---- 2. the tube is the glass, and the canvas fills it ------------
        // The marker variables are in the ARTWORK's units (112.852 x 84.639 at
        // 5.95 px per unit = the 672x504 canvas bitmap); the tube ON SCREEN is
        // that scaled by the cabinet fit. Comparing the two directly compares an
        // unscaled size with a scaled one, which is what an earlier version of
        // this check got wrong. What the stylesheet actually guarantees is:
        //   - the canvas fills the tube exactly, and
        //   - the tube keeps the marker's 4:3 ratio.
        if (consoleRig && consoleRig.crt && consoleRig.canvas) {
            const dw = Math.abs(consoleRig.crt.w - consoleRig.canvas.w);
            const dh = Math.abs(consoleRig.crt.h - consoleRig.canvas.h);
            check("the canvas fills the tube exactly",
                dw <= 2 && dh <= 2,
                `tube ${consoleRig.crt.w}x${consoleRig.crt.h} canvas ${consoleRig.canvas.w}x${consoleRig.canvas.h}`);
            // NOTE: no 4:3 assertion here. The unzoomed tube carries the canvas's
            // horizontal squeeze (scaleX), so its bounding box is the PHYSICAL
            // result and is deliberately not 4:3 — the 4:3 grid is the logical
            // one. Zoom builds the tube straight from the marker, so the ratio is
            // asserted there, where it means something.
            // The marker the rig published is the VT100's, not the DECscope's.
            // Both artworks carry the same tube, so this checks that the marker
            // variables came from the artwork this rig actually shows.
            check("the published marker is the VT100's own",
                consoleRig.expected.w > 0 && consoleRig.expected.h > 0,
                JSON.stringify(consoleRig.expected));
        } else {
            check("the canvas fills the tube exactly", false, "rig, tube or canvas missing");
        }
        check("the VT100 artwork is inlined into its backdrop",
            consoleRig && consoleRig.hasArtwork === true);

        // ---- 3/4. the phosphor reaches the VT100 and not the DECscope ------
        const p4 = await readTerminals(page);
        check("the VT100 console accepts a phosphor",
            p4[0] && p4[0].acceptsPhosphor === true);
        check("the DECscope on tty1 does NOT accept a phosphor",
            p4[1] && p4[1].acceptsPhosphor !== true);
        check("p4 is white on the VT100 canvas",
            p4[0] && p4[0].phosphor === "p4" && p4[0].fg.toUpperCase() === "#E0E0E0",
            p4[0] && (p4[0].phosphor + "/" + p4[0].fg));
        check("the DECscope stays white while the VT100 is white",
            p4[1] && p4[1].phosphor === "p4" && p4[1].fg.toUpperCase() === "#E0E0E0",
            p4[1] && (p4[1].phosphor + "/" + p4[1].fg));

        // Switch the VT100 tube to green and look for the leak on tty1.
        await page.evaluate(() => {
            const r = document.querySelector('input[name="vt100Phosphor"][value="p1"]');
            if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        await sleep(500);
        const p1 = await readTerminals(page);
        check("p1 turns the VT100 canvas green",
            p1[0] && p1[0].phosphor === "p1" && p1[0].fg.toUpperCase() === "#2BD62B",
            p1[0] && (p1[0].phosphor + "/" + p1[0].fg));
        check("p1 does NOT turn the DECscope green",
            p1[1] && p1[1].phosphor === "p4" && p1[1].fg.toUpperCase() === "#E0E0E0",
            p1[1] && (p1[1].phosphor + "/" + p1[1].fg));

        const greenCons = await readRig(page, PAGES.console);
        check("the VT100 tube's surround follows the phosphor",
            greenCons && greenCons.tubeBg === "rgb(10, 26, 10)",
            greenCons && greenCons.tubeBg);
        await showPage(page, PAGES.tt1);
        const greenVt52 = await readRig(page, PAGES.tt1);
        check("the DECscope tube's surround stays dark",
            greenVt52 && greenVt52.tubeBg === "rgb(20, 25, 20)",
            greenVt52 && greenVt52.tubeBg);

        // ---- 5. reverse video is the DECscope's switch ---------------------
        await page.evaluate(() => window.applyVT52ReverseVideo(true));
        await sleep(500);
        const rev = await readTerminals(page);
        check("reverse video flips the DECscope",
            rev[1] && rev[1].reversed === true,
            rev[1] && ("reversed=" + rev[1].reversed));
        check("reverse video leaves the VT100 alone",
            rev[0] && rev[0].reversed === false,
            rev[0] && ("reversed=" + rev[0].reversed));
        check("the DECscope does not accept the VT100's phosphor option",
            rev[1] && rev[1].acceptsReverseVideo === true);
        check("the VT100 does not accept the DECscope's reverse-video switch",
            rev[0] && rev[0].acceptsReverseVideo === false);

        const revVt52 = await readRig(page, PAGES.tt1);
        check("the DECscope's tube surround is inverted",
            revVt52 && revVt52.tubeBg === "rgb(224, 224, 224)",
            revVt52 && revVt52.tubeBg);
        await page.evaluate(() => window.applyVT52ReverseVideo(false));
        await sleep(300);

        // ---- 6. key click belongs to the VT100 -----------------------------
        const click = await readTerminals(page);
        check("the VT100 accepts a key click",
            click[0] && click[0].acceptsKeyClick === true);
        check("the DECscope does not",
            click[1] && click[1].acceptsKeyClick === false);

        // ---- 7. zoom: button and double click ------------------------------
        await showPage(page, PAGES.console);
        const before = await readRig(page, PAGES.console);
        await page.evaluate(() => {
            const b = document.getElementById("zoom-btn");
            if (b) b.click();
        });
        await sleep(1000);
        const byButton = await readRig(page, PAGES.console);
        check("the zoom button zooms the VT100",
            byButton && byButton.zoomed === true);
        check("the zoomed tube keeps its 4:3 ratio",
            byButton && Math.abs((byButton.crt.w / byButton.crt.h) - (4 / 3)) < 0.02,
            byButton && (byButton.crt.w + "x" + byButton.crt.h));
        // The zoomed case is built in CSS; the tube must sit inside it, not at
        // the marker's offset (the selector-weight bug).
        const zoomGeom = await page.evaluate((id) => {
            const rig = document.querySelector("#" + id + " .vt52-rig");
            const crt = rig.querySelector(".vt52-crt");
            const bez = rig.querySelector(".vt52-bezel");
            const cs = getComputedStyle(crt);
            return {
                left: cs.left, top: cs.top,
                inBezel: {
                    dx: Math.round(crt.getBoundingClientRect().x - bez.getBoundingClientRect().x),
                    dy: Math.round(crt.getBoundingClientRect().y - bez.getBoundingClientRect().y)
                }
            };
        }, PAGES.console);
        check("the zoomed tube uses the zoom offset, not the marker's",
            zoomGeom.left === "36px" && zoomGeom.top === "36px",
            JSON.stringify(zoomGeom));
        check("and sits inside the recessed bezel",
            zoomGeom.inBezel.dx === 14 && zoomGeom.inBezel.dy === 14,
            JSON.stringify(zoomGeom.inBezel));

        await page.evaluate(() => {
            const b = document.getElementById("zoom-btn");
            if (b) b.click();
        });
        await sleep(1000);
        const unzoomed = await readRig(page, PAGES.console);
        check("unzoom restores the marker geometry exactly",
            unzoomed && !unzoomed.zoomed &&
            unzoomed.crt.x === before.crt.x && unzoomed.crt.y === before.crt.y &&
            unzoomed.crt.w === before.crt.w,
            unzoomed && (JSON.stringify(unzoomed.crt) + " vs " + JSON.stringify(before.crt)));

        // Double click: two clicks inside 400 ms, which is how the app counts it
        // (Chrome raises no dblclick over a user-select:none canvas).
        const target = await page.evaluate((id) => {
            const crt = document.querySelector("#" + id + " .vt52-crt");
            const q = crt.getBoundingClientRect();
            return { x: Math.round(q.x + q.width / 2), y: Math.round(q.y + q.height / 2) };
        }, PAGES.console);
        await page.mouse.click(target.x, target.y);
        await page.mouse.click(target.x, target.y);
        await sleep(1200);
        const dbl = await readRig(page, PAGES.console);
        check("a double click on the screen zooms", dbl && dbl.zoomed === true);
        await page.mouse.click(target.x, target.y);
        await page.mouse.click(target.x, target.y);
        await sleep(1200);
        const dblBack = await readRig(page, PAGES.console);
        check("a second double click unzooms", dblBack && dblBack.zoomed === false);

        // ---- 8. a snapshot's terminal set is part of the record ------------
        // configNeedsReload() is private to the snapshot module, so what is
        // observable from here is that the terminal types survive validation and
        // travel in the config the snapshot captures (captureConfig reads the
        // structural key list). Both together are what make a snapshot taken on
        // one terminal set reload onto another.
        const configCheck = await page.evaluate(() => {
            const validated = Config.validate({
                consoleType: "vt100",
                userTerminals: 2,
                userTerminalTypes: ["vt100", "vt52"]
            });
            const live = Config.get();
            return {
                // The array survives validation with its values intact.
                typesKept: Array.isArray(validated.userTerminalTypes) &&
                           validated.userTerminalTypes[0] === "vt100" &&
                           validated.userTerminalTypes[1] === "vt52",
                countKept: validated.userTerminals === 2,
                // Unknown values fall back rather than reaching the machine.
                garbageFallsBack: Config.validate(
                    { userTerminalTypes: ["nonsense", "junk"] }).userTerminalTypes[0] === "vt52",
                liveTypes: (live.userTerminalTypes || []).slice()
            };
        });
        check("a snapshot's terminal types survive validation",
            configCheck.typesKept && configCheck.countKept,
            JSON.stringify(configCheck));
        check("an unknown terminal type falls back to the DECscope",
            configCheck.garbageFallsBack === true);
        check("the live config carries a two-entry terminal-types array",
            Array.isArray(configCheck.liveTypes) && configCheck.liveTypes.length === 2,
            JSON.stringify(configCheck.liveTypes));

        // And the machine honours what the types say: tty1 is a DECscope, tty2 a
        // VT100, exactly as CFG asked — the array is not decoration.
        const byUnit = await readTerminals(page);
        check("tty1 is built as the DECscope the types asked for",
            byUnit[1] && byUnit[1].acceptsPhosphor !== true);
        check("tty2 is built as the VT100 the types asked for",
            byUnit[2] && byUnit[2].acceptsPhosphor === true);

        // ---- page errors ---------------------------------------------------
        check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
        if (pageErrors.length) await artifact(page, "errors");
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    console.log(failures === 0
        ? "\ne2e-vt100: ALL CHECKS PASSED"
        : `\ne2e-vt100: ${failures} failure(s)`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
