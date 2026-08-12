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
    // Bundled resources declared in src-tauri/tauri.conf.{minimal,full}.json
    // -> bundle.resources. `resource` is the file name in the resource dir;
    // `url` is the logical device URL the emulator uses (DataLoader key).
    //
    // The full build ships ALL of these; the minimal build ships only the
    // first few (rk0/rk1/bootcode). Missing resources fail in loadOne() and
    // are skipped with a console.warn — so one code path serves both builds.
    var BUNDLED = [
        // RK05 disk images (Unix V5, RT-11, RSTS, XXDP) — core boot images
        { resource: "rk0.dsk.zst", url: "rk0.dsk", zst: true },
        { resource: "rk1.dsk.zst", url: "rk1.dsk", zst: true },
        { resource: "rk2.dsk.zst", url: "rk2.dsk", zst: true },
        { resource: "rk3.dsk.zst", url: "rk3.dsk", zst: true },
        { resource: "rk4.dsk.zst", url: "rk4.dsk", zst: true },
        { resource: "rk5.dsk.zst", url: "rk5.dsk", zst: true },

        // RL02 disk images (BSD 2.9, RSX-11M 3.2, RSTS/E 7.0, XXDP ext.)
        { resource: "rl0.dsk.zst", url: "rl0.dsk", zst: true },
        { resource: "rl1.dsk.zst", url: "rl1.dsk", zst: true },
        { resource: "rl2.dsk.zst", url: "rl2.dsk", zst: true },
        { resource: "rl3.dsk.zst", url: "rl3.dsk", zst: true },

        // RP04/RP06 disk images (ULTRIX-11, BSD 2.11, RSTS/E, RSX-11M 4.6)
        { resource: "rp0.dsk.zst", url: "rp0.dsk", zst: true },
        { resource: "rp1.dsk.zst", url: "rp1.dsk", zst: true },
        { resource: "rp2.dsk.zst", url: "rp2.dsk", zst: true },
        { resource: "rp3.dsk.zst", url: "rp3.dsk", zst: true },
        { resource: "rp4.dsk.zst", url: "rp4.dsk", zst: true },

        // RA disk images (RA80/RA81)
        { resource: "ra0.dsk.zst", url: "ra0.dsk", zst: true },
        { resource: "ra1.dsk.zst", url: "ra1.dsk", zst: true },
        { resource: "ra2.dsk.zst", url: "ra2.dsk", zst: true },

        // TM magnetic tape images (RSTS 4B-17 rollin tapes)
        { resource: "tm0.tap.zst", url: "tm0.tap", zst: true },
        { resource: "tm1.tap.zst", url: "tm1.tap", zst: true },
        { resource: "tm2.tap.zst", url: "tm2.tap", zst: true },

        // Paper tapes (bootstrap loader, BASIC-11, ODT-11, ED-11, Lunar Lander)
        { resource: "bootcode.ptap", url: "bootcode.ptap", zst: false },
        { resource: "DEC-11-AJPB-PB.ptap.zst", url: "DEC-11-AJPB-PB.ptap", zst: true },
        { resource: "DEC-11-O2PA-PB.ptap.zst", url: "DEC-11-O2PA-PB.ptap", zst: true },
        { resource: "ED-11-V004B-8K.ptap.zst", url: "ED-11-V004B-8K.ptap", zst: true },
        { resource: "lander.ptap", url: "lander.ptap", zst: false }
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
