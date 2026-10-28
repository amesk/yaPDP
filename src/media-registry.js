/*
 * Versioned media registry for immutable base disk/tape images.
 *
 * Registry hashes describe decompressed bytes. A snapshot can therefore pin
 * an image version independently of the compression used to distribute it.
 */
"use strict";

(function (global) {
    var manifestPromise = null;

    // The manifest is a bundled resource in the desktop build and a plain file
    // on the site, so it is read through BundledFs (src/tauri-bundled.js) when
    // that is present — the packaged app has no HTTP path to media/ at all.
    function loadManifest() {
        if (global.BundledFs && typeof global.BundledFs.manifest === "function") {
            return global.BundledFs.manifest("media/manifest.json").then(function (data) {
                if (!data) throw new Error("Cannot load media manifest");
                return data;
            });
        }
        return fetch("media/manifest.json").then(function (response) {
            if (!response.ok) throw new Error("Cannot load media manifest");
            return response.json();
        });
    }

    function manifest() {
        if (!manifestPromise) {
            manifestPromise = loadManifest().catch(function (err) {
                manifestPromise = null;
                throw err;
            });
        }
        return manifestPromise;
    }

    function entryFor(name, version, data) {
        var item = data && data["media-versioned"] &&
            data["media-versioned"][name];
        if (!item || !item.versions) return null;
        if (version != null) return item.versions[String(version)] || null;
        var versions = Object.keys(item.versions).map(function (key) {
            return item.versions[key];
        });
        return versions.sort(function (a, b) { return b.version - a.version; })[0] || null;
    }

    function identify(name, sha256) {
        return manifest().then(function (data) {
            var item = data["media-versioned"] && data["media-versioned"][name];
            if (!item || !item.versions) return null;
            var versions = Object.keys(item.versions).map(function (key) {
                return item.versions[key];
            });
            for (var i = 0; i < versions.length; i++) {
                if (String(versions[i].sha256).toLowerCase() === String(sha256).toLowerCase()) {
                    return { version: versions[i].version, sha256: versions[i].sha256 };
                }
            }
            return null;
        });
    }

    // Bytes already mounted under this name AND carrying the registered
    // identity. They win over the network: the desktop build ships its images
    // as Tauri resources and has no HTTP path to media/ at all
    // (src/tauri-bundled.js mounts them at startup), and in a browser this
    // skips re-downloading an image the machine already holds. Identity, not
    // the file name, decides (docs/STATE-FORMAT.md).
    function mountedBytes(name, sha256) {
        if (typeof DataLoader === "undefined" ||
            typeof DataLoader.has !== "function" ||
            typeof DataLoader.get !== "function" ||
            typeof ImageFingerprint === "undefined" ||
            typeof ImageFingerprint.ofBytes !== "function") {
            return null;
        }
        if (!DataLoader.has(name)) return null;
        var bytes = DataLoader.get(name);
        if (!bytes) return null;
        var own = ImageFingerprint.ofBytes(bytes);
        return (own && String(own).toLowerCase() === String(sha256).toLowerCase())
            ? bytes : null;
    }

    async function load(name, version, expectedSha256) {
        var data = await manifest();
        var entry = entryFor(name, version, data);
        if (!entry) throw new Error("Image version is not registered: " + name + " v" + version);
        if (expectedSha256 && String(entry.sha256).toLowerCase() !== String(expectedSha256).toLowerCase()) {
            throw new Error("Registered SHA-256 changed for " + name + " v" + version);
        }
        var raw = mountedBytes(name, entry.sha256);
        var fromMachine = !!raw;
        if (!raw) {
            var response = await fetch(entry.url);
            if (!response.ok) throw new Error("Cannot load " + name + " v" + version + " (" + response.status + ")");
            var bytes = new Uint8Array(await response.arrayBuffer());
            if (/\.zst(?:$|\?)/i.test(entry.url)) {
                if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
                    throw new Error("Zstandard decoder is unavailable for " + name);
                }
                raw = fzstd.decompress(bytes);
            } else {
                raw = bytes;
            }
        }
        if (typeof ImageFingerprint === "undefined" ||
            ImageFingerprint.ofBytes(raw) !== String(entry.sha256).toLowerCase()) {
            throw new Error("SHA-256 mismatch for " + name + " v" + version);
        }
        if (typeof DataLoader === "undefined" || typeof DataLoader.mount !== "function") {
            throw new Error("Image loader is unavailable");
        }
        // Re-mounting bytes that are already there would overwrite their source
        // label ("bundled") with "published" and lie about where they came from.
        if (!fromMachine) DataLoader.mount(name, raw, "published");
        return raw;
    }

    global.VersionedMedia = {
        identify: identify,
        load: load,
        resolve: function (name, version) {
            return manifest().then(function (data) {
                var entry = entryFor(name, version, data);
                return entry ? Object.assign({}, entry) : null;
            });
        }
    };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
    module.exports = { VersionedMedia: globalThis.VersionedMedia };
}
