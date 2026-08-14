/**
 * PDP-11 Emulator — User configuration (CONFIG page).
 *
 * Single source of truth for the configurable system parameters:
 *   - consoleType:   terminal attached to the operator console (tty0),
 *                    'teletype' (ASR 33) or 'vt52' (DECscope).
 *   - userTerminals: number of additional user VT52 terminals (0-2).
 *                    When a terminal is added, a matching sidebar page is shown.
 *   - printer:       whether an LP11 line printer is present (own page, an
 *                    animated G60 printer without a keyboard).
 *   - printWidth:    printable columns for the console teletype (72/80/100/132).
 *   - printerWidth:  printable columns for the LP11 printer page (72/80/100/132).
 *   - keyClick:      audible key-click feedback for VT52 terminals.
 *                    (Absent on the original VT52, introduced with the VT100.)
 *
 * Persistence uses localStorage under the key "pdp11.config.v1" (the same
 * pattern as Onboarding in onboarding.js). The pure helpers validate/load/
 * save/reset are DOM-free and unit-testable in Node.
 *
 * Must be loaded BEFORE iopage.js (which registers devices conditionally on
 * the config) and before pdp11-app.js (which builds the UI from the config).
 */
"use strict";

var Config = (function () {
    var STORAGE_KEY = "pdp11.config.v1";

    var DEFAULTS = Object.freeze({
        consoleType: "teletype", // 'teletype' | 'vt52'
        userTerminals: 0,        // 0 | 1 | 2
        printer: false,          // boolean
        printWidth: 72,          // 72 | 80 | 100 | 132 (console teletype)
        printerWidth: 132,       // 72 | 80 | 100 | 132 (LP11 printer page)
        keyClick: false          // boolean (VT52 key click)
    });

    var PRINT_WIDTHS = Object.freeze([72, 80, 100, 132]);

    function getStorage() {
        try {
            return window.localStorage;
        } catch (err) {
            return null;
        }
    }

    function copy(obj) {
        return Object.assign({}, obj);
    }

    function isOneOf(value, allowed) {
        return allowed.indexOf(value) !== -1;
    }

    // Normalize a raw print width value; falls back to the given default.
    function normalizePrintWidth(value, fallback) {
        var n = Number(value);
        return isOneOf(n, PRINT_WIDTHS) ? n : fallback;
    }

    /**
     * Pure sanitizer: merge raw values over DEFAULTS, clamping every field to
     * a legal value. Unknown/missing keys fall back to their defaults.
     */
    function validate(raw) {
        var o = (raw && typeof raw === "object") ? raw : {};
        return {
            consoleType: o.consoleType === "vt52" ? "vt52" : DEFAULTS.consoleType,
            userTerminals: isOneOf(Number(o.userTerminals), [0, 1, 2])
                ? Number(o.userTerminals)
                : DEFAULTS.userTerminals,
            printer: Boolean(o.printer),
            printWidth: normalizePrintWidth(o.printWidth, DEFAULTS.printWidth),
            printerWidth: normalizePrintWidth(o.printerWidth, DEFAULTS.printerWidth),
            keyClick: Boolean(o.keyClick)
        };
    }

    // Load and validate the stored config; returns a plain object.
    function load(storage) {
        if (!storage) return copy(DEFAULTS);
        try {
            var raw = storage.getItem(STORAGE_KEY);
            if (!raw) return copy(DEFAULTS);
            return validate(JSON.parse(raw));
        } catch (err) {
            return copy(DEFAULTS);
        }
    }

    // Persist a config object (JSON-encoded).
    function save(cfg, storage) {
        if (!storage) return;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        } catch (err) { /* ignore quota/availability errors */ }
    }

    // Clear the stored config and return the defaults.
    function reset(storage) {
        if (storage) {
            try {
                storage.removeItem(STORAGE_KEY);
            } catch (err) { /* ignore */ }
        }
        return copy(DEFAULTS);
    }

    // The in-memory config snapshot; initialized once at module load so that
    // iopage.js can read it synchronously while registering devices.
    var current = load(getStorage());

    return {
        DEFAULTS: DEFAULTS,
        PRINT_WIDTHS: PRINT_WIDTHS,
        getStorage: getStorage,
        validate: validate,
        load: load,
        save: save,
        reset: reset,

        // Current validated configuration (plain object).
        get: function () {
            return current;
        },

        // Merge a partial update into the current config, persist it and
        // refresh the in-memory snapshot. Returns the new validated config.
        set: function (partial) {
            current = validate(Object.assign({}, current, partial || {}));
            save(current, getStorage());
            return current;
        },

        // Restore defaults, persist the cleared state and refresh the snapshot.
        resetAndGet: function () {
            current = reset(getStorage());
            return current;
        }
    };
})();
