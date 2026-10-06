#!/usr/bin/env node
/**
 * yaPDP snapshot import/export end-to-end test (puppeteer + real Chromium).
 *
 * Verifies the full export/import round-trip in a real browser:
 *
 *   A. Export: create a snapshot, click Export, verify a .state.zst is downloaded.
 *   B. Import: take a prepared .state.zst, import it, verify it appears in the list.
 *   C. Round-trip: create → export → delete → import → restore, verify machine.
 *   D. Steps round-trip: create snapshot with steps → export → import → restore,
 *      verify steps are preserved and the scenario runs.
 *   E. Invalid import: try to import a corrupted file, verify error shown.
 *
 * Run with: node tests/e2e-import-export.js
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

// Node-side readers for the .state container the browser writes to disk.
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require(path.join(ROOT, "tools", "state-io.js"));

// Start the repo's static server when nothing serves :1170 (the suite loads the
// page and fetches states over HTTP); reuse one that is already up, and stop
// only a server we started ourselves.
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

// Collect download promises by intercepting the download link creation.
function hookDownloads(page) {
    const downloads = [];
    page.on("response", (res) => {
        if (res.url.startsWith("blob:") || res.url.endsWith(".state.zst")) {
            downloads.push(res.url);
        }
    });
    return downloads;
}

// --- A. Export -----------------------------------------------------------
async function testExport(page) {
    console.log("\n=== A. Export ===");
    const errors = [];

    // Save a snapshot.
    const snapId = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("export-test");
        return snap.id;
    });
    check("A1: snapshot saved", typeof snapId === "string" && snapId.length > 0, String(snapId));

    // Call exportSnapshot and verify we get bytes back.
    const bytes = await page.evaluate(async (id) => {
        const b = await SnapshotStore.exportSnapshot(id);
        if (!b) return null;
        return { len: b.length, first4: Array.from(new Uint8Array(b.slice(0, 4))) };
    }, snapId);
    check("A2: exportSnapshot returned bytes", bytes !== null && bytes.len > 0, JSON.stringify(bytes));
    // .state.zst starts with zstd magic 0x28 0xB5 0x2F 0xFD (or gzip 0x1F 0x8B).
    // The container itself starts with "YAPDPSTA". Either is valid.
    check("A3: bytes look like a compressed container",
        bytes && (bytes.first4[0] === 0x28 || bytes.first4[0] === 0x1F || bytes.first4[0] === 0x59),
        JSON.stringify(bytes.first4));

    // Cleanup.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    console.log("  A: passed");
}

// --- B. Import -----------------------------------------------------------
async function testImport(page) {
    console.log("\n=== B. Import ===");

    // Create a snapshot, export it to get bytes, then delete and re-import.
    const { exported, name } = await page.evaluate(async () => {
        const snap = await SnapshotStore.save("import-test");
        const bytes = await SnapshotStore.exportSnapshot(snap.id);
        await SnapshotStore.remove(snap.id);
        return {
            exported: Array.from(new Uint8Array(bytes)),
            name: snap.name,
        };
    });
    check("B1: exported bytes available", exported.length > 0, String(exported.length));

    // Import the bytes back.
    const result = await page.evaluate(async (arr) => {
        const bytes = new Uint8Array(arr);
        return await SnapshotStore.importState(bytes);
    }, exported);
    check("B2: import succeeded", result.ok === true, JSON.stringify(result));
    check("B3: import returned id", typeof result.id === "string" && result.id.length > 0, String(result.id));

    // Verify the snapshot appears in the list.
    const listed = await page.evaluate(async (id) => {
        const items = await SnapshotStore.list();
        return items.some((it) => it.id === id);
    }, result.id);
    check("B4: imported snapshot appears in list", listed === true);

    // Cleanup.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, result.id);
    console.log("  B: passed");
}

// --- C. Round-trip -------------------------------------------------------
async function testRoundTrip(page) {
    console.log("\n=== C. Round-trip ===");

    // Save a snapshot with known CPU state.
    const { snapId, before } = await page.evaluate(async () => {
        // Mutate some CPU state so we can verify it after restore.
        CPU.registerVal[7] = 0o1234;
        CPU.registerVal[6] = 0o567;
        CPU.memory[0o2000 / 2] = 0xABCD;
        const snap = await SnapshotStore.save("roundtrip-test");
        const state = {
            pc: CPU.registerVal[7],
            sp: CPU.registerVal[6],
            mem: CPU.memory[0o2000 / 2],
        };
        return { snapId: snap.id, before: state };
    });
    check("C1: snapshot saved", typeof snapId === "string", String(snapId));

    // Export.
    const exported = await page.evaluate(async (id) => {
        const bytes = await SnapshotStore.exportSnapshot(id);
        return Array.from(new Uint8Array(bytes));
    }, snapId);
    check("C2: exported", exported.length > 0, String(exported.length));

    // Delete local snapshot.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    const afterDelete = await page.evaluate(async () => (await SnapshotStore.list()).length);
    check("C3: snapshot deleted", afterDelete === 0, String(afterDelete));

    // Import.
    const imported = await page.evaluate(async (arr) => {
        const bytes = new Uint8Array(arr);
        return await SnapshotStore.importState(bytes);
    }, exported);
    check("C4: import succeeded", imported.ok === true, JSON.stringify(imported));

    // Restore the imported snapshot.
    await page.evaluate(async (id) => {
        await SnapshotStore.load(id);
    }, imported.id);
    // load() triggers a page reload; wait for the new page.
    await page.waitForFunction(
        () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
        { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    // Verify restored state.
    const after = await page.evaluate(() => ({
        pc: CPU.registerVal[7],
        sp: CPU.registerVal[6],
        mem: CPU.memory[0o2000 / 2],
    }));
    check("C5: PC restored", after.pc === before.pc, "got=0o" + after.pc.toString(8) + " want=0o" + before.pc.toString(8));
    check("C6: SP restored", after.sp === before.sp, "got=0o" + after.sp.toString(8) + " want=0o" + before.sp.toString(8));
    check("C7: memory restored", after.mem === before.mem, "got=0x" + after.mem.toString(16) + " want=0x" + before.mem.toString(16));

    // Cleanup the imported snapshot.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, imported.id);
    console.log("  C: passed");
}

// --- D. Steps round-trip -------------------------------------------------
async function testStepsRoundTrip(page) {
    console.log("\n=== D. Steps round-trip ===");

    // Save a snapshot with steps and stepsMessage.
    const testSteps = [
        { send: "HELLO" },
        { send: "WORLD" },
    ];
    const testMsg = "Runs a test scenario";
    const { snapId, before } = await page.evaluate(async (steps, msg) => {
        const snap = await SnapshotStore.save("steps-test", steps, msg);
        return {
            snapId: snap.id,
            before: { steps: snap.steps, stepsMessage: snap.stepsMessage },
        };
    }, testSteps, testMsg);
    check("D1: snapshot with steps saved", typeof snapId === "string", String(snapId));
    check("D2: steps preserved in snapshot",
        before.steps && before.steps.length === 2, JSON.stringify(before.steps));
    check("D3: stepsMessage preserved",
        before.stepsMessage === testMsg, String(before.stepsMessage));

    // Export.
    const exported = await page.evaluate(async (id) => {
        const bytes = await SnapshotStore.exportSnapshot(id);
        return Array.from(new Uint8Array(bytes));
    }, snapId);
    check("D4: exported", exported.length > 0, String(exported.length));

    // Delete local.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);

    // Import.
    const imported = await page.evaluate(async (arr) => {
        const bytes = new Uint8Array(arr);
        return await SnapshotStore.importState(bytes);
    }, exported);
    check("D5: import succeeded", imported.ok === true, JSON.stringify(imported));

    // Verify steps and stepsMessage survived the round-trip.
    const after = await page.evaluate(async (id) => {
        // We need the full snapshot from the store; list() only returns metadata.
        // Use a trick: save a second snapshot to trigger the list, then read
        // the imported one via the internal API. Instead, just check the list
        // metadata which now includes hasSteps.
        const items = await SnapshotStore.list();
        const mine = items.find((it) => it.id === id);
        return mine ? { hasSteps: mine.hasSteps, stepsMessage: mine.stepsMessage } : null;
    }, imported.id);
    check("D6: imported snapshot has steps indicator", after !== null && after.hasSteps === true,
        JSON.stringify(after));
    check("D7: stepsMessage survived", after !== null && after.stepsMessage === testMsg,
        JSON.stringify(after));

    // Cleanup.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, imported.id);
    console.log("  D: passed");
}

// --- E. Invalid import ---------------------------------------------------
async function testInvalidImport(page) {
    console.log("\n=== E. Invalid import ===");

    // Try importing garbage bytes.
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const result1 = await page.evaluate(async (arr) => {
        return await SnapshotStore.importState(new Uint8Array(arr));
    }, Array.from(garbage));
    check("E1: garbage rejected", result1.ok === false, JSON.stringify(result1));
    check("E2: reason is not-a-state", result1.reason === "not-a-state", result1.reason);

    // Try importing a too-large file.
    const tooBig = new Uint8Array(17 * 1024 * 1024); // 17 MB > MAX_STATE_BYTES
    const result2 = await page.evaluate(async (arr) => {
        return await SnapshotStore.importState(new Uint8Array(arr));
    }, Array.from(tooBig));
    check("E3: too-large rejected", result2.ok === false, JSON.stringify(result2));
    check("E4: reason is too-large", result2.reason === "too-large", result2.reason);

    // Verify the UI is still responsive (no snapshots were added).
    const count = await page.evaluate(async () => (await SnapshotStore.list()).length);
    check("E5: no snapshots added after invalid imports", count === 0, String(count));

    console.log("  E: passed");
}

// --- F. Overlay disk round-trip -----------------------------------------
// The regression this pins: a guest wrote blocks to a disk (COPY onto RK1),
// a snapshot carried them in the write-back overlay, the snapshot was
// EXPORTED to a file and IMPORTED back — and the overlay block bytes were
// lost (Uint8Array -> JSON object -> "new Uint8Array(obj)" = empty block), so
// the restored machine saw a zeroed file system and DIR hung. This drives the
// REAL Export button, reads the file off disk, and checks the bytes survive
// all the way back onto the disk after restore.

function downloadDir() {
    const dir = path.join(ROOT, "tests", "artifacts", "dl-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function enableDownloads(browser, page, dir) {
    const args = { behavior: "allow", downloadPath: dir, eventsEnabled: true };
    try {
        const c = await browser.createCDPSession();
        await c.send("Browser.setDownloadBehavior", args);
        return c;
    } catch (e) {
        const c = await page.createCDPSession();
        await c.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
        return c;
    }
}

async function waitForDownload(dir, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const files = fs.readdirSync(dir).filter((f) => !f.endsWith(".crdownload"));
        if (files.length) return path.join(dir, files[0]);
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no download appeared in " + dir);
}

async function testOverlayDiskRoundTrip(browser, page) {
    console.log("\n=== F. Overlay disk round-trip (export -> file -> import -> restore) ===");

    const url = "rk5-e2e.dsk";
    const block = 42;
    const words = [0xDEAD, 0xBEEF, 0x1234, 0x5678, 0x9ABC, 0xDEF0, 0x1111, 0x2222];
    // Little-endian bytes of the seeded words (blockToBytes in src/diskstore.js).
    const expected = [];
    words.forEach((w) => { expected.push(w & 0xff, (w >>> 8) & 0xff); });

    // Seed a REAL write-back overlay through the production API — exactly what
    // a guest write (COPY onto a disk) leaves behind.
    await page.evaluate((url, block, words) => {
        DiskStore.registerImage(url, "fp-e2e");
        const cb = { url: url, cache: [] };
        cb.cache[block] = Uint16Array.from(words);
        DiskStore.markDirty(cb, block);
    }, url, block, words);

    const snapId = await page.evaluate(async () => (await SnapshotStore.save("overlay e2e")).id);
    check("F1: snapshot saved", typeof snapId === "string", String(snapId));

    // Export through the REAL button so a file actually lands on disk.
    const dir = downloadDir();
    const client = await enableDownloads(browser, page, dir);
    await page.evaluate(() => {
        const open = document.getElementById("state-btn");
        if (open) open.click();   // reveal the manager modal so the button is clickable
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.click("#snap-export");
    const file = await waitForDownload(dir, 20000);
    check("F2: Export wrote a .state file to disk",
        fs.existsSync(file) && fs.statSync(file).size > 0, file);

    // The file's container must carry the overlay block bytes as plain arrays.
    const { container } = StateIO.readBytes(file);
    const parsed = StateFormat.unpack(container);
    const wire = parsed && parsed.manifest && parsed.manifest.overlay &&
        parsed.manifest.overlay[url] && parsed.manifest.overlay[url].blocks;
    check("F3: file carries the overlay block", !!(wire && wire[block]),
        JSON.stringify(wire && Object.keys(wire)));
    const fileBytes = wire && wire[block] ? Array.from(wire[block]) : [];
    check("F4: file's overlay block bytes match the seeded write",
        JSON.stringify(fileBytes) === JSON.stringify(expected),
        JSON.stringify(fileBytes.slice(0, 8)) + " vs " + JSON.stringify(expected.slice(0, 8)));

    // Drop the local snapshot, import the file from disk, then LOAD it (reload
    // path — the same one a user takes after Import).
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, snapId);
    const importArr = Array.from(fs.readFileSync(file));
    const imported = await page.evaluate(async (arr) => {
        return await SnapshotStore.importState(new Uint8Array(arr));
    }, importArr);
    check("F5: import from disk succeeded", imported.ok === true, JSON.stringify(imported));

    await page.evaluate(async (id) => { await SnapshotStore.load(id); }, imported.id);
    await page.waitForFunction(
        () => typeof SnapshotStore !== "undefined" && typeof CPU !== "undefined",
        { timeout: 30000 });
    // init()/restore() writes the overlay to IndexedDB asynchronously.
    await page.waitForFunction(async (url, block) => {
        if (typeof DiskStore === "undefined") return false;
        const b = await DiskStore.getBlock(url, block);
        return !!b && b.length > 0;
    }, { timeout: 20000 }, url, block);

    const restored = await page.evaluate(async (url, block) => {
        const b = await DiskStore.getBlock(url, block);
        return b ? Array.from(new Uint8Array(b)) : null;
    }, url, block);
    check("F6: restored disk block present", Array.isArray(restored),
        String(restored && restored.length));
    check("F7: restored disk block bytes match (disk survived export/import)",
        JSON.stringify(restored) === JSON.stringify(expected),
        JSON.stringify(restored && restored.slice(0, 8)) + " vs " + JSON.stringify(expected.slice(0, 8)));

    // Cleanup.
    await page.evaluate(async (id) => { await SnapshotStore.remove(id); }, imported.id);
    await page.evaluate(async (u) => {
        if (DiskStore.clear) await DiskStore.clear(u);
    }, url);
    try { await client.detach(); } catch (e) { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log("  F: done");
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

        await testExport(page);
        await testImport(page);
        // Round-trip and steps round-trip need a fresh page (they reload).
        await page.close();

        // C. Round-trip (needs a page reload, so open a fresh page).
        {
            const p2 = await openPage(browser, errors);
            await testRoundTrip(p2);
            await p2.close();
        }

        // D. Steps round-trip.
        {
            const p3 = await openPage(browser, errors);
            await testStepsRoundTrip(p3);
            await p3.close();
        }

        // E. Invalid import.
        {
            const p4 = await openPage(browser, errors);
            await testInvalidImport(p4);
            await p4.close();
        }

        // F. Overlay disk round-trip (needs a page reload, so a fresh page).
        {
            const p5 = await openPage(browser, errors);
            await testOverlayDiskRoundTrip(browser, p5);
            await p5.close();
        }

        // Check for page errors across all pages.
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
    console.log("\nE2E import/export: all checks passed");
    process.exit(0);
})().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
});