#!/usr/bin/env node
/**
 * yaPDP — screenshot diff helper.
 *
 * Screenshot regeneration is deterministic in shape but not in pixels: a
 * one-pixel layout shift rewrites every PNG, and a docs commit then carries
 * images nobody meant to change. This tool tells that noise apart from a real
 * visual change, so a review (and a commit) can keep only the shots that
 * actually changed.
 *
 * Usage:
 *   node tools/compare-shots.js report [<pctLimit> <maxDelta>]
 *       Compare every changed screenshot under assets/images and
 *       landing/public/assets/images against its HEAD version and print how
 *       different it really is: the share of differing pixels and the worst
 *       channel delta (a "strong" pixel differs by more than 32/255).
 *
 *   node tools/compare-shots.js restore [<pctLimit> <maxDelta>]
 *       For every file whose difference is within the thresholds, restore the
 *       HEAD version (treat it as unchanged). Defaults: 0.05 % and 2.
 *
 *   node tools/compare-shots.js pair <a.png> <b.png>
 *       Measure the difference between two given files — used to check whether
 *       the generator itself is deterministic (same code, two runs).
 *
 * npm:  npm run shots:compare  /  npm run shots:restore
 *
 * The comparison needs `sharp` (declared in devDependencies); `stats()` itself
 * is dependency-free and unit-tested by tests/compare-shots.test.js.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");

// Directories whose changed screenshots are compared. Every generated manual
// shot is written to both (the repo copy and the landing mirror), so both must
// be inspected together.
const SHOT_DIRS = ["assets/images", "landing/public/assets/images"];

const DEFAULT_PCT_LIMIT = 0.05;
const DEFAULT_DELTA_LIMIT = 2;

/** The HEAD bytes of a path, or null when the file is not in HEAD (new). */
function gitShow(p) {
    try {
        return execFileSync("git", ["show", "HEAD:" + p],
            { maxBuffer: 128 * 1024 * 1024 });
    } catch (err) {
        return null; // not in HEAD — a brand new artefact
    }
}

/** Paths under the watched directories that git reports as changed/new. */
function changedFiles() {
    const out = execFileSync("git",
        ["status", "--porcelain", "--untracked-files=all", ...SHOT_DIRS],
        { encoding: "utf8" });
    return out.split("\n").map((l) => l.trim()).filter(Boolean)
        .map((l) => l.replace(/^[A-Z?]{1,2}\s+/, "").replace(/^"|"$/g, ""));
}

/** Decode a PNG buffer into { w, h, raw } (RGBA). Requires `sharp`. */
async function pixels(buf) {
    const sharp = require("sharp"); // lazy: stats() stays dependency-free
    const img = sharp(buf);
    const meta = await img.metadata();
    const raw = await img.ensureAlpha().raw().toBuffer();
    return { w: meta.width, h: meta.height, raw: raw };
}

/**
 * stats(a, b) — how different are two decoded images?
 * Returns { size: true } when their dimensions differ, otherwise the share of
 * differing pixels (pct), the share of clearly visible ones (strongPct), the
 * worst channel delta (maxDelta) and the mean delta over differing pixels.
 * Pure — no image library needed, which is what the unit test relies on.
 */
function stats(a, b) {
    if (a.w !== b.w || a.h !== b.h) return { size: true };
    const A = a.raw, B = b.raw;
    let diffPixels = 0, maxDelta = 0, sum = 0, strong = 0;
    for (let i = 0; i < A.length; i += 4) {
        let worst = 0;
        for (let c = 0; c < 4; c++) {
            const d = Math.abs(A[i + c] - B[i + c]);
            if (d > worst) worst = d;
        }
        if (worst > 0) {
            diffPixels++; sum += worst;
            if (worst > maxDelta) maxDelta = worst;
        }
        if (worst > 32) strong++;   // a change a human can notice
    }
    const total = (A.length / 4) || 1;
    return {
        size: false,
        pct: (diffPixels * 100) / total,
        strongPct: (strong * 100) / total,
        strong: strong,
        maxDelta: maxDelta,
        meanDelta: diffPixels ? sum / diffPixels : 0,
        diffPixels: diffPixels,
        total: total
    };
}

function usage() {
    console.log("Usage: node tools/compare-shots.js report|restore [pctLimit] [maxDelta]");
    console.log("       node tools/compare-shots.js pair <a.png> <b.png>");
}

async function main(argv) {
    const mode = argv[2] || "report";
    if (mode === "-h" || mode === "--help") { usage(); return; }
    if (mode !== "report" && mode !== "restore" && mode !== "pair") {
        usage();
        process.exitCode = 1;
        return;
    }

    // pair mode: how different are two files? Used to measure whether the
    // generator itself is deterministic (same code, two runs).
    if (mode === "pair") {
        const a = await pixels(Buffer.from(fs.readFileSync(argv[3])));
        const b = await pixels(Buffer.from(fs.readFileSync(argv[4])));
        const s = stats(a, b);
        console.log(argv[3] + " vs " + argv[4] + ": " +
            (s.size ? "SIZE DIFFERS" :
                s.pct.toFixed(4) + "% pixels, max=" + s.maxDelta +
                ", mean=" + s.meanDelta.toFixed(2)));
        return;
    }

    const pctLimit = Number(argv[3] || DEFAULT_PCT_LIMIT);
    const deltaLimit = Number(argv[4] || DEFAULT_DELTA_LIMIT);
    const rows = [];

    for (const p of changedFiles()) {
        const old = gitShow(p);
        if (!old) { rows.push({ p: p, newFile: true }); continue; }
        const a = await pixels(old);
        const b = await pixels(Buffer.from(fs.readFileSync(p)));
        const s = stats(a, b);
        rows.push({ p: p, s: s });

        if (mode === "restore") {
            const unchanged = !s.size && s.pct <= pctLimit && s.maxDelta <= deltaLimit;
            if (unchanged) execFileSync("git", ["checkout", "--", p]);
            console.log((unchanged ? "RESTORED " : "KEPT     ") + p);
        }
    }

    if (mode === "report") {
        rows.sort((x, y) => (x.newFile ? -1 : y.newFile ? 1
            : x.s.strongPct - y.s.strongPct));
        for (const r of rows) {
            if (r.newFile) { console.log("NEW       " + r.p); continue; }
            const s = r.s;
            console.log("any=" + s.pct.toFixed(3).padStart(7) + "%  strong=" +
                s.strongPct.toFixed(4).padStart(8) + "% (" +
                String(s.strong).padStart(7) + " px)  max=" +
                String(s.maxDelta).padStart(3) + "  mean=" + s.meanDelta.toFixed(2) +
                "  " + r.p);
        }
        console.log("\nfiles: " + rows.length);
    }
}

if (require.main === module) {
    main(process.argv).catch((err) => {
        console.error("compare-shots failed:", err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = { stats, pixels, changedFiles, SHOT_DIRS };
