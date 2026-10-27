/**
 * Tauri desktop — bundled image bootstrap
 *
 * In the desktop build the disk/tape images are shipped as bundled resources
 * (see bundle.resources in src-tauri/tauri.conf.<variant>.json). This module
 * detects the Tauri runtime and, on startup, loads the ones THIS variant ships
 * through the Rust `load_bundled_image` command, decompresses them, and mounts
 * them into DataLoader so the emulator boots offline with no network access.
 *
 * Which ones: the staging step writes media/manifest.json for the selected
 * variant (tools/desktop-manifests.js), so that manifest — not the table below —
 * says what is installed. The table stays as the RESOURCE-NAME map (a logical
 * url is not enough: some payloads ship compressed and some raw) and is filtered
 * by the manifest, so the Minimal build no longer asks for images it
 * deliberately does not contain and no longer reports each absence as a load
 * failure (18 error toasts at startup, deduped into one naming rk2.dsk.zst).
 *
 * In a plain browser this module is a no-op.
 *
 * Must be loaded AFTER iopage.js (DataLoader) and fzstd.js.
 */
"use strict";

(function () {
    // Bundled resources declared in src-tauri/tauri.conf.{minimal,full}.json
    // -> bundle.resources. `resource` is the file name in the resource dir;
    // `url` is the logical device URL the emulator uses (DataLoader key) and
    // `zst` says whether the resource is compressed on disk.
    //
    // This is the RESOURCE-NAME map, not the inventory: the inventory is the
    // staged media/manifest.json (see fetchShipped), filtered per variant at
    // build time. An entry the variant does not ship is never requested — its
    // absence is not an error; an entry the manifest DOES list and that cannot
    // be read is a packaging failure and stays loud.
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

    // The bootstrap loader is a bundled resource but NOT a logical media image —
    // it is excluded from media/manifest.json (tools/gen-media-manifest.js), so
    // the manifest filter must always let it through.
    var BOOTSTRAP_LOADER = "bootcode.ptap";

    function isTauri() {
        return typeof window !== "undefined" &&
            window.__TAURI__ &&
            window.__TAURI__.core &&
            typeof window.__TAURI__.core.invoke === "function";
    }

    // The entries this build actually ships. `shipped` is the logical-url set
    // from the staged manifest; null means "unknown" (a host without one) and
    // every entry is attempted, as before. Pure — unit-testable in Node via
    // window.__yapdpBundledPure.
    function shippedItems(items, shipped) {
        if (!shipped) return items;
        return items.filter(function (item) {
            return shipped[item.url] === true || item.url === BOOTSTRAP_LOADER;
        });
    }

    // The staged manifest of THIS variant: the build step filters it by
    // bundle.resources, so it is the authoritative "what is installed" list.
    function fetchShipped() {
        if (typeof fetch !== "function") return Promise.resolve(null);
        return fetch("media/manifest.json", { cache: "no-store" })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (manifest) {
                if (!manifest || !Array.isArray(manifest.media)) return null;
                var shipped = {};
                manifest.media.forEach(function (name) { shipped[name] = true; });
                return shipped;
            })
            .catch(function () { return null; });
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
                    DataLoader.mount(item.url, fzstd.decompress(u8), "bundled");
                } else {
                    DataLoader.mount(item.url, u8, "bundled");
                }
                return item.url;
            })
            .catch(function (err) {
                // Loud, named: a silently skipped image is how a missing
                // bundled resource (or a slow one) went unnoticed.
                console.error("Bundled image load failed:", item.resource, err);
                if (typeof window.__yapdpReportError === "function") {
                    window.__yapdpReportError("Bundled image load failed: " + item.resource, "bundled-image-load");
                }
                return null;
            });
    }

    function init() {
        if (!isTauri()) return; // regular browser — nothing to do

        if (typeof DataLoader === "undefined") {
            console.warn("DataLoader not available; skipping bundled images");
            if (typeof window.__yapdpReportWarning === "function") {
                window.__yapdpReportWarning("DataLoader not available; skipping bundled images", "dataloader-missing");
            }
            return;
        }
        // Mount every bundled image in PARALLEL, not as a strict chain.
        // A sequential chain made the last entries (e.g. lander.ptap, the
        // ra*/rp* disks) unavailable for seconds while the big .zst images
        // decompressed one after another — a guest booting from one of them
        // read an empty image and appeared to "not start". Parallel mount
        // removes that ordering race entirely.
        //
        // The readiness promise is exposed IMMEDIATELY and covers the manifest
        // lookup too: consumers (baseBytes) wait for it instead of falling back
        // to a network fetch that does not exist in the desktop build, and a
        // gap here would let a disk read race the mount.
        var ready = fetchShipped().then(function (shipped) {
            return Promise.all(shippedItems(BUNDLED, shipped).map(loadOne));
        }).then(function (results) {
            var ok = (results || []).filter(Boolean).length;
            console.info("yaPDP desktop: mounted " + ok + " bundled image(s)");
            // The quick-boot wizard filters its list by what is mounted; if
            // the dialog is already open (opened during the mount window)
            // re-render it so it settles on the bundled set.
            if (typeof QuickBoot !== "undefined" &&
                typeof QuickBoot.refresh === "function") {
                QuickBoot.refresh();
            }
        });
        // Signal for lazy provider reads (browser-machine baseBytes).
        window.__yapdpBundledReady = ready;
    }

    // Pure pieces for the Node contract test (tests/desktop-manifests.test.js):
    // the filter is what decides whether the Minimal installer asks for images
    // it does not contain, and that decision must be pinned.
    if (typeof window !== "undefined") {
        window.__yapdpBundledPure = { BUNDLED: BUNDLED, shippedItems: shippedItems };
    }

    if (typeof document === "undefined") return; // Node: nothing to mount
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
