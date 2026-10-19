/**
 * Convert existing .state.zst files to the canonical container format.
 *
 * Dry-run by default:
 *   node tools/convert-state-format.js
 *   node tools/convert-state-format.js states/example.state.zst
 *
 * Apply after reviewing the report:
 *   node tools/convert-state-format.js --write
 *   node tools/convert-state-format.js --write states/example.state.zst
 *
 * The writer first creates and validates a temporary file. Existing files are
 * replaced only after the converted state can be read back successfully.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { StateFormat } = require(path.join(__dirname, "..", "src", "state-format.js"));
const StateIO = require("./state-io.js");

const ROOT = path.resolve(__dirname, "..");

function listStates(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listStates(full);
        return entry.isFile() && entry.name.endsWith(".state.zst") ? [full] : [];
    });
}

function rawManifest(container) {
    if (!StateFormat.isContainer(container) || container.length < StateFormat.HEADER_LEN) {
        throw new Error("not a state container");
    }
    const length = (container[8] | (container[9] << 8) |
        (container[10] << 16) | (container[11] << 24)) >>> 0;
    if (12 + length > container.length) throw new Error("truncated state manifest");
    return JSON.parse(new TextDecoder().decode(container.subarray(12, 12 + length)));
}

function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function stableValue(value) {
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        const out = {};
        Object.keys(value).sort().forEach((key) => { out[key] = stableValue(value[key]); });
        return out;
    }
    return value;
}

function equalJson(a, b) {
    return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function buildCanonical(parsed) {
    const extras = [];
    for (const descriptor of (parsed.blobCatalog || [])) {
        if (descriptor.id === "memory" || descriptor.id === "disk-overlay") continue;
        const bytes = parsed.blobs && parsed.blobs[descriptor.id];
        if (!bytes) throw new Error("missing payload for blob: " + descriptor.id);
        extras.push({
            id: descriptor.id,
            mediaType: descriptor.mediaType,
            bytes,
        });
    }
    return StateFormat.pack(parsed.manifest, parsed.memoryWords, extras);
}

function verifyConversion(original, converted, expected) {
    const actual = StateFormat.unpack(converted);
    if (!actual) throw new Error("converted output cannot be unpacked");
    if (!equalJson(expected.manifest, actual.manifest)) {
        throw new Error("manifest changed during conversion");
    }
    if (!!expected.memoryWords !== !!actual.memoryWords ||
        (expected.memoryWords && !equalBytes(
            StateFormat.memoryToBytes(expected.memoryWords),
            StateFormat.memoryToBytes(actual.memoryWords)))) {
        throw new Error("RAM changed during conversion");
    }
    for (const descriptor of (expected.blobCatalog || [])) {
        if (descriptor.id === "memory" || descriptor.id === "disk-overlay") continue;
        if (!actual.blobs || !equalBytes(expected.blobs[descriptor.id], actual.blobs[descriptor.id])) {
            throw new Error("blob changed during conversion: " + descriptor.id);
        }
    }
    const headerManifest = rawManifest(converted);
    if (headerManifest.containerVersion !== 1 || !Array.isArray(headerManifest.blobCatalog)) {
        throw new Error("writer did not produce canonical container version 1");
    }
    if (original.length === 0) throw new Error("empty input");
    return actual;
}

function replaceVerified(file, bytes) {
    const temp = file + ".convert-tmp";
    const backup = file + ".convert-backup";
    if (fs.existsSync(temp) || fs.existsSync(backup)) {
        throw new Error("temporary or backup file already exists; refusing to overwrite it");
    }
    try {
        StateIO.writeBytes(temp, bytes);
        const written = StateIO.readBytes(temp);
        const parsed = StateFormat.unpack(written.container);
        if (!parsed) throw new Error("temporary output failed container validation");

        // On Windows rename-over-existing is not portable. Move the original
        // aside, install the verified temporary, then remove the backup.
        fs.renameSync(file, backup);
        try {
            fs.renameSync(temp, file);
            fs.unlinkSync(backup);
        } catch (e) {
            if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file);
            throw e;
        }
    } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
}

function convertOne(file, write) {
    const absolute = path.resolve(file);
    const input = StateIO.readBytes(absolute);
    const manifest = rawManifest(input.container);
    const alreadyCanonical = manifest.containerVersion === 1 &&
        Array.isArray(manifest.blobCatalog);
    if (alreadyCanonical) {
        console.log("SKIP  " + path.relative(ROOT, absolute) + " (already canonical)");
        return { skipped: true };
    }

    const parsed = StateFormat.unpack(input.container);
    if (!parsed) throw new Error("cannot parse source container");
    const packed = buildCanonical(parsed);
    verifyConversion(input.container, packed, parsed);

    if (write) {
        replaceVerified(absolute, packed);
        // Verify the framed file after replacement as well.
        const reread = StateIO.readBytes(absolute);
        const header = rawManifest(reread.container);
        if (header.containerVersion !== 1) {
            throw new Error("replaced file is not canonical after re-read");
        }
        console.log("OK    " + path.relative(ROOT, absolute) +
            " (" + input.size + " -> " + fs.statSync(absolute).size + " bytes)");
    } else {
        console.log("READY " + path.relative(ROOT, absolute) +
            " (" + input.size + " bytes; dry run, unchanged)");
    }
    return { converted: true };
}

function usage() {
    console.log("Usage: node tools/convert-state-format.js [--write] [file.state.zst ...]");
    console.log("Without file arguments, scans states/ recursively. Default is a dry run.");
}

function main() {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    if (args.includes("--help") || args.includes("-h")) {
        usage();
        return;
    }
    const files = args.filter((arg) => !arg.startsWith("--"));
    const targets = files.length ? files.map((file) => path.resolve(file)) : listStates(path.join(ROOT, "states"));
    if (!targets.length) {
        console.log("No .state.zst files found.");
        return;
    }

    let converted = 0;
    let skipped = 0;
    let failed = 0;
    for (const file of targets) {
        try {
            const result = convertOne(file, write);
            if (result.skipped) skipped++;
            else if (result.converted) converted++;
        } catch (e) {
            failed++;
            console.error("FAIL  " + path.relative(ROOT, file) + ": " + e.message);
        }
    }
    console.log("Summary: " + converted + " converted, " + skipped +
        " already canonical, " + failed + " failed" + (write ? "" : " (dry run)"));
    if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { buildCanonical, verifyConversion, convertOne };
