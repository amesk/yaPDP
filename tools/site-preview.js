#!/usr/bin/env node
/**
 * Assemble the deployable yaPDP site: the repository root (emulator,
 * media, css, root assets) with the landing SPA build overlaid on top.
 *
 * The result is what GitHub Pages serves — the SPA as index.html and the
 * emulator same-origin at /pdp11.html. One code path for the CI workflow
 * and for local previews (cross-platform; no rsync needed):
 *
 *   node tools/site-preview.js [outDir]     # default: ./site
 *
 * When the repo checkout has no landing/ directory, the SPA overlay is
 * skipped and the plain static site is produced (rollback path).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LANDING_DIST = path.join(ROOT, "landing", "dist");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "site"));

// Top-level entries of the repo that must not reach the public site
// (tooling, sources of other artifacts, build droppings, docs).
const EXCLUDE_TOP = new Set([
    ".git", ".github", ".wireit", ".roo",
    "landing", "node_modules", "tests", "docs", "tools",
    "src-tauri", "desktop", "macro-asm",
    "dist-linux", "video",
    "package.json", "package-lock.json",
    "CHANGELOG.md", "LICENSE", "README.md",
]);
const EXCLUDE_PATTERNS = [/\.log$/];

function wanted(src) {
    const name = path.basename(src);
    if (EXCLUDE_TOP.has(name)) return false;
    return !EXCLUDE_PATTERNS.some((re) => re.test(src));
}

function copyTree(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        if (!wanted(s)) continue;
        const st = fs.lstatSync(s);
        if (st.isSymbolicLink()) continue; // never follow links into the site
        if (st.isDirectory()) copyTree(s, d);
        else fs.copyFileSync(s, d);
    }
}

function overlayTree(src, dest) {
    // Merge (not replace): repo-root assets/ and the SPA's assets/ coexist.
    for (const entry of fs.readdirSync(src)) {
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        const st = fs.lstatSync(s);
        if (st.isDirectory()) overlayTree(s, d);
        else {
            fs.mkdirSync(path.dirname(d), { recursive: true });
            fs.copyFileSync(s, d);
        }
    }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyTree(ROOT, OUT);
if (fs.existsSync(LANDING_DIST)) {
    overlayTree(LANDING_DIST, OUT);
    console.log("site: repo root + landing/dist overlay -> " + OUT);
} else {
    console.log("site: no landing/dist — classic static site -> " + OUT);
}
const size = fs.readdirSync(OUT).length;
console.log("site: " + size + " top-level entries");
