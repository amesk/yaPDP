#!/usr/bin/env node
/**
 * export-state-browser.js — take a machine state from the REAL browser.
 *
 * The headless exporter (tools/export-state.js) drives the emulator in Node,
 * which is fast but is NOT the configuration a visitor gets. This one drives
 * a real Chromium through the very same path a user takes:
 *
 *   open pdp11.html -> click the magic wand -> pick the guest OS ->
 *   wait for the wizard to finish -> SnapshotStore.exportBytes() -> states/
 *
 * Why it matters: the configuration (console type, printers, the paper-tape
 * path) is the browser's, not a harness's. The headless stand already shipped
 * one wrong configuration ('BOOT RK0' typed for a scenario asking for rp1),
 * and paper tapes never ran there at all.
 *
 * Usage:
 *   node tools/export-state-browser.js rk1vt52 basic lander
 *   node tools/export-state-browser.js            # every scenario missing a state
 *
 * Needs the dev server on :1170 (tools/serve.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const { StateFrame } = require(path.join(__dirname, "..", "src", "state-frame.js"));
const StateIO = require("./state-io.js");
const consoleWait = require("./console-wait.js");
const preview = require("./preview-capture.js");
const statesAnnotate = require("./states-annotate.js");

const ROOT = path.resolve(__dirname, "..");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(ROOT, "states");

// How long to give a guest to reach its own "ready" moment. BSD 2.11 was
// measured at ~150s of real time in the browser; paper tapes are instant.
const READY_TIMEOUT_MS = 240000;

let failures = 0;
function log(...a) { console.log("[" + new Date().toISOString().slice(11, 19) + "] " + a.join(" ")); }

function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(BASE + "/pdp11.html", (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
    });
}

async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "serve.js")],
        { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error("static server did not start on :" + PORT);
}

// Scenarios from src/osboot.js, read the way the other tools read them: the
// same table the wizard, the galleries and the e2e suites use.
function loadScenarios() {
    const vm = require("vm");
    const sb = { console, window: {} };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "osboot.js"), "utf8"), sb);
    return sb.OSBoot.BOOT_SCENARIOS;
}

// Human metadata a state must carry about itself: the label (what this parked
// machine IS) and the one-line description the wizard's toast and the Scenario
// card show. Both come from the SAME table tools/states-annotate.js applies to
// the states already in the repo (tools/state-annotations.json, keyed by state
// file name), so an exported state and a hand-annotated one cannot disagree.
// A missing table is not fatal: the state is still exported, just mute.
const ANNOTATIONS = statesAnnotate.loadAnnotations();

function annotationFor(device) {
    if (device === null || device === undefined) return {};
    return statesAnnotate.annotationFor(ANNOTATIONS, device + "-ready.state.zst");
}

function labelFor(device) {
    const ann = annotationFor(device);
    if (ann.label) return ann.label;
    const sc = loadScenarios().find((s) => s.device === device);
    return (sc && sc.label) || null;
}

function missingScenarios() {
    const have = new Set(fs.readdirSync(OUT_DIR)
        .filter((f) => f.endsWith("-ready.state.zst"))
        .map((f) => f.replace("-ready.state.zst", "")));
    return loadScenarios().filter((s) => !have.has(s.device)).map((s) => s.device);
}

// Drive the wizard by clicking exactly what a user clicks.
async function launchDevice(page, device) {
    await page.evaluate(() => {
        const btn = document.getElementById("quick-boot-btn");
        if (btn) btn.click();
    });
    // Let the dialog render its list (it may filter against the manifest).
    await new Promise((r) => setTimeout(r, 800));

    const sel = '.quickboot-option[data-quickboot-device="' + device + '"]';
    const found = await page.evaluate((s) => !!document.querySelector(s), sel);
    if (!found) {
        const opts = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".quickboot-option"))
                .map((e) => e.getAttribute("data-quickboot-device")));
        throw new Error("no wizard option for '" + device + "' (offered: " +
            opts.join(", ") + ")");
    }
    await page.click(sel);
    log("  clicked " + device + " in the wizard");
}

// Wait until the guest is READY: the wizard's own end-of-run signal.
// isAutoloading() is the input gate — it closes when the steps are done, and
// it is the same moment a user stops waiting.
async function waitReady(page) {
    await page.waitForFunction(() => {
        if (!window.QuickBoot || typeof window.QuickBoot.isAutoloading !== "function") {
            return false;
        }
        return window.QuickBoot.isAutoloading() === false;
    }, { timeout: READY_TIMEOUT_MS, polling: 250 });
}

async function exportOne(page, device) {
    await page.goto(BASE + "/pdp11.html", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(
        () => typeof window.SnapshotStore === "object" && typeof window.QuickBoot === "object",
        { timeout: 60000 });

    // Clean storage per scenario: one guest's leftovers must not colour the
    // next state (printer paper, tape position, config).
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

    // Console render counters, installed BEFORE the boot so they count every
    // character: the preview must not be shot while the teletype is still
    // printing the prompt the state is parked at.
    await consoleWait.installConsoleHooks(page);

    const t0 = Date.now();
    await launchDevice(page, device);
    await waitReady(page);
    const readyMs = Date.now() - t0;
    log("  ready in " + readyMs + "ms");

    // Drain the teletype (and shoot the preview) before the stop-the-world
    // capture: the picture and the state must be the SAME moment, otherwise the
    // tile shows half a prompt and the restore shows the whole one.
    let shotUri = null;
    try {
        const png = await preview.captureMachinePng(page, { stableMs: 2500 });
        shotUri = preview.toDataUri(png);
        log("  preview captured " + Math.round(png.length / 1024) + " KB");
    } catch (e) {
        // A state without a preview is still a state; a lost export is not.
        log("  WARN no preview: " + (e && e.message ? e.message : e));
    }

    const meta = {
        label: labelFor(device),
        description: annotationFor(device).description || null,
        screenshot: shotUri,
    };

    const b64 = await page.evaluate(async (dev, opts) => {
        const bytes = await window.SnapshotStore.exportBytes(dev, opts);
        // Base64 in chunks: a 4 MB state is a big string for one apply().
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    }, device, meta);

    const buf = Buffer.from(b64, "base64");
    const out = path.join(OUT_DIR, device + "-ready.state.zst");
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // The browser exports gzip (its own CompressionStream); the repo's own
    // states are zstd, the frame the images use. The CONTAINER inside is
    // identical either way, so the frame is simply re-wrapped the way
    // src/state-frame.js prescribes (zstd -> gzip -> bare, never bare while a
    // compressor exists), with tools/state-io.js supplying Node's codecs.
    const container = StateFrame.unwrap(buf, StateIO.codecs);
    const frame = StateIO.writeBytes(out, container);
    const written = fs.statSync(out).size;

    log("  browser bytes " + buf.length +
        " -> container " + container.length +
        " -> " + frame + " " + written);
    log("  written " + path.relative(ROOT, out) + "  " + written + " bytes");
    return { device, bytes: written, containerBytes: container.length,
             browserBytes: buf.length, readyMs };
}

(async () => {
    const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const devices = args.length ? args : missingScenarios();
    if (!devices.length) {
        log("every scenario already has a state; nothing to do");
        return;
    }
    log("scenarios: " + devices.join(", "));

    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const results = [];
    try {
        const page = await browser.newPage();
        page.on("pageerror", (e) => log("  PAGE ERROR: " + String(e && e.message)));

        for (const device of devices) {
            log("=== " + device + " ===");
            try {
                results.push(await exportOne(page, device));
            } catch (err) {
                failures++;
                log("  FAIL(" + device + "): " + (err && err.message ? err.message : err));
            }
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    log("---");
    for (const r of results) {
        log("RESULT " + r.device + "  " + r.bytes + " bytes  ready=" + r.readyMs + "ms");
    }
    log(failures ? failures + " failure(s)" : "all ok");
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.error("FAIL: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
