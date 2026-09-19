/**
 * yaPDP — startup loading gate (issue #77)
 *
 * On a slow link the emulator used to assemble itself on screen: the page
 * painted with the CSS fallback artwork, then the SVG art arrived and the
 * layers jumped, while fonts swapped and media kept downloading. The user saw
 * two different machines in a row.
 *
 * This module is the single readiness gate. The overlay itself is an INLINE
 * element in pdp11.html, so it is painted by the very first frame — a script
 * that arrives later could not cover the fallback it is supposed to hide.
 * Here we only decide WHEN to lift it.
 *
 * Boot-critical (the overlay waits for these):
 *   - the Model 33 artwork marker pass   (installTtyArtLayer, pdp11-app.js)
 *   - the terminal artwork marker pass   (vt52LoadArtwork, terminal-core.js)
 *   - the first-screen webfonts          (Courier Prime, VT323, Kalam,
 *                                         Michroma, VT52)
 *   - media/manifest.json
 *
 * NOT boot-critical, and deliberately not awaited: sounds, the room photo,
 * alternative panels, and the disk/tape images themselves (2-20 MB). They keep
 * loading in the background — a slow link stays slow, it just no longer looks
 * broken. See the discussion on #77.
 *
 * Every source is best-effort: a failure resolves its slot rather than
 * hanging the overlay. A hard CEILING_MS cap lifts the gate no matter what,
 * because an overlay that never leaves is worse than the bug it hides.
 *
 * Test hooks: window.__yapdpGate = { done, pending(), lift(), stages } — the
 * e2e suite (tests/e2e-loading-gate.js) asserts on these.
 */
"use strict";

