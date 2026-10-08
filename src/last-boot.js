/**
 * yaPDP — the last boot medium the operator loaded (the "Boot ROM socket").
 *
 * The `last` value of the CONFIG bootDevice option replays what the machine
 * loaded the previous time — a pick from the OS gallery, the Games carousel
 * or a teleport (state) link. That is MACHINE state, not a user preference,
 * so it lives in its own localStorage key rather than in Config: editing the
 * configuration (or applying a snapshot's hardware profile) must never
 * overwrite which medium was in the socket.
 *
 * DOM-free and unit-testable in Node: get()/remember()/clear() take an
 * optional storage object (defaulting to window.localStorage) so tests can
 * pass a Map-backed mock, exactly like Config (src/config.js).
 */
"use strict";

var LastBoot = (function () {
    var STORAGE_KEY = "yapdp.lastboot";
    // A device key is a short mnemonic (rk0, rp1, tm0, lander ...). Anything
    // longer is not one, and is refused rather than stored.
    var MAX_LEN = 64;

    function getStorage(explicit) {
        if (explicit) return explicit;
        try {
            return window.localStorage;
        } catch (err) {
            return null;
        }
    }

    // Accept only a plausible device key: a non-empty, short [A-Za-z0-9_-]
    // token. This keeps a corrupt store from ever reaching a boot command.
    function normalize(device) {
        if (typeof device !== "string") return null;
        var s = device.trim();
        if (!s.length || s.length > MAX_LEN) return null;
        if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
        return s;
    }

    // The remembered medium (a device key), or null when none is known.
    function get(storage) {
        var st = getStorage(storage);
        if (!st) return null;
        try {
            return normalize(st.getItem(STORAGE_KEY));
        } catch (err) {
            return null;
        }
    }

    // Remember a medium. An illegal key is ignored so a bad caller cannot
    // poison the socket. Returns the stored key (or null when nothing stored).
    function remember(device, storage) {
        var key = normalize(device);
        var st = getStorage(storage);
        if (!key || !st) return key;
        try {
            st.setItem(STORAGE_KEY, key);
        } catch (err) { /* ignore quota/availability errors */ }
        return key;
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

if (typeof module !== "undefined" && module.exports) {
    module.exports = { LastBoot: LastBoot };
}
