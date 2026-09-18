/**
 * yaPDP — User configuration (CONFIG page).
 *
 * Single source of truth for the configurable system parameters:
 *   - consoleType:   terminal attached to the operator console (tty0),
 *                    'teletype' (Model 33 ASR), 'vt52' (DECscope) or
 *                    'vt100' (the 1978 ANSI terminal; supersets the VT52).
 *   - userTerminals: number of additional user terminals (0-2).
 *                    When a terminal is added, a matching sidebar page is shown.
 *   - userTerminalTypes: per-terminal dialect of the user terminals, in the
 *                    same order as the sidebar pages (TT1, TT2): 'vt52' or
 *                    'vt100'. Kept as an array like vt52Zoom, so each
 *                    terminal keeps its own type between runs.
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
 *   - upperCaseOnly: force the physical keyboard to send letters in upper case
 *                    (0x41-0x5A), matching the Upper-Case-Only Model 33 ASR.
 *                    Off by default so lower-case passes through (e.g. 2.11 BSD,
 *                    which needs lower-case file names). Applied live, no reboot.
 *   - forceUpperCaseOut: force the PRINTED glyph of the console teletype to
 *                    upper case: a real Model 33 ASR print mechanism has no
 *                    lower-case type, so a loader that writes lower case cannot
 *                    put those letters on the paper. The punched tape keeps the
 *                    raw code (an ASR punch copies the received byte), and
 *                    reading such a tape in LOCAL prints upper case while LINE
 *                    sends the raw lower case to the machine. On by default
 *                    (authentic). Ignored entirely on a VT52 console, which
 *                    does lower case. Applied live, no reboot.
 *   - vt100Phosphor: the VT100 tube's phosphor, 'p4' (white — the phosphor the
 *                    VT100 was introduced on in 1978) or 'p1' (green — the tube
 *                    1980s terminals are known for). The VT52 is NOT offered a
 *                    choice: it was never sold in another phosphor, and its
 *                    dialect pins p4.
 *   - keyClick:      audible key-click feedback for VT52 terminals.
 *                    (Absent on the original VT52, introduced with the VT100.)
 *   - hum:           ambient PDP-11 power-supply hum + fan noise while the
 *                    machine is powered on. Synthesized on a dedicated Web
 *                    Audio context so it never clashes with the teletype/
 *                    printer or VT52 key-click sounds. Applied immediately.
 *   - mute:          global all-sounds mute. A round magic-wand-style button
 *                    on the Panel page toggles it like a checkbox; every
 *                    sound source (hum, VT52 key click, bell, teletype/LP11,
 *                    paper feed/tear) is gated on this flag at play time.
 *                    Applied immediately, no reboot needed.
 *   - photoBackdrop: whether the PDP-11 machine-room photo is shown behind
 *                    the pages. Applied immediately, no reboot needed.
 *   - crtEffects:    pure-CSS CRT simulation on VT52 terminals: brightness
 *                    flicker, scanline shimmer and a vertical-hold roll band.
 *                    Applied immediately, no reboot needed.
 *   - vt52TextMode:  render VT52 terminals as a plain <textarea> instead of the
 *                    canvas CRT. Loses SGR attributes (bold/underline/blink/
 *                    reverse) but enables native text selection and Windows
 *                    Clipboard (Ctrl+C / Ctrl+V / right-click paste) for fast
 *                    source-code entry. Applied immediately, no reboot needed.
 *   - confirmReboot: whether the REBOOT button asks for confirmation before
 *                    restarting the machine (BEHAVIOUR tab of the CONFIG page).
 *   - panelSticker:  whether the operator's hand-written bootstrap sticky note
 *                    is shown on the Panel page (BEHAVIOUR tab of the CONFIG
 *                    page). Hidden by default; the Help Me! button toggles it
 *                    live and persists the choice here.
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
        consoleType: "teletype", // 'teletype' | 'vt52' | 'vt100'
        userTerminals: 0,        // 0 | 1 | 2
        // Per-terminal dialect of the user terminals, in sidebar-page order
        // (TT1, TT2). An array like vt52Zoom, so each terminal remembers its own
        // type between runs; entries beyond userTerminals are simply unused.
        userTerminalTypes: ["vt52", "vt52"],
        printer: false,          // boolean
        vt11: false,             // boolean (VT11 graphics display)
        printWidth: 72,          // 72 | 80 (console teletype, Model 33 ASR)
        printerWidth: 132,       // 72 | 80 | 100 | 132 (LP11 printer page)
        teletypeSpeed: "authentic", // 'authentic' | 'fast' (console teletype echo)
        upperCaseOnly: false,    // boolean (physical keyboard upper-case only)
        // boolean (print PDP output upper case; the punch keeps the raw code)
        forceUpperCaseOut: true,
        keyClick: false,         // boolean (VT52 key click)
        // The VT100's tube: 'p4' (white — the phosphor the VT100 was introduced
        // on in 1978) or 'p1' (green — what 1980s terminals are known for).
        // The VT52 has no such option: it was never offered in another phosphor,
        // and its dialect pins p4 (see the dialect's powerOnState).
        vt100Phosphor: "p4",
        vt52ReverseVideo: false, // boolean (VT52 reverse video — black text on white)
        vt52TextMode: false,     // boolean (VT52 plain <textarea> instead of canvas)
        // Zoomed VT52 tube, PER TERMINAL: [console TT0, TTY1, TTY2]. In zoom mode
        // the cabinet is hidden and the tube grows to the largest 4:3 box the
        // window allows (clearing the corner controls). Kept as an array so the
        // console and each user terminal remember their own state between runs.
        vt52Zoom: [false, false, false],
        crtEffects: true,        // boolean (VT52 pure-CSS CRT flicker/roll simulation)
        hum: true,               // boolean (ambient power-supply hum + fan noise)
        mute: false,             // boolean (global all-sounds mute)
        photoBackdrop: true,     // boolean (PDP-11 photo behind the pages)
        confirmReboot: true,     // boolean (ask before rebooting the machine)
        panelSticker: false,     // boolean (Help Me! sticker on the Panel page)
        powerOn: false,          // boolean (machine powered on at startup)
        autoBoot: false          // boolean (start default bootstrap on power-on)
    });

    // Normalize the per-terminal zoom flags into exactly three booleans.
    function normalizeVt52Zoom(value) {
        var out = [false, false, false];
        if (!Array.isArray(value)) return out;
        for (var i = 0; i < out.length; i++) out[i] = Boolean(value[i]);
        return out;
    }

    // Terminal dialects a user terminal may be built as. 'vt52' is the
    // historical DECscope; 'vt100' is the ANSI terminal (a superset of it).
    var TERMINAL_TYPES = Object.freeze(["vt52", "vt100"]);

    /**
     * Normalize the per-terminal dialect array into two legal entries.
     * Anything unrecognised falls back to the DECscope, so configs saved before
     * the VT100 existed keep building VT52 user terminals.
     */
    function normalizeUserTerminalTypes(value) {
        var out = ["vt52", "vt52"];
        if (!Array.isArray(value)) return out;
        for (var i = 0; i < out.length; i++) {
            out[i] = TERMINAL_TYPES.indexOf(value[i]) !== -1 ? value[i] : out[i];
        }
        return out;
    }

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
            // Any of the three legal terminals; anything else is the teletype.
            consoleType: TERMINAL_TYPES.indexOf(o.consoleType) !== -1
                ? o.consoleType
                : DEFAULTS.consoleType,
            userTerminals: isOneOf(Number(o.userTerminals), [0, 1, 2])
                ? Number(o.userTerminals)
                : DEFAULTS.userTerminals,
            // Per-terminal dialect choices (TT1, TT2); garbage falls back to the
            // DECscope, so a config written before the VT100 existed still builds.
            userTerminalTypes: normalizeUserTerminalTypes(o.userTerminalTypes),
            printer: Boolean(o.printer),
            vt11: Boolean(o.vt11),
            printWidth: normalizePrintWidth(o.printWidth, DEFAULTS.printWidth, PRINT_WIDTHS_TTY),
            printerWidth: normalizePrintWidth(o.printerWidth, DEFAULTS.printerWidth),
            // Absent/garbage falls back to 'authentic' (the real Model 33 ASR speed).
            teletypeSpeed: o.teletypeSpeed === "fast" ? "fast" : DEFAULTS.teletypeSpeed,
            upperCaseOnly: Boolean(o.upperCaseOnly),
            // Absent key falls back to TRUE (authentic Model 33 ASR: the print
            // mechanism only has upper-case type), so configs saved before the
            // option existed print in upper case too.
            forceUpperCaseOut: typeof o.forceUpperCaseOut === "undefined"
                ? DEFAULTS.forceUpperCaseOut
                : Boolean(o.forceUpperCaseOut),
            keyClick: Boolean(o.keyClick),
            // Only the two phosphors the project draws; anything else is p4.
            vt100Phosphor: o.vt100Phosphor === "p1" ? "p1" : DEFAULTS.vt100Phosphor,
            vt52ReverseVideo: Boolean(o.vt52ReverseVideo),
            // Absent key falls back to the default (keeps the authentic canvas
            // CRT for old configs saved before the option existed).
            vt52TextMode: typeof o.vt52TextMode === "undefined"
                ? DEFAULTS.vt52TextMode
                : Boolean(o.vt52TextMode),
            // Always exactly three booleans (console + two user terminals); a
            // missing/oversized/garbage array falls back to all-off, so configs
            // saved before the option existed keep the cabinet.
            vt52Zoom: normalizeVt52Zoom(o.vt52Zoom),
            // Absent key falls back to the default (keeps the CRT effects on
            // for old configs saved before the option existed).
            crtEffects: typeof o.crtEffects === "undefined"
                ? DEFAULTS.crtEffects
                : Boolean(o.crtEffects),
            // Absent key falls back to the default (keeps the ambient hum on
            // for old configs saved before the "hum" option existed).
            hum: typeof o.hum === "undefined"
                ? DEFAULTS.hum
                : Boolean(o.hum),
            // Absent key falls back to false (keeps the sounds on for old
            // configs saved before the "mute" option existed).
            mute: typeof o.mute === "undefined"
                ? DEFAULTS.mute
                : Boolean(o.mute),
            // Absent key falls back to true (keeps the photo on for old configs).
            photoBackdrop: typeof o.photoBackdrop === "undefined"
                ? DEFAULTS.photoBackdrop
                : Boolean(o.photoBackdrop),
            // Absent key falls back to true (keeps the reboot confirmation on
            // for old configs saved before the option existed).
            confirmReboot: typeof o.confirmReboot === "undefined"
                ? DEFAULTS.confirmReboot
                : Boolean(o.confirmReboot),
            // Absent key falls back to false (the sticker is hidden on the
            // very first start, until the operator asks for help).
            panelSticker: typeof o.panelSticker === "undefined"
                ? DEFAULTS.panelSticker
                : Boolean(o.panelSticker),
            // Absent key falls back to false (the machine powers up OFF until
            // the operator turns the POWER LOCK switch or enables this option).
            powerOn: typeof o.powerOn === "undefined"
                ? DEFAULTS.powerOn
                : Boolean(o.powerOn),
            // Absent key falls back to false (no automatic bootstrap; the
            // operator presses Bootstrap now! or types a boot command).
            autoBoot: typeof o.autoBoot === "undefined"
                ? DEFAULTS.autoBoot
                : Boolean(o.autoBoot)
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
