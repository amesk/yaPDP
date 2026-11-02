#!/usr/bin/env node
/**
 * Probe — where does "Restoring the machine state…" spend its time?
 *
 * Opens a real state through the ?state= deep link in Chromium and records a
 * per-document timeline of the restore, so the wait can be attributed instead
 * of guessed:
 *
 *   dcl                DOMContentLoaded of this document
 *   loadFromUrl        SnapshotStore.loadFromUrl() entered / settled
 *   restore            SnapshotStore.restore() entered / settled
 *   clearAll           DiskStore.clearAll() (IndexedDB wipe of old blocks)
 *   restoreOverlay     DiskStore.restoreOverlay() (write the state's blocks)
 *   image              window.__yapdpLoadImage() per url, start / end
 *   toast              the "Restoring the machine state…" toast became
 *                      visible / hidden
 *
 * A document id (performance.timeOrigin) tags every mark: a state whose
 * device set differs reloads the page once, and the two documents must not be
 * mixed up.
 *
 * Usage:
 *   node tools/_probe-restore-timing.js
 *   node tools/_probe-restore-timing.js --state states/rp1-ready.state.zst
 *   node tools/_probe-restore-timing.js --state states/rk1-ready.state.zst --watch 25
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");
const PORT = 1170;
const BASE = "http://localhost:" + PORT + "/pdp11.html";

function parseArgs(argv) {
    const opts = { state: "states/rp1-ready.state.zst", watch: 20 };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i + 1];
        if (argv[i] === "--state" && v) { opts.state = v; i++; continue; }
        if (argv[i] === "--watch" && v) { opts.watch = Math.max(5, parseInt(v, 10) || 20); i++; continue; }
        if (argv[i] === "--help" || argv[i] === "-h") {
            console.log("usage: node tools/_probe-restore-timing.js [--state file] [--watch seconds]");
            process.exit(0);
        }
    }
    return opts;
}

function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(BASE, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on("error", () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
}

async function ensureServer() {
    if (await serverAlive()) return null;
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "serve.js"), "--port", String(PORT)],
        { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        if (await serverAlive()) return child;
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error("Static server did not start on port " + PORT);
}

async function run(browser, stateUrl, watchSeconds) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Installed before any page script: wraps the restore path as it appears.
    await page.evaluateOnNewDocument(() => {
        const doc = Math.round(performance.timeOrigin);
        window.__probeDoc = doc;
        const marks = [];
        const push = (name, arg, at) => {
            const t = Math.round((at == null ? performance.now() : at));
            marks.push({ name, arg: arg == null ? null : String(arg), t });
            try { console.log("PROBE " + JSON.stringify({ doc, name, arg: arg == null ? null : String(arg), t })); } catch (e) {}
        };
        window.__probePush = push;

        // Wrap a property that a page script assigns (script-level var/x.y =).
        const wrapMethod = (holderName, method, label) => {
            let value = null;
            Object.defineProperty(window, holderName, {
                configurable: true,
                get() { return value; },
                set(v) {
                    value = v;
                    if (!v || typeof v !== "object" || typeof v[method] !== "function") return;
                    const orig = v[method];
                    v[method] = function () {
                        const t0 = performance.now();
                        push(label + ":start", null, t0);
                        const out = orig.apply(this, arguments);
                        const done = (tag) => push(label + ":" + tag, Math.round(performance.now() - t0) + "ms",
                            performance.now());
                        if (out && typeof out.then === "function") {
                            return out.then((r) => { done("ok"); return r; }, (e) => { done("fail"); throw e; });
                        }
                        done("sync");
                        return out;
                    };
                }
            });
        };
        wrapMethod("DiskStore", "clearAll", "clearAll");
        wrapMethod("DiskStore", "restoreOverlay", "restoreOverlay");
        wrapMethod("SnapshotStore", "loadFromUrl", "loadFromUrl");
        wrapMethod("SnapshotStore", "restore", "restore");

        let loader = null;
        Object.defineProperty(window, "__yapdpLoadImage", {
            configurable: true,
            get() { return loader; },
            set(fn) {
                loader = typeof fn === "function" ? function (url, versionInfo) {
                    push("image:start", url + (versionInfo ? " v" + versionInfo.version : ""));
                    const out = fn.apply(this, arguments);
                    if (out && typeof out.then === "function") {
                        return out.then((v) => { push("image:end", url); return v; },
                            (e) => { push("image:fail", url); throw e; });
                    }
                    push("image:end", url);
                    return out;
                } : fn;
            }
        });

        document.addEventListener("DOMContentLoaded", () => {
            push("dcl");
            const watchToast = (el) => {
                let on = el.classList.contains("visible");
                new MutationObserver(() => {
                    const now = el.classList.contains("visible");
                    if (now !== on) { on = now; push("toast:" + (now ? "shown" : "hidden")); }
                }).observe(el, { attributes: true, attributeFilter: ["class"] });
            };
            const find = () => {
                const el = document.getElementById("quick-boot-preparing");
                if (el) { watchToast(el); return true; }
                return false;
            };
            if (!find()) {
                const scan = new MutationObserver(() => { if (find()) scan.disconnect(); });
                scan.observe(document.documentElement, { childList: true, subtree: true });
            }
        });
    });

    const marks = [];
    page.on("console", (msg) => {
        const text = msg.text() || "";
        if (text.indexOf("PROBE ") !== 0) return;
        try { marks.push(JSON.parse(text.slice(6))); } catch (e) { /* ignore */ }
    });
    page.on("pageerror", (err) => console.log("PAGEERROR " + (err && err.message)));

    const started = Date.now();
    await page.goto(BASE + "?state=" + encodeURIComponent(stateUrl),
        { waitUntil: "domcontentloaded", timeout: 90000 });
    await new Promise((r) => setTimeout(r, watchSeconds * 1000));

    let cpu = null;
    try {
        cpu = await page.evaluate(() => typeof CPU !== "undefined"
            ? { runState: CPU.runState, pc: CPU.pc } : null);
    } catch (e) { /* ignore */ }
    await page.close();
    return { stateUrl, marks, wallMs: Date.now() - started, cpu };
}

function report(r) {
    const docs = new Map();
    for (const m of r.marks) {
        if (!docs.has(m.doc)) docs.set(m.doc, []);
        docs.get(m.doc).push(m);
    }
    console.log("\n=== " + r.stateUrl + "  (observed " + r.wallMs + " ms, " +
        docs.size + " document(s), CPU " +
        (r.cpu ? "runState=" + r.cpu.runState + " pc=0" + (r.cpu.pc || 0).toString(8) : "n/a") + ")");
    let n = 0;
    for (const [doc, marks] of docs) {
        console.log("-- document " + (++n) + " (" + doc + ")");
        for (const m of marks) {
            console.log("  " + String(m.t).padStart(6) + "  " +
                m.name + (m.arg ? "  [" + m.arg + "]" : ""));
        }
        const at = (name) => { const m = marks.find((x) => x.name === name); return m ? m.t : null; };
        const dcl = at("dcl"), shown = at("toast:shown"), hidden = at("toast:hidden");
        if (dcl != null && shown != null) console.log("  => silent page before the toast: " + (shown - dcl) + " ms");
        if (shown != null && hidden != null) console.log("  => toast up: " + (hidden - shown) + " ms");
    }
}

(async () => {
    const opts = parseArgs(process.argv.slice(2));
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    try {
        report(await run(browser, opts.state, opts.watch));
    } finally {
        await browser.close();
        if (server) server.kill();
    }
})();
