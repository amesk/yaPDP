#!/usr/bin/env node
/**
 * Service mode (maintenance) — engine and wiring contract.
 *
 * The service screen is the only place in yaPDP that destroys operator data:
 * the saved configuration, imported images, stored machine states and the
 * write-back disk overlays. Three kinds of defect have to be caught without a
 * browser:
 *
 *   1. THE REGISTRY DRIFTED from the sources. A new localStorage key added to
 *      a module, or a storage module that stops exposing its clear() method,
 *      silently survives a "factory reset". The guard below scans src/ for the
 *      storage surface and requires every key to be either walked by the
 *      registry or owned by a module-level reset step.
 *   2. THE RESET IS NOT ROBUST. A single failing or hanging step must not abort
 *      the others and must never hang the screen: the caller reloads anyway.
 *   3. THE SCREEN CANNOT BE ENTERED (or, worse, entered by accident). The
 *      gesture is pinned as a pure function, and the markup ids the engine
 *      addresses are checked to exist in pdp11.html.
 *
 * Run with:  node tests/maintenance-reset.test.js
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { Maintenance } = require(path.join(ROOT, "src", "maintenance.js"));

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// A Map-backed Storage stand-in: Config/MountMap/LastBoot/ViewerConfig all take
// an explicit storage object, so nothing here needs a DOM.
function fakeStorage(seed) {
    const map = new Map(Object.entries(seed || {}));
    return {
        map: map,
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
        has(key) { return map.has(key); }
    };
}

function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
}

async function run() {
    // --- 1. Gesture: 5 clicks inside 2 s, never by accident ------------------
    {
        const now = 100000;
        assert.strictEqual(Maintenance.isGesture([now], now), false,
            "one click must not open the service screen");
        assert.strictEqual(
            Maintenance.isGesture([now - 900, now - 600, now - 300, now - 100], now), false,
            "four clicks must not open the service screen");
        assert.strictEqual(
            Maintenance.isGesture([now - 1000, now - 800, now - 600, now - 400, now - 100], now),
            true, "five clicks inside the window must open the service screen");
        assert.strictEqual(
            Maintenance.isGesture([now - 5000, now - 3000, now - 600, now - 400, now - 100], now),
            false, "only the clicks inside the window count");
        assert.strictEqual(Maintenance.GESTURE_CLICKS, 5, "the gesture is five clicks");
        assert.strictEqual(Maintenance.GESTURE_WINDOW_MS, 2000, "the gesture window is 2 s");
    }

    // --- 2. URL helpers: the exhibit deep link survives both directions ------
    {
        const search = "?code=0&maintenance=1&boot=rk1";
        assert.strictEqual(Maintenance.hasParam(search, "maintenance"), true,
            "?maintenance=1 must be recognised");
        assert.strictEqual(Maintenance.hasParam("?boot=rk1", "maintenance"), false,
            "a plain exhibit URL must not enter service mode");
        assert.strictEqual(Maintenance.stripParam(search, "maintenance"),
            "?code=0&boot=rk1",
            "Close must keep every other parameter, in order");
        assert.strictEqual(Maintenance.stripParam("?maintenance=1", "maintenance"), "",
            "a bare ?maintenance=1 must collapse to an empty query");
        assert.strictEqual(Maintenance.stripParam("", "maintenance"), "",
            "an empty query stays empty");
        assert.strictEqual(Maintenance.withParam("?code=0", "maintenance", "1"),
            "?code=0&maintenance=1",
            "the reset reload must keep the service screen AND the exhibit link");
        assert.strictEqual(Maintenance.withParam("?maintenance=1", "maintenance", "1"),
            "?maintenance=1", "the parameter is not duplicated");
        assert.strictEqual(Maintenance.paramValue("?bridge=1", "bridge"), "1",
            "valueless parameters read as 1");
    }

    // --- 3. Registry: the destructive surface, in order ---------------------
    {
        const steps = Maintenance.resetSteps();
        const ids = steps.map((step) => step.id);
        assert.deepStrictEqual(ids,
            ["diskstore", "states", "images", "mounts", "boot", "viewer", "config", "keys"],
            "the reset registry order is part of the contract");
        assert.strictEqual(ids[0], "diskstore",
            "the overlays go FIRST: the page flushes them on pagehide");
        steps.forEach((step) => {
            assert.ok(typeof step.label === "string" && step.label.length > 8,
                "every step carries the operator-facing label " + step.id);
            assert.strictEqual(typeof step.run, "function",
                "every step is runnable " + step.id);
        });
        // The dialog text is generated from these labels, so the warning can
        // never describe operations the button does not perform.
        const html = read("pdp11.html");
        assert.ok(html.includes('id="maintenance-steps"'),
            "the service card lists the registry steps");
        assert.ok(html.includes('id="maintenance-confirm-list"'),
            "the confirmation dialog lists the registry steps");
    }

    // --- 4. runReset: stops first, survives failures and hangs ---------------
    {
        const order = [];
        const local = fakeStorage({ "yapdp.config.v1": "{}" });
        const session = fakeStorage({ "yapdp.emulation-paused": "1" });
        const steps = [
            { id: "a", label: "first step", run: () => { order.push("a"); } },
            { id: "b", label: "explodes", run: () => { order.push("b"); throw new Error("boom"); } },
            { id: "c", label: "still runs", run: () => { order.push("c"); } }
        ];
        let stopCalled = false;
        const report = await Maintenance.runReset({
            storage: { local: local, session: session },
            steps: steps,
            stop: () => { stopCalled = true; order.push("stop"); },
            timeoutMs: 200
        });
        assert.strictEqual(stopCalled, true, "the machine is stopped before any reset step");
        assert.deepStrictEqual(order, ["stop", "a", "b", "c"],
            "every step runs even after a failure");
        assert.strictEqual(report.stopped, true, "the machine was stopped");
        assert.strictEqual(report.ok, false, "a failed step makes the report partial");
        const b = report.steps.find((entry) => entry.id === "b");
        assert.strictEqual(b.status, "failed", "a throwing step is reported as failed");
        assert.ok(session.has(Maintenance.REPORT_KEY),
            "the report survives the reload through sessionStorage");
    }

    {
        // A step that never resolves must not hang the screen.
        const report = await Maintenance.runReset({
            storage: { local: fakeStorage(), session: fakeStorage() },
            steps: [
                { id: "hang", label: "never resolves", run: () => new Promise(() => {}) },
                { id: "after", label: "runs anyway", run: () => {} }
            ],
            stop: () => {},
            timeoutMs: 20
        });
        const hang = report.steps.find((entry) => entry.id === "hang");
        assert.strictEqual(hang.status, "timeout",
            "a hanging step is reported as a timeout, not left pending");
        assert.strictEqual(report.steps.find((entry) => entry.id === "after").status, "ok",
            "the reset continues after a timeout");
    }

    // --- 5. Modules are called through their own APIs -----------------------
    {
        const calls = [];
        const local = fakeStorage();
        const session = fakeStorage();
        globalThis.DiskStore = { clearAll: () => { calls.push("DiskStore.clearAll"); } };
        globalThis.SnapshotStore = { removeAll: () => { calls.push("SnapshotStore.removeAll"); } };
        globalThis.MountMap = { reset: (storage) => { calls.push("MountMap.reset:" + (storage === local)); } };
        globalThis.LastBoot = { clear: () => { calls.push("LastBoot.clear"); } };
        globalThis.ViewerConfig = { clear: () => { calls.push("ViewerConfig.clear"); } };
        globalThis.Config = { reset: (storage) => { calls.push("Config.reset:" + (storage === local)); } };

        try {
            const report = await Maintenance.runReset({
                storage: { local: local, session: session },
                stop: () => {},
                timeoutMs: 200
            });

            assert.strictEqual(report.ok, true, "a run with every module present succeeds");
            assert.strictEqual(calls[0], "DiskStore.clearAll",
                "the overlays are cleared first: " + calls.join(", "));
            assert.ok(calls.includes("SnapshotStore.removeAll"),
                "the snapshot store is cleared through its own API");
            assert.ok(calls.includes("MountMap.reset:true"),
                "the drive table is cleared on localStorage");
            assert.ok(calls.includes("Config.reset:true"),
                "the configuration is reset on localStorage");
        } finally {
            delete globalThis.DiskStore;
            delete globalThis.SnapshotStore;
            delete globalThis.MountMap;
            delete globalThis.LastBoot;
            delete globalThis.ViewerConfig;
            delete globalThis.Config;
        }
    }

    // --- 6. Key cleanup: machine state only, never the credentials ----------
    {
        const local = fakeStorage({
            "yapdp.onboarding.v1": "done",
            "yapdp-pending-snapshot": "abc",
            "yapdp.state-config-active": "1",
            "yapdp.quickboot.pending": "rk1",
            "yapdp.github-pat": "secret",
            "yapdp.config.v1": "{}"
        });
        const session = fakeStorage({
            "yapdp-pending-state-url": "https://example.com/s.state.zst",
            "yapdp.restore-pending": "1",
            "yapdp.load-mode": "shared",
            "yapdp.state-title": "RT-11",
            "yapdp.pending-reboot": "reboot",
            "yapdp.emulation-paused": "1"
        });
        Maintenance._internal.clearKeys({ local: local, session: session });

        Maintenance.LOCAL_KEYS.forEach((key) => {
            assert.ok(!local.has(key), "localStorage key must be cleared: " + key);
        });
        Maintenance.SESSION_KEYS.forEach((key) => {
            assert.ok(!session.has(key), "sessionStorage key must be cleared: " + key);
        });
        assert.strictEqual(local.getItem("yapdp.github-pat"), "secret",
            "System Reset must not log the operator out (GitHub PAT is kept)");
        assert.strictEqual(local.getItem("yapdp.config.v1"), "{}",
            "the config key belongs to Config.reset(), not to the raw key list");
    }

    // --- 7. Drift guard: the storage surface of src/ is fully covered --------
    {
        const OWNED_BY_MODULE_RESET = [
            "yapdp.config.v1",         // Config.reset()
            "yapdp.mountmap.v1",       // MountMap.reset()
            "yapdp.lastboot",          // LastBoot.clear()
            "yapdp.origconfig.v1",     // ViewerConfig.clear()
            "yapdp.github-pat",        // credential: deliberately NOT cleared
            "yapdp.maintenance.report" // the report itself (sessionStorage)
        ];
        const allowed = new Set([
            ...Maintenance.LOCAL_KEYS,
            ...Maintenance.SESSION_KEYS,
            ...OWNED_BY_MODULE_RESET
        ]);

        const patterns = [
            // localStorage.getItem("yapdp...") / sessionStorage.setItem(...)
            /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*["']([^"']+)["']/g,
            // const STORAGE_KEY = "yapdp..."; PENDING_KEY = ...; etc.
            /\b(?:STORAGE_KEY|PENDING_KEY|ONBOARDING_KEY|PENDING_STATE_KEY|STATE_CONFIG_ACTIVE_KEY|PENDING_REBOOT_KEY)\s*=\s*["']([^"']+)["']/g,
            // STATE_META_KEYS values in src/snapshots.js
            /\b(?:steps|stepsMessage|buttonLabel|title|screenshot):\s*"(yapdp[^"]+)"/g
        ];

        const found = new Set();
        for (const file of jsFiles(path.join(ROOT, "src"))) {
            const text = fs.readFileSync(file, "utf8");
            patterns.forEach((re) => {
                let hit;
                re.lastIndex = 0;
                while ((hit = re.exec(text)) !== null) found.add(hit[1]);
            });
        }

        const uncovered = Array.from(found).filter((key) => !allowed.has(key));
        assert.deepStrictEqual(uncovered, [],
            "a stored key is neither reset by the service mode nor owned by a " +
            "module reset step — add it to src/maintenance.js (" + uncovered.join(", ") + ")");
        assert.ok(found.has("yapdp.github-pat"),
            "the guard must actually see the credential key it deliberately keeps");

        // Each storage module must still expose the clearing API the registry
        // calls; a rename there would make System Reset silently do nothing.
        assert.ok(/function removeAll\(/.test(read("src/snapshots.js")) &&
            /removeAll: removeAll/.test(read("src/snapshots.js")),
            "src/snapshots.js must expose removeAll()");
        assert.ok(/function clearAllImages\(/.test(read("src/dragdrop.js")) &&
            /clearAll: clearAllImages/.test(read("src/dragdrop.js")),
            "src/dragdrop.js must expose clearAll() through window.yapdpExportList");
        assert.ok(/function clearAll\(/.test(read("src/diskstore.js")) &&
            /clearAll,/.test(read("src/diskstore.js")),
            "src/diskstore.js must keep its clearAll()");
    }

    // --- 8. Wiring: the engine addresses markup that exists -----------------
    {
        const html = read("pdp11.html");
        const ids = [
            "maintenance-overlay", "maintenance-title", "maintenance-reset",
            "maintenance-close", "maintenance-status", "maintenance-steps",
            "maintenance-confirm", "maintenance-confirm-list", "maintenance-cancel",
            "maintenance-confirm-ok"
        ];
        ids.forEach((id) => {
            assert.ok(html.includes('id="' + id + '"'),
                "pdp11.html must declare #" + id);
        });
        assert.ok(html.includes("css/maintenance.css"),
            "pdp11.html must link the service-mode stylesheet");
        const engine = html.indexOf("<script src='src/maintenance.js'></script>");
        assert.ok(engine > 0, "pdp11.html must load src/maintenance.js");
        assert.ok(engine > html.indexOf("<script src='src/snapshots.js'></script>"),
            "maintenance.js must load after snapshots.js (SnapshotStore.removeAll)");
        assert.ok(engine > html.indexOf("<script src='src/screenshot.js'></script>"),
            "maintenance.js loads after every module it calls into");
        // The overlay has to outrank the startup gate, or a slow first paint
        // could hide the service screen behind the loading spinner.
        assert.ok(/#yapdp-loading[\s\S]{0,400}z-index:\s*100000/.test(html),
            "the startup gate keeps its z-index (100000)");
        assert.ok(/\.maintenance-overlay[\s\S]{0,400}z-index:\s*100001/.test(read("css/maintenance.css")),
            "the service overlay must sit above the startup gate");
    }

    console.log("maintenance-reset: all tests passed");
}

run().then(
    () => process.exit(0),
    (err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    }
);
