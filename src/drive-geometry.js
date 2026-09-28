/*
 * drive-geometry.js — image ↔ controller compatibility check (refactor).
 *
 * The Storage page lets a user bind any mounted image to any drive (MountMap).
 * That is powerful but easy to get wrong: an RP06 image bound to RK0 mounts
 * "successfully" and then the guest silently fails to boot, because the RK11
 * controller is modelled as an RK05 and only addresses the first ~2.4 MB.
 *
 * This module turns that footgun into a checkable fact: each disk controller
 * declares the exact image sizes its geometry produces, and check() reports
 * whether a given image size fits. It is deliberately DOM-free and pure so the
 * UI and the tests share one source of truth.
 *
 * IMPORTANT: the size expressions below MIRROR the device geometry tables
 * (src/devices/rk11.js, rl11.js, rp11.js). If a controller's geometry changes,
 * update this table together with it — tests/drive-geometry.test.js pins the
 * arithmetic.
 *
 * Controllers without a fixed geometry are intentionally unchecked:
 *   - UDA50 (MSCP): addresses logical blocks directly, the image sets its size.
 *   - TM11 (magtape): record-based, no fixed capacity.
 *
 * UMD-ish: exports to window in the browser, module.exports in Node (tests).
 */
"use strict";

var DriveGeometry = (() => {
    "use strict";

    const MB = 1024 * 1024;

    // prefix -> { label, sizes } (sizes in bytes), or null when unchecked.
    const TABLES = {
        // RK11 / RK05: 406 cylinders x 12 sectors x 512 B
        rk: { label: "RK05", sizes: [406 * 12 * 512] },
        // RL11 / RL01 + RL02: 40 sectors x 256 B, 512 or 1024 tracks
        rl: { label: "RL01/RL02", sizes: [512 * 40 * 256, 1024 * 40 * 256] },
        // RP11 / RP04 + RP06: 22 sectors x 19 surfaces x 512 B
        rp: { label: "RP04/RP06", sizes: [411 * 19 * 22 * 512, 815 * 19 * 22 * 512] },
        // UDA50 / RA81: MSCP logical blocks — no fixed geometry to check.
        ra: null,
        // TM11 / TU10: magtape records — no fixed geometry to check.
        tm: null
    };

    const NAMES = { rk: "RK11", rl: "RL11", rp: "RP11", ra: "UDA50", tm: "TM11" };

    /** prefixOf("rk2") -> "rk" */
    function prefixOf(drive) {
        const m = /^([a-z]+)\d*$/i.exec(String(drive || ""));
        return m ? m[1].toLowerCase() : "";
    }

    /** nameOf("rk2") -> "RK11" (controller family), or "" for unknown drives. */
    function nameOf(drive) {
        return NAMES[prefixOf(drive)] || "";
    }

    /** labelOf("rk2") -> "RK05" (drive model), or "" when unchecked/unknown. */
    function labelOf(drive) {
        const t = TABLES[prefixOf(drive)];
        return t ? t.label : "";
    }

    /** sizesFor("rk2") -> [bytes, ...] or null when the drive is unchecked. */
    function sizesFor(drive) {
        const t = TABLES[prefixOf(drive)];
        return t ? t.sizes.slice() : null;
    }

    function mb(bytes) {
        return (bytes / MB).toFixed(1) + " MB";
    }

    /**
     * check(drive, bytes) -> { ok, reason }.
     * ok is true when the drive is unchecked (ra/tm), when the size is unknown,
     * or when it matches one of the controller's geometry sizes. reason is a
     * human-readable explanation of a mismatch (empty when ok).
     */
    function check(drive, bytes) {
        const sizes = sizesFor(drive);
        if (!sizes || typeof bytes !== "number" || !isFinite(bytes)) {
            return { ok: true, reason: "" };
        }
        if (sizes.indexOf(bytes) !== -1) return { ok: true, reason: "" };
        const driveName = drive || "drive";
        const family = nameOf(drive);
        const expected = sizes.map(mb).join(" or ");
        return {
            ok: false,
            reason: "Image is " + mb(bytes) + "; " + driveName + " is " +
                (family ? family + " " : "") + labelOf(drive) +
                " (" + expected + "). Assign anyway only if you know the image fits."
        };
    }

    return {
        check,
        prefixOf,
        nameOf,
        labelOf,
        sizesFor
    };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { DriveGeometry };
if (typeof window !== "undefined") window.DriveGeometry = DriveGeometry;
