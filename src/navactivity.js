/**
 * yaPDP — Sidebar activity lamps.
 *
 * When the PDP-11 writes output to a console / user terminal / line printer,
 * a small green LED in the top-right corner of the matching sidebar button
 * blinks while the output flows and turns off ~0.5s after it stops (the same
 * behaviour as the LP11 READY LED, see lp11ReadyTick() in iopage.js).
 *
 * The mapping helpers (pageForConsole / pageForTerminal) are pure and
 * unit-testable in Node; pulse() is the DOM bridge that toggles the .on class
 * on the button's .nav-led element. The blink itself is pure CSS
 * (.nav-led.on in css/pdp11.css).
 *
 * Loaded before iopage.js, which calls NavActivity.pulse*() from the DL11
 * XBUF write path and the LP11 LPDB write path.
 */
var NavActivity = (function () {
    "use strict";

    // How long the lamp stays lit after the last output byte (ms).
    var LED_MS = 500;

    // page -> auto-off timer handle, so continuous output keeps re-arming it.
    var timers = {};

    // Pure mapping: a DL11 console unit (tty0) is either a teletype or a
    // VT52 DECscope, and the sidebar has one button per variant.
    function pageForConsole(consoleType) {
        return consoleType === "vt52" ? "vt52-console" : "teletype";
    }

    // Pure mapping: user DL11 units 1 and 2 map to their sidebar pages.
    function pageForTerminal(unit) {
        return unit === 1 ? "vt52" : "vt52-2";
    }

    function ledFor(page) {
        var btn = document.querySelector('.nav-btn[data-page="' + page + '"]');
        return btn ? btn.querySelector(".nav-led") : null;
    }

    // Light the lamp for `page` and keep it lit for LED_MS after the last
    // pulse. Missing buttons/elements (device not configured) are no-ops.
    function pulse(page) {
        if (!page) return;
        var led = ledFor(page);
        if (!led) return;
        led.classList.add("on");
        if (timers[page]) clearTimeout(timers[page]);
        timers[page] = setTimeout(function () {
            led.classList.remove("on");
            delete timers[page];
        }, LED_MS);
    }

    // Explicitly set the lamp on/off. Used by polling tickers that know the
    // device's true busy state (e.g. the LP11 READY LED ticker), so the lamp
    // reflects the whole print job rather than the CPU write pattern. Cancels
    // any pending auto-off timer.
    function set(page, active) {
        if (!page) return;
        var led = ledFor(page);
        if (!led) return;
        if (timers[page]) {
            clearTimeout(timers[page]);
            delete timers[page];
        }
        if (active) led.classList.add("on");
        else led.classList.remove("on");
    }

    function pulseConsole(consoleType) {
        pulse(pageForConsole(consoleType));
    }

    function pulseTerminal(unit) {
        pulse(pageForTerminal(unit));
    }

    return {
        pulse: pulse,
        set: set,
        pulseConsole: pulseConsole,
        pulseTerminal: pulseTerminal,
        pageForConsole: pageForConsole,
        pageForTerminal: pageForTerminal,
        LED_MS: LED_MS
    };
})();

if (typeof window !== "undefined") {
    window.NavActivity = NavActivity;
}
