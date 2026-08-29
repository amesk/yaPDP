#!/usr/bin/env node
/**
 * yaPDP — Diagnostic: does the NORMAL quick-boot of RT-11 from rk1 write to
 * the disk (dirty blocks)? Mirrors the rt11.webm capture flow (wizard boot +
 * the same DUNGEON steps) but without recording, and logs every DiskStore
 * write so we can compare against the front-panel bootstrap path.
 *
 * Usage:
 *   node tools/_debug-quickboot-writes.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const consoleWait = require("./console-wait");

const ROOT = path.resolve(__dirname, "..");
const PORT = 11795;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// Optional device arg ("rk1" default, "rk1vt52" for a VT52 console) — used to
// test whether the console type is what triggers RT-11's boot-time disk write.
const DEVICE = process.argv[2] || "rk1";

// Same hardware profile as OS_CFG.rk1 / rk1vt52 in tools/record-video.js.
const CFG = {
    consoleType: DEVICE === "rk1vt52" ? "vt52" : "teletype",
    userTerminals: 0,
    printer: true,
    vt11: false,
    teletypeSpeed: "authentic",
    upperCaseOnly: false,
    powerOn: true,
    autoBoot: false
};

const DUNGEON_STEPS = ["R DUNGEON\r", "OPEN MAILBOX\r", "LOOK\r", "TAKE LEAFLET\r"];

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
        console.log("[1] starting server...");
        server = await ensureServer();
        const exe = findBrowserExecutable();
        if (!exe) throw new Error("No Edge/Chrome found");
        console.log("[2] launching browser...");
        browser = await puppeteer.launch({
            executablePath: exe,
            headless: "new",
            defaultViewport: VIEWPORT
        });
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        await page.evaluateOnNewDocument((seed) => {
            try {
                if (!sessionStorage.getItem("yapdp.seeded.v1")) {
                    sessionStorage.setItem("yapdp.seeded.v1", "1");
                    localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
                }
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (err) { /* ignore */ }
        }, CFG);
        console.log("[3] goto pdp11.html...");
        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });
        await consoleWait.installConsoleHooks(page);

        // Instrument DiskStore.markDirty before the boot.
        await page.evaluate(() => {
            window.__diskWrites = [];
            if (typeof DiskStore !== "undefined" && DiskStore.markDirty) {
                const orig = DiskStore.markDirty;
                DiskStore.markDirty = function (controlBlock, block) {
                    window.__diskWrites.push({
                        url: controlBlock && controlBlock.url,
                        block: block
                    });
                    return orig.call(DiskStore, controlBlock, block);
                };
            }
        });
        console.log("[4] instrumentation installed");

        // Quick-boot rk1 through the wizard (same as captureConsoleOS).
        const wand = await elementCenter(page, "#quick-boot-btn");
        if (!wand) throw new Error("quick-boot button not found");
        await page.mouse.click(wand.x, wand.y);
        await sleep(2000);

        const optSel = '.quickboot-option[data-quickboot-device="' + DEVICE + '"]';
        const opt = await elementCenter(page, optSel);
        if (!opt) throw new Error(`quick-boot option not found for ${DEVICE}`);
        await page.evaluate(async (sel) => {
            const list = document.querySelector(".quickboot-list");
            const item = document.querySelector(sel);
            if (!list || !item) return;
            for (let guard = 0; guard < 40; guard++) {
                const lr = list.getBoundingClientRect();
                const or = item.getBoundingClientRect();
                if (or.top >= lr.top && or.bottom <= lr.bottom) break;
                if (or.top < lr.top) break;
                list.scrollTop += 96;
                await new Promise((r) => setTimeout(r, 160));
            }
        }, optSel);
        await page.mouse.click(opt.x, opt.y);
        console.log("[5] quick-boot rk1 chosen, waiting for '.' ...");

        const ready = await waitFor(async () =>
            (await outputText(page)).includes('.'), 180000);
        console.log("RT-11 ready ('.' seen):", ready);
        await consoleWait.waitRenderStable(page, 2500, 120000,
            (r, g) => console.log(`  [render] ${r}/${g}`));

        // Run the same DUNGEON steps as the rt11.webm clip.
        for (const s of DUNGEON_STEPS) {
            await page.evaluate((str) => {
                if (typeof window.dlReceiveQueue === 'function') {
                    window.dlReceiveQueue(0, Array.from(str, (c) => c.charCodeAt(0) & 0x7F));
                }
            }, s);
            const ok = await waitFor(async () => (await outputText(page)).includes('>'), 60000);
            console.log(`  step ${JSON.stringify(s)} prompt '>' seen: ${ok}`);
        }

        const writes = await page.evaluate(() => window.__diskWrites || []);
        const ds = await page.evaluate(() => ({
            listDirty: (typeof DiskStore !== "undefined" && DiskStore.listDirty)
                ? DiskStore.listDirty() : [],
            hasDirtyRk1: (typeof DiskStore !== "undefined" && DiskStore.hasDirty)
                ? DiskStore.hasDirty("rk1.dsk") : null
        }));
        console.log("---- disk writes during quick-boot ----");
        console.log("total writes:", writes.length);
        const blocks = {};
        writes.forEach((w) => { blocks[w.block] = (blocks[w.block] || 0) + 1; });
        console.log("by block:", JSON.stringify(blocks));
        console.log("---- DiskStore state ----");
        console.log(JSON.stringify(ds, null, 2));
    } finally {
        if (browser) { try { await browser.close(); } catch (err) { /* ignore */ } }
        if (server) server.kill();
    }
}

main().catch((err) => {
    console.error("DEBUG FAILED:", err.message);
    process.exit(1);
});
