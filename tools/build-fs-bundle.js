#!/usr/bin/env node
/*
 * build-fs-bundle.js — pack the files a `file://` page cannot fetch into one
 * <script>-loadable payload (assets/fs-bundle/bundle.js).
 *
 * A browser blocks fetch() for a document opened from disk (its origin is
 * "null"), so pdp11.html double-clicked loses its manifests, its SVG artwork and
 * every disk image — that is the CORS wall described in the manual. A <script
 * src> is the one request such a page is still allowed to make, so the payload
 * is base64 inside a plain script, and src/fsbundle.js turns it back into the
 * responses the emulator asks for.
 *
 * The default set is the demo machine: the two disks every quick-boot card
 * needs (Unix V5 on rk0, RT-11 on rk1), the paper tapes, all the cabinet
 * artwork and the states that only reference those images. `--all` packs every
 * image and every saved state instead (tens of megabytes of base64, slow to
 * load from disk; useful for a fully offline museum copy).
 *
 * Usage: node tools/build-fs-bundle.js [--all] [--out <file>] [--quiet]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "assets", "fs-bundle", "bundle.js");

// Logical image names (as used by media/manifest.json) that the demo boot
// requires: the two quick-boot disks, the bootstrap and the paper tapes.
const DEMO_MEDIA = [
    "bootcode.ptap",
    "rk0.dsk",
    "rk1.dsk",
    "DEC-11-AJPB-PB.ptap",
    "DEC-11-O2PA-PB.ptap",
    "ED-11-V004B-8K.ptap",
    "lander.ptap"
];

// Saved states whose pinned images are all part of DEMO_MEDIA. A state that
// needs an image the bundle does not carry would restore into an error dialog,
// so it is deliberately left out of the default set.
const DEMO_STATES = [
    "basic-ready.state.zst",
    "lunar-lander.state.zst",
    "rk0-ready.state.zst",
    "rk1-ready.state.zst",
    "rk1tty-ready.state.zst",
    "rk1vt52-ready.state.zst",
    "rt-11-adventure.state.zst",
    "rt-11-dungeon.state.zst"
];

// Bundle keys are urls, not filesystem paths: a Windows build must still emit
// "assets/vt52.svg" or every lookup from the page misses.
function toPosix(rel) {
    return rel.split(path.sep).join("/");
}

function argValue(args, name) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function readJson(rel, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    } catch (err) {
        return fallback;
    }
}

// A logical name may be shipped compressed: media/rk0.dsk is media/rk0.dsk.zst
// on disk. The raw file wins when both exist — it is what the page would have
// fetched first anyway.
function resolveMedia(name) {
    const raw = path.join(ROOT, "media", name);
    if (fs.existsSync(raw)) return path.join("media", name);
    const zst = path.join(ROOT, "media", name + ".zst");
    if (fs.existsSync(zst)) return path.join("media", name) + ".zst";
    return null;
}

function listArtwork() {
    const dir = path.join(ROOT, "assets");
    return fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".svg"))
        .map((f) => path.join("assets", f));
}

function collect(all) {
    const files = new Set();

    // The manifests themselves: without them the wizard cannot even list what
    // the deployment carries.
    ["media/manifest.json", "states/manifest.json"].forEach((rel) => {
        if (fs.existsSync(path.join(ROOT, rel))) files.add(rel);
    });

    // Cabinet artwork: the geometry of the Model 33 and the DECscope is read
    // from the SVG at runtime, so a missing file costs the whole cabinet.
    listArtwork().forEach((rel) => files.add(rel));

    const mediaManifest = readJson("media/manifest.json", { media: [] });
    const mediaNames = Array.isArray(mediaManifest.media)
        ? mediaManifest.media
        : [];
    const wantedMedia = all ? mediaNames : DEMO_MEDIA;
    wantedMedia.forEach((name) => {
        const rel = resolveMedia(name);
        if (!rel) {
            process.stderr.write(`! media image not found: ${name}\n`);
            return;
        }
        files.add(rel);
    });

    const stateManifest = readJson("states/manifest.json", []);
    const stateFiles = Array.isArray(stateManifest)
        ? stateManifest.map((entry) => entry && entry.file).filter(Boolean)
        : [];
    const wantedStates = all ? stateFiles : DEMO_STATES;
    wantedStates.forEach((file) => {
        const rel = path.join("states", file);
        if (!fs.existsSync(path.join(ROOT, rel))) {
            process.stderr.write(`! state not found: ${file}\n`);
            return;
        }
        files.add(rel);
    });

    return Array.from(files).sort();
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
        process.stdout.write(
            "Usage: node tools/build-fs-bundle.js [--all] [--out <file>] [--quiet]\n" +
            "  --all    pack every image and every saved state (large)\n" +
            "  --out    output file (default assets/fs-bundle/bundle.js)\n" +
            "  --quiet  do not print the per-file table\n"
        );
        return;
    }
    const all = args.includes("--all");
    const quiet = args.includes("--quiet");
    const out = argValue(args, "--out")
        ? path.resolve(ROOT, argValue(args, "--out"))
        : DEFAULT_OUT;

    const files = collect(all);
    const parts = [];
    let total = 0;
    const rows = [];

    files.forEach((entry) => {
        const bytes = fs.readFileSync(path.join(ROOT, entry));
        const base64 = bytes.toString("base64");
        const rel = toPosix(entry);
        total += base64.length;
        rows.push([rel, bytes.length, base64.length]);
        parts.push("  " + JSON.stringify(rel) + ": " + JSON.stringify(base64));
    });

    if (!parts.length) {
        process.stderr.write("Nothing to bundle: media/ and states/ are empty.\n");
        process.exit(1);
    }

    const js =
        "/*\n" +
        " * Generated by tools/build-fs-bundle.js — DO NOT EDIT.\n" +
        " *\n" +
        " * Static payloads a file:// page is not allowed to fetch(), base64-encoded\n" +
        " * and loaded as an ordinary <script> by src/fsbundle.js. Regenerate with\n" +
        " * `npm run fs-bundle` after changing media/, states/ or the artwork.\n" +
        " */\n" +
        "window.__yapdpFsBundle = {\n" +
        "  version: 1,\n" +
        "  generated: " + JSON.stringify(new Date().toISOString()) + ",\n" +
        "  files: {\n" +
        parts.join(",\n") + "\n" +
        "  }\n" +
        "};\n";

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, js, "utf8");

    if (!quiet) {
        rows.forEach((row) => {
            process.stdout.write(
                "  " + String(row[0]).padEnd(42) +
                String(row[1]).padStart(10) + " B -> " +
                String(row[2]).padStart(10) + " B base64\n"
            );
        });
    }
    process.stdout.write(
        (all ? "Full" : "Demo") + " bundle: " + files.length + " files, " +
        (total / 1048576).toFixed(2) + " MB of base64 -> " +
        path.relative(ROOT, out) + "\n"
    );
}

main();
