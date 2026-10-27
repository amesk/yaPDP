#!/usr/bin/env node
/**
 * yaPDP Share snapshot end-to-end test (puppeteer + real Chromium).
 *
 * Verifies the Share feature:
 *
 *   A. Share without command: snapshot → Share → description → no command
 *   B. Share with one command: snapshot → Share → "RUN SPCINV"
 *   C. Original snapshot unchanged after Share
 *   D. Balloon shows stepsMessage during ?state= restore
 *   E. Manifest CLI round-trip: extract → edit → replace → load
 *   F. "Share via platform" hands over a real .state.zst FILE (share sheet
 *      stubbed), and that file imports back as a state
 *   G. Without file sharing the FULL text envelope travels (share text or
 *      clipboard) — never the 2 KB stub the dialog used to send
 *   H. A share sheet that refuses the payload degrades to the clipboard with
 *      the full envelope instead of leaving the operator with a bare toast
 *   I. A refused FILE retries as text on the next click (a share needs a fresh
 *      click for its activation, so the retry can never be automatic)
 *
 * Run with: node tests/e2e-share.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PORT = 1170;
const BASE = `http://localhost:${PORT}/pdp11.html`;
const ROOT = path.resolve(__dirname, "..");

// Start the repo's static server when nothing serves :1170 (the suite loads
// the page and fetches states over HTTP); reuse one that is already up, and
// stop only a server we started ourselves.
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

// --- A. Share without command --------------------------------------------
async function testShareNoCommand(page) {
    console.log("\n=== A. Share without command ===");

    // Save a snapshot.
    const snapId = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("share-test");
        return snap.id;
    });
    check("A1: snapshot saved", typeof snapId === "string", String(snapId));

    // Create shareable state with description but no command. Read the byte
    // facts IN THE PAGE: a raw Uint8Array does not survive page.evaluate()
    // (puppeteer hands back a numeric-keyed object with NO .length), which is
    // what made A2 report "created = false" while A3 still found the magic byte.
    const info = await page.evaluate(async (id) => {
        const bytes = await SnapshotStore.createShareableState(id, {
            title: "Share Test",
            description: "A test shareable state",
            command: "",
        });
        if (!bytes) return null;
        return { len: bytes.length, first: Array.from(bytes.slice(0, 4)) };
    }, snapId);
    check("A2: shareable state created", info !== null && info.len > 0, JSON.stringify(info));
    check("A3: bytes look like a container",
        info && (info.first[0] === 0x28 || info.first[0] === 0x1F || info.first[0] === 0x59),
        info ? JSON.stringify(info.first) : "null");

    // Cleanup.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("  A: passed");
}

// --- B. Share with one command -------------------------------------------
async function testShareWithCommand(page) {
    console.log("\n=== B. Share with one command ===");

    const snapId = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("share-cmd-test");
        return snap.id;
    });
    check("B1: snapshot saved", typeof snapId === "string", String(snapId));

    // Create shareable state with a command.
    const result = await page.evaluate(async (id) => {
        const bytes = await SnapshotStore.createShareableState(id, {
            title: "Space Invaders",
            description: "Loads RT-11 and runs SPCINV",
            command: "RUN SPCINV",
        });
        if (!bytes) return null;
        // Import the shareable state to verify steps/stepsMessage.
        const imported = await SnapshotStore.importState(bytes);
        if (!imported.ok) return { error: imported.reason };
        const items = await SnapshotStore.list();
        const mine = items.find((it) => it.id === imported.id);
        await SnapshotStore.remove(imported.id);
        return {
            hasSteps: mine ? mine.hasSteps : null,
            stepsMessage: mine ? mine.stepsMessage : null,
        };
    }, snapId);
    check("B2: shareable state created", result !== null, JSON.stringify(result));
    check("B3: stepsMessage preserved",
        result && result.stepsMessage === "Loads RT-11 and runs SPCINV",
        JSON.stringify(result));
    check("B4: hasSteps is true", result && result.hasSteps === true, JSON.stringify(result));

    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("  B: passed");
}

// --- C. Original snapshot unchanged --------------------------------------
async function testOriginalUnchanged(page) {
    console.log("\n=== C. Original snapshot unchanged ===");

    // Save a snapshot with known properties.
    const { snapId, origSteps, origMsg } = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("original-test", [{ send: "DIR" }], "Original steps");
        return {
            snapId: snap.id,
            origSteps: snap.steps ? snap.steps.length : 0,
            origMsg: snap.stepsMessage,
        };
    });
    check("C1: original has steps", origSteps > 0, String(origSteps));
    check("C2: original has stepsMessage", origMsg === "Original steps", String(origMsg));

    // Create shareable state with DIFFERENT description and command.
    await page.evaluate(async (id) => {
        await SnapshotStore.createShareableState(id, {
            title: "Share Copy",
            description: "Shareable copy",
            command: "RUN TEST",
        });
    }, snapId);

    // Verify the original snapshot is unchanged.
    const after = await page.evaluate(async (id) => {
        const items = await SnapshotStore.list();
        const mine = items.find((it) => it.id === id);
        return mine ? { hasSteps: mine.hasSteps, stepsMessage: mine.stepsMessage } : null;
    }, snapId);
    check("C3: original hasSteps unchanged", after && after.hasSteps === true, JSON.stringify(after));
    check("C4: original stepsMessage unchanged",
        after && after.stepsMessage === "Original steps", JSON.stringify(after));

    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("  C: passed");
}

// --- D. Balloon shows stepsMessage ---------------------------------------
async function testBalloonStepsMessage(page) {
    console.log("\n=== D. Balloon shows stepsMessage ===");

    // Create a shareable state and verify the manifest has stepsMessage.
    const snapId = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("balloon-test");
        return snap.id;
    });
    check("D1: snapshot saved", typeof snapId === "string", String(snapId));

    const created = await page.evaluate(async (id) => {
        const bytes = await SnapshotStore.createShareableState(id, {
            title: "Balloon Test",
            description: "Balloon description text",
            command: "RUN TEST",
        });
        if (!bytes) return null;
        // A plain array, because a raw Uint8Array does not survive
        // page.evaluate() and would arrive empty on the next call (see A2).
        return { len: bytes.length, data: Array.from(bytes) };
    }, snapId);
    check("D2: shareable state created", created !== null && created.len > 0,
        created ? "len=" + created.len : "null");

    // Verify the manifest inside the bytes has stepsMessage.
    // We can't easily peek into the container from the browser, so we verify
    // via import.
    const manifest = await page.evaluate(async (arr) => {
        const bytes = new Uint8Array(arr);
        const imported = await SnapshotStore.importState(bytes);
        if (!imported.ok) return null;
        const items = await SnapshotStore.list();
        const mine = items.find((it) => it.id === imported.id);
        await SnapshotStore.remove(imported.id);
        return mine ? { stepsMessage: mine.stepsMessage, hasSteps: mine.hasSteps } : null;
    }, created ? created.data : []);
    check("D3: stepsMessage in imported state",
        manifest && manifest.stepsMessage === "Balloon description text",
        JSON.stringify(manifest));
    check("D4: hasSteps is true", manifest && manifest.hasSteps === true, JSON.stringify(manifest));

    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("  D: passed");
}

// --- E. Manifest CLI round-trip ------------------------------------------
async function testManifestCLI() {
    console.log("\n=== E. Manifest CLI round-trip ===");

    const statePath = path.join(ROOT, "states", "rk1-ready.state.zst");
    if (!fs.existsSync(statePath)) {
        console.log("  SKIP: no rk1-ready.state.zst found");
        return;
    }

    const tmpDir = path.join(ROOT, "tmp-test-share");
    fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, "manifest.json");
    const outputPath = path.join(tmpDir, "modified.state.zst");

    try {
        // Extract manifest. execFile, NOT exec: a command STRING with an
        // unquoted interpreter path breaks on Windows — process.execPath is
        // "C:\\Program Files\\nodejs\\node.exe", so cmd.exe saw "C:\\Program".
        // Passing argv separately skips the shell entirely.
        const { execFileSync } = require("child_process");
        const manifestTool = path.join(ROOT, "tools", "state-manifest.js");
        execFileSync(process.execPath, [manifestTool, "extract", statePath, manifestPath],
            { cwd: ROOT });
        check("E1: manifest extracted", fs.existsSync(manifestPath));

        // Read and modify manifest.
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.stepsMessage = "CLI round-trip test";
        manifest.steps = [{ send: "RUN SPCINV" }];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

        // Replace manifest (argv form, as above — no shell).
        execFileSync(process.execPath, [manifestTool, "replace", statePath, manifestPath, outputPath],
            { cwd: ROOT });
        check("E2: manifest replaced", fs.existsSync(outputPath));

        // Verify the output is a valid .state.zst. The FRAME is whatever the
        // CLI chose (zstd here, gzip on a Node without zstd in zlib), so it is
        // read through the shared module rather than guessed at.
        const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
        const StateIO = require(path.join(ROOT, "tools", "state-io.js"));
        const read = StateIO.readBytes(outputPath);
        const parsed = StateFormat.unpack(read.container);
        check("E3: output is a valid container", parsed !== null,
            read.frame + " / " +
            JSON.stringify(parsed ? parsed.manifest.schemaVersion : null));
        check("E4: stepsMessage preserved",
            parsed && parsed.manifest.stepsMessage === "CLI round-trip test",
            parsed ? JSON.stringify(parsed.manifest.stepsMessage) : "null");
        check("E5: steps preserved",
            parsed && parsed.manifest.steps && parsed.manifest.steps.length === 1,
            parsed ? JSON.stringify(parsed.manifest.steps) : "null");
        check("E6: memory words preserved",
            parsed && parsed.memoryWords && parsed.memoryWords.length > 0,
            parsed ? String(parsed.memoryWords.length) : "null");
    } finally {
        // Cleanup temp files.
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
    console.log("  E: passed");
}

// --- F/G. Platform share (share sheet) -----------------------------------
// The share sheet cannot be observed from an automated browser, so the page
// gets a stub BEFORE load: navigator.share records its payload instead of
// opening the OS sheet, and navigator.canShare answers for the File support
// the scenario wants. Everything else — the dialog, the state packaging, the
// decision what to hand over — is the real code under test.
async function openStubPage(browser, errors, options) {
    const opts = Object.assign(
        { acceptFiles: false, shareError: null, shareErrorOnce: null, mobile: false },
        options || {});
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e && e.stack ? e.stack : e)));
    if (opts.mobile) {
        // Files are only offered to a MOBILE sheet (that is the policy under
        // test), so the file scenarios must look like a phone to the page.
        await page.setUserAgent(
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        await page.setViewport({ width: 480, height: 900, isMobile: true });
    }
    await page.evaluateOnNewDocument((stubOptions) => {
        try {
            localStorage.setItem("yapdp.onboarding.v1", "done");
        } catch (e) { /* ignore */ }
        window.__shareCalls = [];
        window.__clipboardWrites = [];
        window.__acceptFiles = !!stubOptions.acceptFiles;
        window.__shareError = stubOptions.shareError || null;
        window.__shareErrorOnce = stubOptions.shareErrorOnce || null;
        const record = (data) => ({
            hasFiles: !!(data && data.files && data.files.length),
            fileNames: data && data.files ? Array.from(data.files).map((f) => f.name) : [],
            fileTypes: data && data.files ? Array.from(data.files).map((f) => f.type) : [],
            fileSizes: data && data.files ? Array.from(data.files).map((f) => f.size) : [],
            textLength: data && typeof data.text === "string" ? data.text.length : 0,
            textHead: data && typeof data.text === "string" ? data.text.slice(0, 24) : "",
            title: data ? data.title : null
        });
        try {
            Object.defineProperty(navigator, "canShare", {
                configurable: true,
                value: function (data) {
                    return !!(window.__acceptFiles && data && data.files && data.files.length);
                }
            });
        } catch (e) { window.__stubError = "canShare: " + e.message; }
        try {
            Object.defineProperty(navigator, "share", {
                configurable: true,
                value: function (data) {
                    window.__shareCalls.push(record(data));
                    window.__lastShareFiles = data && data.files ? Array.from(data.files) : [];
                    if (window.__shareError) {
                        // The share sheet itself refusing the payload, as a
                        // platform with a blocked MIME type or an expired
                        // activation does.
                        const err = new Error("share refused by the stub");
                        err.name = window.__shareError;
                        return Promise.reject(err);
                    }
                    if (window.__shareErrorOnce) {
                        // Refuse the first payload only: the second click is
                        // allowed to succeed (the text retry scenario).
                        const once = new Error("share refused once by the stub");
                        once.name = window.__shareErrorOnce;
                        window.__shareErrorOnce = null;
                        return Promise.reject(once);
                    }
                    return Promise.resolve();
                }
            });
        } catch (e) { window.__stubError = "share: " + e.message; }
        try {
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: function (t) {
                        const s = String(t);
                        window.__clipboardWrites.push({ len: s.length, head: s.slice(0, 24) });
                        return Promise.resolve();
                    },
                    readText: function () { return Promise.resolve(""); }
                }
            });
        } catch (e) { window.__stubError = "clipboard: " + e.message; }
    }, opts);
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(
        () => typeof SnapshotStore === "object" && typeof SnapshotStore.init === "function",
        { timeout: 60000 });
    return page;
}

