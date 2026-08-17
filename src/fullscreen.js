/**
 * yaPDP — Floating fullscreen toggle.
 *
 * A single floating button (top-right of the window) hides the "chrome"
 * around the emulator:
 *   - browser: the standard Fullscreen API (requestFullscreen / exitFullscreen)
 *     hides the address bar and the rest of the browser UI;
 *   - Tauri desktop: the native window fullscreen (getCurrentWindow()
 *     -> isFullscreen()/setFullscreen()) hides the OS window frame and the
 *     taskbar, which the web Fullscreen API cannot do.
 *
 * The button is a plain <button id="fullscreen-btn"> with no data-page, so
 * the sidebar navigation (pdp11-panel.js) never treats it as a page switch.
 * The button state stays in sync via the fullscreenchange event (browser) and
 * the window's resize event (Tauri native fullscreen fires no DOM event).
 *
 * The decision helpers are DOM-free and take explicit runtime objects, so the
 * module can be unit-tested in Node (see tests/fullscreen.test.js).
 *
 * Must be loaded after tauri-bundled.js (consistent Tauri detection) and
 * before pdp11-app.js.
 */
"use strict";

var Fullscreen = (function () {
    "use strict";

    // Detect the Tauri runtime from an injected `win` object (the browser
    // global is used by default). The native window object exposes
    // getCurrentWindow(), which is absent in a plain browser.
    function isTauri(win) {
        win = win || (typeof window !== "undefined" ? window : null);
        return !!(win && win.__TAURI__ && win.__TAURI__.window &&
            typeof win.__TAURI__.window.getCurrentWindow === "function");
    }

    // Is the DOM currently in fullscreen? Handles both modern browsers that
    // expose fullscreenElement and older ones still using the webkit prefix.
    function isBrowserFullscreen(doc) {
        doc = doc || (typeof document !== "undefined" ? document : null);
        return !!(doc && (doc.fullscreenElement || doc.webkitFullscreenElement));
    }

    // Enter browser fullscreen on the root element (webkit fallback).
    function requestBrowserFullscreen(doc) {
        doc = doc || (typeof document !== "undefined" ? document : null);
        if (!doc) return Promise.reject(new Error("document unavailable"));
        var el = doc.documentElement;
        if (el && el.requestFullscreen) return Promise.resolve(el.requestFullscreen());
        if (el && el.webkitRequestFullscreen) return Promise.resolve(el.webkitRequestFullscreen());
        return Promise.reject(new Error("Fullscreen API not supported"));
    }

    // Leave browser fullscreen (webkit fallback).
    function exitBrowserFullscreen(doc) {
        doc = doc || (typeof document !== "undefined" ? document : null);
        if (!doc) return Promise.reject(new Error("document unavailable"));
        if (doc.exitFullscreen) return Promise.resolve(doc.exitFullscreen());
        if (doc.webkitExitFullscreen) return Promise.resolve(doc.webkitExitFullscreen());
        return Promise.reject(new Error("Fullscreen API not supported"));
    }

    // Resolve the current fullscreen state as a Promise<boolean>
    // (true = fullscreen is active).
    function current(win, doc) {
        if (isTauri(win)) {
            var w = win.__TAURI__.window.getCurrentWindow();
            return Promise.resolve(
                (w && typeof w.isFullscreen === "function") ? w.isFullscreen() : false
            );
        }
        return Promise.resolve(isBrowserFullscreen(doc));
    }

    // Toggle fullscreen: the native Tauri window API on desktop, the browser
    // Fullscreen API elsewhere. Returns a Promise that resolves when the
    // state change has been requested.
    function toggle(win, doc) {
        win = win || (typeof window !== "undefined" ? window : null);
        doc = doc || (typeof document !== "undefined" ? document : null);
        if (isTauri(win)) {
            var w = win.__TAURI__.window.getCurrentWindow();
            return Promise.resolve()
                .then(function () {
                    return (w && typeof w.isFullscreen === "function") ? w.isFullscreen() : false;
                })
                .then(function (fs) {
                    if (w && typeof w.setFullscreen === "function") return w.setFullscreen(!fs);
                    throw new Error("Tauri setFullscreen unavailable");
                });
        }
        return isBrowserFullscreen(doc)
            ? exitBrowserFullscreen(doc)
            : requestBrowserFullscreen(doc);
    }

    // Refresh the button icon/label to reflect the current fullscreen state.
    // Best-effort: resolves false if the button or the state query is missing.
    function updateUI() {
        var btn = (typeof document !== "undefined") ? document.getElementById("fullscreen-btn") : null;
        if (!btn) return Promise.resolve(false);
        var use = btn.querySelector("use");
        return current().then(function (fs) {
            btn.classList.toggle("fullscreen-on", fs);
            if (use) use.setAttribute("href", fs ? "#icon-fullscreen-exit" : "#icon-fullscreen");
            btn.setAttribute("aria-label", fs ? "Exit fullscreen" : "Enter fullscreen");
            btn.title = fs ? "Exit fullscreen (Esc)" : "Enter fullscreen";
            return fs;
        }).catch(function () {
            return false;
        });
    }

    function init() {
        // No-op outside a real browser environment (Node test sandbox).
        if (typeof document === "undefined" || typeof window === "undefined") return;

        var btn = document.getElementById("fullscreen-btn");
        if (!btn) return;

        btn.addEventListener("click", function () {
            toggle().then(updateUI).catch(function (err) {
                console.warn("Fullscreen toggle failed:", err);
            });
        });

        // Browser fullscreen can be toggled without the button (Esc, the
        // context menu) — keep the icon in sync.
        document.addEventListener("fullscreenchange", updateUI);
        document.addEventListener("webkitfullscreenchange", updateUI);

        // Tauri native fullscreen emits no DOM fullscreenchange, but it does
        // resize the window, so re-query the state on resize.
        if (isTauri()) {
            try {
                var w = window.__TAURI__.window.getCurrentWindow();
                if (w && typeof w.onResized === "function") {
                    w.onResized(updateUI);
                }
            } catch (err) { /* ignore listener registration errors */ }
        }

        // In the desktop app F11 is not reserved by a browser, so wire it as a
        // convenient shortcut. In a browser F11 is handled natively and the
        // fullscreenchange listener above keeps the icon correct.
        document.addEventListener("keydown", function (e) {
            if (isTauri() && e.key === "F11") {
                e.preventDefault();
                toggle().then(updateUI).catch(function (err) {
                    console.warn("Fullscreen toggle failed:", err);
                });
            }
        });

        updateUI();
    }

    // Auto-start once the DOM is ready.
    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }

    return {
        isTauri: isTauri,
        isBrowserFullscreen: isBrowserFullscreen,
        current: current,
        toggle: toggle,
        updateUI: updateUI,
        init: init
    };
})();

// Expose to the browser build (Node tests read the object from the sandbox).
if (typeof window !== "undefined") {
    window.Fullscreen = Fullscreen;
}
