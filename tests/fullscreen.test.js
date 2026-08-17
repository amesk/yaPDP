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

    console.log("\nAll Fullscreen tests passed.");
}

run().catch((err) => {
    console.error("Fullscreen test failure:", err && err.message ? err.message : err);
    process.exitCode = 1;
});
