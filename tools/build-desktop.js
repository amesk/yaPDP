#!/usr/bin/env node
/**
 * Stage the Tauri frontend directory (desktop/) from the web sources.
 *
 * Node port of the former tools/build-desktop.sh - removes the MinGW/bash
 * dependency so the desktop pipeline runs natively on Windows. The Tauri app
 * serves its UI from `desktop/` (see src-tauri/tauri.conf.json ->
 * build.frontendDist). Only the lightweight static assets are staged here; the
 * large disk/tape images in media/ are deliberately EXCLUDED and shipped
 * instead as bundled Tauri resources so the installer stays small.
 *
 * Two installer variants are produced from the same frontend:
 *   --variant minimal  (default) -> bundles only rk0/rk1/bootcode
 *   --variant full               -> bundles every media image (RK/RL/RP/RA/TM + tapes)
 *
 * The matching src-tauri/tauri.conf.<variant>.json is copied over
 * src-tauri/tauri.conf.json (gitignored) before `cargo tauri build`.
 *
 * Usage:
 *   node tools/build-desktop.js [--variant minimal|full] [--clean] [--help]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "desktop");
const CONFIG_DEST = path.join(ROOT, "src-tauri", "tauri.conf.json");

// --- Helpers ------------------------------------------------------------

function usage() {
    console.log("Usage: node tools/build-desktop.js [--variant minimal|full] [--clean]");
    console.log("  minimal  (default) bundle rk0/rk1/bootcode only");
    console.log("  full     bundle every media image");
    console.log("  --clean  remove staged frontend + generated tauri.conf.json");
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

// --- Argument parsing ---------------------------------------------------

let variant = "minimal";
let clean = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--variant") {
        variant = args[++i];
    } else if (arg.startsWith("--variant=")) {
        variant = arg.slice("--variant=".length);
    } else if (arg === "--clean") {
        clean = true;
    } else if (arg === "-h" || arg === "--help") {
        usage();
        process.exit(0);
    } else {
        console.error(`Unknown argument: ${arg}`);
        usage();
        process.exit(1);
    }
}

if (variant !== "minimal" && variant !== "full") {
    console.error(`Unknown variant '${variant}' (expected: minimal|full)`);
    process.exit(1);
}

// --- Clean mode ---------------------------------------------------------

if (clean) {
    fs.rmSync(DEST, { recursive: true, force: true });
    fs.rmSync(CONFIG_DEST, { force: true });
    console.log(`Removed staged frontend -> ${DEST}`);
    console.log("Removed generated src-tauri/tauri.conf.json");
    process.exit(0);
}

// --- Stage lightweight static web app (no media/) -----------------------

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

fs.copyFileSync(path.join(ROOT, "pdp11.html"), path.join(DEST, "pdp11.html"));
fs.copyFileSync(path.join(ROOT, "favicon.ico"), path.join(DEST, "favicon.ico"));
copyDir(path.join(ROOT, "css"), path.join(DEST, "css"));
copyDir(path.join(ROOT, "src"), path.join(DEST, "src"));
copyDir(path.join(ROOT, "assets"), path.join(DEST, "assets"));

// --- Select the Tauri config for this variant ---------------------------

fs.copyFileSync(
    path.join(ROOT, "src-tauri", `tauri.conf.${variant}.json`),
    CONFIG_DEST
);

console.log(`Staged Tauri frontend -> ${DEST}`);
console.log(`Variant: ${variant} (tauri.conf.${variant}.json -> tauri.conf.json)`);
console.log("Next: node tools/tauri-build.js  (or: npm run desktop)");
