#!/usr/bin/env node
/**
 * Service mode (maintenance) — end-to-end regression test (puppeteer + Chromium).
 *
 * The service screen is the only destructive surface of yaPDP, so it is pinned
 * end to end rather than only as a unit:
 *
 *   1. ENTRY with ?maintenance=1 opens the screen and keeps the rest of the
 *      query string (?code=0 — an exhibit deep link) untouched.
 *   2. The confirmation dialog focuses CANCEL, and Esc leaves everything alone:
 *      a destructive action must never be one Enter (or one stray key) away.
 *   3. SYSTEM RESET erases what it promises — the configuration, the stored
 *      images, the machine states and the disk overlays — while the GitHub
 *      credential survives, and it reloads back into the service screen so the
 *      operator sees the result.
 *   4. CLOSE strips `maintenance` and returns to the exhibit URL, keeping the
 *      other parameters.
 *   5. The 5-clicks-in-2-seconds gesture on the version marker opens the same
 *      screen without any URL (a kiosk has no address bar).
 *
 * Run with:  node tests/e2e-maintenance.js
 * (needs puppeteer; starts the dev server itself if :1170 is not serving)
 */
"use strict";

const puppeteer = require("puppeteer");
const h = require("./e2e-teletype-harness.js");

const EXHIBIT_PARAM = "code=0";
const GITHUB_PAT = "ghp-service-mode-should-keep-this";

// --- page helpers ----------------------------------------------------------

function overlayShown(page) {
    return page.evaluate(() => {
        const el = document.getElementById("maintenance-overlay");
        return !!el && !el.hidden && el.getAttribute("aria-hidden") === "false";
    });
}

function dialogOpen(page) {
    return page.evaluate(() => {
        const el = document.getElementById("maintenance-confirm");
        return !!(el && el.open);
    });
}

function activeElementId(page) {
    return page.evaluate(() =>
        (document.activeElement && document.activeElement.id) || "");
}

// Polling that survives a navigation. A reset ends with location.reload(), so
// an evaluate issued while the document is being replaced throws
// "Execution context was destroyed" — that is not a failed check, it is the
// reload being in flight.
async function waitForSafe(page, fn, timeout) {
    const startedAt = Date.now();
    for (;;) {
        try {
            if (await fn()) return true;
        } catch (err) { /* mid-navigation: poll again */ }
        if (Date.now() - startedAt > (timeout || 15000)) return false;
        await h.sleep(250);
    }
}

