#!/usr/bin/env node
/**
 * Configuration-profile tests for the SnapshotStore.
 *
 * Pins the rule this change exists to enforce: a state carries the WHOLE
 * configuration MINUS the sound settings.
 *   - captureConfig()  records everything except mute/hum;
 *   - applySnapshotConfig() applies the profile (sound untouched), remembers
 *     the viewer's configuration ONCE, and re-tunes live instances;
 *   - configNeedsReload() fires only on the device set (zoom/glow never reload);
 *   - configDiffers() ignores mute/hum;
 *   - rollbackToBaseline() returns the viewer's remembered configuration and
 *     reloads only when the device set differs.
 *
 * Loads the REAL modules (src/config.js, src/viewer-config.js,
 * src/state-format.js, src/state-frame.js) plus the SnapshotStore IIFE into one
 * VM context, with a Map-backed localStorage and a headless (no-document) page.
 *
 * Run with:  node tests/snapshot-config.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SNAP_PATH = path.join(ROOT, "src", "snapshots.js");
const CONFIG_PATH = path.join(ROOT, "src", "config.js");
const VIEWER_PATH = path.join(ROOT, "src", "viewer-config.js");
const SF_PATH = path.join(ROOT, "src", "state-format.js");
const FRAME_PATH = path.join(ROOT, "src", "state-frame.js");

// Same balanced-brace extractor as tests/snapshotstore.test.js: only the
// SnapshotStore IIFE is run, without the page-startup tail.
function extractIIFE(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error("marker not found: " + startMarker);
    const braceOpen = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(start, i + 2 + 2); // "})();"
        }
    }
    throw new Error("unbalanced braces for: " + startMarker);
}

function makeStorage(init) {
    const map = new Map(Object.entries(init || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function build() {
    const state = { reloads: 0, hookCalls: 0 };
    const sb = {
        console,
        setTimeout, clearTimeout, setInterval: () => 0,
        TextEncoder, TextDecoder,
    };
    sb.localStorage = makeStorage();
    sb.window = {
        localStorage: sb.localStorage,
        __yapdpApplyConfigLive: () => { state.hookCalls++; },
    };
    sb.location = { reload: () => { state.reloads++; } };
    vm.createContext(sb);
    // Order mirrors the page: config, the viewer's baseline store, then the
    // shared state format the store delegates its bytes to.
    vm.runInContext(fs.readFileSync(CONFIG_PATH, "utf8"), sb);
    vm.runInContext(fs.readFileSync(VIEWER_PATH, "utf8"), sb);
    vm.runInContext(fs.readFileSync(SF_PATH, "utf8"), sb);
    vm.runInContext(fs.readFileSync(FRAME_PATH, "utf8"), sb);
    const code = extractIIFE(fs.readFileSync(SNAP_PATH, "utf8"),
        "var SnapshotStore = (() => {");
    vm.runInContext(code, sb);
    return { sb, SS: sb.SnapshotStore, Config: sb.Config, ViewerConfig: sb.ViewerConfig, state };
}

function run() {
    // ---- captureConfig: whole config minus the sound settings --------
    {
        const { SS, Config } = build();
        Config.set({
            consoleType: "vt52", printer: true, printerWidth: 80,
            vt52Zoom: [true, false, false], mute: true, hum: false,
        });
        const cap = SS.captureConfig();
        assert.strictEqual("mute" in cap, false, "mute is never captured");
        assert.strictEqual("hum" in cap, false, "hum is never captured");
        assert.strictEqual(cap.consoleType, "vt52");
        assert.strictEqual(cap.printer, true);
        assert.strictEqual(cap.printerWidth, 80);
        assert.deepStrictEqual(plain(cap.vt52Zoom), [true, false, false]);
        console.log("PASS captureConfig: whole config minus mute/hum");
    }

    // ---- applySnapshotConfig: apply all, keep sound, baseline once ---
    {
        const { SS, Config, ViewerConfig, state } = build();
        // The viewer's own configuration, before any state.
        Config.set({
            consoleType: "teletype", printer: false, printerWidth: 132,
            vt52Zoom: [false, false, false], mute: true, hum: true,
        });
        ViewerConfig.clear();
        state.hookCalls = 0;

        SS.applySnapshotConfig({ config: {
            consoleType: "vt52", printer: true, printerWidth: 80,
            vt52Zoom: [true, true, true], mute: false, hum: false,
        } });
        const cur = Config.get();
        assert.strictEqual(cur.consoleType, "vt52", "structural applied");
        assert.strictEqual(cur.printer, true);
        assert.strictEqual(cur.printerWidth, 80, "live field applied");
        assert.deepStrictEqual(plain(cur.vt52Zoom), [true, true, true]);
        assert.strictEqual(cur.mute, true, "viewer's mute untouched");
        assert.strictEqual(cur.hum, true, "viewer's hum untouched");
        assert.ok(state.hookCalls >= 1, "live re-tune hook called");

        // The baseline is the viewer's PRE-state configuration.
        const base = ViewerConfig.get();
        assert.strictEqual(base.consoleType, "teletype");
        assert.strictEqual(base.printerWidth, 132);

        // A second state in the same chain must NOT overwrite the baseline.
        SS.applySnapshotConfig({ config: { consoleType: "vt100" } });
        assert.strictEqual(ViewerConfig.get().consoleType, "teletype",
            "baseline survives a run of applied states");
        assert.strictEqual(Config.get().consoleType, "vt100", "second state applied");
        console.log("PASS applySnapshotConfig: applies profile, keeps sound, baseline once");
    }

    // ---- configNeedsReload: device set only --------------------------
    {
        const { SS, Config } = build();
        Config.set({
            consoleType: "teletype", userTerminals: 0,
            userTerminalTypes: ["vt52", "vt52"], printer: false, vt11: false,
        });
        assert.strictEqual(SS.configNeedsReload(null), false);
        assert.strictEqual(SS.configNeedsReload({ config: { consoleType: "vt52" } }), true);
        assert.strictEqual(SS.configNeedsReload({ config: { printer: true } }), true);
        // Live fields never force a reload.
        assert.strictEqual(SS.configNeedsReload({ config: { vt52Zoom: [true, false, false] } }), false);
        assert.strictEqual(SS.configNeedsReload({ config: { printerWidth: 80 } }), false);
        assert.strictEqual(SS.configNeedsReload({ config: { crtEffects: false } }), false);
        console.log("PASS configNeedsReload: only the device set");
    }

    // ---- configDiffers: sound ignored --------------------------------
    {
        const { SS, Config } = build();
        const a = Config.get();
        const soundOnly = Object.assign({}, a, { mute: !a.mute, hum: !a.hum });
        assert.strictEqual(SS.configDiffers(a, soundOnly), false,
            "a sound-only change is not a difference");
        const zoom = Object.assign({}, a, { vt52Zoom: [true, false, false] });
        assert.strictEqual(SS.configDiffers(a, zoom), true, "a live field counts");
        console.log("PASS configDiffers: ignores mute/hum");
    }

    // ---- rollbackToBaseline: reload only on a structural change ------
    {
        const { SS, Config, ViewerConfig, state } = build();
        // Baseline differs structurally (console teletype vs vt52).
        ViewerConfig.clear();
        Config.set({ consoleType: "teletype", printerWidth: 132 });
        ViewerConfig.remember(Config.get());
        Config.set({ consoleType: "vt52", printerWidth: 80 });
        state.reloads = 0;

        const r1 = SS.rollbackToBaseline();
        assert.strictEqual(r1, "reloading", "structural rollback reloads");
        assert.strictEqual(state.reloads, 1, "one reload");
        assert.strictEqual(Config.get().consoleType, "teletype", "baseline applied");
        assert.strictEqual(Config.get().printerWidth, 132);
        assert.strictEqual(ViewerConfig.get(), null, "baseline cleared");

        // Baseline differs only in a live field (same device set).
        Config.set({ consoleType: "teletype", vt52Zoom: [false, false, false] });
        ViewerConfig.remember(Config.get());
        Config.set({ vt52Zoom: [true, true, true] });
        state.reloads = 0;

        const r2 = SS.rollbackToBaseline();
        assert.strictEqual(r2, "proceed", "live-only rollback needs no reload");
        assert.strictEqual(state.reloads, 0, "no reload");
        assert.deepStrictEqual(plain(Config.get().vt52Zoom), [false, false, false]);
        console.log("PASS rollbackToBaseline: reload only on a device-set change");
    }

    console.log("snapshot-config.test.js: all tests passed");
}

run();
