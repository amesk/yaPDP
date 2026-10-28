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
 * The page, though, still ASKS for the two manifests and for the pre-built
 * machine states (media/manifest.json, states/manifest.json + *.state.zst +
 * states/previews/*). They are derived here from the variant's
 * bundle.resources — the only inventory of what the installer really carries —
 * so the quick-boot wizard offers only shippable guests and the Scenario tab
 * lists only states that can be restored offline. See
 * tools/desktop-manifests.js for the filters and the per-variant state policy.
 *
 * States and BOTH manifests are staged into desktop-resources/ and shipped as
 * Tauri resources, exactly like the images: they are content, they differ per
 * variant, and the frontend is compiled ONCE for both variants, so a
 * variant-specific manifest inside it would be wrong for one of them. Only the
 * Scenario previews stay in the frontend — the cards paint them as <img src>.
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
const DesktopManifests = require("./desktop-manifests.js");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "desktop");
// Staging for bundle.resources: states/ and media/manifest.json, shipped next
// to the executable (see bundle.resources in both tauri.conf variants).
const RESOURCES_DEST = path.join(ROOT, "desktop-resources");
const CONFIG_DEST = path.join(ROOT, "src-tauri", "tauri.conf.json");
const MEDIA_MANIFEST = path.join(ROOT, "media", "manifest.json");
const STATES_SRC = path.join(ROOT, "states");

// --- Helpers ------------------------------------------------------------

function usage() {
    console.log("Usage: node tools/build-desktop.js [--variant minimal|full] [--clean]");
    console.log("  minimal  (default) bundle rk0/rk1/bootcode only");
    console.log("  full     bundle every media image");
    console.log("  --clean  remove staged frontend, staged resources + generated tauri.conf.json");
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

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

// Stage the two manifests the page reads, plus the machine states this variant
// can actually restore. Both lists are filtered by bundle.resources of the
// SELECTED variant, so the packaged app never advertises what it cannot serve
// (see tools/desktop-manifests.js). Output goes to desktop-resources/ because
// all three are bundled resources, not part of the compiled-in frontend.
function stageManifests(variant, conf) {
    const shipped = DesktopManifests.shippedNames(conf);
    if (!shipped.size) {
        fail(`tauri.conf.${variant}.json declares no bundle.resources — nothing to stage`);
    }

    if (!fs.existsSync(MEDIA_MANIFEST)) {
        fail("media/manifest.json is missing — run: npm run manifest");
    }
    const mediaManifest = readJson(MEDIA_MANIFEST);
    const unlisted = DesktopManifests.unlistedResources(mediaManifest, shipped);
    if (unlisted.length) {
        fail(`bundle.resources of the ${variant} variant names payloads that ` +
            "media/manifest.json does not describe: " + unlisted.join(", ") +
            "\n  run: npm run manifest");
    }
    const filteredMedia = DesktopManifests.filterMediaManifest(mediaManifest, shipped);
    // Staged WITH the images it describes: the app reads it from the resource
    // dir (Rust `load_bundled_file`), never over HTTP.
    writeJson(path.join(RESOURCES_DEST, "media", "manifest.json"), filteredMedia);

    const stateManifestFile = path.join(STATES_SRC, "manifest.json");
    if (!fs.existsSync(stateManifestFile)) {
        fail("states/manifest.json is missing — run: npm run state-manifest");
    }
    const entries = readJson(stateManifestFile);

    // `mounted` from each container is what a state really needs; the device key
    // only names the scenario (rk1tty and rk1vt52 both boot rk1.dsk).
    const mountedByFile = {};
    for (const entry of entries) {
        try {
            mountedByFile[entry.file] = DesktopManifests.readMounted(STATES_SRC, entry.file);
        } catch (e) {
            fail(`cannot read states/${entry.file}: ${e && e.message ? e.message : e}`);
        }
    }

    const policy = DesktopManifests.STATE_POLICY[variant];
    try {
        DesktopManifests.assertPolicyCovered(policy, entries, mountedByFile, shipped);
    } catch (e) {
        fail(e.message + "\n  (fix tools/desktop-manifests.js -> STATE_POLICY)");
    }

    const filtered = DesktopManifests.filterStateEntries(entries, mountedByFile, shipped, policy);
    const statesDest = path.join(RESOURCES_DEST, "states");
    const previewsDest = path.join(DEST, "states");
    const stagedEntries = [];
    for (const entry of filtered.kept) {
        const src = path.join(STATES_SRC, entry.file);
        if (!fs.existsSync(src)) {
            fail(`states/${entry.file} is listed in states/manifest.json but missing — ` +
                "run: npm run state-manifest");
        }
        // The container is content: it ships next to the executable, like the
        // images it mounts.
        fs.mkdirSync(statesDest, { recursive: true });
        fs.copyFileSync(src, path.join(statesDest, entry.file));
        const staged = Object.assign({}, entry);
        // Previews are UI, not content: they stay in the embedded frontend,
        // which paints them as <img src="states/previews/...">. A missing file
        // is reported and dropped from the manifest, so the card falls back to
        // text instead of the lightbox opening a 404.
        for (const key of ["screenshot", "screenshotFull"]) {
            const rel = staged[key];
            if (!rel) continue;
            const from = path.join(STATES_SRC, rel);
            if (!fs.existsSync(from)) {
                console.warn(`  missing ${rel} for ${entry.file} — its card shows text only`);
                staged[key] = null;
                continue;
            }
            const to = path.join(previewsDest, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
        }
        stagedEntries.push(staged);
    }
    if (stagedEntries.length) {
        writeJson(path.join(statesDest, "manifest.json"), stagedEntries);
    }

    const stateBytes = DesktopManifests.dirBytes(statesDest).bytes;
    console.log(`  media/manifest.json: ${filteredMedia.media.length} image(s)`);
    console.log(`  states: ${stagedEntries.length} of ${entries.length} — ` +
        DesktopManifests.megabytes(stateBytes));
    for (const skip of filtered.skipped) {
        console.log(`    skip ${DesktopManifests.stateId(skip.file)}: ${skip.reason}`);
    }
    if (stateBytes > DesktopManifests.STATES_BUDGET_BYTES) {
        console.warn(`  WARNING: staged states exceed ` +
            `${DesktopManifests.megabytes(DesktopManifests.STATES_BUDGET_BYTES)} — ` +
            "they are installed next to the executable, so the installer grows");
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
    fs.rmSync(RESOURCES_DEST, { recursive: true, force: true });
    fs.rmSync(CONFIG_DEST, { force: true });
    console.log(`Removed staged frontend -> ${DEST}`);
    console.log(`Removed staged resources -> ${RESOURCES_DEST}`);
    console.log("Removed generated src-tauri/tauri.conf.json");
    process.exit(0);
}

// --- Stage lightweight static web app (no media/) -----------------------

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.rmSync(RESOURCES_DEST, { recursive: true, force: true });
fs.mkdirSync(RESOURCES_DEST, { recursive: true });

fs.copyFileSync(path.join(ROOT, "pdp11.html"), path.join(DEST, "pdp11.html"));
fs.copyFileSync(path.join(ROOT, "favicon.ico"), path.join(DEST, "favicon.ico"));
copyDir(path.join(ROOT, "css"), path.join(DEST, "css"));
copyDir(path.join(ROOT, "src"), path.join(DEST, "src"));
copyDir(path.join(ROOT, "assets"), path.join(DEST, "assets"));

// --- Select the Tauri config for this variant ---------------------------

const CONF_SRC = path.join(ROOT, "src-tauri", `tauri.conf.${variant}.json`);
const variantConf = readJson(CONF_SRC);

// --- Manifests + pre-built states, filtered by that variant -------------

stageManifests(variant, variantConf);

fs.copyFileSync(CONF_SRC, CONFIG_DEST);

console.log(`Staged Tauri frontend -> ${DEST}`);
console.log(`Variant: ${variant} (tauri.conf.${variant}.json -> tauri.conf.json)`);
console.log("Next: node tools/tauri-build.js  (or: npm run desktop)");
