/**
 * yaPDP — host-level emulation pause coordination.
 *
 * This is intentionally separate from the PDP-11 RUN/WAIT/HALT state: pause
 * freezes virtual execution without changing any guest-visible CPU or device
 * registers. The session-scoped flag survives a reload used by state/config
 * restoration, but is not stored in machine snapshots.
 */
(function (root) {
    "use strict";

    var STORAGE_KEY = "yapdp.emulation-paused";
    var handlers = Object.create(null);
    var paused = false;

    try {
        paused = !!(root.sessionStorage &&
            root.sessionStorage.getItem(STORAGE_KEY) === "1");
    } catch (e) {
        // Storage can be unavailable in privacy-restricted browser contexts.
    }

    function safelyCall(handler, method) {
        if (!handler || typeof handler[method] !== "function") return;
        try {
            handler[method]();
        } catch (error) {
            if (root.console && typeof root.console.error === "function") {
                root.console.error("EmulationControl " + method + " handler failed:", error);
            }
        }
    }

    function notifyState() {
        if (!root.document || typeof root.document.dispatchEvent !== "function" ||
            typeof root.CustomEvent !== "function") return;
        root.document.dispatchEvent(new root.CustomEvent("yapdp:emulation-state", {
            detail: { paused: paused }
        }));
    }

    function persistState() {
        try {
            if (!root.sessionStorage) return;
            if (paused) root.sessionStorage.setItem(STORAGE_KEY, "1");
            else root.sessionStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            // Pausing still works when sessionStorage is unavailable.
        }
    }

    function setPaused(next) {
        next = !!next;
        if (paused === next) return false;
        paused = next;
        persistState();

        Object.keys(handlers).forEach(function (name) {
            safelyCall(handlers[name], paused ? "pause" : "resume");
        });
        notifyState();
        return true;
    }

    function register(name, handler) {
        if (!name || !handler) throw new TypeError("A name and handler are required");
        handlers[name] = handler;
        // A module may load after the page has restored a paused session.
        safelyCall(handler, paused ? "pause" : "resume-if-needed");
        return function () {
            if (handlers[name] === handler) delete handlers[name];
        };
    }

    root.EmulationControl = {
        isPaused: function () { return paused; },
        pause: function () { return setPaused(true); },
        resume: function () { return setPaused(false); },
        toggle: function () { return setPaused(!paused); },
        register: register
    };
})(typeof window !== "undefined" ? window : globalThis);
