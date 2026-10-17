#!/usr/bin/env node
/**
 * yaPDP — State-manifest generator.
 *
 * Scans states/*.state.zst and writes states/manifest.json: the list of
 * pre-built machine states this build ships, with metadata extracted from
 * each state's own manifest (label, description, screenshot).
 *
 * Screenshots: a state carries its screenshot as a base64 data URI. The raw
 * image is a large PNG (tens of KB), so the manifest holds it as separate
 * lightweight files instead of inlining the base64 — the scenario list is
 * fetched on every page load (see fetchStateManifest in src/quickboot.js),
 * and on a slow link 230 KB of base64 delayed the startup loading gate past
 * its e2e budget (tests/e2e-startup-cls.js). This generator writes:
 *   states/previews/<file>-small.png   - downscaled list thumbnail
 *   states/previews/<file>-full.png    - the original screenshot, for the
 *                                        lightbox (src/lightbox.js)
 * The JSON then stores only the relative paths ("previews/x-small.png").
 * A state without a screenshot stores null in both slots.
 *
 * The quick-boot wizard's Scenario tab uses the manifest to show what
 * states are available, so a build with a reduced state set no longer
 * advertises states whose file is absent.
 *
 * Run manually or as a deploy step:  node tools/gen-state-manifest.js
 *
 * Output is deterministic (sorted, no timestamps) so the file can be
 * committed and diffed. The preview PNGs are deterministic too (sharp),
 * so a no-op rerun changes nothing.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const STATES = path.join(ROOT, "states");
const PREVIEWS = path.join(STATES, "previews");
const OUT = path.join(STATES, "manifest.json");

const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

// Thumbnails are 80x60 in the dialog (css/pdp11.css .quickboot-scenario-preview);
// 320px wide keeps them sharp on a 2x screen without being heavy.
const THUMB_MAX_WIDTH = 320;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStateMeta(file) {
    const parsed = StateFormat.unpack(StateIO.readBytes(file).container);
    if (!parsed) return null;
    return parsed.manifest || null;
}

// Build a display label from the manifest.  When the manifest carries a
// human-readable label (e.g. "Lunar Lander") use it; otherwise derive one
// from the device key (e.g. "rk1" -> "RK1 (ready)").
function displayLabel(manifest, file) {
    if (manifest && manifest.label && manifest.label !== manifest.device) {
        return manifest.label;
    }
    // Derive from the file name: strip "-ready" and ".state.zst", uppercase.
    var base = path.basename(file, ".state.zst");
    base = base.replace(/-ready$/, "");
    return base.toUpperCase() + " (ready)";
}

// Build a short description.  Prefer stepsMessage from the manifest; fall
// back to a generic line.
function displayDescription(manifest) {
    if (manifest && manifest.stepsMessage) return manifest.stepsMessage;
    return null;
}

// Decode a state's data-URI screenshot into a Buffer, or null when the state
// carries none / it is not a data URI we understand.
function screenshotBuffer(manifest) {
    var raw = manifest && manifest.screenshot;
    if (!raw || typeof raw !== "string") return null;
    var m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw.trim());
    if (!m) return null;
    return Buffer.from(m[1], "base64");
}

// Write both preview sizes for one state. Resolves to
// { small, full } relative paths under states/, or null when the state has
// no screenshot (or the image cannot be processed — the list then shows the
// text-only card, same as a state without a screenshot).
//
// The full file, once it exists, is OWNED by the operator: a hand-placed
// beautiful screenshot (or one rendered by a different tool) must survive a
// manifest regeneration, so an existing -full.png is never overwritten and
// becomes the source the thumbnails are derived from. The in-state screenshot
// is only the FALLBACK for a state that has never been previewed yet.
async function writePreviews(file, manifest, previewsDir) {
    var dir = previewsDir || PREVIEWS;
    var base = path.basename(file, ".state.zst");
    var smallRel = "previews/" + base + "-small.png";
    var fullRel = "previews/" + base + "-full.png";
    var smallPath = path.join(dir, base + "-small.png");
    var fullPath = path.join(dir, base + "-full.png");

    // Source of truth: an existing full preview (hand-placed, never touched),
    // then the screenshot embedded in the state's own manifest, then nothing.
    var srcBuf;
    if (fs.existsSync(fullPath)) {
        srcBuf = fs.readFileSync(fullPath);
    } else {
        srcBuf = screenshotBuffer(manifest);
        if (!srcBuf) return null;
        // Full size: the original state screenshot, decoded to a plain file.
        // The state container keeps its own copy; this one exists for the
        // lightbox. Written only once — a later regeneration sees the file
        // and treats it as the operator-owned source above.
        fs.writeFileSync(fullPath, srcBuf);
    }

    try {
        var small = await sharp(srcBuf)
            .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
            .png()
            .toBuffer();
        fs.writeFileSync(smallPath, small);
        return { small: smallRel, full: fullRel };
    } catch (e) {
        console.warn("  SKIP screenshot " + file + ": " +
            (e && e.message ? e.message : e));
        return null;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    fs.mkdirSync(PREVIEWS, { recursive: true });

    var files = fs.readdirSync(STATES)
        .filter(function (f) { return /\.state\.zst$/.test(f) && !f.startsWith("."); })
        .sort();

    var entries = [];
    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var manifest;
        try {
            manifest = readStateMeta(path.join(STATES, f));
        } catch (e) {
            console.warn("  SKIP " + f + ": " + (e && e.message ? e.message : e));
            continue;
        }
        if (!manifest) {
            console.warn("  SKIP " + f + ": could not unpack container");
            continue;
        }

        var device = (manifest && manifest.device) || null;
        var label = displayLabel(manifest, f);
        var description = displayDescription(manifest);
        var previews = await writePreviews(f, manifest);

        entries.push({
            device: device,
            label: label,
            description: description,
            file: f,
            screenshot: previews ? previews.small : null,
            screenshotFull: previews ? previews.full : null,
        });
    }

    var output = JSON.stringify(entries, null, 2) + "\n";
    fs.writeFileSync(OUT, output, "utf8");
    console.log("states/manifest.json: " + entries.length + " states -> " + OUT);
}

// Run as a CLI when invoked directly; expose the pure pieces when required by
// a test (tests/states-manifest.test.js exercises writePreviews idempotency
// without touching the real states/previews/).
if (require.main === module) {
    main().catch(function (e) {
        console.error("gen-state-manifest error:", e && e.message ? e.message : e);
        process.exit(1);
    });
}

module.exports = {
    writePreviews: writePreviews,
    screenshotBuffer: screenshotBuffer,
    THUMB_MAX_WIDTH: THUMB_MAX_WIDTH,
};