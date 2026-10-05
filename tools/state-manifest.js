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
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readState(path) {
    const raw = fs.readFileSync(path);
    // Try zstd decompression first.
    let container = null;
    if (typeof zlib.zstdDecompressSync === "function") {
        try {
            container = zlib.zstdDecompressSync(raw);
        } catch (e) { /* not zstd */ }
    }
    if (!container) {
        // Try as uncompressed container.
        if (StateFormat.isContainer(new Uint8Array(raw))) {
            container = new Uint8Array(raw);
        } else {
            throw new Error("not a .state.zst file (not zstd, not a container)");
        }
    }
    const parsed = StateFormat.unpack(container);
    if (!parsed) throw new Error("could not unpack the container");
    return parsed;
}

function writeState(manifest, memoryWords, outPath) {
    const packed = StateFormat.pack(manifest, memoryWords);
    let compressed = packed;
    if (typeof zlib.zstdCompressSync === "function") {
        compressed = zlib.zstdCompressSync(packed, { level: 19 });
    }
    fs.writeFileSync(outPath, compressed);
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
    writeState(newManifest, parsed.memoryWords, outputPath);
    console.log("manifest replaced: " + path.relative(ROOT, outputPath));
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