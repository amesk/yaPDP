#!/usr/bin/env node
/**
 * yaPDP — State-manifest generator.
 *
 * Scans states/*.state.zst and writes states/manifest.json: the list of
 * pre-built machine states this build ships, with metadata extracted from
 * each state's own manifest (label, description, screenshot).
 *
 * The quick-boot wizard's Scenario tab uses the manifest to show what
 * states are available, so a build with a reduced state set no longer
 * advertises states whose file is absent.
 *
 * Run manually or as a deploy step:  node tools/gen-state-manifest.js
 *
 * Output is deterministic (sorted, no timestamps) so the file can be
 * committed and diffed.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATES = path.join(ROOT, "states");
const OUT = path.join(STATES, "manifest.json");

const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

var entries = [];

var files = fs.readdirSync(STATES)
    .filter(function (f) { return /\.state\.zst$/.test(f) && !f.startsWith("."); })
    .sort();

files.forEach(function (f) {
    var fullPath = path.join(STATES, f);
    var manifest;
    try {
        manifest = readStateMeta(fullPath);
    } catch (e) {
        console.warn("  SKIP " + f + ": " + (e && e.message ? e.message : e));
        return;
    }
    if (!manifest) {
        console.warn("  SKIP " + f + ": could not unpack container");
        return;
    }

    var device = (manifest && manifest.device) || null;
    var label = displayLabel(manifest, f);
    var description = displayDescription(manifest);
    var screenshot = (manifest && manifest.screenshot) || null;

    entries.push({
        device: device,
        label: label,
        description: description,
        file: f,
        screenshot: screenshot,
    });
});

var output = JSON.stringify(entries, null, 2) + "\n";
fs.writeFileSync(OUT, output, "utf8");
console.log("states/manifest.json: " + entries.length + " states -> " + OUT);