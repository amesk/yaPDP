#!/usr/bin/env node
/**
 * Migration tests for tools/convert-state-format.js.
 *
 * Run with: node tests/state-format-migration.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { StateFormat } = require(path.join(__dirname, "..", "src", "state-format.js"));
const StateIO = require(path.join(__dirname, "..", "tools", "state-io.js"));
const { convertOne, fnv1a32, sha256 } = require(path.join(__dirname, "..", "tools", "convert-state-format.js"));

function testLegacyImageFingerprintMigration(dir) {
    const mediaDir = path.join(dir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const imageBytes = Buffer.from("fixture compressed image payload");
    fs.writeFileSync(path.join(mediaDir, "rk1.dsk.zst"), imageBytes);

    const oldFingerprint = fnv1a32(imageBytes);
    const file = path.join(dir, "canonical-with-legacy-fingerprint.state.zst");
    const words = Uint16Array.from([0x1111, 0x2222, 0x3333]);
    const manifest = {
        schemaVersion: "1.0.0",
        yaPDPVersion: "0.3.0",
        label: "fingerprint migration test",
        mounted: ["rk1.dsk"],
        imageFingerprints: { "rk1.dsk": oldFingerprint },
        overlay: {
            "rk1.dsk": {
                v: oldFingerprint,
                origin: "snapshot",
                blocks: { "0": [1, 2, 3, 4] }
            }
        }
    };
    StateIO.writeBytes(file, StateFormat.pack(manifest, words));

    const dryRun = convertOne(file, false, dir);
    assert.strictEqual(dryRun.migratedIdentities, 2,
        "dry run identifies both snapshot and overlay fingerprints");
    const afterDryRun = StateIO.readBytes(file);
    const beforeParse = StateFormat.unpack(afterDryRun.container);
    assert.strictEqual(beforeParse.manifest.imageFingerprints["rk1.dsk"], oldFingerprint,
        "dry run does not mutate a canonical state");

    const converted = convertOne(file, true, dir);
    assert.strictEqual(converted.migratedIdentities, 2);
    const parsed = StateFormat.unpack(StateIO.readBytes(file).container);
    const expectedFingerprint = sha256(imageBytes);
    assert.strictEqual(parsed.manifest.imageFingerprints["rk1.dsk"], expectedFingerprint,
        "snapshot image identity becomes SHA-256 of verified image bytes");
    assert.strictEqual(parsed.manifest.overlay["rk1.dsk"].v, expectedFingerprint,
        "disk overlay identity is migrated with the same verified image");
    assert.deepStrictEqual(Array.from(parsed.memoryWords), Array.from(words),
        "identity migration preserves RAM");
    assert.deepStrictEqual(Array.from(parsed.manifest.overlay["rk1.dsk"].blocks["0"]),
        [1, 2, 3, 4], "identity migration preserves overlay blocks");

    const secondPass = convertOne(file, true, dir);
    assert.strictEqual(secondPass.skipped, true,
        "canonical state with migrated identities is idempotent");

    const badFile = path.join(dir, "unverifiable-fingerprint.state.zst");
    const badManifest = {
        schemaVersion: "1.0.0",
        imageFingerprints: { "rk1.dsk": "00000000" }
    };
    StateIO.writeBytes(badFile, StateFormat.pack(badManifest, words));
    const originalBytes = Array.from(StateIO.readBytes(badFile).container);
    assert.throws(() => convertOne(badFile, true, dir), /cannot safely migrate image fingerprint/,
        "a legacy fingerprint must match the actual image before conversion");
    assert.deepStrictEqual(Array.from(StateIO.readBytes(badFile).container), originalBytes,
        "an unverifiable fingerprint leaves the original file unchanged");
}

function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yapdp-state-migration-"));
    const file = path.join(dir, "legacy.state.zst");
    const words = Uint16Array.from([0, 1, 0x1234, 0xffff]);
    const manifest = {
        schemaVersion: 1,
        yaPDPVersion: "0.3.0",
        label: "migration test",
        device: "rk1",
    };

    try {
        StateIO.writeBytes(file, StateFormat.packLegacy(manifest, words));
        const before = StateIO.readBytes(file);
        const beforeRaw = before.container.slice();

        const dryRun = convertOne(file, false);
        assert.strictEqual(dryRun.converted, true);
        assert.deepStrictEqual(Array.from(StateIO.readBytes(file).container), Array.from(beforeRaw),
            "dry run leaves the source bytes unchanged");

        const converted = convertOne(file, true);
        assert.strictEqual(converted.converted, true);
        const read = StateIO.readBytes(file);
        const parsed = StateFormat.unpack(read.container);
        assert.ok(parsed, "converted file can be read");
        assert.deepStrictEqual(Array.from(parsed.memoryWords), Array.from(words),
            "RAM is preserved by migration");
        assert.strictEqual(parsed.manifest.label, manifest.label);
        assert.strictEqual(parsed.manifest.device, manifest.device);

        const manifestLength = read.container[8] | (read.container[9] << 8) |
            (read.container[10] << 16) | (read.container[11] << 24);
        const storedManifest = JSON.parse(new TextDecoder().decode(
            read.container.subarray(12, 12 + manifestLength)));
        assert.strictEqual(storedManifest.containerVersion, 1);
        assert.ok(Array.isArray(storedManifest.blobCatalog));

        const secondPass = convertOne(file, true);
        assert.strictEqual(secondPass.skipped, true,
            "running the migration twice is idempotent");
        testLegacyImageFingerprintMigration(dir);
        console.log("All state-format migration tests passed.");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

run();
