#!/usr/bin/env node
/**
 * yaPDP — desktop (Tauri) manifest staging helpers.
 *
 * The web version ships media/manifest.json and states/manifest.json as part of
 * the repository, and the page fetches both page-relatively (src/quickboot.js,
 * src/media-registry.js, src/loading-gate.js). The desktop build stages only the
 * lightweight frontend into desktop/ and ships the disk/tape images as Tauri
 * resources instead, so those two manifests never reached the packaged app: the
 * quick-boot wizard advertised guests whose image is not installed, the Scenario
 * tab was empty, and a state restore that pins an image version tried to fetch
 * media/<image> over HTTP, which does not exist inside the app.
 *
 * This module derives BOTH manifests from the single source of truth that
 * decides what an installer really contains — bundle.resources of the variant
 * config — and filters the pre-built machine states down to the ones that can
 * actually be restored on that variant.
 *
 * Everything staged here — both manifests and *.state.zst — ships as a bundled
 * RESOURCE, next to the executable and next to the disk images, never inside the
 * embedded frontend: the frontend is compiled once for both installer variants,
 * so a variant-specific inventory baked into it is wrong for one of them.
 *
 * Two inventories are kept deliberately:
 *
 *   1. shippedNames(conf)  — logical image names from bundle.resources. Every
 *      payload the installer carries must be here; a payload the page can mount
 *      but the map omits only fails inside the packaged app.
 *   2. STATE_POLICY        — which pre-built states a variant advertises. The
 *      minimal installer has no rl/rp/ra images, so the RSTS/XXDP/BSD states
 *      cannot be restored there; the policy also trims states whose image IS
 *      shipped but whose card is not worth the megabytes (the guest is still
 *      reachable through the Boot tab). The policy is validated at stage time:
 *      a state listed for a variant but missing its image, or missing from
 *      states/, fails the stage instead of silently vanishing from the UI.
 *
 * Pure helpers (no filesystem) are unit-testable in Node — see
 * tests/desktop-manifests.test.js. readMounted() is the one exception: it reads
 * a state container to learn the images that state needs.
 *
 * Usage:  const DM = require("./desktop-manifests.js");
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Payloads that are shipped but are NOT logical media images: bootcode.ptap is
// the bootstrap loader and is deliberately excluded from media/manifest.json
// (see tools/gen-media-manifest.js -> EXCLUDE). A state may still mount it.
const NON_MANIFEST_PAYLOADS = new Set(["bootcode.ptap"]);

// Which pre-built states each variant advertises (ids = file name without the
// ".state.zst" suffix). null = every state whose images the variant ships.
//
// minimal: the three guests its own documentation promises (Unix V5, RT-11,
// BASIC-11), the VT11 showcase, and both extra console variants — the Model 33
// teletype and the VT52 DECscope are the point of the project. The remaining
// RT-11 cards stay in the full build; their guests are bootable in minimal
// anyway.
//
// rt-11-print-coguar (the LP11 showcase) is deliberately NOT here: it mounts
// rk5.dsk, which the minimal installer does not ship, so a card for it would be
// a restore that cannot complete.
const STATE_POLICY = {
    minimal: [
        "rk0-ready",
        "rk1-ready",
        "basic-ready",
        "lunar-lander",
        "rk1tty-ready",
        "rk1vt52-ready"
    ],
    full: null
};

// Log a warning above this many bytes of staged states (state files + previews).
// States are installed NEXT TO the executable (bundle.resources), so this sizes
// the installer rather than the app binary; the ceiling keeps a future state
// set from growing the download by accident.
const STATES_BUDGET_BYTES = 20 * 1024 * 1024;

// bundle.resources -> logical image names ("media/rk0.dsk.zst" -> "rk0.dsk").
//
// Only file destinations under media/ are images. The same map also carries the
// state tree and both variant-filtered manifests ("states/", "media/"), which
// are resources too but are NOT part of the image inventory — counting them
// would make the staleness check below complain about a payload the media
// manifest is not supposed to describe.
function shippedNames(conf) {
    const resources = (conf && conf.bundle && conf.bundle.resources) || {};
    const out = new Set();
    for (const value of Object.values(resources)) {
        const dest = String(value).replace(/\\/g, "/");
        if (!dest.startsWith("media/") || dest.endsWith("/")) continue;
        const name = path.basename(dest).replace(/\.zst$/i, "");
        if (!name || name === "manifest.json") continue;
        out.add(name);
    }
    return out;
}

// Shipped payloads that media/manifest.json does not describe at all. An empty
// result means the committed manifest is in step with the installer inventory;
// anything else is a stale `npm run manifest` and the stage must stop.
function unlistedResources(manifest, shipped) {
    const listed = new Set(Array.isArray(manifest && manifest.media) ? manifest.media : []);
    const registry = (manifest && manifest["media-versioned"]) || {};
    for (const name of Object.keys(registry)) listed.add(name);
    const out = [];
    for (const name of shipped) {
        if (NON_MANIFEST_PAYLOADS.has(name)) continue;
        if (!listed.has(name)) out.push(name);
    }
    return out.sort();
}

// The media manifest as this variant should see it: only the images it ships.
// Without the filter the wizard offers guests whose image is not installed and
// the versioned registry names URLs the app cannot fetch.
function filterMediaManifest(manifest, shipped) {
    const listed = Array.isArray(manifest && manifest.media) ? manifest.media : [];
    const registry = (manifest && manifest["media-versioned"]) || {};
    const media = listed.filter((name) => shipped.has(name));
    const versioned = {};
    for (const name of Object.keys(registry).sort()) {
        if (shipped.has(name)) versioned[name] = registry[name];
    }
    return { media: media, "media-versioned": versioned };
}

// The images a single state needs, read from the container's own manifest.
// `mounted` is the machine's image list at capture time (docs/STATE-FORMAT.md),
// which is the only exact answer: a device key names a scenario, not an image
// (rk1tty and rk1vt52 both boot rk1.dsk).
function readMounted(statesDir, file) {
    const StateIO = require(path.join(ROOT, "tools", "state-io.js"));
    const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
    const parsed = StateFormat.unpack(StateIO.readBytes(path.join(statesDir, file)).container);
    const manifest = parsed && parsed.manifest;
    return (manifest && Array.isArray(manifest.mounted)) ? manifest.mounted.slice() : [];
}

function stateId(file) {
    return String(file).replace(/\.state\.zst$/, "");
}

// A policy entry must name an existing state whose every image the variant
// ships. Throws (rather than skipping) so a drifting policy fails the stage
// loudly instead of quietly dropping a card from the installer.
function assertPolicyCovered(policy, entries, mountedByFile, shipped) {
    if (!Array.isArray(policy) || !policy.length) return;
    const byId = new Map();
    for (const entry of entries || []) byId.set(stateId(entry.file), entry);
    const problems = [];
    for (const id of policy) {
        const entry = byId.get(id);
        if (!entry) {
            problems.push(id + ": no states/" + id + ".state.zst");
            continue;
        }
        for (const image of mountedByFile[entry.file] || []) {
            if (!shipped.has(image)) {
                problems.push(id + ": needs " + image + ", which this variant does not ship");
            }
        }
    }
    if (problems.length) {
        throw new Error("STATE_POLICY names states this variant cannot restore:\n  " +
            problems.join("\n  "));
    }
}

// Split the state-manifest entries into what this variant advertises and what
// it leaves out, with the reason for every skip (the stage prints them, so a
// missing card is never a mystery).
function filterStateEntries(entries, mountedByFile, shipped, policy) {
    const allow = Array.isArray(policy) ? new Set(policy) : null;
    const kept = [];
    const skipped = [];
    for (const entry of entries || []) {
        const id = stateId(entry.file);
        if (allow && !allow.has(id)) {
            skipped.push({ file: entry.file, reason: "not advertised by this variant" });
            continue;
        }
        const needed = (mountedByFile && mountedByFile[entry.file]) || [];
        const missing = needed.filter((image) => !shipped.has(image));
        if (missing.length) {
            skipped.push({ file: entry.file, reason: "needs " + missing.join(", ") +
                " (not shipped by this variant)" });
            continue;
        }
        kept.push(entry);
    }
    return { kept: kept, skipped: skipped };
}

// Total bytes of every regular file under dir (0 when dir is absent).
function dirBytes(dir) {
    let total = 0;
    let files = 0;
    if (!fs.existsSync(dir)) return { bytes: 0, files: 0 };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const inner = dirBytes(full);
            total += inner.bytes;
            files += inner.files;
        } else {
            total += fs.statSync(full).size;
            files += 1;
        }
    }
    return { bytes: total, files: files };
}

function megabytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

module.exports = {
    STATE_POLICY: STATE_POLICY,
    STATES_BUDGET_BYTES: STATES_BUDGET_BYTES,
    NON_MANIFEST_PAYLOADS: NON_MANIFEST_PAYLOADS,
    shippedNames: shippedNames,
    unlistedResources: unlistedResources,
    filterMediaManifest: filterMediaManifest,
    readMounted: readMounted,
    stateId: stateId,
    assertPolicyCovered: assertPolicyCovered,
    filterStateEntries: filterStateEntries,
    dirBytes: dirBytes,
    megabytes: megabytes
};
