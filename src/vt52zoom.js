/**
 * yaPDP — VT52 zoom toggle.
 *
 * The floating zoom button hides the VT52 cabinet and grows the tube to the
 * largest 4:3 box the window allows, clearing the corner controls. The state is
 * PER TERMINAL (console TT0, TTY1, TTY2 — one flag each) and lives in
 * Config.vt52Zoom, so each terminal remembers its own zoom between sessions.
 *
 * The button acts on the VT52 page currently on screen (the .page.active one);
 * pressing it while no VT52 page is shown does nothing. The page <-> terminal
 * mapping is the same one initVT52Page() uses in src/pdp11-app.js.
 *
 * The module is DOM-light and exposes its pure decisions for testing; the
 * actual class toggling and scaling are delegated to the app (window.vt52Zoom
 * / window.vt52Unzoom), which owns the geometry.
 */
"use strict";

var Vt52Zoom = (function () {
    "use strict";

    // page id -> terminal index (the order initVT52Page uses).
    var PAGE_UNIT = {
        "page-vt52-console": 0,
        "page-vt52": 1,
        "page-vt52-2": 2
    };

    // The terminal index of the VT52 page currently on screen, or -1 when the
    // visible page is not a VT52 one (teletype, printer, panel, config, …).
    function activeUnit(doc) {
        doc = doc || (typeof document !== "undefined" ? document : null);
        if (!doc) return -1;
        var page = doc.querySelector(".page.active");
        if (!page || !page.id) return -1;
        return Object.prototype.hasOwnProperty.call(PAGE_UNIT, page.id)
            ? PAGE_UNIT[page.id]
            : -1;
    }

    // Is this terminal zoomed? Reads the live config when available, falling
    // back to the persisted value. Always a boolean.
    function isZoomed(unit) {
        if (typeof Config === "undefined") return false;
        var cfg = Config.get ? Config.get() : null;
        var flags = (cfg && cfg.vt52Zoom) || [];
        return !!flags[unit];
    }

    // Persist a new zoom flag for one terminal. The whole array is written back
    // (Config stores a scalar set, so the array is copied, not mutated in place).
    function setZoomed(unit, value) {
        if (typeof Config === "undefined" || !Config.set) return;
        var cfg = Config.get ? Config.get() : null;
        var flags = ((cfg && cfg.vt52Zoom) || [false, false, false]).slice();
        while (flags.length < 3) flags.push(false);
        flags[unit] = !!value;
        Config.set({ vt52Zoom: flags });
    }

    // Refresh the button icon/label for the terminal currently on screen.
    function updateUI() {
        var btn = (typeof document !== "undefined")
            ? document.getElementById("zoom-btn")
            : null;
        if (!btn) return false;
        var unit = activeUnit();
        var on = unit >= 0 && isZoomed(unit);
        var use = btn.querySelector("use");
        btn.classList.toggle("zoom-on", on);
        // Hidden, not disabled, where there is no VT52 terminal: a greyed-out
        // button still claims a corner and invites a click that can do nothing.
        // The other floating controls use the same .hidden convention.
        btn.classList.toggle("hidden", unit < 0);
        if (use) use.setAttribute("href", on ? "#icon-zoom-exit" : "#icon-zoom");
        btn.disabled = false;
        btn.setAttribute("aria-label", on ? "Restore the VT52 cabinet" : "Zoom the VT52 screen");
        btn.title = on ? "Restore the VT52 cabinet" : "Zoom the VT52 screen";
        return on;
    }

    // Apply the stored flag to the terminal on screen. Called on startup and
    // whenever the visible page changes, so a terminal comes back zoomed.
    function applyActive() {
        var unit = activeUnit();
        if (unit < 0) return;
        var page = document.querySelector(".page.active");
        if (!page) return;
        var rig = page.querySelector(".vt52-rig");
        if (!rig) return;
        if (isZoomed(unit)) {
            if (typeof window.vt52Zoom === "function") window.vt52Zoom(rig);
        } else if (typeof window.vt52Unzoom === "function") {
            window.vt52Unzoom(rig);
        }
    }

    function toggle() {
        var unit = activeUnit();
        if (unit < 0) return Promise.resolve(false);
        var next = !isZoomed(unit);
        setZoomed(unit, next);
        applyActive();
        updateUI();
        return Promise.resolve(next);
    }

    function init() {
        if (typeof document === "undefined" || typeof window === "undefined") return;
        var btn = document.getElementById("zoom-btn");
        if (!btn) return;

        btn.addEventListener("click", function () {
            toggle();
        });

        // The zoom flag is per terminal, so the button follows the page: it
        // re-reads the active terminal whenever navigation happens.
        document.addEventListener("yapdp:pagechange", function () {
            applyActive();
            updateUI();
        });

        applyActive();
        updateUI();
    }

    return {
        PAGE_UNIT: PAGE_UNIT,
        activeUnit: activeUnit,
        isZoomed: isZoomed,
        setZoomed: setZoomed,
        applyActive: applyActive,
        updateUI: updateUI,
        toggle: toggle,
        init: init
    };
})();

if (typeof window !== "undefined") {
    window.Vt52Zoom = Vt52Zoom;
}