// Seed the three IndexedDB stores plus the credential key, the way a real
// exhibit accumulates them: an imported image, a saved state, a dirty block.
function seedStorage(page) {
    return page.evaluate(async (pat) => {
        localStorage.setItem("yapdp.config.v1", JSON.stringify({ consoleType: "vt52" }));
        localStorage.setItem("yapdp.onboarding.v1", "done");
        localStorage.setItem("yapdp.github-pat", pat);
        localStorage.setItem("yapdp.mountmap.v1", JSON.stringify({ rk4: "myrt.dsk" }));

        const open = (name, store) => new Promise((resolve, reject) => {
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(store)) {
                    req.result.createObjectStore(store);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const put = (db, store, key, value) => new Promise((resolve) => {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });

        const images = await open("yapdp-images", "images");
        await put(images, "images", "myrt.dsk", new Uint8Array([1, 2, 3, 4]));
        images.close();

        const states = await open("yapdp-snapshots", "snapshots");
        await put(states, "snapshots", "s1",
            { id: "s1", name: "exhibit", createdAt: Date.now(), schemaVersion: "1.0.0" });
        states.close();

        const blocks = await open("yapdp-diskstore", "blocks");
        await put(blocks, "blocks", "rk0.dsk::42", new Uint8Array([9, 9, 9, 9]));
        await put(blocks, "blocks", "rk0.dsk::meta", { origin: null });
        blocks.close();
    }, GITHUB_PAT);
}

function storageState(page) {
    return page.evaluate(async () => {
        const count = (name, store) => new Promise((resolve) => {
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(store)) {
                    req.result.createObjectStore(store);
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                try {
                    const tx = db.transaction(store, "readonly");
                    const keys = tx.objectStore(store).getAllKeys();
                    keys.onsuccess = () => { db.close(); resolve(keys.result.length); };
                    keys.onerror = () => { db.close(); resolve(-1); };
                } catch (err) {
                    db.close();
                    resolve(-1);
                }
            };
            req.onerror = () => resolve(-1);
        });

        return {
            images: await count("yapdp-images", "images"),
            snapshots: await count("yapdp-snapshots", "snapshots"),
            blocks: await count("yapdp-diskstore", "blocks"),
            config: localStorage.getItem("yapdp.config.v1"),
            // The contract is the VALUES, not the absence of the key: the page
            // itself re-persists the default profile right after a reset (the
            // power-on bookkeeping in src/pdp11-app.js calls Config.set()).
            configIsFactory: (() => {
                const raw = localStorage.getItem("yapdp.config.v1");
                if (!raw) return true;
                try {
                    const stored = JSON.stringify(Config.validate(JSON.parse(raw)));
                    const factory = JSON.stringify(Config.validate(Config.load(null)));
                    return stored === factory;
                } catch (err) {
                    return false;
                }
            })(),
            onboarding: localStorage.getItem("yapdp.onboarding.v1"),
            mountmap: localStorage.getItem("yapdp.mountmap.v1"),
            pat: localStorage.getItem("yapdp.github-pat")
        };
    });
}

// Click an element the way the operator does, without depending on its size:
// the version marker is a small piece of text.
function click(page, selector, times) {
    return page.evaluate((sel, count) => {
        const node = document.querySelector(sel);
        if (!node) return false;
        for (let i = 0; i < count; i++) node.click();
        return true;
    }, selector, times || 1);
}

async function main() {
    const server = await h.ensureServer();
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // ---- 1. Entry by parameter -------------------------------------
        await page.goto(`${h.BASE}/pdp11.html?maintenance=1&${EXHIBIT_PARAM}`,
            { waitUntil: "load", timeout: 90000 });

        h.check("?maintenance=1 opens the service screen",
            await h.waitFor(() => overlayShown(page), 30000));
        h.check("the exhibit parameter survives the entry",
            (await page.evaluate(() => location.search)).indexOf(EXHIBIT_PARAM) !== -1,
            await page.evaluate(() => location.search));

        // ---- 2. The confirmation dialog protects the data --------------
        await click(page, "#maintenance-reset");
        h.check("System Reset asks for confirmation",
            await h.waitFor(() => dialogOpen(page), 5000));
        h.check("the confirmation focuses Cancel",
            (await activeElementId(page)) === "maintenance-cancel",
            await activeElementId(page));

        await page.keyboard.press("Escape");
        h.check("Esc cancels the confirmation",
            await h.waitFor(async () => !(await dialogOpen(page)), 5000));
        h.check("cancelling keeps the service screen open", await overlayShown(page));

        // ---- 3. Seed the exhibit the way a museum would ----------------
        await seedStorage(page);
        let state = await storageState(page);
        h.check("the test seeds an image, a state and a disk block",
            state.images === 1 && state.snapshots === 1 && state.blocks === 2,
            JSON.stringify(state));

        // ---- 4. System Reset ------------------------------------------
        await click(page, "#maintenance-reset");
        await h.waitFor(() => dialogOpen(page), 5000);
        const navigation = page.waitForNavigation({ waitUntil: "load", timeout: 90000 });
        await click(page, "#maintenance-confirm-ok");
        await navigation;

        h.check("a reset reloads back into the service screen",
            await waitForSafe(page, () => overlayShown(page), 30000));
        h.check("the reset keeps the exhibit parameter",
            await waitForSafe(page, async () =>
                (await page.evaluate(() => location.search)).indexOf(EXHIBIT_PARAM) !== -1, 5000),
            await page.evaluate(() => location.search).catch(() => "?"));
        h.check("the screen reports what happened",
            await waitForSafe(page, async () => {
                const text = await page.evaluate(() =>
                    (document.getElementById("maintenance-status") || {}).textContent || "");
                return /reset/i.test(text);
            }, 10000));

        state = await storageState(page);
        h.check("the stored images are gone", state.images === 0, JSON.stringify(state));
        h.check("the stored machine states are gone", state.snapshots === 0, JSON.stringify(state));
        h.check("the disk overlays are gone", state.blocks === 0, JSON.stringify(state));
        h.check("the configuration is back to the factory defaults", state.configIsFactory,
            JSON.stringify(state));
        h.check("the first-run hint is armed again", state.onboarding === null,
            JSON.stringify(state));
        h.check("the drive binding table is cleared", state.mountmap === null,
            JSON.stringify(state));
        h.check("the GitHub credential survives a reset", state.pat === GITHUB_PAT,
            JSON.stringify(state));

        // ---- 5. Close --------------------------------------------------
        const closeNav = page.waitForNavigation({ waitUntil: "load", timeout: 90000 });
        await click(page, "#maintenance-close");
        await closeNav;

        const afterClose = await page.evaluate(() => location.search);
        h.check("Close leaves the service mode", afterClose.indexOf("maintenance") === -1,
            afterClose);
        h.check("Close keeps the exhibit parameter", afterClose.indexOf(EXHIBIT_PARAM) !== -1,
            afterClose);
        h.check("Close shows the emulator again",
            await waitForSafe(page, async () => {
                return (await page.evaluate(() =>
                    typeof window.switchPage === "function")) &&
                    !(await overlayShown(page));
            }, 30000));

        // ---- 5b. The factory state is a quiet, powered-off machine -----
        // Regression: a startup setPowerState('run') in the panel module used
        // to power the machine on behind the config, so a factory reset left a
        // CPU executing zeroed memory and the "halted at 000002" notice
        // appeared on every reload.
        const machine = () => page.evaluate(() => ({
            power: (typeof panel !== "undefined") ? panel.powerSwitch : "n/a",
            toast: (() => {
                const node = document.querySelector(".yapdp-toast");
                return node ? String(node.textContent || "") : "";
            })()
        }));

        let quiet = await machine();
        h.check("after a reset the machine comes up powered off",
            typeof quiet.power === "number" && quiet.power < 0, JSON.stringify(quiet));
        h.check("the factory state raises no halt notice",
            !/halt/i.test(quiet.toast), JSON.stringify(quiet));

        await page.reload({ waitUntil: "load", timeout: 90000 });
        await waitForSafe(page, () => page.evaluate(() =>
            typeof window.switchPage === "function"), 30000);
        await h.sleep(1500);
        quiet = await machine();
        h.check("a force reload keeps the factory machine powered off",
            typeof quiet.power === "number" && quiet.power < 0, JSON.stringify(quiet));
        h.check("a force reload raises no halt notice",
            !/halt/i.test(quiet.toast), JSON.stringify(quiet));

        // ---- 6. The kiosk gesture -------------------------------------
        await waitForSafe(page, () => page.evaluate(() =>
            typeof window.switchPage === "function"), 30000);
        const markerText = await page.evaluate(() => {
            const node = document.querySelector("#sidebar-version .sidebar-version-text");
            return node ? String(node.textContent || "").trim() : "";
        });
        h.check("the version marker is filled (the gesture target)", markerText.length > 0,
            markerText);

        await click(page, "#sidebar-version .sidebar-version-text", 4);
        await h.sleep(300);
        h.check("four clicks do not open the service screen", !(await overlayShown(page)));

        await h.sleep(2200); // let the gesture window expire
        await click(page, "#sidebar-version .sidebar-version-text", 5);
        h.check("five clicks open the service screen",
            await waitForSafe(page, () => overlayShown(page), 5000));
        h.check("the gesture marks the URL so a reload stays in service mode",
            (await page.evaluate(() => location.search)).indexOf("maintenance=1") !== -1,
            await page.evaluate(() => location.search));
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    const failures = h.failureCount();
    console.log(failures === 0
        ? "e2e-maintenance: all checks passed"
        : `e2e-maintenance: ${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("e2e-maintenance: FAILED —", err && err.message);
    process.exit(1);
});
