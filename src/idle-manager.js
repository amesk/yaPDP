/**
 * yaPDP — configurable inactivity hand-off.
 *
 * Optional URL parameters:
 *   idle-timeout=<seconds>
 *   idle-redirect=<URL>
 *
 * Both parameters are required. With neither (or an invalid pair), this module
 * is inert. The redirect is a normal top-level navigation; it may point to a
 * different origin. Relative URLs are resolved against pdp11.html, which makes
 * "attract.html" work when yaPDP is hosted below a repository path on GitHub
 * Pages. Use location.replace() so Back does not resurrect the expired session.
 *
 * Five seconds before the hand-off the module raises a warning toast
 * ("Inactivity detected, activating idle mode..."). Any activity that restarts
 * the idle window withdraws it again, so the warning is only on screen while
 * the session is actually about to end.
 */
"use strict";

var IdleManager = (function () {
    "use strict";

    const POINTER_MOVE_THROTTLE_MS = 250;
    // The hand-off is announced this long before it happens, so an operator
    // standing near the exhibit still has time to touch the machine and keep
    // the session. A window shorter than the lead warns at once.
    const WARNING_LEAD_MS = 5000;
    const WARNING_TEXT = "Inactivity detected, activating idle mode...";
    // Key of the warning inside the Toasts subsystem (src/toasts.js): a reset
    // withdraws exactly this toast and never somebody else's.
    const WARNING_KEY = "idle-warning";
    // Browsers clamp setTimeout delays above 2^31-1 ms, and several fire such a
    // timer at once, so an absurd idle-timeout is capped instead of misbehaving.
    const MAX_TIMEOUT_MS = 2147483647;
    const ACTIVITY_EVENTS = [
        "pointerdown",
        "pointermove",
        "keydown",
        "wheel",
        "touchstart",
        "input",
        "change"
    ];

    function parseOptions(search) {
        const params = new URLSearchParams(String(search || ""));
        const timeoutText = params.get("idle-timeout");
        const redirect = params.get("idle-redirect");
        if (!timeoutText || !/^\d+$/.test(timeoutText) || !redirect || !redirect.trim()) {
            return null;
        }
        // The URL speaks seconds, timers speak milliseconds. Reading the value
        // as milliseconds made "?idle-timeout=30" a 30 ms wait — the page
        // redirected before the operator could touch the machine.
        const seconds = Number(timeoutText);
        if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
        const timeout = Math.min(seconds * 1000, MAX_TIMEOUT_MS);
        return { timeout: timeout, redirect: redirect.trim() };
    }

    function isTauriRuntime(base) {
        // Tauri 2 uses tauri://localhost on macOS/Linux and
        // http://tauri.localhost on Windows. These are app origins, not
        // ordinary web pages.
        return (base.protocol === "tauri:" && base.hostname === "localhost") ||
            ((base.protocol === "http:" || base.protocol === "https:") &&
                base.hostname === "tauri.localhost");
    }

    function resolveRedirect(redirect, base) {
        const source = new URL(base);
        let value = String(redirect).trim();

        // Accept a native Windows absolute path in local/Tauri deployments.
        // URL() otherwise interprets "D:\\..." as a custom URL scheme.
        if (/^[a-zA-Z]:[\\/]/.test(value)) {
            if (source.protocol !== "file:" && !isTauriRuntime(source)) {
                throw new TypeError("Local file redirects are not allowed from web pages");
            }
            const normalized = value.replace(/\\/g, "/");
            const drive = normalized.slice(0, 2);
            const segments = normalized.slice(3).split("/");
            value = "file:///" + drive + "/" + segments.map(encodeURIComponent).join("/");
        }

        const target = new URL(value, source);
        const webTarget = target.protocol === "http:" || target.protocol === "https:";
        const localFileTarget = target.protocol === "file:" &&
            (source.protocol === "file:" || isTauriRuntime(source));

        // A normal web page must never be able to navigate to a local file.
        // Local launches and the Tauri app may use an operator-configured file
        // anywhere on disk; the attract page need not live beside yaPDP.
        if (!webTarget && !localFileTarget) {
            throw new TypeError("Unsupported idle redirect protocol: " + target.protocol);
        }
        return target.href;
    }

    function create(options, environment) {
        const env = environment || {};
        const doc = env.document || (typeof document !== "undefined" ? document : null);
        const win = env.window || (typeof window !== "undefined" ? window : null);
        const set = env.setTimeout || setTimeout;
        const clear = env.clearTimeout || clearTimeout;
        const now = env.now || Date.now;
        if (!doc || !win || !options || !(options.timeout > 0) || !options.redirect) {
            return { active: false, reset: function () {}, stop: function () {} };
        }

        const destination = resolveRedirect(options.redirect, win.location.href);
        // src/toasts.js is loaded AFTER this module in pdp11.html, so the toast
        // backend is resolved lazily; tests inject their own stub instead.
        const toasts = env.toasts || null;
        let timer = null;
        let warnTimer = null;
        let warningUp = false;
        let active = true;
        let lastPointerMove = 0;

        function callToasts(method, payload) {
            const backend = toasts || win.Toasts;
            if (backend && typeof backend[method] === "function") backend[method](payload);
        }

        // The operator is back: the hand-off is no longer imminent, so the
        // warning goes away without disturbing the rest of the toast queue.
        function withdrawWarning() {
            if (!warningUp) return;
            warningUp = false;
            callToasts("hide", WARNING_KEY);
        }

        function raiseWarning() {
            warnTimer = null;
            if (!active) return;
            warningUp = true;
            callToasts("show", {
                text: WARNING_TEXT,
                // A warning, not a failure: the session is still alive and one
                // touch cancels the hand-off.
                category: "warning",
                key: WARNING_KEY,
                // The warning lives no longer than the time it announces.
                duration: Math.min(WARNING_LEAD_MS, options.timeout)
            });
        }

        function stop() {
            if (!active) return;
            active = false;
            if (timer !== null) clear(timer);
            timer = null;
            if (warnTimer !== null) clear(warnTimer);
            warnTimer = null;
            withdrawWarning();
            ACTIVITY_EVENTS.forEach((name) => {
                doc.removeEventListener(name, onActivity, true);
            });
            doc.removeEventListener("visibilitychange", onVisibilityChange, true);
        }

        function expire() {
            if (!active) return;
            stop();
            win.location.replace(destination);
        }

        function reset() {
            if (!active) return;
            if (timer !== null) clear(timer);
            if (warnTimer !== null) clear(warnTimer);
            withdrawWarning();
            // A window shorter than the lead is already past the warning point,
            // so its timer fires at once instead of never.
            warnTimer = set(raiseWarning, Math.max(0, options.timeout - WARNING_LEAD_MS));
            timer = set(expire, options.timeout);
        }

        function onActivity(event) {
            if (event && event.type === "pointermove") {
                const stamp = now();
                if (stamp - lastPointerMove < POINTER_MOVE_THROTTLE_MS) return;
                lastPointerMove = stamp;
            }
            reset();
        }

        function onVisibilityChange() {
            // Returning to the kiosk after a browser/system interruption counts
            // as fresh activity. Time spent in the background still expires.
            if (!doc.hidden) reset();
        }

        ACTIVITY_EVENTS.forEach((name) => {
            doc.addEventListener(name, onActivity, { capture: true, passive: true });
        });
        doc.addEventListener("visibilitychange", onVisibilityChange, true);
        reset();

        return {
            get active() {
                return active;
            },
            reset: reset,
            stop: stop,
            destination: destination
        };
    }

    function init() {
        if (typeof window === "undefined" || typeof document === "undefined") return null;
        const options = parseOptions(window.location.search);
        if (!options) return null;

        const start = function () {
            if (!window.__yapdpIdleManager) {
                window.__yapdpIdleManager = create(options, { window: window, document: document });
            }
        };
        if (document.readyState === "complete") start();
        else window.addEventListener("load", start, { once: true });
        return options;
    }

    return {
        parseOptions: parseOptions,
        resolveRedirect: resolveRedirect,
        create: create,
        init: init,
        POINTER_MOVE_THROTTLE_MS: POINTER_MOVE_THROTTLE_MS,
        WARNING_LEAD_MS: WARNING_LEAD_MS,
        WARNING_TEXT: WARNING_TEXT,
        WARNING_KEY: WARNING_KEY
    };
})();

if (typeof window !== "undefined") window.IdleManager = IdleManager;
if (typeof module !== "undefined" && module.exports) module.exports = { IdleManager };

// This module is loaded by pdp11.html on every build; without the URL pair it
// installs no listeners and creates no timer.
if (typeof window !== "undefined" && typeof document !== "undefined") {
    IdleManager.init();
}
