"use strict";
/**
 * yaPDP — Cross-platform font resolution for the demo-reel title cards.
 *
 * tools/assemble-video.js burns title/URL/banner text into the promo videos
 * with ffmpeg's drawtext, which needs a real .ttf path (fontfile=). The
 * reference look on Windows uses the OS's Consolas (mono body text) and Arial
 * Bold (display titles); Linux/macOS runners do not ship those two faces, so
 * we fall back to typefaces committed in assets/fonts — always present after a
 * git checkout, no apt-installed fonts needed on the CI runner. The choice can
 * be overridden per face with the YAPDP_FONT / YAPDP_FONT_BOLD env vars when a
 * specific font is wanted instead.
 *
 * Pure helpers only (no browser, no ffmpeg), so tests can pin the resolution
 * with a fake platform/env/exists without executing the tools' real requires.
 */

const fs = require("fs");
const path = require("path");

// Windows system faces — kept as the reference look. The values carry ffmpeg
// filtergraph escaping (`\\` -> `\`, `\:` -> `:`) because they are spliced
// straight into a drawtext filter string; do NOT de-escape them here.
const FONT_WIN = "C\\\\:/Windows/Fonts/consola.ttf";
const FONT_BOLD_WIN = "C\\\\:/Windows/Fonts/arialbd.ttf";

// Repo-committed fallback faces (relative to the repo root). Courier Prime
// (a DEC-era typewriter mono) stands in for Consolas; Michroma — the project's
// Eurostile/Microgramma-style display face used for the engraved DEC wordmark
// — stands in for Arial Bold. Both live under assets/fonts, so they exist on
// any runner right after checkout.
const FONT_REPO = ["assets", "fonts", "courierprime", "CourierPrime-Regular.ttf"];
const FONT_BOLD_REPO = ["assets", "fonts", "michroma", "Michroma-Regular.ttf"];

// First existing candidate (or null when none exist).
function firstExisting(candidates, exists) {
    for (const c of candidates) {
        if (c && exists(c)) return c;
    }
    return null;
}

// Resolve { font, fontBold } paths for drawtext. opts (all optional):
//   platform — process.platform value to simulate (default process.platform);
//   root     — repo root used to build the fallback paths
//              (default: this file's parent);
//   env      — env-like object (default process.env);
//   exists   — fs.existsSync-like probe (default fs.existsSync).
// Per-face order: env override (YAPDP_FONT / YAPDP_FONT_BOLD) > the Windows
// system font on win32 > the first repo-committed face that exists.
function resolveFontPaths(opts) {
    opts = opts || {};
    const platform = opts.platform || process.platform;
    const root = opts.root || path.resolve(__dirname, "..");
    const env = opts.env || process.env;
    const exists = opts.exists || ((p) => fs.existsSync(p));

    const pick = (envName, win, repo) => {
        if (env[envName]) return env[envName];
        if (platform === "win32") return win;
        const repoPath = path.join(root, ...repo);
        return firstExisting([repoPath], exists) || repoPath;
    };

    return {
        font: pick("YAPDP_FONT", FONT_WIN, FONT_REPO),
        fontBold: pick("YAPDP_FONT_BOLD", FONT_BOLD_WIN, FONT_BOLD_REPO)
    };
}

module.exports = {
    FONT_WIN,
    FONT_BOLD_WIN,
    FONT_REPO,
    FONT_BOLD_REPO,
    firstExisting,
    resolveFontPaths
};
