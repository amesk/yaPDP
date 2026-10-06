#!/usr/bin/env node
/**
 * state-manifest.js — extract or replace the manifest inside a .state.zst file.
 *
 * Usage:
 *   node tools/state-manifest.js extract <input.state.zst> [output.json]
 *   node tools/state-manifest.js replace <input.state.zst> <manifest.json> <output.state.zst>
 *
 * extract:
 *   Read a .state.zst, decompress it, unpack the container, write the manifest
 *   as a pretty-printed JSON file. The original state is not modified.
 *
 * replace:
 *   Read a .state.zst, decompress it, unpack the container, read the new
 *   manifest JSON, validate it, re-pack with the original memory words, and
 *   write a new .state.zst. The original state is not modified.
 *
 * The FRAME around the container is whatever the writer had: zstd (the Node
 * tools and the repo's own states/), gzip (the browser — the page has no zstd
 * compressor, only CompressionStream), or no frame at all on a Node without
 * zstd. src/snapshots.js reads all three, so the frame is recognised here as
 * well and a state exported from the browser opens exactly like a locally made
 * one. `replace` frames its output too — zstd when this Node has an encoder,
 * gzip otherwise — so the file never grows back to its raw size.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));
const StateIO = require("./state-io.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// The frame half belongs to src/state-frame.js (zstd from the tools, gzip from
// the browser's own export, none from a writer with no compressor) and the
// Node codecs to tools/state-io.js — shared with every other state tool.
function readState(file) {
    const parsed = StateFormat.unpack(StateIO.readBytes(file).container);
    if (!parsed) throw new Error("could not unpack the container");
    return parsed;
}

// Returns the frame that was written, for the caller to report.
function writeState(manifest, memoryWords, outPath) {
    return StateIO.writeBytes(outPath, StateFormat.pack(manifest, memoryWords));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdExtract(inputPath, outputPath) {
    const parsed = readState(inputPath);
    const json = JSON.stringify(parsed.manifest, null, 2) + "\n";
    const out = outputPath || (path.basename(inputPath, ".state.zst") + ".manifest.json");
    fs.writeFileSync(out, json, "utf8");
    console.log("manifest extracted: " + path.relative(ROOT, out));
    console.log("  schemaVersion: " + (parsed.manifest.schemaVersion || "?"));
    console.log("  label: " + (parsed.manifest.label || "(none)"));
    console.log("  device: " + (parsed.manifest.device || "(none)"));
    console.log("  memoryWords: " + (parsed.memoryWords ? parsed.memoryWords.length + " words" : "none"));
}

function cmdReplace(inputPath, manifestPath, outputPath) {
    const parsed = readState(inputPath);
    const manifestJson = fs.readFileSync(manifestPath, "utf8");
    let newManifest;
    try {
        newManifest = JSON.parse(manifestJson);
    } catch (e) {
        throw new Error("invalid manifest JSON: " + e.message);
    }
    if (!newManifest || typeof newManifest !== "object") {
        throw new Error("manifest must be a JSON object");
    }
    if (!newManifest.schemaVersion || typeof newManifest.schemaVersion !== "number") {
        throw new Error("manifest must have a numeric schemaVersion");
    }
    // Preserve the original memoryWords (they are not in the manifest).
    const frame = writeState(newManifest, parsed.memoryWords, outputPath);
    console.log("manifest replaced: " + path.relative(ROOT, outputPath) +
        " (" + frame + ")");
    console.log("  schemaVersion: " + newManifest.schemaVersion);
    console.log("  label: " + (newManifest.label || "(none)"));
    console.log("  device: " + (newManifest.device || "(none)"));
    console.log("  steps: " + (newManifest.steps ? newManifest.steps.length + " step(s)" : "none"));
    console.log("  stepsMessage: " + (newManifest.stepsMessage ? JSON.stringify(newManifest.stepsMessage) : "none"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function usage() {
    console.error("Usage:");
    console.error("  node tools/state-manifest.js extract <input.state.zst> [output.json]");
    console.error("  node tools/state-manifest.js replace <input.state.zst> <manifest.json> <output.state.zst>");
    process.exit(2);
}

(function main() {
    const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const cmd = args[0];
    if (cmd === "extract" && args.length >= 2) {
        cmdExtract(args[1], args[2]);
    } else if (cmd === "replace" && args.length >= 4) {
        cmdReplace(args[1], args[2], args[3]);
    } else {
        usage();
    }
})();