// Drive the real UI: STATE button → select the snapshot → Share → the split
// menu → the platform-share item. Returns the item's label (which advertises
// what will be handed over).
async function driveShareDialog(page, snapId) {
    await page.evaluate((id) => {
        const btn = document.getElementById("state-btn");
        if (btn) btn.click();
        SnapshotStore.refreshUI(id);
    }, snapId);
    await page.waitForFunction(() => {
        const share = document.getElementById("snap-share");
        return !!(share && !share.disabled);
    }, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("snap-share").click());
    await page.waitForSelector("#share-create-more", { timeout: 20000 });
    await page.evaluate(() => document.getElementById("share-create-more").click());
    // The artifact is built while the menu is open; the item enables when done.
    await page.waitForFunction(() => {
        const item = document.getElementById("share-create-share");
        return !!(item && !item.disabled);
    }, { timeout: 120000 });
    const label = await page.evaluate(
        () => document.getElementById("share-create-share").textContent);
    await page.evaluate(() => document.getElementById("share-create-share").click());
    return label;
}

async function testPlatformShareFile(browser, errors) {
    console.log("\n=== F. Platform share sends a .state.zst file ===");
    const page = await openStubPage(browser, errors, { acceptFiles: true, mobile: true });
    try {
        const snapId = await page.evaluate(async () => {
            const snap = await SnapshotStore.save("ui-share-file");
            return snap.id;
        });
        check("F1: snapshot saved", typeof snapId === "string", String(snapId));

        const stubError = await page.evaluate(() => window.__stubError || null);
        check("F2: navigator stubs installed", stubError === null, String(stubError));

        const label = await driveShareDialog(page, snapId);
        check("F3: the item advertises a file", /^Share state file/.test(label || ""), String(label));

        const calls = await page.evaluate(() => window.__shareCalls);
        check("F4: navigator.share called once", calls.length === 1, String(calls.length));
        const call = calls[0] || {};
        check("F5: the share carried a file", call.hasFiles === true, JSON.stringify(call));
        check("F6: named .state.zst",
            /\.state\.zst$/.test((call.fileNames || [])[0] || ""), JSON.stringify(call.fileNames));
        check("F7: typed application/octet-stream",
            (call.fileTypes || [])[0] === "application/octet-stream", JSON.stringify(call.fileTypes));
        check("F8: not a 2 KB text stub — only a short note travels as text",
            (call.textLength || 0) < 512, String(call.textLength));
        const writes = await page.evaluate(() => window.__clipboardWrites);
        check("F9: clipboard untouched in file mode", writes.length === 0, String(writes.length));

        // The bytes handed to the share sheet must import back as a state.
        const imported = await page.evaluate(async () => {
            const files = window.__lastShareFiles || [];
            if (!files.length) return { ok: false, reason: "no-file" };
            const buf = await files[0].arrayBuffer();
            const res = await SnapshotStore.importState(new Uint8Array(buf));
            if (res && res.ok) await SnapshotStore.remove(res.id);
            return { ok: !!(res && res.ok), reason: res ? res.reason : "null", size: buf.byteLength };
        });
        check("F10: the shared bytes import as a state", imported.ok === true, JSON.stringify(imported));

        await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    } finally {
        await page.close();
    }
    console.log("  F: passed");
}