var LoadingGate = (function () {
    // Hard cap: never hold the page hostage, whatever fails to arrive.
    var CEILING_MS = 15000;

    // Fonts that can appear on the first painted screen. Loading is requested
    // explicitly (the CSS may not have needed them yet) and awaited, so the
    // sticker/keycap swap cannot happen after the overlay is gone.
    var FONTS = [
        "400 20px 'Courier Prime'",
        "700 20px 'Courier Prime'",
        "400 20px 'VT323'",
        "400 20px 'Kalam'",
        "700 20px 'Kalam'",
        "400 20px 'Michroma'",
        "400 20px 'VT52'"
    ];

    // Stage id -> human label shown in the overlay (no percentages: #77 asked
    // for a spinner/stage text, not a progress bar).
    var STAGES = {
        artwork: "Drawing the machines\u2026",
        fonts: "Loading typefaces\u2026",
        media: "Reading the media\u2026"
    };

    var slots = {};      // stage id -> Promise (resolved when that work settles)
    var stageText = null;
    var done = false;
    var startedAt = Date.now();
    var ceilingTimer = null;
    var waiters = [];    // resolve callbacks of the public whenReady()

    function overlay() {
        return (typeof document === "undefined")
            ? null
            : document.getElementById("yapdp-loading");
    }

    function setStage(id) {
        var label = STAGES[id];
        var el = overlay();
        if (!el) return;
        // The overlay shows one live line; the class drives the CSS colour so
        // the text is visibly the "current" stage rather than a list.
        var line = el.querySelector(".yapdp-loading-stage");
        if (line && label) {
            line.textContent = label;
            line.setAttribute("data-stage", id);
        }
        stageText = id;
    }

    // Add one awaited slot. `work` must be a thenable (or null to skip); a
    // rejected slot is swallowed — the gate is a courtesy, not a validator.
    function expect(id, work) {
        if (!work || typeof work.then !== "function") return;
        setStage(id);
        slots[id] = Promise.resolve(work).catch(function () { /* best effort */ });
    }

    function pending() {
        return Object.keys(slots);
    }

    function lift(reason) {
        if (done) return;
        done = true;
        if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; }
        var el = overlay();
        if (el) {
            el.classList.add("yapdp-loading-done");
            // Remove it from the tree once the fade finished, so it can never
            // swallow a click or a keypress (it is pointer-events:none already,
            // this is belt and braces).
            var drop = function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            };
            el.addEventListener("transitionend", drop, { once: true });
            setTimeout(drop, 600);
        }
        if (typeof document !== "undefined") {
            document.documentElement.classList.remove("yapdp-booting");
            try {
                document.dispatchEvent(new CustomEvent("yapdp:ready", {
                    detail: { reason: reason || "settled", ms: Date.now() - startedAt,
                        stages: pending() }
                }));
            } catch (err) { /* ignore */ }
        }
        for (var i = 0; i < waiters.length; i++) waiters[i]();
        waiters = [];
    }

    // Wait for every registered slot, then lift. Always resolves.
    function settle() {
        var all = pending().map(function (k) { return slots[k]; });
        return Promise.all(all).then(function () { lift("settled"); },
            function () { lift("settled"); });
    }

    // Public: register the artwork slot and start the whole gate. Called by the
    // page once the two artwork passes have been kicked off, so their promises
    // (not a guess) decide when the drawing is really there.
    function start(sources) {
        sources = sources || {};
        expect("artwork", sources.artwork);
        expect("fonts", loadFonts());
        expect("media", loadManifest());
        ceilingTimer = setTimeout(function () { lift("ceiling"); }, CEILING_MS);
        return settle();
    }

    // Ask the browser for each first-screen face and wait for them. Resolves
    // even when the Font Loading API is missing (older/!browser contexts).
    function loadFonts() {
        if (typeof document === "undefined" || !document.fonts ||
            typeof document.fonts.load !== "function") {
            return Promise.resolve();
        }
        var jobs = FONTS.map(function (spec) {
            try {
                return document.fonts.load(spec).catch(function () { /* ignore */ });
            } catch (err) {
                return Promise.resolve();
            }
        });
        // fonts.ready covers faces the browser started on its own (CSS-driven);
        // the explicit loads above cover the ones the first screen needs but
        // nothing has asked for yet.
        return Promise.all(jobs.concat([
            (document.fonts.ready || Promise.resolve()).catch(function () {})
        ]));
    }

    // The manifest declares which images this build ships; QuickBoot already
    // fetches it, so reuse that promise when it is there (one request, not two).
    function loadManifest() {
        if (typeof fetch !== "function") return Promise.resolve();
        if (typeof QuickBoot !== "undefined" && QuickBoot &&
            typeof QuickBoot.manifest === "function") {
            try {
                return Promise.resolve(QuickBoot.manifest());
            } catch (err) { /* fall through to a plain fetch */ }
        }
        return fetch("media/manifest.json", { cache: "force-cache" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });
    }

    function whenReady() {
        if (done) return Promise.resolve();
        return new Promise(function (resolve) { waiters.push(resolve); });
    }

    return {
        start: start,
        lift: lift,
        settle: settle,
        whenReady: whenReady,
        isDone: function () { return done; },
        pending: pending,
        stage: function () { return stageText; },
        CEILING_MS: CEILING_MS
    };
})();

if (typeof window !== "undefined") window.LoadingGate = LoadingGate;
// When the gate module came alive. The e2e CLS suite times the GATE from here
// rather than from the navigation: on a throttled link the navigation alone
// takes minutes and says nothing about how long the overlay was up.
if (typeof window !== "undefined") window.__yapdpGateStartedAt = Date.now();
// The e2e suite reads this: `done` flips exactly when the overlay is lifted.
if (typeof window !== "undefined") {
    window.__yapdpGate = window.__yapdpGate || {};
    Object.defineProperty(window.__yapdpGate, "done", {
        get: function () { return LoadingGate.isDone(); },
        configurable: true
    });
    window.__yapdpGate.pending = function () { return LoadingGate.pending(); };
    window.__yapdpGate.stages = LoadingGate;   // STAGES/CEILING_MS live here
    window.__yapdpGate.lift = LoadingGate.lift;
}
