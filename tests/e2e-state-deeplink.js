#!/usr/bin/env node
/**
 * yaPDP ?state= deep-link end-to-end test (puppeteer + real Chromium).
 *
 * The second shareable link (see docs/ROADMAP.md): ?boot= names a scenario the
 * build ships, ?state=<url> points at a machine state — one the project hosts
 * (states/<name>.state.zst) or one a visitor put on their own host. A state
 * REPLACES a boot: the guest was already running when it was taken.
 *
 * What is pinned here, in a real browser:
 *
 *   1. a state the project hosts is fetched, applied, and the machine comes up
 *      RUNNING the restored guest (not booting);
 *   2. the parameter is dropped from the URL once the state is applied — a
 *      link that worked leaves a clean address bar;
 *   3. a URL we refuse before fetching (a javascript: trap, a
 *      protocol-relative host, an absurd length) shows the refusal dialog and
 *      changes nothing;
 *   4. a URL that is not a state (a page, a disk image) shows the failure
 *      dialog rather than half-applying anything;
 *   5. a link that could not be honoured KEEPS its parameter, so the visitor
 *      sees what was actually asked for;
 *   6. an EXTERNAL host works — the same state served from another origin with
 *      CORS applied, which is the whole point of sharing a state with somebody
 *      else (the project's own states are same-origin, so nothing above proves
 *      the cross-origin path);
 *   7. an external host WITHOUT CORS fails loudly — the visitor gets the
 *      failure dialog naming the URL, never a silent dead machine.
 *
 * Run with:  node tests/e2e-state-deeplink.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PORT = 1170;
const BASE = `http://localhost:${PORT}/pdp11.html`;
const STATE = "states/rk1-ready.state.zst";   // RT-11, ~2 KB, committed
const STATE_BYTES = fs.readFileSync(path.join(ROOT, STATE));

// A second origin for the cross-origin checks. It serves the SAME state bytes,
// with or without the CORS header, so the only variable is the header itself.
// Port 0 lets the OS pick a free one — the suite must not collide with the
// static server, a developer's own instance, or a parallel CI job.
async function startExternalHost(withCors) {
    const server = http.createServer((req, res) => {
        if (/state\.zst$/.test(req.url || "")) {
            const headers = { "Content-Type": "application/octet-stream" };
            if (withCors) headers["Access-Control-Allow-Origin"] = "*";
            res.writeHead(200, headers);
            res.end(STATE_BYTES);
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    return { server: server, url: `http://127.0.0.1:${port}/my.state.zst` };
}

// The suite fetches states/... over HTTP, so it needs a server on :1170. It is
// the one e2e suite that used to ASSUME a server was already up — true under
// CI (a shared server) and under `npm run validate` only by luck, since the
// other suites start and stop their own. Start one when nothing serves the
// port and kill it on the way out.
function serverAlive() {
    return new Promise((resolve) => {
        const req = http.get(BASE, (res) => {
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
        await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();
    throw new Error(`Static server did not start on port ${PORT}`);
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

async function poll(page, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (await page.evaluate(predicate)) return true;
        } catch (e) { /* navigating: context gone, retry */ }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 150));
    }
}

// Open the emulator with the loading gate out of the way; storage is CLEAN so
// the state path is the only thing that can bring the machine up.
async function openPage(browser, errors, search) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    await page.evaluateOnNewDocument(() => {
        try { localStorage.clear(); } catch (e) { /* ignore */ }
    });
    await page.goto(BASE + search, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(
        () => typeof SnapshotStore === "object" && typeof QuickBoot === "object",
        { timeout: 60000 });
    return page;
}

function snapshot(page) {
    return page.evaluate(() => ({
        search: location.search,
        // The refusal/failure dialog shares this overlay with the "no such
        // scenario" one; its title tells the two apart.
        dialogTitle: (function () {
            const el = document.querySelector("#quickboot-link-error.visible .modal-title");
            return el ? el.textContent : null;
        })(),
        dialogUrl: (function () {
            const el = document.querySelector("#quickboot-link-error.visible .modal-intro code");
            return el ? el.textContent : null;
        })(),
        // A restored machine shows the running guest on the console page.
        consoleText: (function () {
            const c = document.querySelector("#page-teletype");
            return c ? c.innerText.slice(-200) : "";
        })(),
    }));
}

