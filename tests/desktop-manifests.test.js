#!/usr/bin/env node
/**
 * Tauri desktop build — manifest and state staging contract.
 *
 * The packaged app serves pdp11.html from desktop/ but ships the disk/tape
 * images as Tauri resources, so the page's two manifests (media/manifest.json,
 * states/manifest.json) and the pre-built states have to be STAGED, filtered by
 * what the chosen variant actually contains. Three things can silently break
 * the desktop UI, and none of them is visible in the browser suites:
 *
 *   1. media/manifest.json names images the variant does not ship (the wizard
 *      offers guests that cannot boot) or is stale relative to bundle.resources
 *      (an image mounted by the page but absent from the manifest).
 *   2. states/manifest.json advertises a state whose images are missing — the
 *      Scenario card is there, the restore fails.
 *   3. a state restore that pins an image version goes through
 *      VersionedMedia.load(), which used to fetch media/<image> over HTTP — a
 *      path that does not exist inside the desktop app. It must prefer bytes
 *      the machine already holds (the bundled resources are mounted at startup)
 *      when their SHA-256 matches the registered one.
 *
 * Run with:  node tests/desktop-manifests.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const DM = require(path.join(ROOT, "tools", "desktop-manifests.js"));
const MEDIA_MANIFEST = path.join(ROOT, "media", "manifest.json");
const STATES_DIR = path.join(ROOT, "states");
const STATE_MANIFEST = path.join(STATES_DIR, "manifest.json");
const CONFIGS = {
    minimal: path.join(ROOT, "src-tauri", "tauri.conf.minimal.json"),
    full: path.join(ROOT, "src-tauri", "tauri.conf.full.json")
};

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

// --- Minimal test harness ------------------------------------------------

const tests = [];
function defineTest(name, fn) {
    tests.push({ name: name, fn: fn });
}

// --- Inventory truth: bundle.resources ------------------------------------

function testShippedNames() {
    const minimal = DM.shippedNames(readJson(CONFIGS.minimal));
    const full = DM.shippedNames(readJson(CONFIGS.full));

    for (const name of ["rk0.dsk", "rk1.dsk", "bootcode.ptap", "DEC-11-AJPB-PB.ptap",
        "DEC-11-O2PA-PB.ptap", "ED-11-V004B-8K.ptap", "lander.ptap"]) {
        assert.ok(minimal.has(name), "minimal must ship " + name);
        assert.ok(full.has(name), "full must ship " + name);
    }
    // ".zst" is a transport detail: the logical name is what the page mounts.
    assert.ok(!Array.from(minimal).some((n) => /\.zst$/i.test(n)),
        "shippedNames must strip the .zst suffix (got " +
        Array.from(minimal).join(", ") + ")");
    for (const name of ["rl0.dsk", "rp1.dsk", "ra0.dsk", "tm0.tap"]) {
        assert.ok(!minimal.has(name), "minimal must NOT ship " + name);
        assert.ok(full.has(name), "full must ship " + name);
    }
    assert.ok(full.size > minimal.size,
        "the full installer must stay bigger than the minimal one");

    // The same resources map also carries the state tree and both variant
    // manifests. They ARE resources, but they are not images: a phantom
    // "states"/"manifest.json" name would make unlistedResources fail on a
    // payload the media manifest is not supposed to describe.
    for (const variant of ["minimal", "full"]) {
        const names = DM.shippedNames(readJson(CONFIGS[variant]));
        assert.ok(!names.has("states"),
            "shippedNames must ignore the staged states tree (" + variant + ")");
        assert.ok(!names.has("manifest.json"),
            "shippedNames must ignore the staged manifests (" + variant + ")");
    }
}

defineTest("shippedNames: bundle.resources -> logical image names", testShippedNames);

// --- media/manifest.json is in step with the installers -------------------

defineTest("unlistedResources: a payload the manifest does not describe",
    function () {
        const manifest = { media: ["rk0.dsk"], "media-versioned": { "rk1.dsk": {} } };
        const shipped = new Set(["rk0.dsk", "rk1.dsk", "bootcode.ptap", "new.dsk"]);
        assert.deepStrictEqual(DM.unlistedResources(manifest, shipped), ["new.dsk"],
            "a shipped payload missing from the manifest must be reported");
        // bootcode.ptap is deliberately excluded from the manifest: it is the
        // bootstrap loader, not a logical guest image (see gen-media-manifest).
        assert.ok(DM.NON_MANIFEST_PAYLOADS.has("bootcode.ptap"),
            "bootcode.ptap must stay the documented manifest exception");
    });

defineTest("unlistedResources: the committed manifest covers both variants",
    function () {
        const manifest = readJson(MEDIA_MANIFEST);
        for (const variant of ["minimal", "full"]) {
            const unlisted = DM.unlistedResources(manifest, DM.shippedNames(readJson(CONFIGS[variant])));
            assert.deepStrictEqual(unlisted, [],
                "tauri.conf." + variant + ".json ships payloads media/manifest.json " +
                "does not list — run: npm run manifest");
        }
    });

// --- The filtered media manifest -----------------------------------------

defineTest("filterMediaManifest: only shippable images, registry in step",
    function () {
        const manifest = readJson(MEDIA_MANIFEST);
        const shipped = DM.shippedNames(readJson(CONFIGS.minimal));
        const filtered = DM.filterMediaManifest(manifest, shipped);

        assert.ok(filtered.media.length > 0, "the minimal manifest must not be empty");
        for (const name of filtered.media) {
            assert.ok(shipped.has(name),
                "the minimal media manifest must not advertise " + name);
        }
        for (const name of ["rk2.dsk", "rk3.dsk", "rp1.dsk", "rl0.dsk", "tm0.tap"]) {
            assert.ok(filtered.media.indexOf(name) === -1,
                name + " is not shipped by minimal and must not be advertised");
        }
        const registry = filtered["media-versioned"];
        for (const name of Object.keys(registry)) {
            assert.ok(shipped.has(name),
                "the versioned registry must not name " + name +
                " (the app cannot fetch it)");
            assert.ok(registry[name] && registry[name].versions,
                "the filtered registry entry for " + name + " must keep its versions");
        }
        // The full variant keeps the whole media list.
        const fullFiltered = DM.filterMediaManifest(
            manifest, DM.shippedNames(readJson(CONFIGS.full)));
        assert.deepStrictEqual(fullFiltered.media, manifest.media,
            "the full variant ships every image, so its media list is the manifest's");
    });

// --- State policy --------------------------------------------------------

defineTest("filterStateEntries: policy trims, images decide the rest",
    function () {
        const entries = [
            { file: "rk0-ready.state.zst" },
            { file: "rk1-ready.state.zst" },
            { file: "rk1vt52-ready.state.zst" },
            { file: "rp1-ready.state.zst" }
        ];
        const mountedByFile = {
            "rk0-ready.state.zst": ["rk0.dsk"],
            "rk1-ready.state.zst": ["rk1.dsk"],
            "rk1vt52-ready.state.zst": ["rk1.dsk"],
            "rp1-ready.state.zst": ["rp1.dsk"]
        };
        const shipped = new Set(["rk0.dsk", "rk1.dsk", "bootcode.ptap"]);
        const policy = ["rk0-ready", "rp1-ready"];

        const filtered = DM.filterStateEntries(entries, mountedByFile, shipped, policy);
        assert.deepStrictEqual(filtered.kept.map((e) => e.file),
            ["rk0-ready.state.zst"],
            "only a state the policy names AND whose image is shipped may be kept");
        const reasons = filtered.skipped.map((s) => s.file + ": " + s.reason);
        assert.ok(reasons.some((r) => /rp1\.dsk/.test(r)),
            "a state whose image is not shipped must be skipped by image, not by policy");
        assert.ok(reasons.some((r) => r.indexOf("rk1-ready.state.zst: ") === 0),
            "a state the policy does not name must be skipped by policy");

        // No policy (the full build) keeps everything whose images are there.
        const all = DM.filterStateEntries(entries, mountedByFile, shipped, null);
        assert.deepStrictEqual(all.kept.map((e) => e.file),
            ["rk0-ready.state.zst", "rk1-ready.state.zst", "rk1vt52-ready.state.zst"]);
    });

defineTest("assertPolicyCovered: a policy naming an unshippable state fails",
    function () {
        const entries = [{ file: "rp1-ready.state.zst" }];
        const mountedByFile = { "rp1-ready.state.zst": ["rp1.dsk"] };
        const shipped = new Set(["rk0.dsk"]);
        assert.throws(
            () => DM.assertPolicyCovered(["rp1-ready"], entries, mountedByFile, shipped),
            /rp1\.dsk/,
            "the stage must fail loudly instead of dropping the card");
        assert.throws(
            () => DM.assertPolicyCovered(["nope-ready"], entries, mountedByFile, shipped),
            /no states\/nope-ready\.state\.zst/,
            "a policy entry without a state file must be reported");
    });

// --- The real state set --------------------------------------------------

defineTest("real states: minimal advertises the promised six, full keeps all",
    function () {
        const entries = readJson(STATE_MANIFEST);
        assert.ok(entries.length > 0, "states/manifest.json must list the states");

        const mountedByFile = {};
        for (const entry of entries) {
            mountedByFile[entry.file] = DM.readMounted(STATES_DIR, entry.file);
        }

        const minimal = DM.shippedNames(readJson(CONFIGS.minimal));
        const full = DM.shippedNames(readJson(CONFIGS.full));

        DM.assertPolicyCovered(DM.STATE_POLICY.minimal, entries, mountedByFile, minimal);
        const minFiltered = DM.filterStateEntries(entries, mountedByFile, minimal,
            DM.STATE_POLICY.minimal);
        assert.deepStrictEqual(minFiltered.kept.map((e) => e.file), [
            "basic-ready.state.zst",
            "lunar-lander.state.zst",
            "rk0-ready.state.zst",
            "rk1-ready.state.zst",
            "rk1tty-ready.state.zst",
            "rk1vt52-ready.state.zst"
        ], "the minimal installer advertises exactly the six promised states");

        // The LP11 showcase needs rk5.dsk, which minimal does not ship: it must
        // stay out of the minimal policy (its card would be an impossible
        // restore) and be skipped by IMAGE, not silently.
        const coguarSkip = minFiltered.skipped
            .filter((s) => s.file === "rt-11-print-coguar.state.zst")[0];
        assert.ok(coguarSkip, "rt-11-print-coguar must be skipped on minimal");
        assert.ok(/not advertised by this variant/.test(coguarSkip.reason),
            "it is skipped by policy; the image reason is pinned by the synthetic test");

        // Every preview a staged card names must exist next to the states: a
        // missing -full.png leaves the lightbox opening a 404.
        for (const entry of minFiltered.kept) {
            for (const key of ["screenshot", "screenshotFull"]) {
                const rel = entry[key];
                if (!rel) continue;
                assert.ok(fs.existsSync(path.join(STATES_DIR, rel)),
                    "states/" + rel + " is named by " + entry.file +
                    " but missing — run: npm run state-manifest");
            }
        }

        const fullFiltered = DM.filterStateEntries(entries, mountedByFile, full, null);
        assert.deepStrictEqual(fullFiltered.skipped, [],
            "the full installer ships every image, so every state must be stageable: " +
            JSON.stringify(fullFiltered.skipped));
        assert.strictEqual(fullFiltered.kept.length, entries.length,
            "the full variant must stage the whole state set");
    });

// --- VersionedMedia prefers bytes the machine already holds --------------

defineTest("VersionedMedia.load: mounted bytes with the right digest, no fetch",
    async function () {
        const ImageFingerprint = require(path.join(ROOT, "src", "imagefingerprint.js")).ImageFingerprint;
        const bytes = new Uint8Array([0x59, 0x41, 0x50, 0x44, 0x50, 0x01, 0x02, 0x03]);
        const sha256 = ImageFingerprint.ofBytes(bytes);
        const manifest = {
            media: ["rk0.dsk"],
            "media-versioned": {
                "rk0.dsk": { versions: { "1": { version: 1, sha256: sha256, url: "media/rk0.dsk" } } }
            }
        };
        const calls = [];
        const mounts = [];

        globalThis.fetch = function (url) {
            calls.push(String(url));
            if (String(url) === "media/manifest.json") {
                return Promise.resolve({ ok: true, json: function () { return Promise.resolve(manifest); } });
            }
            return Promise.reject(new Error("the desktop build has no HTTP path to " + url));
        };
        globalThis.ImageFingerprint = ImageFingerprint;
        globalThis.DataLoader = {
            has: function (name) { return name === "rk0.dsk"; },
            get: function (name) { return name === "rk0.dsk" ? bytes : undefined; },
            mount: function (name, data, source) { mounts.push({ name: name, source: source }); }
        };

        delete require.cache[require.resolve(path.join(ROOT, "src", "media-registry.js"))];
        const VersionedMedia = require(path.join(ROOT, "src", "media-registry.js")).VersionedMedia;

        const loaded = await VersionedMedia.load("rk0.dsk", 1, sha256);
        assert.strictEqual(loaded, bytes, "the mounted bytes are returned as they are");
        assert.deepStrictEqual(calls, ["media/manifest.json"],
            "no image fetch: the machine already holds the right bytes");
        assert.deepStrictEqual(mounts, [],
            "re-mounting would relabel bundled bytes as published");

        // Bytes that do NOT match the registered digest are never trusted: the
        // loader falls back to the network, which fails here — and that is the
        // correct answer for a desktop host.
        globalThis.DataLoader.get = function () { return new Uint8Array([0, 0, 0, 0]); };
        await assert.rejects(VersionedMedia.load("rk0.dsk", 1, sha256),
            /media\/rk0\.dsk/,
            "a wrong digest must not be accepted from local storage");
    });

// --- The bundle mounts only what the variant ships -----------------------

defineTest("tauri-bundled: the BUNDLED table is filtered by the staged manifest",
    function () {
        // The module is an IIFE that mounts images on DOMContentLoaded; in Node
        // it exposes its pure pieces and stops before mounting anything.
        globalThis.window = globalThis.window || {};
        const bundledPath = path.join(ROOT, "src", "tauri-bundled.js");
        delete require.cache[require.resolve(bundledPath)];
        require(bundledPath);
        const pure = globalThis.window.__yapdpBundledPure;
        assert.ok(pure && Array.isArray(pure.BUNDLED) && pure.BUNDLED.length,
            "src/tauri-bundled.js must expose its BUNDLED table for the contract test");

        // No staged manifest (an older build): every entry is attempted, as before.
        assert.strictEqual(pure.shippedItems(pure.BUNDLED, null).length,
            pure.BUNDLED.length,
            "without a manifest the loader keeps its old behaviour");

        const minimalMedia = DM.filterMediaManifest(readJson(MEDIA_MANIFEST),
            DM.shippedNames(readJson(CONFIGS.minimal))).media;
        const shipped = {};
        minimalMedia.forEach(function (name) { shipped[name] = true; });

        const kept = pure.shippedItems(pure.BUNDLED, shipped).map(function (item) {
            return item.url;
        });
        assert.ok(kept.indexOf("rk0.dsk") !== -1, "minimal ships rk0.dsk");
        assert.ok(kept.indexOf("rk1.dsk") !== -1, "minimal ships rk1.dsk");
        assert.ok(kept.indexOf("rk2.dsk") === -1,
            "the minimal installer must not ask for rk2.dsk: every absent image " +
            "was reported as a load error at startup");
        assert.ok(kept.indexOf("bootcode.ptap") !== -1,
            "the bootstrap loader is not in media/manifest.json and must survive " +
            "the filter");
        for (const url of kept) {
            assert.ok(shipped[url] === true || url === "bootcode.ptap",
                "the filter kept an image this variant does not ship: " + url);
        }
        // One resource per kept entry, and no duplicate logical url: the table
        // maps a logical image to exactly one file in the resource directory.
        const seen = {};
        for (const item of pure.shippedItems(pure.BUNDLED, shipped)) {
            assert.ok(!seen[item.url], "duplicate BUNDLED entry for " + item.url);
            seen[item.url] = true;
        }

        // The full variant ships everything the table knows about.
        const fullMedia = DM.filterMediaManifest(readJson(MEDIA_MANIFEST),
            DM.shippedNames(readJson(CONFIGS.full))).media;
        const fullShipped = {};
        fullMedia.forEach(function (name) { fullShipped[name] = true; });
        assert.strictEqual(pure.shippedItems(pure.BUNDLED, fullShipped).length,
            pure.BUNDLED.length,
            "the full installer must mount every bundled image");
    });

async function main() {
    let failed = 0;
    for (const test of tests) {
        try {
            await test.fn();
            console.log("ok   " + test.name);
        } catch (e) {
            failed += 1;
            console.error("FAIL " + test.name);
            console.error("     " + (e && e.message ? e.message : e));
        }
    }
    if (failed) {
        console.error("desktop-manifests: " + failed + " of " + tests.length + " test(s) failed");
        process.exit(1);
    }
    console.log("desktop-manifests: all tests passed");
}

main().catch(function (e) {
    console.error("desktop-manifests error:", e && e.message ? e.message : e);
    process.exit(1);
});
