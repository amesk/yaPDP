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
 *   1. the dialog says the state was not restored and that the machine was
 *      left untouched — what happened, before any technical detail;
 *   2. it names each disk by its bare image name (no path, no .zst) with a
 *      SHORT identity, while the full 64-digit digests live behind "Technical
 *      details": unbroken digests used to widen the box past the window edge;
 *   3. it uses the shared error shell (.modal-box.error), like the failed-image
 *      dialog it is styled after;
 *   4. "Delete this state" really removes it from the store;
 *   5. "Keep it" dismisses it without deleting anything;
 *   6. the image name arrives as TEXT — a snapshot name is stored data, not a
 *      URL we validated, and must never be parsed as markup;
 *   7. .modal-box does not overflow horizontally, collapsed or expanded.
 *
 * Run with:  node tests/e2e-snapshot-image-changed.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { ImageFingerprint } = require("../src/imagefingerprint.js");

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
            const thenHash = "a1b2c3d4".repeat(8);   // 64 digits, like a real digest
            const nowHash = "ff0099aa".repeat(8);
            await page.evaluate((then, now) => {
                SnapshotStore.showIncompatibleImageDialog(
                    { id: "snap-e2e", name: "unix-v5 before the upgrade" },
                    [{ url: "media/rk0.dsk.zst", then: then, now: now, reason: "changed" }]);
            }, thenHash, nowHash);
            const state = await page.evaluate(() => {
                const overlay = document.querySelector("#snap-incompatible-overlay.visible");
                if (!overlay) return null;
                const title = overlay.querySelector(".modal-title");
                const intro = overlay.querySelector(".modal-intro");
                const box = overlay.querySelector(".modal-box");
                const details = overlay.querySelector(".modal-details");
                // Everything the operator reads in the flow, i.e. the box
                // without the collapsed "Technical details" block.
                const body = box ? box.cloneNode(true) : null;
                if (body) {
                    const collapsed = body.querySelector(".modal-details");
                    if (collapsed) collapsed.remove();
                }
                return {
                    title: title ? title.textContent : "",
                    intro: intro ? intro.textContent : "",
                    bodyText: body ? body.textContent : "",
                    codes: Array.from(overlay.querySelectorAll("code")).map((c) => c.textContent),
                    hasDetails: !!details,
                    detailsText: details ? details.textContent : "",
                    detailsOpen: details ? details.open : null,
                    errorShell: overlay.querySelectorAll(".modal-box.error").length,
                    overflow: box ? box.scrollWidth - box.clientWidth : -1,
                    buttons: Array.from(overlay.querySelectorAll("button"))
                        .map((b) => b.textContent)
                };
            });
            check("the dialog opens", state !== null);
            check("it says the snapshot was not restored",
                state && state.title === "Snapshot not restored", state && state.title);
            check("it says the machine was left as it was",
                state && /left exactly as it was/i.test(state.intro), state && state.intro);
            check("it names the disk without a path or .zst",
                state && state.codes.indexOf("rk0.dsk") !== -1,
                state && state.codes.join(" | "));
            check("it shows a SHORT identity in the flow",
                state && state.bodyText.indexOf("a1b2c3d4\u2026") !== -1,
                state && state.bodyText);
            check("the full digests are NOT in the dialog body",
                state && state.bodyText.indexOf("a1b2c3d4".repeat(8)) === -1 &&
                state.bodyText.indexOf("ff0099aa".repeat(8)) === -1,
                state && state.bodyText);
            check("the full digests live behind Technical details",
                state && state.hasDetails && state.detailsOpen === false &&
                state.detailsText.indexOf("a1b2c3d4".repeat(8)) !== -1 &&
                state.detailsText.indexOf("ff0099aa".repeat(8)) !== -1,
                state && state.detailsText);
            check("it names the snapshot",
                state && state.codes.indexOf("unix-v5 before the upgrade") !== -1,
                state && state.codes.join(" | "));
            check("it uses the shared error shell",
                state && state.errorShell === 1);
            check("it offers Copy details, Keep it and Delete this state",
                state && state.buttons.indexOf("Copy details") !== -1 &&
                state.buttons.indexOf("Keep it") !== -1 &&
                state.buttons.indexOf("Delete this state") !== -1,
                state && state.buttons.join(" | "));
            check("the dialog does not overflow horizontally",
                state && state.overflow <= 0, state && String(state.overflow));

            // --- 7. ...and it stays inside the box when details are open ---
            await page.evaluate(() => {
                const details = document.querySelector("#snap-incompatible-overlay .modal-details");
                if (details) details.open = true;
            });
            const opened = await page.evaluate(() => {
                const box = document.querySelector("#snap-incompatible-overlay .modal-box");
                return box ? box.scrollWidth - box.clientWidth : -1;
            });
            check("no horizontal overflow with Technical details expanded",
                opened <= 0, String(opened));

            // --- 10. The actions never touch: they wrap as one row --------
            // Three inline buttons separated by margin-left butt-joined
            // vertically the moment the row wrapped — "Use my own copy…" sat
            // right on top of "Delete this state" on a narrow window.
            const actionLayout = async () => page.evaluate(() => {
                const actions = document.querySelector("#snap-incompatible-overlay .modal-actions");
                if (!actions) return null;
                const actionsLeft = Math.round(actions.getBoundingClientRect().left);
                const rects = Array.from(actions.querySelectorAll("button"))
                    .map((b) => b.getBoundingClientRect());
                let overlap = false;
                for (let i = 0; i < rects.length; i++) {
                    for (let j = i + 1; j < rects.length; j++) {
                        const a = rects[i];
                        const b = rects[j];
                        if (a.left < b.right && b.left < a.right &&
                            a.top < b.bottom && b.top < a.bottom) overlap = true;
                    }
                }
                // Every ROW must start on the row's left edge. The shared
                // `.modal-box .modal-close + .modal-close` margin used to push a
                // wrapped row 10px right, which read as ragged alignment.
                const rowStarts = {};
                rects.forEach((r) => {
                    const key = Math.round(r.top);
                    if (!(key in rowStarts)) rowStarts[key] = Math.round(r.left);
                });
                const raggedRows = Object.keys(rowStarts)
                    .filter((key) => Math.abs(rowStarts[key] - actionsLeft) > 1).length;
                return {
                    count: rects.length,
                    display: getComputedStyle(actions).display,
                    overlap,
                    raggedRows
                };
            });
            const wide = await actionLayout();
            check("the actions share one wrapping row",
                wide && wide.display === "flex" && wide.count === 3,
                JSON.stringify(wide));
            check("no two actions overlap at the default width",
                wide && wide.overlap === false, JSON.stringify(wide));
            check("every row of actions starts on the same left edge",
                wide && wide.raggedRows === 0, JSON.stringify(wide));

            await page.setViewport({ width: 360, height: 720 });
            const narrow = await actionLayout();
            check("no two actions overlap on a phone-width window",
                narrow && narrow.overlap === false, JSON.stringify(narrow));
            check("wrapped rows stay aligned on a phone-width window",
                narrow && narrow.raggedRows === 0, JSON.stringify(narrow));
            await page.setViewport({ width: 1280, height: 900 });

            // --- 5. Keep it dismisses, and deletes nothing -----------------
            await page.click("#snap-incompatible-overlay [data-snap-action='close']");
            const dismissed = await page.evaluate(() =>
                !document.querySelector("#snap-incompatible-overlay.visible"));
            check("Keep it dismisses the dialog", dismissed);
            await page.close();
        }

        // --- 8. Supplying the disk the state needs -----------------------
        // The state was taken on a disk only this browser has. The operator
        // hands the bytes back: the DIGEST decides, a wrong file changes
        // nothing, and the right one restores the state.
        {
            const page = await openPage(browser, errors);
            const bytes = new Uint8Array(512);
            bytes[0] = 0x11;
            bytes[511] = 0xee;
            const sha = ImageFingerprint.ofBytes(bytes);
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-supply-"));
            const goodPath = path.join(tmpDir, "my-rk5.dsk");
            fs.writeFileSync(goodPath, Buffer.from(bytes));
            const badPath = path.join(tmpDir, "other.dsk");
            fs.writeFileSync(badPath, Buffer.alloc(512, 0x7f));

            const offered = await page.evaluate(async (thenSha) => {
                const snap = await SnapshotStore.save("needs my disk");
                SnapshotStore.showIncompatibleImageDialog(snap,
                    [{ url: "local-rk5.dsk", then: thenSha, now: "0".repeat(64),
                       reason: "changed" }]);
                const overlay = document.querySelector("#snap-incompatible-overlay.visible");
                const picker = overlay && overlay.querySelector("#snap-incompat-file");
                return {
                    id: snap.id,
                    hasButton: !!overlay && Array.from(overlay.querySelectorAll("button"))
                        .some((b) => b.textContent.indexOf("Use my own copy") !== -1),
                    pickerHidden: !!picker && getComputedStyle(picker).display === "none"
                };
            }, sha);
            check("it offers the operator's own copy of the disk", offered.hasButton);
            check("the file picker itself stays out of the dialog", offered.pickerHidden);

            // Wrong file: refused where the operator is looking, nothing mounted.
            await (await page.$("#snap-incompat-file")).uploadFile(badPath);
            const wrong = await page.evaluate(async () => {
                await new Promise((r) => setTimeout(r, 400));
                const status = document.querySelector("#snap-incompatible-overlay .modal-status");
                return {
                    text: status ? status.textContent : "",
                    isError: status ? status.classList.contains("error") : false,
                    mounted: DataLoader.has("local-rk5.dsk"),
                    open: !!document.querySelector("#snap-incompatible-overlay.visible")
                };
            });
            check("a wrong disk is refused in place",
                wrong.isError && /not the disk this state needs/i.test(wrong.text), wrong.text);
            check("...and nothing is mounted from it", wrong.mounted === false);
            check("...and the dialog stays open", wrong.open === true);

            // Right bytes under a DIFFERENT name: accepted, the name is decoration.
            await (await page.$("#snap-incompat-file")).uploadFile(goodPath);
            const right = await page.evaluate(async (id) => {
                await new Promise((r) => setTimeout(r, 900));
                const items = await SnapshotStore.list();
                return {
                    mounted: DataLoader.has("local-rk5.dsk"),
                    open: !!document.querySelector("#snap-incompatible-overlay.visible"),
                    stillStored: items.some((it) => it.id === id)
                };
            }, offered.id);
            check("the right disk is mounted under the name the state expects",
                right.mounted === true, JSON.stringify(right));
            check("...the dialog closes and the restore proceeds",
                right.open === false, JSON.stringify(right));
            check("...and supplying a disk never deletes the state",
                right.stillStored === true, JSON.stringify(right));

            fs.rmSync(tmpDir, { recursive: true, force: true });
            await page.close();
        }

        // --- 9. A state on a local-only disk warns about portability -----
        {
            const page = await openPage(browser, errors);
            const warned = await page.evaluate(async () => {
                const bytes = new Uint8Array(64);
                bytes[0] = 3;
                DataLoader.mount("local-test.dsk", bytes, "local");
                const snap = await SnapshotStore.save("portable?");
                const toast = document.querySelector(".yapdp-toast.visible");
                return {
                    text: toast ? toast.textContent : "",
                    local: Array.prototype.join.call(
                        SnapshotStore.localOnlyImages(snap), ","),
                    stored: (await SnapshotStore.list()).some((it) => it.id === snap.id)
                };
            });
            check("a local-only disk makes the state non-portable",
                warned.local === "local-test.dsk", warned.local);
            check("saving says so in a toast",
                /only this browser has/i.test(warned.text), warned.text);
            check("...and the state is still saved",
                warned.stored === true, JSON.stringify(warned));
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
            check("Delete this state removes it from the store",
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
