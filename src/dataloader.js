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
        mount(url, bytes) {
            mounted.set(url, bytes);
            sources.set(url, "local");
        },
        mountZst(url, zstBytes) {
            if (typeof fzstd === "undefined" || typeof fzstd.decompress !== "function") {
                return -1;
            }
            try {
                const decompressed = fzstd.decompress(new Uint8Array(zstBytes));
                mounted.set(url, decompressed);
                sources.set(url, "local");
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
