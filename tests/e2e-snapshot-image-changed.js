#!/usr/bin/env node
/**
 * yaPDP snapshot/image-change end-to-end test (puppeteer + real Chromium).
 *
 * The unit tests (tests/image-fingerprint-invalidation.test.js) pin the RULE:
 * a snapshot whose disk changed under it is refused, an unknown fingerprint is
 * not. This suite pins what the operator actually SEES when it happens, in a
 * real browser, because the refuse path is the half of the feature that only
 * exists in the DOM:
 *
 *   1. the dialog opens and says the snapshot was taken on a different build;
 *   2. it names the image and both fingerprints, so the message is actionable;
 *   3. it uses the shared error shell (.modal-box.error), like the failed-image
 *      dialog it is styled after;
 *   4. "Delete this snapshot" really removes it from the store;
 *   5. "Got it" dismisses it without deleting anything;
 *   6. the image name arrives as TEXT — a snapshot name is stored data, not a
 *      URL we validated, and must never be parsed as markup.
 *
 * Run with:  node tests/e2e-snapshot-image-changed.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const BASE = "http://localhost:1170/pdp11.html";

const ROOT = path.resolve(__dirname, "..");

// --- shared dev server ------------------------------------------------------
// The suite needs a server on :1170 (the page and its media come from it).
// Start our own when nothing serves the port and stop it on the way out;
// reuse one that is already up (the shared server tools/validate.js starts).
const SERVE_URL = "http://localhost:1170/pdp11.html";
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

// Open the emulator with the startup gate out of the way.
async function openPage(browser, errors) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    await page.evaluateOnNewDocument(() => {
        try {
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (e) { /* ignore */ }
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(
        () => typeof SnapshotStore === "object" && typeof SnapshotStore.init === "function",
        { timeout: 60000 });
    return page;
}

(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const errors = [];

    try {
        // --- 1 / 2 / 3: the dialog itself --------------------------------
        {
            const page = await openPage(browser, errors);
            await page.evaluate(() => {
                SnapshotStore.showIncompatibleImageDialog(
                    { id: "snap-e2e", name: "unix-v5 before the upgrade" },
                    [{ url: "rk0.dsk", then: "a1b2c3d4", now: "ff0099aa" }]);
            });
            const state = await page.evaluate(() => {
                const overlay = document.querySelector("#snap-incompatible-overlay.visible");
                if (!overlay) return null;
                const title = overlay.querySelector(".modal-title");
                const intro = overlay.querySelector(".modal-intro");
                return {
                    title: title ? title.textContent : "",
                    intro: intro ? intro.textContent : "",
                    codes: Array.from(overlay.querySelectorAll("code")).map((c) => c.textContent),
                    errorShell: overlay.querySelectorAll(".modal-box.error").length,
                    buttons: Array.from(overlay.querySelectorAll("button"))
                        .map((b) => b.textContent)
                };
            });
            check("the dialog opens", state !== null);
            check("it says the snapshot was not restored",
                state && state.title === "Snapshot not restored", state && state.title);
            check("it names the image and both fingerprints",
                state && state.codes.indexOf("rk0.dsk (expected a1b2c3d4, found ff0099aa)") !== -1,
                state && state.codes.join(" | "));
            check("it names the snapshot",
                state && state.codes.indexOf("unix-v5 before the upgrade") !== -1,
                state && state.codes.join(" | "));
            check("it uses the shared error shell",
                state && state.errorShell === 1);
            check("it offers Got it and Delete this snapshot",
                state && state.buttons.indexOf("Got it") !== -1 &&
                state.buttons.indexOf("Delete this snapshot") !== -1,
                state && state.buttons.join(" | "));

            // --- 5. Got it dismisses, and deletes nothing -----------------
            await page.click("#snap-incompatible-overlay [data-snap-action='close']");
            const dismissed = await page.evaluate(() =>
                !document.querySelector("#snap-incompatible-overlay.visible"));
            check("Got it dismisses the dialog", dismissed);
            await page.close();
        }

        // --- 4. Delete this snapshot really deletes ----------------------
        {
            const page = await openPage(browser, errors);
            // Save a real snapshot, then present it as incompatible.
            const saved = await page.evaluate(async () => {
                const snap = await SnapshotStore.save("doomed snapshot");
                return { id: snap.id, count: (await SnapshotStore.list()).length };
            });
            check("a snapshot was saved for the delete check", saved.count >= 1,
                String(saved.count));

            await page.evaluate((id) => {
                SnapshotStore.showIncompatibleImageDialog(
                    { id: id, name: "doomed snapshot" },
                    [{ url: "rk0.dsk", then: "aaaa1111", now: "bbbb2222" }]);
            }, saved.id);

            await page.click("#snap-incompatible-overlay [data-snap-action='remove']");
            const gone = await page.evaluate(async (id) => {
                const items = await SnapshotStore.list();
                return {
                    stillThere: items.some((it) => it.id === id),
                    overlayVisible: !!document.querySelector("#snap-incompatible-overlay.visible")
                };
            }, saved.id);
            check("Delete this snapshot removes it from the store",
                gone.stillThere === false, JSON.stringify(gone));
            check("...and closes the dialog behind it",
                gone.overlayVisible === false, JSON.stringify(gone));
            await page.close();
        }

        // --- 6. Stored data is text, not markup --------------------------
        {
            const page = await openPage(browser, errors);
            const hostile = "<img src=x onerror=alert(1)>";
            await page.evaluate((name) => {
                SnapshotStore.showIncompatibleImageDialog(
                    { id: "snap-x", name: name },
                    [{ url: "rk0.dsk", then: "aaaa1111", now: "bbbb2222" }]);
            }, hostile);
            const state = await page.evaluate(() => {
                const overlay = document.querySelector("#snap-incompatible-overlay");
                const name = overlay.querySelector(".modal-intro code");
                return {
                    text: name ? name.textContent : "",
                    injected: !!overlay.querySelector("img")
                };
            });
            check("a hostile snapshot name is shown as text",
                state.text === hostile, state.text);
            check("nothing was injected into the dialog", state.injected === false);

            await page.evaluate(() => SnapshotStore.hideIncompatibleImageDialog());
            check("no page errors during the whole flow", errors.length === 0,
                errors.join(" | "));
            await page.close();
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\nsnapshot image-change e2e: all checks passed");
})();
