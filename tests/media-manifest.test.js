#!/usr/bin/env node
/**
 * yaPDP media manifest tests.
 *
 * Verifies the generated registry against real media files and exercises
 * immutable-version and historical-entry behavior with temporary fixtures.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const crypto = require("crypto");
const MediaZst = require("../tools/media-zst.js");
const Generator = require("../tools/gen-media-manifest.js");

const ROOT = path.join(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const MANIFEST = path.join(MEDIA, "manifest.json");
const EXCLUDE = new Set(["bootcode.ptap", "bootcode.ptap.zst"]);
const IMAGE_RE = /^(.+)\.(dsk|tap|ptap)(\.zst)?$/;
const VERSION_RE = /^(.*)-v(\d+)$/;

function expectedCurrentImages() {
    const images = new Map();
    for (const file of fs.readdirSync(MEDIA).sort()) {
        if (EXCLUDE.has(file) || file.startsWith(".")) continue;
        const match = IMAGE_RE.exec(file);
        if (!match) continue;
        const stem = match[1];
        const extension = match[2];
        const versionMatch = VERSION_RE.exec(stem);
        const logicalName = `${versionMatch ? versionMatch[1] : stem}.${extension}`;
        const version = versionMatch ? Number(versionMatch[2]) : 1;
        const bytes = fs.readFileSync(path.join(MEDIA, file));
        const unpacked = match[3]
            ? Buffer.from(MediaZst.decompressBytes(bytes))
            : bytes;
        const sha256 = crypto.createHash("sha256").update(unpacked).digest("hex");
        const key = `${logicalName}@${version}`;
        assert.ok(!images.has(key), `duplicate physical image version: ${key}`);
        images.set(key, { logicalName, version, sha256, url: `media/${file}` });
    }
    return images;
}

function run() {
    // --- The committed registry must describe every image present locally.
    {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
        assert.ok(Array.isArray(manifest.media), 'manifest should carry "media"');
        assert.ok(manifest["media-versioned"] &&
            typeof manifest["media-versioned"] === "object",
        'manifest should carry "media-versioned"');

        const current = expectedCurrentImages();
        for (const [key, expected] of current) {
            const entry = manifest["media-versioned"][expected.logicalName];
            assert.ok(entry, `missing registry entry for ${expected.logicalName}`);
            const actual = entry.versions[String(expected.version)];
            assert.ok(actual, `missing registry version ${key}`);
            assert.deepStrictEqual(actual, {
                version: expected.version,
                sha256: expected.sha256,
                url: expected.url
            }, `registry mismatch for ${key}`);
        }

        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(manifest.media)),
            Object.keys(manifest["media-versioned"]).sort(),
            "legacy media list should be the sorted logical-name list"
        );
        assert.strictEqual(new Set(manifest.media).size, manifest.media.length,
            "manifest should not contain duplicate logical names");
    }

    // --- Existing published versions are immutable.
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-registry-"));
        try {
            const file = path.join(tmp, "rk1.dsk");
            const first = Buffer.from("original image bytes");
            const changed = Buffer.from("changed image bytes");
            fs.writeFileSync(file, first);
            const initial = Generator.buildManifest(tmp);
            fs.writeFileSync(file, changed);
            assert.throws(
                () => Generator.buildManifest(tmp, initial),
                /Published image is immutable: rk1\.dsk v1/,
                "regeneration must reject changed bytes under an existing version"
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // --- A duplicate physical file must not publish the same version twice.
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-registry-duplicate-"));
        try {
            fs.writeFileSync(path.join(tmp, "rk1.dsk"), "image");
            fs.writeFileSync(path.join(tmp, "rk1.dsk.zst"), "not decoded: duplicate detected first");
            assert.throws(
                () => Generator.buildManifest(tmp),
                /Duplicate publication version 1 for rk1\.dsk/,
                "raw and compressed copies must not silently compete for version 1"
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // --- Historical versions remain registered when their files move away.
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-registry-history-"));
        try {
            const v2 = Buffer.from("second published image");
            fs.writeFileSync(path.join(tmp, "rk1-v2.dsk"), v2);
            const v1 = Buffer.from("first published image");
            const previous = {
                "media-versioned": {
                    "rk1.dsk": {
                        versions: {
                            "1": {
                                version: 1,
                                sha256: crypto.createHash("sha256").update(v1).digest("hex"),
                                url: "https://archive.example/rk1.dsk.zst"
                            }
                        }
                    }
                }
            };
            const result = Generator.buildManifest(tmp, previous);
            assert.strictEqual(
                result["media-versioned"]["rk1.dsk"].versions["1"].url,
                "https://archive.example/rk1.dsk.zst",
                "a historical locator should survive when its local file is absent"
            );
            assert.strictEqual(
                result["media-versioned"]["rk1.dsk"].versions["2"].sha256,
                crypto.createHash("sha256").update(v2).digest("hex")
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // --- Existing OS boot scenarios still resolve through the legacy list.
    {
        const vm = require("vm");
        const sandbox = { console };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, "src", "osboot.js"), "utf8"),
            sandbox
        );
        const OSBoot = sandbox.OSBoot;
        const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
        const shipped = new Set(manifest.media);
        const missing = OSBoot.BOOT_SCENARIOS
            .filter((scenario) => !scenario.paperTape)
            .map((scenario) => scenario.url || OSBoot.urlFor(scenario.device))
            .filter((url) => !shipped.has(url));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(missing)), [],
            "every wizard disk/tape image should ship with the full repo");
    }

    console.log("media-manifest tests passed");
}

run();