async function testShareRefusalKeepsTheState(browser, errors) {
    console.log("\n=== H. A refused share sheet degrades to the clipboard ===");
    const page = await openStubPage(browser, errors, {
        acceptFiles: true,
        shareError: "NotAllowedError",
        mobile: true
    });
    try {
        const snapId = await page.evaluate(async () => {
            const snap = await SnapshotStore.save("ui-share-refused");
            return snap.id;
        });
        check("H1: snapshot saved", typeof snapId === "string", String(snapId));

        await driveShareDialog(page, snapId);
        // The refusal is asynchronous: the clipboard write follows it.
        await page.waitForFunction(() => window.__clipboardWrites.length > 0, { timeout: 20000 })
            .catch(() => { /* reported below */ });

        const calls = await page.evaluate(() => window.__shareCalls);
        const writes = await page.evaluate(() => window.__clipboardWrites);
        const pasted = writes[0] || {};
        check("H2: the sheet was asked for the file", calls.length >= 1, String(calls.length));
        check("H3: the refusal did not leave the operator empty-handed",
            writes.length === 1, String(writes.length));
        check("H4: the full envelope landed on the clipboard",
            (pasted.len || 0) > 2048, "len=" + (pasted.len || 0));
        check("H5: with the envelope marker intact",
            String(pasted.head || "").indexOf("yapdp-text-envelope-v1") === 0,
            String(pasted.head));

        // A toast would be painted UNDER the modal overlay (z-index 50000 vs
        // 100000), so the refusal must be reported inside the dialog.
        const status = await page.evaluate(() => {
            const el = document.getElementById("share-status");
            return el ? { display: el.style.display, text: el.textContent } : null;
        });
        check("H6: the refusal is reported inside the dialog",
            !!status && status.display === "block" && /clipboard/.test(status.text || ""),
            JSON.stringify(status));

        await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    } finally {
        await page.close();
    }
    console.log("  H: passed");
}

