#!/usr/bin/env node
/**
 * yaPDP — reel-font pure-helper tests.
 *
 * tools/assemble-video.js renders its title/URL/banner cards with ffmpeg
 * drawtext, which needs real .ttf files. The reference look uses the Windows
 * system faces (Consolas + Arial Bold); on Linux/macOS runners those are
 * missing, so tools/reel-font-util.js resolves repo-committed fallbacks
 * (Courier Prime / Michroma under assets/fonts). This file pins that resolver
 * with a fake platform/env/exists — no ffmpeg, no real fontconfig needed:
 *   1. On win32 it keeps the exact Windows system-font paths (the reference);
 *   2. Elsewhere it falls back to the repo-committed faces that exist;
 *   3. YAPDP_FONT / YAPDP_FONT_BOLD override the choice on every platform;
 *   4. The repo faces really are committed under assets/fonts.
 *
 * Run with:  node tests/reel-font.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const util = require(path.join(__dirname, "..", "tools", "reel-font-util.js"));

const { FONT_WIN, FONT_BOLD_WIN, FONT_REPO, FONT_BOLD_REPO,
    resolveFontPaths } = util;

const ROOT = path.join(__dirname, "..");

// --- Helpers -------------------------------------------------------------

// exists() that only "finds" the given allow-listed absolute paths.
function makeExists(allowList) {
    const set = new Set(allowList.map((p) => path.resolve(p)));
    return (p) => set.has(path.resolve(p));
}

const repoFont = (rel) => path.join(ROOT, ...rel);
const repoFontsExist = [repoFont(FONT_REPO), repoFont(FONT_BOLD_REPO)];

// --- 1. Windows keeps the reference system fonts --------------------------

const win = resolveFontPaths({ platform: "win32", env: {}, exists: makeExists([]) });
assert.strictEqual(win.font, FONT_WIN,
    "on Windows FONT must stay the Consolas system path");
assert.strictEqual(win.fontBold, FONT_BOLD_WIN,
    "on Windows FONT_BOLD must stay the Arial Bold system path");

// --- 2. Non-Windows falls back to the repo-committed faces ----------------

const linux = resolveFontPaths({
    platform: "linux",
    env: {},
    exists: makeExists(repoFontsExist)
});
assert.strictEqual(linux.font, repoFont(FONT_REPO),
    "on Linux FONT must fall back to the repo Courier Prime face");
assert.strictEqual(linux.fontBold, repoFont(FONT_BOLD_REPO),
    "on Linux FONT_BOLD must fall back to the repo Michroma face");

// macOS behaves like Linux (no Microsoft system fonts in the default layout).
const mac = resolveFontPaths({ platform: "darwin", env: {}, exists: makeExists(repoFontsExist) });
assert.strictEqual(mac.font, repoFont(FONT_REPO), "macOS must use the repo fallback too");

// --- 3. Env override wins on every platform -------------------------------

const over = resolveFontPaths({
    platform: "win32",
    env: { YAPDP_FONT: "/custom/mono.ttf", YAPDP_FONT_BOLD: "/custom/bold.ttf" },
    exists: makeExists([])
});
assert.strictEqual(over.font, "/custom/mono.ttf",
    "YAPDP_FONT must override the Windows font");
assert.strictEqual(over.fontBold, "/custom/bold.ttf",
    "YAPDP_FONT_BOLD must override the Windows bold font");

const overLinux = resolveFontPaths({
    platform: "linux",
    env: { YAPDP_FONT: "/custom/mono.ttf" },
    exists: makeExists([])
});
assert.strictEqual(overLinux.font, "/custom/mono.ttf",
    "YAPDP_FONT must override the Linux fallback");
assert.strictEqual(overLinux.fontBold, repoFont(FONT_BOLD_REPO),
    "unset YAPDP_FONT_BOLD on Linux must keep the repo fallback");

// --- 4. The repo faces really exist under assets/fonts --------------------

for (const rel of [FONT_REPO, FONT_BOLD_REPO]) {
    const p = repoFont(rel);
    assert.ok(fs.existsSync(p), "repo font must be committed: " + rel.join("/"));
}

console.log("reel-font tests passed.");
