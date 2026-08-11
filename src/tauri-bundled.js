/**
 * Tauri desktop — bundled image bootstrap
 *
 * In the desktop build a small set of media images (rk0, rk1, bootcode) is
 * shipped as bundled resources (see src-tauri/tauri.conf.json). This module
 * detects the Tauri runtime and, on startup, loads those images through the
 * Rust `load_bundled_image` command, decompresses them, and mounts them into
 * DataLoader so the emulator boots offline with no network access.
 *
 * In a plain browser this module is a no-op.
 *
 * Must be loaded AFTER iopage.js (DataLoader) and fzstd.js.
 */
"use strict";

(function () {
    // Bundled resources declared in src-tauri/tauri.conf.json -> bundle.resources.
    // `resource` is the file name in the resource dir; `url` is the logical
    // device URL the emulator uses (DataLoader key).
    var BUNDLED = [
        { resource: "rk0.dsk.zst", url: "rk0.dsk", zst: true },
        { resource: "rk1.dsk.zst", url: "rk1.dsk", zst: true },
        { resource: "bootcode.ptap", url: "bootcode.ptap", zst: false }
    ];

    function isTauri() {
        return typeof window !== "undefined" &&
            window.__TAURI__ &&
            window.__TAURI__.core &&
            typeof window.__TAURI__.core.invoke === "function";
    }

    function loadOne(item) {
        return window.__TAURI__.core
            .invoke("load_bundled_image", { name: item.resource })
            .then(function (bytes) {
                var u8 = new Uint8Array(bytes);
                if (item.zst) {
                    if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
                        throw new Error("fzstd not available for " + item.resource);
                    }
                    DataLoader.mount(item.url, fzstd.decompress(u8));
                } else {
                    DataLoader.mount(item.url, u8);
                }
                return item.url;
            })
            .catch(function (err) {
                console.warn("Bundled image load failed:", item.resource, err);
                return null;
            });
    }

    function init() {
        if (!isTauri()) return; // regular browser — nothing to do
        if (typeof DataLoader === "undefined") {
            console.warn("DataLoader not available; skipping bundled images");
            return;
        }
        var chain = Promise.resolve();
        BUNDLED.forEach(function (item) {
            chain = chain.then(function () { return loadOne(item); });
        });
        chain.then(function (results) {
            var ok = (results || []).filter(Boolean).length;
            if (ok > 0) {
                console.info("PDP-11 desktop: mounted " + ok + " bundled image(s)");
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