// --- I. A refused file retries as text on the next click ------------------
async function testFileRefusalRetriesAsText(browser, errors) {
    console.log("\n=== I. A refused file retries as text ===");
    const page = await openStubPage(browser, errors, {
        acceptFiles: true,
        shareErrorOnce: "NotSupportedError",
        mobile: true
    });
    try {
        const snapId = await page.evaluate(async () => {
            const snap = await SnapshotStore.save("ui-share-retry");
            return snap.id;
        });
        check("I1: snapshot saved", typeof snapId === "string", String(snapId));

        await driveShareDialog(page, snapId);
        await page.waitForFunction(() => window.__clipboardWrites.length > 0, { timeout: 20000 })
            .catch(() => { /* reported below */ });
        const writes = await page.evaluate(() => window.__clipboardWrites);
        check("I2: the refusal kept the state on the clipboard",
            writes.length === 1, String(writes.length));
        const status = await page.evaluate(() => {
            const el = document.getElementById("share-status");
            return el ? el.style.display : null;
        });
        check("I2b: the refusal is visible inside the open dialog",
            status === "block", String(status));

        // The dialog stays open, and the same item now advertises the text
        // channel: one more click is all a share needs for its activation.
        await page.evaluate(() => {
            const more = document.getElementById("share-create-more");
            if (more) more.click();
        });
        await page.waitForFunction(() => {
            const item = document.getElementById("share-create-share");
            return !!(item && !item.disabled && /^Share state text/.test(item.textContent));
        }, { timeout: 20000 }).catch(() => { /* reported below */ });
        const label = await page.evaluate(
            () => (document.getElementById("share-create-share") || {}).textContent || "");
        check("I3: the item now offers the text envelope",
            /^Share state text/.test(label), String(label));

        await page.evaluate(() => document.getElementById("share-create-share").click());
        await page.waitForFunction(() => window.__shareCalls.length >= 2, { timeout: 20000 })
            .catch(() => { /* reported below */ });
        const calls = await page.evaluate(() => window.__shareCalls);
        const last = calls[calls.length - 1] || {};
        check("I4: the second click shared text", calls.length >= 2, String(calls.length));
        check("I5: carrying the full envelope",
            (last.textLength || 0) > 2048 &&
            String(last.textHead || "").indexOf("yapdp-text-envelope-v1") === 0,
            JSON.stringify({ len: last.textLength, head: last.textHead }));
        check("I6: and no file this time", last.hasFiles !== true, JSON.stringify(last.hasFiles));

        await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    } finally {
        await page.close();
    }
    console.log("  I: passed");
}

