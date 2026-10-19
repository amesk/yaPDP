/*
 * Versioned media registry for immutable base disk/tape images.
 *
 * Registry hashes describe decompressed bytes. A snapshot can therefore pin
 * an image version independently of the compression used to distribute it.
 */
"use strict";

(function (global) {
    var manifestPromise = null;

    function manifest() {
        if (!manifestPromise) {
            manifestPromise = fetch("media/manifest.json").then(function (response) {
                if (!response.ok) throw new Error("Cannot load media manifest");
                return response.json();
            }).catch(function (err) {
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

    async function load(name, version, expectedSha256) {
        var data = await manifest();
        var entry = entryFor(name, version, data);
        if (!entry) throw new Error("Image version is not registered: " + name + " v" + version);
        if (expectedSha256 && String(entry.sha256).toLowerCase() !== String(expectedSha256).toLowerCase()) {
            throw new Error("Registered SHA-256 changed for " + name + " v" + version);
        }
        var response = await fetch(entry.url);
        if (!response.ok) throw new Error("Cannot load " + name + " v" + version + " (" + response.status + ")");
        var bytes = new Uint8Array(await response.arrayBuffer());
        var raw;
        if (/\.zst(?:$|\?)/i.test(entry.url)) {
            if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
                throw new Error("Zstandard decoder is unavailable for " + name);
            }
            raw = fzstd.decompress(bytes);
        } else {
            raw = bytes;
        }
        if (typeof ImageFingerprint === "undefined" ||
            ImageFingerprint.ofBytes(raw) !== String(entry.sha256).toLowerCase()) {
            throw new Error("SHA-256 mismatch for " + name + " v" + version);
        }
        if (typeof DataLoader === "undefined" || typeof DataLoader.mount !== "function") {
            throw new Error("Image loader is unavailable");
        }
        DataLoader.mount(name, raw);
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
