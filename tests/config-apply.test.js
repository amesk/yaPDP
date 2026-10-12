#!/usr/bin/env node
/**
 * ConfigApply seam tests.
 *
 * ConfigApply (src/config-apply.js) is the explicit seam between the page's
 * live applier (src/pdp11-app.js, which registers it) and the consumers that
 * change the config (src/snapshots.js, which requests it). Its contract:
 *   - applyLive() is a silent no-op until register() runs;
 *   - after register(fn), applyLive() forwards the CURRENT Config.get();
 *   - register(null) clears the registration.
 *
 * Loads the real src/config.js + src/config-apply.js in one VM context.
 * Run with:  node tests/config-apply.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const CONFIG_PATH = path.join(__dirname, "..", "src", "config.js");
const APPLY_PATH = path.join(__dirname, "..", "src", "config-apply.js");

function load() {
    const sb = { console };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(CONFIG_PATH, "utf8"), sb);
    vm.runInContext(fs.readFileSync(APPLY_PATH, "utf8"), sb);
    return { sb, CA: sb.ConfigApply };
}

function run() {
    const { sb, CA } = load();
    assert.ok(CA, "module should expose ConfigApply");

    // ---- no applier yet: applyLive is a silent no-op -----------------
    assert.doesNotThrow(() => CA.applyLive(), "applyLive before register must not throw");

    // ---- register() then applyLive() forwards the current config ----
    let seen = null;
    CA.register(function (cfg) { seen = cfg; });
    sb.Config.set({ consoleType: "vt52" });
    CA.applyLive();
    assert.ok(seen, "applier was called");
    assert.strictEqual(seen.consoleType, "vt52", "the live config is forwarded");

    // ---- a non-function clears the registration ---------------------
    CA.register(null);
    seen = null;
    CA.applyLive();
    assert.strictEqual(seen, null, "no applier after clearing");

    // ---- garbage input is refused the same way ----------------------
    CA.register("nope");
    seen = null;
    CA.applyLive();
    assert.strictEqual(seen, null, "a non-function registration is ignored");

    console.log("config-apply.test.js: all tests passed");
}

run();
