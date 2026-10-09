/**
 * yaPDP — the viewer's own configuration, remembered across a state apply.
 *
 * Applying a machine state also applies the state's configuration profile
 * (everything except the sound settings — see src/snapshots.js). That is the
 * point of a teleport link: the guest arrives with the hardware it was saved
 * on. But it also replaces the viewer's own setup (console, printer, zoom,
 * glow, widths ...). This module remembers the configuration the viewer had
 * BEFORE the first state was applied, so the emulator can offer to bring it
 * back — "Return my configuration" after a reload, or before a reboot.
 *
 * MACHINE-shared state, not a user preference: it lives in its own
 * localStorage key rather than in Config, so applying a state (which calls
 * Config.set) can never overwrite it. This mirrors src/last-boot.js.
 *
 * DOM-free and unit-testable in Node: get()/remember()/clear() take an
 * optional storage object (defaulting to window.localStorage) so tests can
 * pass a Map-backed mock, exactly like Config (src/config.js) and LastBoot.
 * The stored value is a full config object, normalised through Config.validate
 * on the way in and on the way out, so a corrupt store can never reach the
 * live configuration.
 *
 * Must be loaded AFTER src/config.js (it validates through Config) and BEFORE
 * src/snapshots.js (which is its only consumer).
 */
"use strict";

var ViewerConfig = (function () {
    var STORAGE_KEY = "yapdp.origconfig.v1";

    function getStorage(explicit) {
        if (explicit) return explicit;
        try {
            return window.localStorage;
        } catch (err) {
            return null;
        }
    }

    // Validate against the shared config contract. Config is loaded before this
    // module in the page; Node tests load it first too.
    function normalize(cfg) {
        if (typeof Config === "undefined" || typeof Config.validate !== "function") return null;
        if (!cfg || typeof cfg !== "object") return null;
        return Config.validate(cfg);
    }

    // The remembered configuration, or null when none is known.
    function get(storage) {
        var st = getStorage(storage);
        if (!st) return null;
        try {
            var raw = st.getItem(STORAGE_KEY);
            if (!raw) return null;
            return normalize(JSON.parse(raw));
        } catch (err) {
            return null;
        }
    }

    // Remember a full configuration. Illegal input is refused so a bad caller
    // cannot poison the store. Returns the stored (normalised) config or null.
    function remember(cfg, storage) {
        var value = normalize(cfg);
        var st = getStorage(storage);
        if (!value || !st) return value;
        try {
            st.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch (err) { /* ignore quota/availability errors */ }
        return value;
    }

    function clear(storage) {
        var st = getStorage(storage);
        if (!st) return;
        try {
            st.removeItem(STORAGE_KEY);
        } catch (err) { /* ignore */ }
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        get: get,
        remember: remember,
        clear: clear
    };
})();

if (typeof window !== "undefined") window.ViewerConfig = ViewerConfig;
if (typeof module !== "undefined" && module.exports) module.exports = { ViewerConfig: ViewerConfig };
