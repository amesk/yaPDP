/*
 * mountmap.js — declared drive → image-url registry (refactor).
 *
 * The storage layer used to bind a drive to an image by MAGIC FILE NAME:
 * every controller built its control-block url from a template like
 * `rk${drive}.dsk` (see rk11.js, rl11.js, rp11.js, uda50.js, tm11.js and the
 * legacy iopage.js). That makes remounting impossible: a user cannot say
 * "drive rl0 now holds mybsd.dsk".
 *
 * MountMap is the explicit mount table PCjs users know from machine.xml:
 * a logical drive key ("rk0", "rl2", "tm0" ...) maps to the image url the
 * controller should read. When no override exists, urlFor() falls back to the
 * historical template, so every existing image keeps its default binding.
 *
 * Split of responsibilities (mirrors dataloader.js / disk-service.js):
 *   - MountMap       — WHICH url a drive points at (this file, DOM-free)
 *   - DataLoader     — WHERE the bytes of a url live (drag & drop, bundle)
 *   - DiskService    — the block cache + write-back over those bytes
 *
 * Top-level `var MountMap` (not wrapped in an IIFE module) so the VM
 * sandboxes of the headless tools see it as a context property, exactly like
 * DataLoader. module.exports for Node tests; window export for the browser.
 */
"use strict";

var MountMap = (() => {
    "use strict";

    // localStorage key for the persisted table (same pattern as Config).
    const STORAGE_KEY = "yapdp.mountmap.v1";

    // logical drive key ("rk0") → image url ("mybsd.dsk")
    const overrides = new Map();

    const normalizeKey = (key) => String(key || "").toLowerCase();

    /** set(key, url) — bind a logical drive to an image url. */
    function set(key, url) {
        const k = normalizeKey(key);
        if (!k || url === undefined || url === null || url === "") return;
        overrides.set(k, String(url));
    }

    /** get(key) — the override url of a drive, or undefined. */
    function get(key) {
        return overrides.get(normalizeKey(key));
    }

    /** has(key) — true when the drive has an explicit override. */
    function has(key) {
        return overrides.has(normalizeKey(key));
    }

    /** remove(key) — drop the override of one drive. */
    function remove(key) {
        return overrides.delete(normalizeKey(key));
    }

    /** removeByUrl(url) — drop every drive bound to this url (unmount). */
    function removeByUrl(url) {
        const target = String(url);
        for (const [key, value] of overrides) {
            if (value === target) overrides.delete(key);
        }
    }

    /** clear() — forget every override (defaults apply again). */
    function clear() {
        overrides.clear();
    }

    /** list() — a plain { key: url } snapshot (debug / persistence). */
    function list() {
        const out = {};
        overrides.forEach((url, key) => { out[key] = url; });
        return out;
    }

    /**
     * urlFor(prefix, unit, suffix) — the url a controller should read.
     * Returns the override when one exists, otherwise the historical
     * template `prefix + unit + suffix` (e.g. rk2.dsk, tm0.tap), so callers
     * that never set an override behave exactly as before.
     */
    function urlFor(prefix, unit, suffix) {
        const key = normalizeKey(prefix) + unit;
        const override = overrides.get(key);
        return override !== undefined ? override : key + (suffix || ".dsk");
    }

    /** load(storage) — replace the table from persisted JSON (best-effort). */
    function load(storage) {
        overrides.clear();
        if (!storage) return;
        let raw = null;
        try {
            raw = storage.getItem(STORAGE_KEY);
        } catch (err) {
            return;
        }
        if (!raw) return;
        let data = null;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            return;
        }
        if (!data || typeof data !== "object") return;
        Object.keys(data).forEach((key) => set(key, data[key]));
    }

    /** save(storage) — persist the table as JSON (best-effort). */
    function save(storage) {
        if (!storage) return;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(list()));
        } catch (err) { /* ignore quota/availability errors */ }
    }

    /** reset(storage) — clear and persist an empty table. */
    function reset(storage) {
        clear();
        if (storage) {
            try {
                storage.removeItem(STORAGE_KEY);
            } catch (err) { /* ignore */ }
        }
    }

    // Auto-restore the persisted table in the browser (Node tests call load()
    // explicitly with a fake storage). Runs at load time, before the machine
    // layer reads urlFor() — mountmap.js is loaded before iopage.js and
    // browser-machine.js.
    if (typeof window !== "undefined" && window.localStorage) {
        load(window.localStorage);
    }

    return {
        STORAGE_KEY,
        set,
        get,
        has,
        remove,
        removeByUrl,
        clear,
        list,
        urlFor,
        load,
        save,
        reset
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { MountMap };
if (typeof window !== "undefined") window.MountMap = MountMap;
