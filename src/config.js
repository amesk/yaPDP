/**
 * yaPDP — User configuration (CONFIG page).
 *
 * Single source of truth for the configurable system parameters:
 *   - consoleType:   terminal attached to the operator console (tty0),
 *                    'teletype' (Model 33 ASR) or 'vt52' (DECscope).
 *   - userTerminals: number of additional user VT52 terminals (0-2).
 *                    When a terminal is added, a matching sidebar page is shown.
 *   - printer:       whether an LP11 line printer is present (own page, an
 *                    animated G60 printer without a keyboard).
 *   - vt11:          whether a VT11 vector-graphics display is present (own
 *                    "Display" page, green-phosphor CRT). Off by default.
 *   - printWidth:    printable columns for the console teletype (72/80).
 *                    A Model 33 ASR is at most an 80-column machine; the wider
 *                    100/132 columns exist only on the LP11 line printer.
 *   - printerWidth:  printable columns for the LP11 printer page (72/80/100/132).
 *   - teletypeSpeed: console teletype echo speed, 'authentic' (real Model 33 ASR,
 *                    110 baud = 10 chars/sec) or 'fast' (accelerated dev pace,
 *                    ~33 chars/sec). Applied live, no reboot needed.
 *   - keyClick:      audible key-click feedback for VT52 terminals.
 *                    (Absent on the original VT52, introduced with the VT100.)
 *   - hum:           ambient PDP-11 power-supply hum + fan noise while the
 *                    machine is powered on. Synthesized on a dedicated Web
 *                    Audio context so it never clashes with the teletype/
 *                    printer or VT52 key-click sounds. Applied immediately.
 *   - photoBackdrop: whether the PDP-11 machine-room photo is shown behind
 *                    the pages. Applied immediately, no reboot needed.
 *
 * Persistence uses localStorage under the key "yapdp.config.v1" (the same
 * pattern as Onboarding in onboarding.js). The pure helpers validate/load/
 * save/reset are DOM-free and unit-testable in Node.
 *
 * Must be loaded BEFORE iopage.js (which registers devices conditionally on
 * the config) and before pdp11-app.js (which builds the UI from the config).
 */
"use strict";

var Config = (function () {
    var STORAGE_KEY = "yapdp.config.v1";

    var DEFAULTS = Object.freeze({
        consoleType: "teletype", // 'teletype' | 'vt52'
        userTerminals: 0,        // 0 | 1 | 2
        printer: false,          // boolean
        vt11: false,             // boolean (VT11 graphics display)
        printWidth: 72,          // 72 | 80 (console teletype, Model 33 ASR)
        printerWidth: 132,       // 72 | 80 | 100 | 132 (LP11 printer page)
        teletypeSpeed: "authentic", // 'authentic' | 'fast' (console teletype echo)
        keyClick: false,         // boolean (VT52 key click)
        hum: true,               // boolean (ambient power-supply hum + fan noise)
        photoBackdrop: true      // boolean (PDP-11 photo behind the pages)
    });

    // LP11 line-printer widths (a real LP11 is a 132-column machine).
    var PRINT_WIDTHS = Object.freeze([72, 80, 100, 132]);
    // Model 33 ASR console teletype widths — a teletype is at most 80 columns.
    var PRINT_WIDTHS_TTY = Object.freeze([72, 80]);
    // Console teletype echo speeds. 'authentic' is the real Model 33 ASR at 110 baud
    // (~100 ms/char, 10 chars/sec); 'fast' is the accelerated dev pace (~30 ms).
    var TELETYPE_SPEEDS = Object.freeze(["authentic", "fast"]);

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
    // `allowed` restricts the accepted values (defaults to the LP11 list);
    // the teletype passes PRINT_WIDTHS_TTY so 100/132 fall back.
    function normalizePrintWidth(value, fallback, allowed) {
        var n = Number(value);
        var list = allowed || PRINT_WIDTHS;
        return isOneOf(n, list) ? n : fallback;
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
            vt11: Boolean(o.vt11),
            printWidth: normalizePrintWidth(o.printWidth, DEFAULTS.printWidth, PRINT_WIDTHS_TTY),
            printerWidth: normalizePrintWidth(o.printerWidth, DEFAULTS.printerWidth),
            // Absent/garbage falls back to 'authentic' (the real Model 33 ASR speed).
            teletypeSpeed: o.teletypeSpeed === "fast" ? "fast" : DEFAULTS.teletypeSpeed,
            keyClick: Boolean(o.keyClick),
            // Absent key falls back to the default (keeps the ambient hum on
            // for old configs saved before the "hum" option existed).
            hum: typeof o.hum === "undefined"
                ? DEFAULTS.hum
                : Boolean(o.hum),
            // Absent key falls back to true (keeps the photo on for old configs).
            photoBackdrop: typeof o.photoBackdrop === "undefined"
                ? DEFAULTS.photoBackdrop
                : Boolean(o.photoBackdrop)
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
        PRINT_WIDTHS_TTY: PRINT_WIDTHS_TTY,
        TELETYPE_SPEEDS: TELETYPE_SPEEDS,
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
