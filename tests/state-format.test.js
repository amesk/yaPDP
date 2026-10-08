#!/usr/bin/env node
/**
 * src/state-format.js versioning tests.
 *
 * Three versions travel with a state and answer different questions:
 *   - CONTAINER_VERSION (number) — the byte layout (header, manifest, memory);
 *   - schemaVersion (semver)     — the SHAPE of the manifest JSON readers
 *                                  branch on;
 *   - yaPDPVersion (semver)      — the app that wrote the state, for the
 *                                  "newer snapshot" warning.
 *
 * These tests pin: the normalisation of the legacy numeric schemaVersion, the
 * MAJOR branch, the semver comparison, and the compatibility rule (a newer
 * MAJOR/MINOR warns; equal, older, absent or unparsable does not). Pure — no
 * DOM, no fs.
 *
 * Run with:  node tests/state-format.test.js
 * Exit code 0 = all passed.
 */
"use strict";

const path = require("path");
const assert = require("assert");
const { StateFormat } = require(path.join(__dirname, "..", "src", "state-format.js"));

function run() {
    // ---- constants ------------------------------------------------------
    assert.strictEqual(typeof StateFormat.CONTAINER_VERSION, "number");
    assert.strictEqual(StateFormat.SCHEMA_VERSION, "1.0.0",
        "the current manifest schema is 1.0.0");

    // ---- parseSemver ----------------------------------------------------
    assert.deepStrictEqual(StateFormat.parseSemver("1.2.3"),
        { major: 1, minor: 2, patch: 3 });
    assert.deepStrictEqual(StateFormat.parseSemver(" 10.0.7 "),
        { major: 10, minor: 0, patch: 7 }, "surrounding spaces are ignored");
    assert.strictEqual(StateFormat.parseSemver("1.2"), null, "two parts is not semver");
    assert.strictEqual(StateFormat.parseSemver("v1.2.3"), null, "no v prefix");
    assert.strictEqual(StateFormat.parseSemver(1), null, "a bare number is not a string");
    assert.strictEqual(StateFormat.parseSemver(""), null);
    assert.strictEqual(StateFormat.parseSemver(null), null);

    // ---- compareSemver --------------------------------------------------
    const p = StateFormat.parseSemver;
    assert.ok(StateFormat.compareSemver(p("1.0.0"), p("1.0.1")) < 0, "patch orders");
    assert.ok(StateFormat.compareSemver(p("1.2.0"), p("1.1.9")) > 0, "minor orders");
    assert.ok(StateFormat.compareSemver(p("2.0.0"), p("1.9.9")) > 0, "major orders");
    assert.strictEqual(StateFormat.compareSemver(p("1.1.1"), p("1.1.1")), 0, "equal");

    // ---- normalizeSchemaVersion (legacy numeric -> semver) --------------
    assert.strictEqual(StateFormat.normalizeSchemaVersion({ schemaVersion: 1 }), "1.0.0",
        "the legacy bare 1 reads as 1.0.0");
    assert.strictEqual(StateFormat.normalizeSchemaVersion({ schemaVersion: 2 }), "2.0.0",
        "a numeric major becomes that major");
    assert.strictEqual(StateFormat.normalizeSchemaVersion({ schemaVersion: "1.1.0" }), "1.1.0");
    assert.strictEqual(StateFormat.normalizeSchemaVersion({ schemaVersion: " 1.2.3 " }), "1.2.3",
        "a string is trimmed");
    assert.strictEqual(StateFormat.normalizeSchemaVersion({}), "1.0.0",
        "a state with no field is the base schema");
    assert.strictEqual(StateFormat.normalizeSchemaVersion({ schemaVersion: "" }), "1.0.0");

    // ---- schemaMajor (the branch readers use) ---------------------------
    assert.strictEqual(StateFormat.schemaMajor({ schemaVersion: "1.0.0" }), 1);
    assert.strictEqual(StateFormat.schemaMajor({ schemaVersion: "1.7.2" }), 1);
    assert.strictEqual(StateFormat.schemaMajor({ schemaVersion: "2.0.0" }), 2,
        "2.x is the binary-overlay schema");
    assert.strictEqual(StateFormat.schemaMajor({ schemaVersion: 1 }), 1, "legacy number");
    assert.strictEqual(StateFormat.schemaMajor({}), 1, "absent -> base schema");
    assert.strictEqual(StateFormat.schemaMajor({ schemaVersion: "nonsense" }), 0,
        "an unparsable schema is major 0 (refused by readers)");

    // ---- checkVersionCompatibility --------------------------------------
    const CUR = "0.4.0";
    const cases = [
        ["no yaPDPVersion", {}, true],
        ["newer MAJOR", { yaPDPVersion: "1.0.0" }, false],
        ["newer MINOR", { yaPDPVersion: "0.5.0" }, false],
        ["same version", { yaPDPVersion: "0.4.0" }, true],
        ["newer PATCH only", { yaPDPVersion: "0.4.1" }, true],
        ["older MINOR", { yaPDPVersion: "0.3.9" }, true],
        ["older MAJOR", { yaPDPVersion: "0.0.1" }, true],
        ["unparsable", { yaPDPVersion: "abc" }, true],
    ];
    for (const [label, manifest, compatible] of cases) {
        const r = StateFormat.checkVersionCompatibility(manifest, CUR);
        assert.strictEqual(r.compatible, compatible, "compatibility: " + label);
        if (!compatible) {
            assert.strictEqual(r.warning.type, "newer_version", "warning type: " + label);
            assert.strictEqual(r.warning.snapshotVersion, manifest.yaPDPVersion,
                "warning names the snapshot version: " + label);
            assert.strictEqual(r.warning.currentVersion, CUR,
                "warning names the current version: " + label);
        } else {
            assert.strictEqual(r.warning, null, "no warning: " + label);
        }
    }
    // An unparsable CURRENT version cannot judge anything: do not warn.
    assert.strictEqual(
        StateFormat.checkVersionCompatibility({ yaPDPVersion: "9.9.9" }, "dev").compatible,
        true, "an unknown current version never warns");

    // ---- round trip: the new manifest shape survives pack/unpack --------
    const manifest = {
        schemaVersion: StateFormat.SCHEMA_VERSION,
        yaPDPVersion: CUR,
        label: "round trip",
        device: "rk1",
    };
    const words = new Uint16Array(8);
    for (let i = 0; i < words.length; i++) words[i] = (i * 5) & 0xffff;
    const packed = StateFormat.pack(manifest, words);
    const parsed = StateFormat.unpack(packed);
    assert.ok(parsed, "unpack returns the container");
    assert.strictEqual(parsed.manifest.schemaVersion, "1.0.0");
    assert.strictEqual(parsed.manifest.yaPDPVersion, CUR);
    assert.strictEqual(StateFormat.schemaMajor(parsed.manifest), 1);
    assert.strictEqual(
        StateFormat.checkVersionCompatibility(parsed.manifest, CUR).compatible, true,
        "a state this build can read is compatible");

    console.log("All StateFormat versioning tests passed.");
}

run();
