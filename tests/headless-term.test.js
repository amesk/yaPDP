#!/usr/bin/env node
/**
 * headless-term batch-mode tests — the rt11-term feature set on the NEW
 * headless stack (no browser, no puppeteer, no iopage.js).
 *
 * Spawns tools/headless-term.js with a batch script on stdin and checks:
 *   - RT-11 boots (banner), prompt synchronization holds
 *   - :wait matches a marker already present in the output tail
 *   - :mount finds media/bootcode.ptap and the guest reads it (COPY PC:)
 *   - the guest punches a file back (COPY ... PC:) and :export writes the
 *     .ptap — the bootloader-build pipeline roundtrip
 *   - :status reports reader/punch state
 *
 * Run with:  node tests/headless-term.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const TOOL = path.join(REPO, "tools", "headless-term.js");
const ORIG_TAPE = path.join(REPO, "media", "bootcode.ptap");
const OUT_TAPE = path.join(REPO, "out.test.ptap");

function runBatch(script, extraArgs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [TOOL].concat(extraArgs || []), {
            cwd: REPO,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(script);
    });
}

async function run() {
    const script = [
        ":wait RT-11SJ",           // marker already in the boot output tail
        ":mount bootcode.ptap",    // media/ lookup
        "COPY PC: T.IMG",          // guest reads the tape into a file
        "COPY T.IMG PC:",          // guest punches the file back out
        ":export " + OUT_TAPE,     // host saves the punched bytes
        ":status",
        ":quit",
    ].join("\n") + "\n";

    const { code, stdout, stderr } = await runBatch(script);
    assert.strictEqual(code, 0, "headless-term exits 0 (got " + code + ")\n" + stderr);

    // Boot reached the guest.
    assert.ok(stdout.indexOf("RT-11SJ") !== -1, "RT-11 banner on stdout");
    assert.ok(stdout.indexOf("V04.00C") !== -1, "RT-11 version on stdout");

    // :wait resolved against the tail.
    assert.ok(stderr.indexOf("marker seen") !== -1, ":wait matched a marker in the tail");

    // :mount found the tape under media/ and reported its size.
    assert.ok(/mounted bootcode\.ptap \(2048 bytes\)/.test(stderr),
        ":mount reported the tape size");

    // Guest tape read + punch both completed (the bootloader pipeline).
    const copies = (stdout.match(/Files copied:/g) || []).length;
    assert.strictEqual(copies, 2, "guest COPY PC: (read) and COPY ... PC: (punch) completed");

    // :export wrote a punch file whose payload matches the original tape
    // (RT-11 pads the punch stream with a NUL leader and block padding).
    assert.ok(fs.existsSync(OUT_TAPE), ":export produced " + OUT_TAPE);
    const out = fs.readFileSync(OUT_TAPE);
    const orig = fs.readFileSync(ORIG_TAPE);
    const idx = out.indexOf(orig.subarray(0, 32));
    assert.ok(idx >= 0, "exported punch contains the original tape payload (idx=" + idx + ")");

    // :status printed the punch state.
    assert.ok(stderr.indexOf("punch=") !== -1, ":status printed punch state");

    console.log("PASS: headless-term batch — boot, :wait, :mount, tape read/punch roundtrip, :export, :status");
}

run().then(() => {
    try { fs.unlinkSync(OUT_TAPE); } catch (e) { /* ignore */ }
    process.exit(0);
}).catch((e) => {
    try { fs.unlinkSync(OUT_TAPE); } catch (e) { /* ignore */ }
    console.error("FAIL:", e.message);
    process.exit(1);
});
