#!/usr/bin/env node
/**
 * Rebuilds src/bootcode.js (and desktop/src/bootcode.js) from the MACRO-11
 * source macro-asm/boot.mac using the authentic in-emulator pipeline — the
 * three already-working pieces joined into one command:
 *
 *   1. tools/headless-term.js   — batch driver: boot RT-11SJ V04.00C, mount
 *                                 the source as a paper tape, type the guest
 *                                 commands, export the punch (no browser).
 *   2. the historic build script documented in macro-asm/README-odt11.md
 *      (the same one used by hand on 2026-08-29):
 *          COPY PC: BOOT.MAC
 *          R MACRO
 *          DK1:BOOT.OBJ,DK1:BOOT.LST=DK1:BOOT.MAC
 *          R LINK
 *          DK1:BOOT.SAV=DK1:BOOT
 *          R BOOT
 *          COPY DK1:BOOT.SAV PC:
 *   3. tools/bin2bootdump.js    — raw PDP-11 image -> bootcode.js octal dump.
 *
 * The punch stream is 8-bit (byte & 0xff); a fixed 700 ms wait used to cut the
 * dump short, so the collection waits for the buffer to stop growing instead.
 *
 * Usage:  node tools/rebuild-bootcode.js
 *         npm run rebuild-boot
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ASM_DIR = path.join(ROOT, "macro-asm");
const BOOTCODE_SRC = path.join(ROOT, "src", "bootcode.js");
const BOOTCODE_DESKTOP = path.join(ROOT, "desktop", "src", "bootcode.js");
const TERM = path.join(ROOT, "tools", "headless-term.js");
const DUMPER = path.join(ROOT, "tools", "bin2bootdump.js");

const BOOT_BASE = 0o120000;         // link base address (words stored from here)
const TMP_TAPE = path.join(ROOT, "macro-asm", "boot.mac.ptap");
const TMP_SAV = path.join(ROOT, "macro-asm", "boot.sav");

// The RT-11 source is LF-only; the tape reader wants CR (0x0D) as the line
// delimiter, so the tape is the same text with CRLF endings (this is exactly
// "cp boot.mac boot.mac.ptap" from a Windows checkout with autocrlf).
function writeTape() {
    const lf = fs.readFileSync(path.join(ASM_DIR, "boot.mac"), "latin1")
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    fs.writeFileSync(TMP_TAPE, Buffer.from(lf.replace(/\n/g, "\r\n"), "latin1"));
    return TMP_TAPE;
}

// Drive tools/headless-term.js in batch mode with the historic build script.
function runPipeline() {
    const script = [
        ":wait RT-11SJ",
        ":mount " + path.relative(ROOT, TMP_TAPE),
        "COPY PC: BOOT.MAC",
        ":wait .",
        "R MACRO",
        ":wait *",
        "DK:BOOT.OBJ,DK:BOOT.LST=DK:BOOT.MAC",
        ":wait ERRORS DETECTED",
        ":raw 03",
        ":wait .",
        "R LINK",
        ":wait *",
        "DK:BOOT.SAV=DK:BOOT/B:120000",
        ":wait ERRORS DETECTED",
        ":raw 03",
        ":wait .",
        // No "R BOOT" smoke run here: running the assembled loader takes over
        // the console ('@' prompt) and the following COPY would go to the new
        // bootloader instead of the RT-11 monitor. Dump the .SAV directly.
        "COPY DK:BOOT.SAV PC:",
        ":wait .",
        ":export " + path.relative(ROOT, TMP_SAV),
        ":quit",
        "",
    ].join("\n");

    return new Promise((resolve, reject) => {
        // --prompt "" disables the batch prompt-wait: this script drives every
        // transition itself with :wait (the guest prompt is "." at the RT-11
        // monitor but "*" inside MACRO/LINK, so a single prompt marker cannot
        // sync the whole run).
        const child = spawn(process.execPath, [TERM, "--device", "rk1", "--prompt", ""], {
            cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
        child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(script);
    });
}

// .SAV is a raw memory image (file offset == address), little-endian words.
function readSavWords(sav) {
    const words = [];
    for (let i = 0; i + 1 < sav.length; i += 2) {
        words.push((sav[i] | (sav[i + 1] << 8)) & 0xffff);
    }
    return words;
}

// Read the current bootcode.js word array.
function readBootcodeWords(file) {
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/var bootcode=\[([\s\S]*?)\];/);
    if (!m) throw new Error("bootcode array not found in " + file);
    const words = [];
    for (const w of m[1].split(",")) {
        const t = w.trim();
        if (/^0o[0-7]+$/.test(t)) words.push(Number(t));
    }
    return words;
}

// Serialise words into the bootcode.js array body (8 words per line, octals).
function formatWords(words) {
    let body = "var bootcode=[\n";
    for (let i = 0; i < words.length; i++) {
        body += "0o" + words[i].toString(8).padStart(6, "0");
        if (i < words.length - 1) body += ",";
        if ((i + 1) % 8 === 0) body += "\n";
    }
    body += "\n];\n";
    return body;
}

async function main() {
    console.log("== 1/3 stage the source as a paper tape ==");
    writeTape();
    console.log("  " + path.relative(ROOT, TMP_TAPE) + " (" +
        fs.statSync(TMP_TAPE).size + " bytes)");

    console.log("== 2/3 in-emulator build (RT-11SJ + DEC MACRO-11 V04.00C) ==");
    try { fs.unlinkSync(TMP_SAV); } catch (e) { /* ignore */ }
    const { code, stdout, stderr } = await runPipeline();
    const log = stdout + "\n" + stderr;
    if (code !== 0) {
        throw new Error("headless-term pipeline exited with code " + code + "\n" + log);
    }
    if (/(?:\?ERRORS DETECTED|ERRORS DETECTED):\s*[1-9]/.test(log)) {
        throw new Error("the guest build reported errors (see output above)");
    }
    if (!/ERRORS DETECTED:\s*0/.test(log)) {
        throw new Error("the guest build did not report a clean result " +
            "(no 'ERRORS DETECTED: 0' in the output)");
    }
    if (!fs.existsSync(TMP_SAV)) {
        throw new Error(":export produced no " + path.relative(ROOT, TMP_SAV));
    }
    console.log("  exported " + path.relative(ROOT, TMP_SAV) + " (" +
        fs.statSync(TMP_SAV).size + " bytes)");

    console.log("== 3/3 extract the boot module ==");
    const savWords = readSavWords(fs.readFileSync(TMP_SAV));
    const base = savWords.indexOf(0o000005); // first boot instruction (reset)
    if (base < 0) {
        throw new Error("boot module start (word 000005) not found in the .SAV");
    }
    let words = savWords.slice(base);
    let trail = 0;
    for (let i = words.length - 1; i >= 0 && words[i] === 0; i--) trail++;
    if (trail > 1) words = words.slice(0, words.length - (trail - 1));
    if (words.length === 0) throw new Error("boot module is empty");
    console.log("  boot module: " + words.length + " words (addr " +
        (base * 2).toString(8) + "), base 0o" + BOOT_BASE.toString(8));

    const srcText = fs.readFileSync(BOOTCODE_SRC, "utf8");
    const cur = readBootcodeWords(BOOTCODE_SRC);
    const header = srcText.slice(0, srcText.indexOf("var bootcode="));

    const diffs = [];
    for (let i = 0; i < Math.min(words.length, cur.length); i++) {
        if (words[i] !== cur[i]) diffs.push(i);
    }
    console.log("  diffs vs the shipped image: " + diffs.length + " word(s)" +
        (diffs.length ? " at [" + diffs.slice(0, 20).join(",") + "]" : ""));
    console.log("  size change: " + cur.length + " -> " + words.length + " words");

    if (diffs.length || cur.length !== words.length) {
        fs.writeFileSync(BOOTCODE_SRC, header + formatWords(words), "utf8");
        fs.copyFileSync(BOOTCODE_SRC, BOOTCODE_DESKTOP);
        console.log("  wrote src/bootcode.js and desktop/src/bootcode.js");
    } else {
        console.log("  identical to the shipped image — nothing to write");
    }
    console.log("== done ==");
}

main().catch((err) => {
    console.error("rebuild-boot: FAILED\n" + (err && err.message ? err.message : err));
    process.exit(1);
});
