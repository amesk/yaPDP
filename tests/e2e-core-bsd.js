#!/usr/bin/env node
/**
 * e2e: BSD 2.11 boot in the browser on the NEW headless stack (?core=1).
 *
 * The refactored machine layer (bus/device/machine + DiskService + MMU
 * regs + RP11 + UDA50) must boot BSD 2.11 to login: in the browser just
 * like iopage.js does — this is the end-to-end parity check for the
 * core-mode path (pdp11.html?core=1 + browser-machine.js).
 *
 * Needs:  node tools/serve.js --port 1170  (started automatically if down)
 * Run:    node tests/e2e-core-bsd.js
 * Exit 0 = passed, non-zero = failure.
 */
"use strict";

const http = require("http");
const puppeteer = require("puppeteer");
const PORT = 1170;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureServer() {
    return new Promise((res) => {
        const req = http.get(`${BASE}/pdp11.html?core=1&bridge=1`, (r) => { r.resume(); res(null); });
        req.on("error", () => {
            const srv = require("child_process").spawn(
                "node", ["tools/serve.js", "--port", String(PORT)],
                { cwd: __dirname + "/..", stdio: "ignore" });
            setTimeout(() => res(srv), 1500);
        });
    });
}

async function run() {
    await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        const errors = [];
        page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
        page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

        const cfg = {
            consoleType: "teletype", userTerminals: 0, printer: false,
            vt11: false, teletypeSpeed: "fast", powerOn: true, autoBoot: false,
        };
        await page.evaluateOnNewDocument((seed) => {
            try {
                localStorage.setItem("yapdp.config.v1", JSON.stringify(seed));
                localStorage.setItem("yapdp.onboarding.v1", "done");
            } catch (e) {}
        }, cfg);

        await page.goto(`${BASE}/pdp11.html?core=1&bridge=1`, { waitUntil: "load", timeout: 90000 });
        await page.waitForFunction(() => typeof window.switchPage === "function", { timeout: 30000 });

        // Capture console output through the bridge hook.
        await page.evaluate(() => {
            window.__osShotOutput = "";
            const orig = window.__consoleOutputHook;
            window.__consoleOutputHook = function (ch) {
                if (typeof orig === "function") orig(ch);
                window.__osShotOutput += String.fromCharCode(ch & 0x7F);
                if (window.__osShotOutput.length > 32768) {
                    window.__osShotOutput = window.__osShotOutput.slice(-32768);
                }
            };
        });

        await page.evaluate(() => { if (typeof boot === "function") boot(); });
        const out = () => page.evaluate(() => window.__osShotOutput || "");
        const waitFor = async (fn, t) => {
            const t0 = Date.now();
            while (Date.now() - t0 < t) {
                try { if (await fn()) return true; } catch (e) {}
                await sleep(250);
            }
            return false;
        };

        // Bootloader "@" → "boot rp1" → "Press <CR>" → CR → login:
        const ok1 = await waitFor(async () => (await out()).includes("@"), 60000);
        if (!ok1) throw new Error("bootloader prompt '@' not reached\n" + (await out()).slice(-500));

        await page.evaluate(() => {
            if (typeof window.dlReceiveQueue === "function") {
                window.dlReceiveQueue(0, Array.from("boot rp1").map((c) => c.charCodeAt(0)).concat([13]));
            }
        });
        const ok2 = await waitFor(async () => (await out()).includes("Press <CR>"), 90000);
        if (!ok2) throw new Error("'Press <CR>' not reached after boot rp1\n" + (await out()).slice(-500));

        await page.evaluate(() => {
            if (typeof window.dlReceiveQueue === "function") window.dlReceiveQueue(0, [13]);
        });
        const ok3 = await waitFor(async () => (await out()).includes("login:"), 240000);

        const finalOut = await out();
        if (errors.length) {
            console.error("browser errors:\n" + errors.join("\n"));
        }

        // ---- assertions ---------------------------------------------------
        const assert = require("assert");
        assert.ok(ok3, "BSD 2.11 reached login: in ?core=1 mode\n--- tail ---\n" + finalOut.slice(-800));
        assert.ok(finalOut.includes("2.11 BSD UNIX"), "kernel banner present");
        assert.ok(/ra 0 csr 172150 vector 154/.test(finalOut) &&
            finalOut.includes("vectorset attached"), "UDA50 ra 0 attached");
        assert.ok(/xp 0 csr 176700 vector 254 attached/.test(finalOut), "RP11 xp 0 attached");
        assert.strictEqual(errors.length, 0, "no page/console errors");

        console.log("PASS: BSD 2.11 boots to login: on ?core=1 (headless stack in browser)");
        console.log("PASS: autoconfig parity (ra 0 vectorset attached, xp 0 attached)");
        console.log("PASS: no browser errors");
        console.log("\ne2e-core-bsd: ALL CHECKS PASSED");
        process.exit(0);
    } finally {
        await browser.close();
    }
}

run().catch((e) => {
    console.error("FAIL:", e.message);
    process.exit(1);
});
