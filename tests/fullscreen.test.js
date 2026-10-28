#!/usr/bin/env node
/**
 * Fullscreen toggle modular tests.
 *
 * Loads the real production module (src/fullscreen.js) in an isolated VM
 * context and exercises its DOM-free decision helpers with stubbed window/
 * document globals:
 *   - isTauri()          — Tauri runtime detection
 *   - isBrowserFullscreen() — Fullscreen API state detection (incl. webkit)
 *   - current()          — resolved fullscreen state (browser + Tauri)
 *   - toggle()           — routes to browser requestFullscreen/exitFullscreen
 *                          or Tauri setFullscreen(!state) as appropriate
 *
 * The module must also load cleanly in a bare sandbox (no window/document),
 * mirroring how it boots in Node before the DOM is available.
 *
 * Run with:  node tests/fullscreen.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "fullscreen.js");

function loadModule() {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var Fullscreen = ...` at top level becomes a property of the sandbox.
    return sandbox.Fullscreen;
}

// Load the module with browser globals injected, so the auto-init path runs the
// same way it does in the desktop app.
function loadModuleWithGlobals(globals) {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = Object.assign({ console }, globals);
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.Fullscreen;
}

// Minimal document stub: no #fullscreen-btn, so init() stays a no-op.
function makeEmptyDocument() {
    return {
        readyState: "complete",
        getElementById: () => null,
        addEventListener: () => {}
    };
}

// Minimal <button id="fullscreen-btn"> stub used by updateUI().
function makeFullscreenButton() {
    const attrs = {};
    const useAttrs = {};
    const classes = new Set();
    return {
        title: "",
        attrs,
        useAttrs,
        classes,
        querySelector: (sel) => (sel === "use"
            ? { setAttribute: (k, v) => { useAttrs[k] = v; } }
            : null),
        classList: {
            toggle: (cls, on) => { if (on) classes.add(cls); else classes.delete(cls); }
        },
        setAttribute: (k, v) => { attrs[k] = v; },
        addEventListener: () => {}
    };
}

function makeDocumentWithButton(btn) {
    return {
        readyState: "complete",
        getElementById: (id) => (id === "fullscreen-btn" ? btn : null),
        addEventListener: () => {}
    };
}

// A Tauri-like window stub whose native fullscreen state can be inspected.
function makeTauriWindow(initialFullscreen) {
    let fullscreen = initialFullscreen;
    const calls = { isFullscreen: 0, setFullscreen: 0 };
    return {
        win: {
            __TAURI__: {
                window: {
                    getCurrentWindow: () => ({
                        isFullscreen: () => {
                            calls.isFullscreen++;
                            return Promise.resolve(fullscreen);
                        },
                        setFullscreen: (v) => {
                            calls.setFullscreen++;
                            fullscreen = v;
                            return Promise.resolve();
                        }
                    })
                }
            }
        },
        calls,
        state: () => fullscreen
    };
}

async function run() {
    const F = loadModule();
    assert.ok(F, "module should expose Fullscreen");

    // ---- bare sandbox must load without window/document --------------
    assert.strictEqual(F.isTauri(undefined), false,
        "no Tauri in a bare environment");
    assert.strictEqual(F.isBrowserFullscreen(undefined), false,
        "no fullscreen in a bare environment");

    // ---- isTauri -----------------------------------------------------
    {
        assert.strictEqual(
            F.isTauri({ __TAURI__: { window: { getCurrentWindow: () => {} } } }), true,
            "Tauri runtime with getCurrentWindow detected");
        assert.strictEqual(F.isTauri({ __TAURI__: {} }), false,
            "partial __TAURI__ without window API is not Tauri");
        assert.strictEqual(F.isTauri({}), false,
            "plain object is not Tauri");
        assert.strictEqual(F.isTauri(null), false,
            "null is not Tauri");
    }

    // ---- isBrowserFullscreen -----------------------------------------
    {
        assert.strictEqual(F.isBrowserFullscreen({ fullscreenElement: {} }), true,
            "fullscreenElement set => fullscreen");
        assert.strictEqual(F.isBrowserFullscreen({ webkitFullscreenElement: {} }), true,
            "webkitFullscreenElement set => fullscreen");
        assert.strictEqual(F.isBrowserFullscreen({ fullscreenElement: null }), false,
            "no fullscreen element => not fullscreen");
        assert.strictEqual(F.isBrowserFullscreen({}), false,
            "empty document => not fullscreen");
        assert.strictEqual(F.isBrowserFullscreen(null), false,
            "null document => not fullscreen");
    }

    // ---- current (browser) -------------------------------------------
    {
        assert.strictEqual(await F.current({}, { fullscreenElement: null }), false,
            "browser current resolves false when not fullscreen");
        assert.strictEqual(await F.current({}, { fullscreenElement: {} }), true,
            "browser current resolves true when fullscreen");
        assert.strictEqual(await F.current({}, { webkitFullscreenElement: {} }), true,
            "browser current honours webkit prefix");
    }

    // ---- current (Tauri) ---------------------------------------------
    {
        const on = makeTauriWindow(true);
        assert.strictEqual(await F.current(on.win, {}), true,
            "tauri current resolves true when native fullscreen");
        const off = makeTauriWindow(false);
        assert.strictEqual(await F.current(off.win, {}), false,
            "tauri current resolves false when not fullscreen");
    }

    // ---- toggle (browser: enter fullscreen) --------------------------
    {
        const calls = { request: 0, exit: 0 };
        const doc = {
            fullscreenElement: null,
            documentElement: {
                requestFullscreen: () => { calls.request++; return Promise.resolve(); }
            },
            exitFullscreen: () => { calls.exit++; return Promise.resolve(); }
        };
        await F.toggle({}, doc);
        assert.strictEqual(calls.request, 1, "browser enter calls requestFullscreen");
        assert.strictEqual(calls.exit, 0, "browser enter must not call exitFullscreen");
    }

    // ---- toggle (browser: exit fullscreen) ---------------------------
    {
        const calls = { request: 0, exit: 0 };
        const doc = {
            fullscreenElement: {},
            documentElement: {},
            exitFullscreen: () => { calls.exit++; return Promise.resolve(); }
        };
        await F.toggle({}, doc);
        assert.strictEqual(calls.exit, 1, "browser exit calls exitFullscreen");
        assert.strictEqual(calls.request, 0, "browser exit must not call requestFullscreen");
    }

    // ---- toggle (Tauri) ----------------------------------------------
    {
        const off = makeTauriWindow(false);
        await F.toggle(off.win, {});
        assert.strictEqual(off.state(), true, "tauri toggle enters fullscreen when off");
        assert.strictEqual(off.calls.isFullscreen, 1, "tauri toggle queries state first");
        assert.strictEqual(off.calls.setFullscreen, 1, "tauri toggle calls setFullscreen");

        const on = makeTauriWindow(true);
        await F.toggle(on.win, {});
        assert.strictEqual(on.state(), false, "tauri toggle exits fullscreen when on");
    }

    // ---- current()/updateUI() resolve the globals themselves ------------
    // Regression: current() used to default `win` inside isTauri() only and
    // then dereference the raw argument, so updateUI() threw in the desktop
    // app (Tauri) and a successful toggle was reported as a failure.
    {
        const on = makeTauriWindow(true);
        const WithGlobals = loadModuleWithGlobals({
            window: on.win,
            document: makeEmptyDocument()
        });
        assert.strictEqual(await WithGlobals.current(), true,
            "current() without arguments uses the global Tauri window");
        assert.strictEqual(await WithGlobals.updateUI(), false,
            "updateUI() without a button resolves false instead of throwing");

        const off = makeTauriWindow(false);
        const WithGlobalsOff = loadModuleWithGlobals({
            window: off.win,
            document: makeEmptyDocument()
        });
        assert.strictEqual(await WithGlobalsOff.current(), false,
            "current() without arguments reports native fullscreen off");
    }

    // ---- updateUI() reflects the Tauri state on the button ---------------
    {
        const btn = makeFullscreenButton();
        const on = makeTauriWindow(true);
        const WithButton = loadModuleWithGlobals({
            window: on.win,
            document: makeDocumentWithButton(btn)
        });
        assert.strictEqual(await WithButton.updateUI(), true,
            "updateUI() resolves the native fullscreen state");
        assert.ok(btn.classes.has("fullscreen-on"),
            "updateUI() marks the button as fullscreen");
        assert.strictEqual(btn.useAttrs.href, "#icon-fullscreen-exit",
            "updateUI() swaps the icon to the exit variant");
        assert.strictEqual(btn.attrs["aria-label"], "Exit fullscreen",
            "updateUI() updates the accessible label");
    }

    console.log("\nAll Fullscreen tests passed.");
}

run().catch((err) => {
    console.error("Fullscreen test failure:", err && err.message ? err.message : err);
    process.exitCode = 1;
});
