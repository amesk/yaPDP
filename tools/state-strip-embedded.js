#!/usr/bin/env node
/**
 * state-strip-embedded.js — turn a self-contained .state.zst into a normal
 * (published base + overlay) state.
 *
 * A self-contained state carries whole disk images inside the container. That is
 * what makes it portable and what makes it big. When the image is a published
 * one (media/manifest.json), the same machine can be described in a fraction of
 * the size: reference the published version, keep the block overlay.
 *
 * The proof this tool insists on is byte equality: mounting the published base,
 * applying the state's overlay block by block, must reproduce the embedded image
 * exactly. If it does not, nothing is written — a "light" state that restores a
 * different disk is worse than a big one that restores the right one.
 *
 * What changes in the manifest:
 *   - embeddedImages[url]              removed (no image bytes in the container)
 *   - imageFingerprints[url]           := digest of the published base
 *   - imageVersions[url]               := { version, sha256 } from the registry
 *   - imageSources[url]                := "published"
 *   - overlay[url].v                   := digest of the published base
 *
 * Usage:
 *   node tools/state-strip-embedded.js <self-contained.state.zst> [--out <file>] [--dry-run]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const StateIO = require(path.join(ROOT, "tools", "state-io.js"));
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));

// The overlay block granularity the emulator writes (src/iopage.js IO_BLOCKSIZE).
const BLOCK = 131072;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function readImage(file) {
    const raw = fs.readFileSync(file);
    if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
        return Buffer.from(zlib.zstdDecompressSync(raw));
    }
    if (raw[0] === 0x1f && raw[1] === 0x8b) return zlib.gunzipSync(raw);
    return raw;
}

function registryEntry(url) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "media", "manifest.json"), "utf8"));
    const versioned = manifest["media-versioned"] || {};
    const logical = versioned[url];
    if (!logical || !logical.versions) return null;
    return logical;
}

// The published version whose bytes are exactly `digest`, or null.
function publishedVersion(url, digest) {
    const logical = registryEntry(url);
    if (!logical) return null;
    const keys = Object.keys(logical.versions);
    for (const key of keys) {
        const entry = logical.versions[key];
        if (entry && entry.sha256 === digest && entry.url) {
            return { version: entry.version != null ? entry.version : Number(key), entry };
        }
    }
    return null;
}

function defaultOut(file) {
    return /\.state\.zst$/i.test(file)
        ? file.replace(/\.state\.zst$/i, ".light.state.zst")
        : file + ".light.state.zst";
}

function applyOverlay(base, rec) {
    const out = Buffer.from(base);
    Object.keys(rec.blocks || {}).forEach(function (key) {
        const blockNo = Number(key);
        const bytes = Buffer.from(rec.blocks[key]);
        bytes.copy(out, blockNo * BLOCK, 0, Math.min(bytes.length, BLOCK));
    });
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.indexOf("--dry-run") !== -1;
    const outIndex = argv.indexOf("--out");
    const outArg = outIndex !== -1 ? argv[outIndex + 1] : null;
    const positional = argv.filter((a, i) =>
        a !== "--dry-run" && (outIndex === -1 || (i !== outIndex && i !== outIndex + 1)));
    const input = positional[0];
    if (!input) {
        console.error("usage: node tools/state-strip-embedded.js <self-contained.state.zst> " +
            "[--out <file>] [--dry-run]");
        process.exit(2);
    }

    const parsed = StateFormat.unpack(StateIO.readBytes(input).container);
    if (!parsed) {
        console.error("the input does not unpack — repair it first");
        process.exit(3);
    }
    const manifest = parsed.manifest;
    const embedded = manifest.embeddedImages || {};
    const urls = Object.keys(embedded);
    if (!urls.length) {
        console.log("nothing to strip: this state embeds no images");
        process.exit(0);
    }

    const built = [];
    for (const url of urls) {
        const image = parsed.blobs[embedded[url]];
        if (!image) {
            console.error("embedded blob missing for " + url + " — repair the state first");
            process.exit(4);
        }
        const imageBytes = Buffer.from(image);
        const imageDigest = sha256(imageBytes);

        const logical = registryEntry(url);
        if (!logical) {
            console.error(url + ": not in media/manifest.json — cannot reference a published base");
            process.exit(4);
        }

        // Which published version reproduces this image once the overlay is applied?
        const overlay = manifest.overlay && manifest.overlay[url];
        if (!overlay || !overlay.blocks || !Object.keys(overlay.blocks).length) {
            console.error(url + ": the state has no overlay, so the image is already the base; " +
                "look for the published version with digest " + imageDigest);
            const exact = publishedVersion(url, imageDigest);
            if (!exact) process.exit(4);
            built.push({ url, base: imageBytes, bytes: imageBytes, digest: imageDigest,
                version: exact.version, overlay: { v: imageDigest, blocks: {} } });
            continue;
        }

        let chosen = null;
        for (const key of Object.keys(logical.versions)) {
            const entry = logical.versions[key];
            if (!entry || !entry.url) continue;
            let base;
            try {
                base = readImage(path.join(ROOT, entry.url));
            } catch (e) {
                continue;
            }
            if (base.length !== imageBytes.length) continue;
            const rebuilt = applyOverlay(base, overlay);
            if (!rebuilt.equals(imageBytes)) continue;
            chosen = { entry, base, digest: sha256(base) };
            break;
        }
        if (!chosen) {
            console.error(url + ": no published version reproduces the embedded image through this " +
                "overlay — refusing to write a state that restores a different disk");
            process.exit(4);
        }
        console.log(url + ": published v" + chosen.entry.version + " (" +
            chosen.digest.slice(0, 16) + ") + " +
            Object.keys(overlay.blocks).length + " blocks == embedded image (" +
            imageDigest.slice(0, 16) + ")");
        built.push({ url, base: chosen.base, bytes: imageBytes, digest: chosen.digest,
            version: chosen.entry.version, overlay });
    }

    // All checks hold: rewrite the manifest and drop the image blobs.
    const imageBlobIds = new Set(urls.map((u) => embedded[u]));
    const extraBlobs = (parsed.blobCatalog || [])
        .filter((item) => !imageBlobIds.has(item.id) &&
            item.id !== "memory" && item.id !== "disk-overlay")
        .map((item) => ({ id: item.id, mediaType: item.mediaType, bytes: parsed.blobs[item.id] }));

    const fingerprints = Object.assign({}, manifest.imageFingerprints || {});
    const versions = Object.assign({}, manifest.imageVersions || {});
    const sources = Object.assign({}, manifest.imageSources || {});
    const overlayOut = Object.assign({}, manifest.overlay || {});
    built.forEach(function (item) {
        fingerprints[item.url] = item.digest;
        versions[item.url] = { version: item.version, sha256: item.digest };
        sources[item.url] = "published";
        overlayOut[item.url] = Object.assign({}, item.overlay, { v: item.digest });
        delete manifest.embeddedImages[item.url];
    });
    if (!Object.keys(manifest.embeddedImages).length) delete manifest.embeddedImages;
    manifest.imageFingerprints = fingerprints;
    manifest.imageVersions = versions;
    manifest.imageSources = sources;
    manifest.overlay = overlayOut;

    const container = StateFormat.pack(manifest, parsed.memoryWords, extraBlobs);
    const check = StateFormat.unpack(container);
    if (!check) {
        console.error("validation failed: the stripped container does not unpack");
        process.exit(5);
    }
    built.forEach(function (item) {
        const rebuilt = applyOverlay(Buffer.from(item.base), check.manifest.overlay[item.url]);
        if (!rebuilt.equals(Buffer.from(item.bytes))) {
            console.error("validation failed: " + item.url + " does not round-trip");
            process.exit(5);
        }
    });

    const inBytes = fs.statSync(input).size;
    if (dryRun) {
        console.log("dry run: " + input + " -> " + (outArg || defaultOut(input)) +
            " (input " + inBytes + " B)");
        console.log("validated: base + overlay reproduces every embedded image byte-for-byte");
        return;
    }

    const out = outArg || defaultOut(input);
    const frame = StateIO.writeBytes(out, container);
    console.log("written: " + out + " (" + frame + ", " + fs.statSync(out).size + " B, was " +
        inBytes + " B)");
    console.log("validated: base + overlay reproduces every embedded image byte-for-byte");
    console.log("imageVersions: " + JSON.stringify(check.manifest.imageVersions));
    console.log("imageSources: " + JSON.stringify(check.manifest.imageSources));
    console.log("overlay v: " + JSON.stringify(Object.keys(check.manifest.overlay || {})
        .map((u) => check.manifest.overlay[u].v)));
}

main();
