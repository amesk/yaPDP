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
const { convertOne } = require(path.join(__dirname, "..", "tools", "convert-state-format.js"));

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
        console.log("All state-format migration tests passed.");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

run();