// The state flow can RELOAD the page (its device set or its config differs from
// the live one) right after it drops ?state=, so a read can race a navigation.
// Retry until the page settles instead of dying with "Execution context was
// destroyed" — the same tolerance poll() already has.
async function snap(page) {
    const deadline = Date.now() + 20000;
    for (;;) {
        try {
            return await snapshot(page);
        } catch (e) {
            if (Date.now() > deadline) throw e;
            await new Promise((r) => setTimeout(r, 150));
        }
    }
}

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const errors = [];

    try {
        // --- 1. A state the project hosts: fetched, applied, running ------
        {
            const page = await openPage(browser, errors, "?state=" + STATE);
            // The state is applied by SnapshotStore.loadFromUrl; success is the
            // parameter leaving the URL (see 2) plus a live console.
            const applied = await poll(page, () =>
                location.search.indexOf("state=") === -1, 45000);
            const state = await snap(page);
            check("?state=: the state was applied (parameter dropped)",
                applied, JSON.stringify(state));
            check("?state=: no failure dialog was shown",
                state.dialogTitle === null, String(state.dialogTitle));
            check("?state=: the machine is running the restored guest",
                state.consoleText.length > 0, JSON.stringify(state.consoleText));
            await page.close();
        }

        // --- 2. A refused URL: never fetched ------------------------------
        for (const [label, url] of [
            ["a javascript: trap", "javascript:alert(1)"],
            ["a protocol-relative host", "//evil.example/x.state.zst"],
        ]) {
            const page = await openPage(browser, errors,
                "?state=" + encodeURIComponent(url));
            const shown = await poll(page, () =>
                !!document.querySelector("#quickboot-link-error.visible"), 15000);
            const state = await snap(page);
            check("refused (" + label + "): the dialog explains the refusal",
                shown && state.dialogTitle === "Shared state refused",
                JSON.stringify(state));
            check("refused (" + label + "): the parameter is kept",
                state.search.indexOf("state=") !== -1, state.search);
            check("refused (" + label + "): nothing was fetched (no page errors)",
                errors.length === 0, errors.join(" | "));
            await page.close();
        }

        // --- 3. A URL that is not a state: failure, not half-apply --------
        {
            const page = await openPage(browser, errors,
                "?state=" + encodeURIComponent("pdp11.html"));
            const shown = await poll(page, () =>
                !!document.querySelector("#quickboot-link-error.visible"), 30000);
            const state = await snap(page);
            check("not-a-state: the failure dialog opens",
                shown && state.dialogTitle === "Shared state not restored",
                JSON.stringify(state));
            check("not-a-state: the parameter is kept",
                state.search.indexOf("state=") !== -1, state.search);
            check("not-a-state: the URL is named as text",
                !!state.dialogUrl, JSON.stringify(state.dialogUrl));
            await page.close();
        }

        // --- 4. An external host WITH CORS: sharing to the world --------
        // The project's own states are same-origin, so nothing above exercises
        // the cross-origin path a visitor's own host must take. This is the
        // point of sharing a state at all: the file lives somewhere else.
        {
            const ext = await startExternalHost(true);
            try {
                const page = await openPage(browser, errors,
                    "?state=" + encodeURIComponent(ext.url));
                const applied = await poll(page, () =>
                    location.search.indexOf("state=") === -1, 45000);
                const state = await snap(page);
                check("external (CORS): the state was applied",
                    applied, JSON.stringify(state));
                check("external (CORS): no failure dialog was shown",
                    state.dialogTitle === null, String(state.dialogTitle));
                check("external (CORS): the machine is running the restored guest",
                    state.consoleText.length > 0, JSON.stringify(state.consoleText));
                await page.close();
            } finally {
                ext.server.close();
            }
        }

        // --- 5. An external host WITHOUT CORS: fail loudly ---------------
        // The same bytes, the same link, the header missing. The fetch is
        // blocked by the browser, so the visitor must be TOLD — a silent dead
        // machine is the one outcome a share link can never have.
        {
            const ext = await startExternalHost(false);
            try {
                const page = await openPage(browser, errors,
                    "?state=" + encodeURIComponent(ext.url));
                const shown = await poll(page, () =>
                    !!document.querySelector("#quickboot-link-error.visible"), 30000);
                const state = await snap(page);
                check("external (no CORS): the failure dialog opens",
                    shown && state.dialogTitle === "Shared state not restored",
                    JSON.stringify(state));
                check("external (no CORS): the parameter is kept",
                    state.search.indexOf("state=") !== -1, state.search);
                await page.close();
            } finally {
                ext.server.close();
            }
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\n?state= deep-link e2e: all checks passed");
})();
