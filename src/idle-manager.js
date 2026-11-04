/**
 * yaPDP — configurable inactivity hand-off.
 *
 * Optional URL parameters:
 *   idle-timeout=<milliseconds>
 *   idle-redirect=<URL>
 *
 * Both parameters are required. With neither (or an invalid pair), this module
 * is inert. The redirect is a normal top-level navigation; it may point to a
 * different origin. Relative URLs are resolved against pdp11.html, which makes
 * "attract.html" work when yaPDP is hosted below a repository path on GitHub
 * Pages. Use location.replace() so Back does not resurrect the expired session.
 */
"use strict";

var IdleManager = (function () {
    "use strict";

    const POINTER_MOVE_THROTTLE_MS = 250;
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
        const timeout = Number(timeoutText);
        if (!Number.isSafeInteger(timeout) || timeout <= 0) return null;
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
        let timer = null;
        let active = true;
        let lastPointerMove = 0;

        function stop() {
            if (!active) return;
            active = false;
            if (timer !== null) clear(timer);
            timer = null;
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
        POINTER_MOVE_THROTTLE_MS: POINTER_MOVE_THROTTLE_MS
    };
})();

if (typeof window !== "undefined") window.IdleManager = IdleManager;
if (typeof module !== "undefined" && module.exports) module.exports = { IdleManager };

// This module is loaded by pdp11.html on every build; without the URL pair it
// installs no listeners and creates no timer.
if (typeof window !== "undefined" && typeof document !== "undefined") {
    IdleManager.init();
}
