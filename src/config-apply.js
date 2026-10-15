/**
 * yaPDP — the live configuration applier (an explicit seam).
 *
 * Applying a state's profile (src/snapshots.js) or rolling the viewer's
 * configuration back changes Config, but the UI instances — console printer,
 * LP11, VT52 cabinets, CRT effects, photo backdrop, sticker — have to be
 * re-tuned from the new values. That re-tuning lives in src/pdp11-app.js
 * (its applyLive), which is page-specific and cannot be imported.
 *
 * This module is the seam between the two: pdp11-app.js REGISTERS its applier
 * here, snapshots.js REQUESTS one. Neither reaches for a page global the other
 * happens to set — the dependency is a named module with a small contract, in
 * the same spirit as src/last-boot.js and the Toasts adapter.
 *
 * DOM-free and unit-testable: applyLive() is a no-op until register() runs.
 * Must be loaded before src/pdp11-app.js (the registrar) and src/snapshots.js
 * (the consumer).
 */
"use strict";

var ConfigApply = (function () {
    var applier = null;

    // Register the page's live applier: a function that reads the current
    // config itself (pdp11-app.js passes its applyLive). A non-function clears
    // the registration.
    function register(fn) {
        applier = (typeof fn === "function") ? fn : null;
    }

    // Re-tune the live instances from the CURRENT Config. A no-op before
    // register() — a headless harness, or a page whose UI never loaded.
    function applyLive() {
        if (!applier) return;
        if (typeof Config === "undefined" || typeof Config.get !== "function") return;
        applier(Config.get());
    }

    return {
        register: register,
        applyLive: applyLive
    };
})();

if (typeof window !== "undefined") window.ConfigApply = ConfigApply;
if (typeof module !== "undefined" && module.exports) module.exports = { ConfigApply: ConfigApply };
