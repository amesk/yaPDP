#!/usr/bin/env node
/**
 * yaPDP — Build-manifest generator.
 *
 * Scans media/ and writes media/manifest.json: the list of disk, tape and
 * paper-tape images this build ships, as logical urls (rk0.dsk, tm0.tap,
 * lander.ptap). The quick-boot wizard and the Info page's guest-OS table
 * use the manifest to show only what can actually boot in this deployment,
 * so a build with a reduced image set (e.g. the desktop "minimal" variant)
 * no longer advertises OSes whose image is absent.
 *
 * Run manually or as a deploy step:  node tools/gen-media-manifest.js
 *
 * Output is deterministic (sorted, no timestamps) so the file can be
 * committed and diffed. If you change the naming rules here, update the
 * mirror in tests/media-manifest.test.js (the test recomputes the expected
 * list from the directory and fails when they drift).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(MEDIA, "manifest.json");

// bootcode.ptap is the bootstrap loader, not a guest image: every boot needs
// it, so it is excluded from the manifest on purpose.
const EXCLUDE = new Set(["bootcode.ptap", "bootcode.ptap.zst"]);

// A media file is a guest image when it is a .dsk / .tap / .ptap, optionally
// zstd-compressed. Logical url = file name without the .zst suffix, which is
// exactly what DataLoader keys and OSBoot.urlFor() use.
const IMAGE_RE = /\.(dsk|tap|ptap)(\.zst)?$/;

function logicalUrl(file) {
    return file.endsWith(".zst") ? file.slice(0, -4) : file;
}

const files = fs.readdirSync(MEDIA)
    .filter((f) => IMAGE_RE.test(f) && !EXCLUDE.has(f) && !f.startsWith("."))
    .map(logicalUrl)
    .sort();

const manifest = { media: files };
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`media/manifest.json: ${files.length} images -> ${OUT}`);