async function testPlatformShareFallback(browser, errors) {
    console.log("\n=== G. No file sharing: the full envelope travels ===");
    const page = await openStubPage(browser, errors, { acceptFiles: false });
    try {
        const snapId = await page.evaluate(async () => {
            const snap = await SnapshotStore.save("ui-share-fallback");
            return snap.id;
        });
        check("G1: snapshot saved", typeof snapId === "string", String(snapId));

        const label = await driveShareDialog(page, snapId);
        check("G2: the item advertises text, not a file",
            /^(Share state text|Copy state text)/.test(label || ""), String(label));

        const calls = await page.evaluate(() => window.__shareCalls);
        const writes = await page.evaluate(() => window.__clipboardWrites);
        const shared = calls[0] || {};
        check("G3: no file was claimed",
            shared.hasFiles !== true, JSON.stringify(shared.hasFiles));

        const viaShare = (shared.textLength || 0) > 0;
        const head = viaShare ? shared.textHead : (writes[0] || {}).head;
        const len = viaShare ? shared.textLength : ((writes[0] || {}).len || 0);
        check("G4: the whole envelope travelled, not a 2 KB body", len > 2048, "len=" + len);
        check("G5: with the envelope marker intact",
            String(head || "").indexOf("yapdp-text-envelope-v1") === 0, String(head));

        await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    } finally {
        await page.close();
    }
    console.log("  G: passed");
}

// --- Main ----------------------------------------------------------------
(async () => {
    const server = await ensureServer();
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const errors = [];

    try {
        const page = await openPage(browser, errors);

        await testShareNoCommand(page);
        await testShareWithCommand(page);
        await testOriginalUnchanged(page);
        await testBalloonStepsMessage(page);
        await page.close();

        // F/G. The platform share sheet (each scenario needs its own page, so
        // its navigator can be stubbed before the app loads).
        await testPlatformShareFile(browser, errors);
        await testPlatformShareFallback(browser, errors);
        await testShareRefusalKeepsTheState(browser, errors);
        await testFileRefusalRetriesAsText(browser, errors);

        // E. Manifest CLI (doesn't need a browser page).
        await testManifestCLI();

        // Check for page errors.
        const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
        if (fatal.length) {
            console.error("\nPage errors during tests:", fatal.slice(0, 10));
            failures++;
        }
    } finally {
        await browser.close();
        if (server) server.kill();
    }

    if (failures) {
        console.error("\n" + failures + " check(s) failed");
        process.exit(1);
    }
    console.log("\nE2E Share: all checks passed");
    process.exit(0);
})().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
});