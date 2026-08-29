#!/usr/bin/env node
/**
 * yaPDP — Diagnostic: BASIC-11 heart demo fed from the ASR paper-tape reader.
 *
 * Boots BASIC-11 through the quick-boot wizard exactly like the video
 * generator (tools/record-video.js), then loads the integer-only heart
 * program into the Model 33 ASR reader (AUTO mode) and prints the FULL
 * console output (window.__osShotOutput), so we can see on paper: the
 * BASIC-11 banner, the echoed program lines and the printed heart.
 *
 * This mirrors the capture flow but without recording — it is the quick way
 * to verify the tape program and the reader feed before re-rendering the
 * video clip.
 *
 * Usage:
 *   node tools/_debug-basic-tape.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const consoleWait = require("./console-wait");

const ROOT = path.resolve(__dirname, "..");
const PORT = 11792;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// Same config the video generator seeds for the BASIC-11 tape clip
// (tools/record-video.js openPage + OS_CFG.basic).
const CFG = {
    consoleType: "teletype",
    userTerminals: 0,
    printer: false,
    vt11: false,
    teletypeSpeed: "authentic",
    upperCaseOnly: false,
    powerOn: true,
    autoBoot: false
};

// The heart program + tape-byte builder — mirrored from tools/record-video.js.
// This BASIC-11 V007A build has no integer variables (I% -> ERROR 1) and no
// TAB() (ERROR 123), so integer-valued math is done with real variables
// holding exact small integers and leading-space loops; no FPP built-ins and
// no fractional STEP.
const BASIC_TAPE_LINES = [
    "10 REM BASIC-11 TAPE DEMO: HEART (INTEGER ONLY)",
    "20 FOR I=1 TO 2",
    '30 PRINT " ";',
    "40 NEXT I",
    '50 PRINT "***";',
    "60 FOR I=1 TO 5",
    '70 PRINT " ";',
    "80 NEXT I",
    '90 PRINT "***"',
    "100 DATA 2,13,2,13,3,11,4,9,5,7,6,5,7,3,8,1",
    "110 FOR I=1 TO 8",
    "120 READ S,W",
    "130 FOR X=1 TO S-1",
    '140 PRINT " ";',
    "150 NEXT X",
    "160 FOR X=1 TO W",
    '170 PRINT "*";',
    "180 NEXT X",
    "190 PRINT",
    "200 NEXT I",
    "210 END",
    "RUN"
];

function linesToTapeBytes(lines) {
    const text = lines.join("\r") + "\r";
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0x7F);
    return bytes;
}

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
        path.join(ROOT, "tools", "serve.js"), "--port", String(PORT)
    ], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await sleep(200);
    }
    child.kill();
    throw new Error("Static server did not start");
}

function findBrowserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ].filter(Boolean);
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

async function waitFor(fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - startedAt > timeout) return false;
        await sleep(200);
    }
}

async function elementCenter(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
}

async function outputText(page) {
    return page.evaluate(() => window.__osShotOutput || "");
}

async function main() {
    let server = null;
    let browser = null;
    try {
        server = await ensureServer();
        const exe = findBrowserExecutable();
        if (!exe) throw new Error("No Edge/Chrome found");
        browser = await puppeteer.launch({
            executablePath: exe,
            headless: "new",
            defaultViewport: VIEWPORT
        });
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        await page.evaluateOnNewDocument((seed) => {
            try {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (err) { /* ignore */ }
        }, CFG);
        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        await consoleWait.installConsoleHooks(page);

        // Open the quick-boot wizard and pick BASIC-11 (first paper tape).
        const wand = await elementCenter(page, "#quick-boot-btn");
        if (!wand) throw new Error("quick-boot button not found");
        await page.mouse.click(wand.x, wand.y);
        await sleep(1500);
        const optSel = '.quickboot-option[data-quickboot-device="basic"]';
        let opt = await elementCenter(page, optSel);
        if (!opt) throw new Error("basic quick-boot option not found");
        await page.evaluate(async (sel) => {
            const list = document.querySelector(".quickboot-list");
            const item = document.querySelector(sel);
            if (!list || !item) return;
            const step = 96;
            for (let guard = 0; guard < 40; guard++) {
                const lr = list.getBoundingClientRect();
                const or = item.getBoundingClientRect();
                if (or.top >= lr.top + 6 && or.bottom <= lr.bottom - 6) break;
                list.scrollTop += (or.top < lr.top ? -1 : 1) * step;
                await new Promise((r) => setTimeout(r, 120));
            }
        }, optSel);
        await sleep(400);
        opt = await elementCenter(page, optSel);
        await page.mouse.click(opt.x, opt.y);

        // Wait for the BASIC-11 "*O " prompt, then let the boot finish printing.
        const ready = await waitFor(() =>
            outputText(page).then((t) => t.includes("*O")), 90000);
        console.log("BASIC-11 ready (prompt seen):", ready);
        await consoleWait.waitRenderStable(page, 2500, 120000,
            (r, g) => console.log(`  [render] ${r}/${g}`));

        // Feed the heart program from the ASR reader (AUTO mode).
        await page.evaluate((bytes) => {
            if (window.tapeReader && typeof window.tapeReader.loadBytes === "function") {
                window.tapeReader.loadBytes(new Uint8Array(bytes));
            }
        }, linesToTapeBytes(BASIC_TAPE_LINES));
        await page.evaluate(() => {
            if (typeof window.setReaderMode === "function") {
                window.setReaderMode("auto");
            }
        });

        const consumed = await waitFor(() => page.evaluate(() => {
            const tr = window.tapeReader;
            return tr ? !tr.hasTape() : true;
        }), 180000);
        console.log("tape consumed:", consumed);
        await consoleWait.waitRenderStable(page, 2500, 180000,
            (r, g) => console.log(`  [render] ${r}/${g}`));
        await sleep(1000);

        const out = await outputText(page);
        console.log("---- console output ----");
        console.log(out);
        console.log("------------------------");

        // Verify the heart: a top "bumps" row and a single bottom point.
        const lines = out.split("\n").map((l) => l.trimEnd());
        const hasBumps = lines.some((l) => /^\s*\*{2,}\s+\*{2,}\s*$/.test(l));
        const hasPoint = lines.some((l) => l.trim() === "*");
        const sawError = /ERROR|UNDEFINED|ILLEGAL|NOT READY/i.test(out);
        console.log("heart top bumps row:", hasBumps,
            "| bottom point:", hasPoint, "| BASIC errors:", sawError);
        if (!hasBumps || !hasPoint || sawError) process.exitCode = 1;
    } finally {
        if (browser) { try { await browser.close(); } catch (err) { /* ignore */ } }
        if (server) server.kill();
    }
}

main().catch((err) => {
    console.error("DEBUG FAILED:", err.message);
    process.exit(1);
});
