#!/usr/bin/env node
/**
 * yaPDP — Build-manifest generator.
 *
 * Generates the compatible logical-media list and the versioned image
 * registry. Image identity is SHA-256 of decompressed bytes.
 *
 * Run: node tools/gen-media-manifest.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const MediaZst = require("./media-zst.js");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(MEDIA, "manifest.json");

const EXCLUDE = new Set(["bootcode.ptap", "bootcode.ptap.zst"]);
const IMAGE_RE = /^(.+)\.(dsk|tap|ptap)(\.zst)?$/;
const VERSION_RE = /^(.*)-v(\d+)$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function parseImageFile(file) {
    if (EXCLUDE.has(file) || file.startsWith(".")) return null;

    const match = IMAGE_RE.exec(file);
    if (!match) return null;

    const stem = match[1];
    const extension = match[2];
    const versionMatch = VERSION_RE.exec(stem);
    let logicalStem = stem;
    let version = 1;

    if (versionMatch) {
        logicalStem = versionMatch[1];
        version = Number(versionMatch[2]);
        if (!logicalStem || !Number.isSafeInteger(version) || version < 2) {
            throw new Error(`Invalid versioned image filename: ${file}`);
        }
    }

    return {
        file,
        logicalName: `${logicalStem}.${extension}`,
        version,
        compressed: Boolean(match[3])
    };
}

function imageDigest(mediaDir, image) {
    const storedBytes = fs.readFileSync(path.join(mediaDir, image.file));
    const bytes = image.compressed
        ? Buffer.from(MediaZst.decompressBytes(storedBytes))
        : storedBytes;
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function cloneRegistry(registry) {
    const copy = {};
    for (const [logicalName, entry] of Object.entries(registry || {})) {
        if (!entry || !entry.versions || typeof entry.versions !== "object") {
            throw new Error(`Invalid registry entry for ${logicalName}`);
        }
        copy[logicalName] = { versions: {} };
        for (const [key, value] of Object.entries(entry.versions)) {
            const version = Number(key);
            if (!Number.isSafeInteger(version) || version < 1 ||
                !value || value.version !== version ||
                !DIGEST_RE.test(value.sha256 || "") ||
                typeof value.url !== "string" || !value.url) {
                throw new Error(`Invalid registry version ${logicalName} v${key}`);
            }
            copy[logicalName].versions[key] = { ...value };
        }
    }
    return copy;
}

function buildManifest(mediaDir = MEDIA, previousManifest = null) {
    const images = fs.readdirSync(mediaDir)
        .sort()
        .map(parseImageFile)
        .filter(Boolean);
    const currentByName = new Map();

    for (const image of images) {
        let versions = currentByName.get(image.logicalName);
        if (!versions) {
            versions = new Map();
            currentByName.set(image.logicalName, versions);
        }
        if (versions.has(image.version)) {
            throw new Error(
                `Duplicate publication version ${image.version} for ${image.logicalName}: ` +
                `${versions.get(image.version).file} and ${image.file}`
            );
        }
        versions.set(image.version, image);
    }

    const previousRegistry = previousManifest &&
        previousManifest["media-versioned"] || {};
    const registry = cloneRegistry(previousRegistry);

    for (const [logicalName, versions] of currentByName) {
        if (!registry[logicalName]) registry[logicalName] = { versions: {} };

        for (const [number, image] of versions) {
            const key = String(number);
            const sha256 = imageDigest(mediaDir, image);
            const previous = registry[logicalName].versions[key];

            if (previous && previous.sha256 !== sha256) {
                throw new Error(
                    `Published image is immutable: ${logicalName} v${number} ` +
                    `has SHA-256 ${previous.sha256}, but ${image.file} has ${sha256}. ` +
                    `Publish changed bytes under a new version number.`
                );
            }

            registry[logicalName].versions[key] = {
                version: number,
                sha256,
                url: `media/${image.file}`
            };
        }
    }

    for (const [logicalName, entry] of Object.entries(registry)) {
        if (!entry.versions["1"]) {
            throw new Error(
                `Missing version 1 for ${logicalName}; ` +
                "the original unversioned image or its published registry entry must be retained"
            );
        }
    }

    const media = Object.keys(registry).sort();
    const sortedRegistry = {};
    for (const logicalName of media) {
        const versions = registry[logicalName].versions;
        const sortedVersions = {};
        for (const key of Object.keys(versions).sort((a, b) => Number(a) - Number(b))) {
            sortedVersions[key] = versions[key];
        }
        sortedRegistry[logicalName] = { versions: sortedVersions };
    }

    return { media, "media-versioned": sortedRegistry };
}

function main() {
    const previousManifest = fs.existsSync(OUT)
        ? JSON.parse(fs.readFileSync(OUT, "utf8"))
        : null;
    const manifest = buildManifest(MEDIA, previousManifest);
    fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
        `media/manifest.json: ${manifest.media.length} logical images -> ${OUT}`
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(
            `gen-media-manifest: ${error && error.message ? error.message : error}`
        );
        process.exitCode = 1;
    }
}

module.exports = { parseImageFile, imageDigest, buildManifest };
