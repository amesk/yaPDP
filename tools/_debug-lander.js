#!/usr/bin/env node
/**
 * yaPDP — Diagnostic: Lunar Lander VT11 canvas fill over time.
 *
 * Boots Lunar Lander through the quick-boot wizard exactly like the video
 * generator, then logs the green-phosphor pixel counts (total / top half /
 * bottom half) every 2 s and saves a few screenshots, so we can see where the
 * start-up text ends and when the full picture (mountains + lander module)
 * appears. Used to pick the trim points for the video cut (fade-out/fade-in).
 *
 * Usage:
 *   node tools/_debug-lander.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "video");
const PORT = 11791;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

// Same profile the video generator uses for Lunar Lander.
const CFG = {
    consoleType: "teletype",
    userTerminals: 2,
    printer: false,
    vt11: true,
    teletypeSpeed: "fast",
    powerOn: true,
    autoBoot: false
};

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

async function launchBrowser() {
    const executablePath = findBrowserExecutable();
    if (!executablePath) throw new Error("No Edge/Chrome found");
    return puppeteer.launch({
        executablePath,
        headless: "new",
        defaultViewport: VIEWPORT
    });
}

(async function main() {
    let server = null;
    let browser = null;
    try {
        fs.mkdirSync(OUT, { recursive: true });
        server = await ensureServer();
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);

        await page.evaluateOnNewDocument((seed) => {
            try {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed.cfg));
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (err) { /* ignore */ }
        }, { cfg: CFG });

        await page.goto(`${BASE}/pdp11.html`, { waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function",
            { timeout: 30000 });

        await page.evaluate(() => {
            const btn = document.getElementById("quick-boot-btn");
            if (btn) btn.click();
        });
        await sleep(500);
        await page.evaluate(() => {
            const opt = document.querySelector(
                '.quickboot-option[data-quickboot-device="lander"]');
            if (opt) opt.click();
        });

        let onDisplay = false;
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            onDisplay = await page.evaluate(() => {
                const p = document.getElementById("page-vt11");
                return !!(p && p.classList.contains("active"));
            });
            if (onDisplay) break;
        }
        if (!onDisplay) {
            console.log("NOT on Display page");
            return;
        }

        console.log("t(s), total, top, bottom");
        const t0 = Date.now();
        for (let i = 0; i < 75; i++) { // 75 * 2 s = 150 s
            const counts = await page.evaluate(() => {
                const c = document.querySelector("#vt11 canvas");
                if (!c) return { total: 0, top: 0, bottom: 0 };
                const ctx = c.getContext("2d");
                const w = c.width, h = c.height;
                const d = ctx.getImageData(0, 0, w, h).data;
                let total = 0, top = 0, bottom = 0;
                const half = h >> 1;
                for (let y = 0; y < h; y++) {
                    const row = y * w * 4;
                    for (let x = 0; x < w; x++) {
                        if (d[row + x * 4 + 1] > 80) {
                            total++;
                            if (y < half) top++; else bottom++;
                        }
                    }
                }
                return { total: total, top: top, bottom: bottom };
            });
            const t = Math.round((Date.now() - t0) / 1000);
            console.log(`${t}, ${counts.total}, ${counts.top}, ${counts.bottom}`);
            await page.mouse.move(80 + ((i * 97) % 1100), 80 + ((i * 71) % 620));
            if (t === 30 || t === 60 || t === 90 || t === 120 || t === 150) {
                await page.screenshot({
                    path: path.join(OUT, `lander-debug-${t}.png`), type: "png"
                });
            }
            await sleep(2000);
        }
    } finally {
        if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
        if (server) server.kill();
    }
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
