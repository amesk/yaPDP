#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { ImageFingerprint } = require("../src/imagefingerprint.js");

const payload = new Uint8Array([0x50, 0x44, 0x50, 0x31, 0x31]);
const sha256 = ImageFingerprint.ofBytes(payload);
const mounted = new Map();
global.ImageFingerprint = ImageFingerprint;
global.DataLoader = {
    mount: (name, bytes) => mounted.set(name, bytes),
    get: (name) => mounted.get(name)
};

const manifest = {
    "media-versioned": {
        "rk1.dsk": {
            versions: {
                "1": {
                    version: 1,
                    sha256,
                    url: "media/rk1.dsk"
                }
            }
        }
    }
};

global.fetch = async (url) => {
    if (url === "media/manifest.json") {
        return { ok: true, json: async () => manifest };
    }
    if (url === "media/rk1.dsk") {
        return {
            ok: true,
            arrayBuffer: async () => payload.slice().buffer
        };
    }
    return { ok: false, status: 404 };
};

const { VersionedMedia } = require("../src/media-registry.js");

async function run() {
    const identity = await VersionedMedia.identify("rk1.dsk", sha256);
    assert.deepStrictEqual(identity, { version: 1, sha256 });

    const resolved = await VersionedMedia.resolve("rk1.dsk", 1);
    assert.strictEqual(resolved.url, "media/rk1.dsk");

    const bytes = await VersionedMedia.load("rk1.dsk", 1, sha256);
    assert.deepStrictEqual(Array.from(bytes), Array.from(payload));
    assert.deepStrictEqual(Array.from(mounted.get("rk1.dsk")), Array.from(payload));

    await assert.rejects(
        () => VersionedMedia.load("rk1.dsk", 1, "0".repeat(64)),
        /Registered SHA-256 changed/
    );
    await assert.rejects(
        () => VersionedMedia.load("rk1.dsk", 9),
        /Image version is not registered/
    );

    console.log("media-registry tests passed");
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
