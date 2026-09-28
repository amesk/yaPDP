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
 *   - :save-disk writes the whole image back, the guest's writes included
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
const vm = require("vm");

const REPO = path.resolve(__dirname, "..");
const TOOL = path.join(REPO, "tools", "headless-term.js");
const ORIG_TAPE = path.join(REPO, "media", "bootcode.ptap");
const OUT_TAPE = path.join(REPO, "out.test.ptap");
const OUT_DISK = path.join(REPO, "out.test.dsk");

/**
 * decompressZst — the pristine .dsk behind a .zst, so the saved image can be
 * compared against it (same loader the tool itself uses: the vendored fzstd
 * in its own VM context).
 */
function decompressZst(file) {
    const sb = vm.createContext({});
    vm.runInContext(
        fs.readFileSync(path.join(REPO, "assets", "vendor", "fzstd.js"), "utf8"),
        sb, { filename: "assets/vendor/fzstd.js" });
    return Buffer.from(sb.fzstd.decompress(new Uint8Array(fs.readFileSync(file))));
}

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
        ":save-disk " + OUT_DISK,  // host saves the whole (written-back) image
        ":save-disk",              // no argument: usage, not a crash
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

    // :save-disk wrote the WHOLE image, and it carries the guest's writes:
    // the same run created T.IMG in the guest (COPY PC: above), and those
    // sectors only exist in the boot engine's in-memory write-back, so an
    // image identical to the pristine one would mean the overlay was lost.
    assert.ok(fs.existsSync(OUT_DISK), ":save-disk produced " + OUT_DISK);
    const savedDisk = fs.readFileSync(OUT_DISK);
    const pristineDisk = decompressZst(path.join(REPO, "media", "rk1.dsk.zst"));
    assert.strictEqual(savedDisk.length, pristineDisk.length,
        ":save-disk wrote a full image (pristine " + pristineDisk.length +
        " bytes, saved " + savedDisk.length + ")");
    assert.ok(!savedDisk.equals(pristineDisk),
        ":save-disk captured the guest's writes (the saved image differs from the pristine .dsk)");
    assert.ok(/saved \d+ bytes to /.test(stderr), ":save-disk reported the image size");

    // A bare :save-disk is a usage error, not a crash or a silent no-op.
    assert.ok(stderr.indexOf("usage: :save-disk") !== -1,
        "a bare :save-disk prints its usage");

    // :status printed the punch state.
    assert.ok(stderr.indexOf("punch=") !== -1, ":status printed punch state");

    console.log("PASS: headless-term batch — boot, :wait, :mount, tape read/punch roundtrip, :export, :save-disk, :status");

    // ---- Test 2: multi-step boot (--step) -----------------------------
    // Same guest, booted through the step engine instead of a single
    // boot command: send "BOOT RK0", wait for the RT-11 banner, then run
    // an interactive command against the "." prompt.
    //
    // Repeated, because both failures this guards against are timing
    // dependent: the banner readiness fires while the guest is still in its
    // startup command file (RT-11 STARTF.COM runs after the banner), and
    // piped stdout used to be truncated at process.exit.
    const script2 = [
        "DIR",
        ":quit",
    ].join("\n") + "\n";
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r2 = await runBatch(script2,
            ["--step", "BOOT RK0|V04.00C", "--prompt", ".", "--prompt-timeout", "8"]);
        assert.strictEqual(r2.code, 0, "steps boot exits 0 (attempt " + attempt +
            ", got " + r2.code + ")\n" + r2.stderr);
        assert.ok(r2.stdout.indexOf("RT-11SJ") !== -1,
            "steps boot reached RT-11 (banner, attempt " + attempt + ")");
        assert.ok(r2.stdout.indexOf("Free blocks") !== -1,
            "steps boot + DIR works (attempt " + attempt + ")");
        // The listing must be complete, prompt included: the tool quits as
        // soon as it sees the prompt, so a lost tail shows up as a missing
        // trailing "." — exactly the output the emulator printed last.
        assert.ok(/Free blocks[\s\S]*\.\s*$/.test(r2.stdout),
            "the tail of the DIR listing survived the shutdown (attempt " +
            attempt + ")");
        assert.ok(r2.stderr.indexOf("no prompt before the first guest") === -1,
            "the first guest line waited for the guest prompt (attempt " +
            attempt + ")");
    }

    console.log("PASS: headless-term multi-step boot (--step send|waitFor)");
}

function cleanup() {
    try { fs.unlinkSync(OUT_TAPE); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(OUT_DISK); } catch (e) { /* ignore */ }
}

run().then(() => {
    cleanup();
    process.exit(0);
}).catch((e) => {
    cleanup();
    console.error("FAIL:", e.message);
    process.exit(1);
});
