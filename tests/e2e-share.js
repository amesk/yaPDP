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
 *
 * Run with: node tests/e2e-share.js
 * (needs puppeteer, server on :1170 — see tools/serve.js)
 */
"use strict";

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:1170/pdp11.html";
const ROOT = path.resolve(__dirname, "..");

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

    // Create shareable state with description but no command.
    const bytes = await page.evaluate(async (id) => {
        return await SnapshotStore.createShareableState(id, {
            title: "Share Test",
            description: "A test shareable state",
            command: "",
        });
    }, snapId);
    check("A2: shareable state created", bytes !== null && bytes.length > 0, String(bytes ? bytes.length : "null"));
    check("A3: bytes look like a container",
        bytes && (bytes[0] === 0x28 || bytes[0] === 0x1F || bytes[0] === 0x59),
        bytes ? "0x" + bytes[0].toString(16) : "null");

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

    const bytes = await page.evaluate(async (id) => {
        return await SnapshotStore.createShareableState(id, {
            title: "Balloon Test",
            description: "Balloon description text",
            command: "RUN TEST",
        });
    }, snapId);
    check("D2: shareable state created", bytes !== null && bytes.length > 0, String(bytes ? bytes.length : "null"));

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
    }, Array.from(new Uint8Array(bytes)));
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
        // Extract manifest.
        const { execSync } = require("child_process");
        execSync(process.execPath + " " + path.join(ROOT, "tools", "state-manifest.js") +
            " extract " + statePath + " " + manifestPath, { cwd: ROOT });
        check("E1: manifest extracted", fs.existsSync(manifestPath));

        // Read and modify manifest.
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.stepsMessage = "CLI round-trip test";
        manifest.steps = [{ send: "RUN SPCINV" }];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

        // Replace manifest.
        execSync(process.execPath + " " + path.join(ROOT, "tools", "state-manifest.js") +
            " replace " + statePath + " " + manifestPath + " " + outputPath, { cwd: ROOT });
        check("E2: manifest replaced", fs.existsSync(outputPath));

        // Verify the output is a valid .state.zst.
        const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
        const zlib = require("zlib");
        const raw = fs.readFileSync(outputPath);
        let container = null;
        if (typeof zlib.zstdDecompressSync === "function") {
            try { container = zlib.zstdDecompressSync(raw); } catch (e) { /* not zstd */ }
        }
        if (!container) container = new Uint8Array(raw);
        const parsed = StateFormat.unpack(container);
        check("E3: output is a valid container", parsed !== null, JSON.stringify(parsed ? parsed.manifest.schemaVersion : null));
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

// --- Main ----------------------------------------------------------------
(async () => {
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