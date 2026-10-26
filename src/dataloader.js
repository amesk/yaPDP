/*
 * dataloader.js — the "get the bytes" layer of the storage split (refactor).
 *
 * Moved out of iopage.js verbatim: DataLoader is NOT a device — it is the
 * UI/environment side of the block interface. It holds decompressed image
 * bytes by logical url (rk0.dsk, boot.ptap, ...) and is filled by
 * dragdrop.js (drag & drop, bundled media index), tauri-bundled.js
 * (desktop build) and quickboot. In the headless Node world it does not
 * exist at all — tools read files directly via the DiskService providers.
 *
 * The refactored browser machine (?core=1) mounts drives from here
 * exactly like the iopage path did.
 *
 * Top-level `var DataLoader` (not wrapped in an IIFE) so the VM sandboxes
 * of the headless tools see it as a context property, exactly like the
 * old iopage.js definition. module.exports for Node tests; window export
 * for the browser.
 */
"use strict";

var DataLoader = (() => {
    "use strict";

    // Logical url (e.g. "rk0.dsk") → full decompressed image bytes
    const mounted = new Map();
    // Logical url → source hint for UI (dragdrop / bundled)
    const sources = new Map();

    return {
        // `source` records WHERE the bytes came from — "local" (drag & drop),
        // "network", "published" (a registry version), "bundled" (desktop) or
        // "embedded" (carried inside a state). A thin snapshot cannot fetch
        // local bytes back, so a state records this and can warn or refuse
        // honestly instead of blaming the wrong disk.
        mount(url, bytes, source) {
            mounted.set(url, bytes);
            sources.set(url, source || "local");
            // All mounted data is decompressed payload bytes. Register one
            // canonical identity here so network, drag-and-drop, QuickBoot,
            // and desktop-bundled images follow the same rule.
            if (typeof DiskStore !== "undefined" &&
                typeof DiskStore.registerImage === "function" &&
                typeof ImageFingerprint !== "undefined" &&
                typeof ImageFingerprint.ofBytes === "function") {
                try {
                    DiskStore.registerImage(url, ImageFingerprint.ofBytes(bytes));
                } catch (err) { /* identity unknown: stay permissive */ }
            }
        },
        mountZst(url, zstBytes) {
            if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
                return -1;
            }
            try {
                const decompressed = fzstd.decompress(new Uint8Array(zstBytes));
                this.mount(url, decompressed);
                return decompressed.length;
            } catch (err) {
                return -1;
            }
        },
        get(url) {
            return mounted.get(url);
        },
        has(url) {
            return mounted.has(url);
        },
        unmount(url) {
            mounted.delete(url);
            sources.delete(url);
        },
        list() {
            return Array.from(mounted.keys());
        },
        sourceOf(url) {
            return sources.get(url);
        }
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { DataLoader };
if (typeof window !== "undefined") window.DataLoader = DataLoader;
