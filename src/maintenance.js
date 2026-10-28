/**
 * yaPDP — service mode (maintenance).
 *
 * A museum exhibit accumulates operator-visible state that no ordinary UI
 * control is meant to destroy: the saved configuration, the drive binding
 * table, imported disk images, stored machine states and the write-back disk
 * overlays. "Bring the machine back to how it left the factory" is therefore a
 * deliberately hidden, destructive operation:
 *
 *   entry     ?maintenance=1  |  5 clicks in 2 s on the version marker
 *             (src/pdp11.html #sidebar-version .sidebar-version-text, or the
 *             Info page #about-version)  |  desktop app launched with
 *             --maintenance (Rust command startup_flags)
 *   action    System Reset: stop the machine, walk the reset registry, reload
 *   exit      Close: strip the parameter and reload into the exhibit again
 *
 * WHY THE RESET REGISTRY IS SO SHORT — and why device modules are not touched:
 * the reload at the end of a reset rebuilds every in-memory subsystem from
 * scratch (CPU, RAM, devices, terminals, printer, punched tape, the panel), so
 * a per-device reset() would be dead code. What actually survives a reload is
 * persisted state only: localStorage keys and the three IndexedDB stores. Each
 * entry below owns one of those, and each is cleared THROUGH ITS OWN MODULE —
 * a clear() inside the existing transaction rather than
 * indexedDB.deleteDatabase(), which would sit in `blocked` forever because this
 * very page holds the connection open.
 *
 * The DOM-free half (isGesture, runReset, the key lists and the URL helpers) is
 * exported for Node unit tests (tests/maintenance-reset.test.js); the UI half
 * only wires the markup declared in pdp11.html.
 *
 * Must be loaded LAST in pdp11.html: it calls into Config, MountMap, LastBoot,
 * ViewerConfig, DiskStore, SnapshotStore, EmulationControl and the CPU.
 */
"use strict";

var Maintenance = (() => {
    "use strict";

    // 5 clicks inside a 2 s window. Small enough to be impractical by accident,
    // large enough for a finger on a tablet.
    const GESTURE_CLICKS = 5;
    const GESTURE_WINDOW_MS = 2000;
    // A wedged storage backend must never keep the operator on a frozen screen.
    const STEP_TIMEOUT_MS = 5000;
    const REPORT_KEY = "yapdp.maintenance.report";

    // Machine state that survives a reload. Credentials are deliberately
    // absent (yapdp.github-pat): System Reset restores the exhibit, it does not
    // log the operator out. Each key names the module that owns it.
    const LOCAL_KEYS = [
        "yapdp.onboarding.v1",        // src/onboarding.js  (first-run hint)
        "yapdp-pending-snapshot",     // src/snapshots.js   (restore after reload)
        "yapdp.state-config-active",  // src/snapshots.js   (state configuration)
        "yapdp.quickboot.pending"     // src/quickboot.js   (boot after reload)
    ];
    // sessionStorage is per top-level context, so these must be cleared by the
    // page that owns them — i.e. by this one, before its own reload.
    const SESSION_KEYS = [
        "yapdp-pending-state-url",    // src/snapshots.js
        "yapdp.restore-pending",      // src/snapshots.js / src/diskstore.js
        "yapdp.load-mode",            // src/snapshots.js
        // Share metadata of a state that asked for a reload (STATE_META_KEYS
        // in src/snapshots.js): scenario steps, guide text, balloon label,
        // title and preview. A reset must not inherit somebody else's state.
        "yapdp.state-steps",
        "yapdp.state-steps-message",
        "yapdp.state-button-label",
        "yapdp.state-title",
        "yapdp.state-screenshot",
        "yapdp.pending-reboot",       // src/pdp11-panel.js
        "yapdp.emulation-paused"      // src/emulation-control.js
    ];

    // ------------------------------------------------------------------
    // Pure helpers (unit-tested in Node)
    // ------------------------------------------------------------------

    // Is the click series a service-mode gesture? `stamps` is the raw history;
    // only the timestamps inside the window count, so five slow clicks never
    // open the service screen by surprise.
    function isGesture(stamps, now, clicks, windowMs) {
        const limit = now - (windowMs || GESTURE_WINDOW_MS);
        const needed = clicks || GESTURE_CLICKS;
        return (stamps || []).filter((t) => t > limit).length >= needed;
    }

    function paramValue(search, name) {
        const query = String(search || "").replace(/^\?/, "");
        if (!query) return null;
        const pairs = query.split("&");
        for (const pair of pairs) {
            const eq = pair.indexOf("=");
            const key = eq === -1 ? pair : pair.slice(0, eq);
            if (key !== name) continue;
            return eq === -1 ? "1" : decodeURIComponent(pair.slice(eq + 1));
        }
        return null;
    }

    function hasParam(search, name) {
        return paramValue(search, name) !== null;
    }

    // Drop one parameter and leave every other one — and its order — alone.
    // The exhibit URL carries deep links (?boot=, ?state=, ?code=) that must
    // survive a service-mode round trip untouched.
    function stripParam(search, name) {
        const query = String(search || "").replace(/^\?/, "");
        if (!query) return "";
        const kept = query.split("&").filter((pair) => {
            if (!pair) return false;
            const eq = pair.indexOf("=");
            return (eq === -1 ? pair : pair.slice(0, eq)) !== name;
        });
        return kept.length ? "?" + kept.join("&") : "";
    }

    function withParam(search, name, value) {
        const rest = stripParam(search, name);
        const pair = name + "=" + encodeURIComponent(String(value == null ? "1" : value));
        return rest ? rest + "&" + pair : "?" + pair;
    }

    function errorText(err) {
        if (!err) return "unknown error";
        return String(err.message || err);
    }

    function withTimeout(promise, ms) {
        if (!ms) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const err = new Error("step timed out after " + ms + " ms");
                err.code = "timeout";
                reject(err);
            }, ms);
            Promise.resolve(promise).then(
                (value) => { clearTimeout(timer); resolve(value); },
                (err) => { clearTimeout(timer); reject(err); }
            );
        });
    }

    // ------------------------------------------------------------------
    // Reset registry — one entry per OWNER of persisted state
    // ------------------------------------------------------------------
    // A step returns a promise (or a value). Adding an operation to the service
    // screen means adding a step here: the dialog text is generated from the
    // same `label`, so the warning the operator reads can never drift from what
    // the button actually does.

    function modulePresent(name) {
        return typeof globalThis !== "undefined" && globalThis[name] &&
            typeof globalThis[name] === "object";
    }

    function callModule(name, method) {
        if (!modulePresent(name) || typeof globalThis[name][method] !== "function") {
            return undefined;
        }
        return globalThis[name][method]();
    }

    function clearKeys(storage) {
        const local = storage && storage.local;
        const session = storage && storage.session;
        LOCAL_KEYS.forEach((key) => {
            try { if (local) local.removeItem(key); } catch (err) { /* unavailable */ }
        });
        SESSION_KEYS.forEach((key) => {
            try { if (session) session.removeItem(key); } catch (err) { /* unavailable */ }
        });
        return LOCAL_KEYS.length + SESSION_KEYS.length;
    }

    function resetSteps() {
        return [
            {
                // FIRST on purpose: the page flushes pending write-back blocks
                // on pagehide (src/diskstore.js), so the dirty set has to be
                // dropped before the reload or the overlays would come back.
                id: "diskstore",
                label: "Erase the disk overlays (saved guest writes)",
                run: () => callModule("DiskStore", "clearAll")
            },
            {
                id: "states",
                label: "Erase every saved machine state",
                run: () => callModule("SnapshotStore", "removeAll")
            },
            {
                id: "images",
                label: "Erase every imported disk and tape image",
                run: () => {
                    const seam = (typeof window !== "undefined") ? window.yapdpExportList : null;
                    if (seam && typeof seam.clearAll === "function") return seam.clearAll();
                    return undefined;
                }
            },
            {
                id: "mounts",
                label: "Forget which image each drive holds",
                run: (storage) => {
                    if (!modulePresent("MountMap")) return undefined;
                    return MountMap.reset(storage && storage.local);
                }
            },
            {
                id: "boot",
                label: "Forget the last boot device",
                run: () => callModule("LastBoot", "clear")
            },
            {
                id: "viewer",
                label: "Forget the configuration a state brought",
                run: () => callModule("ViewerConfig", "clear")
            },
            {
                id: "config",
                label: "Restore the factory configuration",
                run: (storage) => {
                    if (!modulePresent("Config")) return undefined;
                    return Config.reset(storage && storage.local);
                }
            },
            {
                id: "keys",
                label: "Cancel pending restores and the first-run hint",
                run: (storage) => clearKeys(storage)
            }
        ];
    }

    function defaultStorage() {
        const win = (typeof window !== "undefined") ? window : null;
        let local = null;
        let session = null;
        try { local = win ? win.localStorage : null; } catch (err) { local = null; }
        try { session = win ? win.sessionStorage : null; } catch (err) { session = null; }
        return { local: local, session: session };
    }

    // Stop the machine before anything is wiped: a running guest would keep
    // dirtying disk blocks between the reset and the reload.
    function defaultStop() {
        if (typeof EmulationControl !== "undefined" && EmulationControl &&
            typeof EmulationControl.pause === "function") {
            EmulationControl.pause();
        }
        if (typeof CPU !== "undefined" && CPU && typeof STATE_HALT !== "undefined") {
            CPU.runState = STATE_HALT;
        }
    }

    /**
     * Run the whole reset. Resolves with a report:
     *   { ok, stopped, steps: [{ id, status: "ok" | "failed" | "timeout" }] }
     * Every step is attempted even if an earlier one failed, and no step can
     * hang the screen — the caller reloads with whatever it got.
     */
    async function runReset(options) {
        const opts = options || {};
        const storage = opts.storage || defaultStorage();
        const steps = opts.steps || resetSteps();
        const stop = opts.stop || defaultStop;
        const timeoutMs = (typeof opts.timeoutMs === "number") ? opts.timeoutMs : STEP_TIMEOUT_MS;
        const report = { startedAt: Date.now(), stopped: false, ok: false, steps: [] };

        try {
            await withTimeout(Promise.resolve(stop()), timeoutMs);
            report.stopped = true;
        } catch (err) {
            report.steps.push({ id: "stop", status: "failed", error: errorText(err) });
        }

        for (const step of steps) {
            try {
                const value = await withTimeout(Promise.resolve(step.run(storage)), timeoutMs);
                report.steps.push({ id: step.id, status: "ok", value: value });
            } catch (err) {
                report.steps.push({
                    id: step.id,
                    status: err && err.code === "timeout" ? "timeout" : "failed",
                    error: errorText(err)
                });
            }
        }

        report.ok = report.stopped &&
            report.steps.every((entry) => entry.status === "ok");
        report.finishedAt = Date.now();
        saveReport(storage.session, report);
        return report;
    }

    function saveReport(session, report) {
        if (!session) return;
        try { session.setItem(REPORT_KEY, JSON.stringify(report)); } catch (err) { /* ignore */ }
    }

    function takeReport(session) {
        if (!session) return null;
        try {
            const raw = session.getItem(REPORT_KEY);
            if (!raw) return null;
            session.removeItem(REPORT_KEY);
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    function reportLine(report) {
        if (!report) return "";
        const bad = report.steps.filter((entry) => entry.status !== "ok");
        if (report.ok && bad.length === 0) {
            return "System reset complete: " + report.steps.length + " subsystems cleared.";
        }
        const names = bad.map((entry) => entry.id + " (" + entry.status + ")").join(", ");
        return "System reset finished with problems: " + names +
            ". Close the exhibit and run it again.";
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    let overlay = null;
    let dialog = null;
    let busy = false;
    let stamps = [];
    // Whether the machine was already paused before the service screen opened:
    // Close must hand it back in the state the operator left it.
    let wasPaused = false;

    function el(id) {
        return (typeof document !== "undefined") ? document.getElementById(id) : null;
    }

    function setStatus(text) {
        const status = el("maintenance-status");
        if (status) status.textContent = text || "";
    }

    function setBusy(value) {
        busy = !!value;
        ["maintenance-reset", "maintenance-close"].forEach((id) => {
            const btn = el(id);
            if (btn) btn.disabled = busy;
        });
    }

    // The consequence lists (the service card and the confirmation dialog) are
    // generated from the SAME registry the reset walks, so the warning can
    // never describe operations the button does not perform.
    function renderStepList(id) {
        const list = el(id);
        if (!list) return;
        list.textContent = "";
        resetSteps().forEach((step) => {
            const item = document.createElement("li");
            item.textContent = step.label;
            list.appendChild(item);
        });
    }

    function markUrl() {
        if (typeof history === "undefined" || !history.replaceState) return;
        try {
            history.replaceState(null, "",
                location.pathname + withParam(location.search, "maintenance", "1") + location.hash);
        } catch (err) { /* file:// and friends: the screen still works for this load */ }
    }

    function open() {
        const box = el("maintenance-overlay");
        if (!box) {
            setStatus("Service screen markup is missing from the page.");
            return false;
        }
        overlay = box;
        overlay.hidden = false;
        overlay.setAttribute("aria-hidden", "false");
        if (typeof document !== "undefined") document.body.classList.add("maintenance-open");
        markUrl();
        renderStepList("maintenance-steps");
        const report = takeReport(defaultStorage().session);
        setStatus(reportLine(report) || "Service mode. Nothing has been changed yet.");
        if (typeof EmulationControl !== "undefined" && EmulationControl &&
            typeof EmulationControl.pause === "function") {
            wasPaused = (typeof EmulationControl.isPaused === "function")
                ? !!EmulationControl.isPaused() : false;
            EmulationControl.pause();
        }
        return true;
    }

    function closeDialog() {
        if (dialog && typeof dialog.close === "function" && dialog.open) dialog.close();
    }

    function openDialog() {
        dialog = el("maintenance-confirm");
        if (!dialog || typeof dialog.showModal !== "function") {
            setStatus("The confirmation dialog is unavailable; nothing was changed.");
            return;
        }
        renderStepList("maintenance-confirm-list");
        renderStepList("maintenance-steps");
        dialog.showModal();
        // The unsafe action must never be one Enter away: focus lands on Cancel.
        const cancel = el("maintenance-cancel");
        if (cancel) cancel.focus();
    }

    async function doReset() {
        if (busy) return;
        closeDialog();
        setBusy(true);
        setStatus("Resetting the machine\u2026");
        const report = await runReset({});
        setStatus(reportLine(report));
        // Reload into a factory-fresh page. `maintenance=1` is kept so the
        // operator sees the result and can Close the exhibit deliberately.
        if (typeof window !== "undefined") window.__allowConfigReload = true;
        markUrl();
        try {
            location.reload();
        } catch (err) {
            setBusy(false);
        }
    }

    function doClose() {
        if (busy) return;
        // The service screen paused the machine on the way in; leaving without a
        // reset must not hand the exhibit back frozen.
        if (!wasPaused && typeof EmulationControl !== "undefined" && EmulationControl &&
            typeof EmulationControl.resume === "function") {
            EmulationControl.resume();
        }
        if (typeof window !== "undefined") window.__allowConfigReload = true;
        const target = location.pathname +
            stripParam(location.search, "maintenance") + location.hash;
        try {
            location.replace(target);
        } catch (err) {
            location.href = target;
        }
    }

    // The gesture: one counter shared by every armed element, so a series
    // cannot be split between them.
    function onGestureClick(event) {
        const now = Date.now();
        stamps.push(now);
        stamps = stamps.filter((t) => t > now - GESTURE_WINDOW_MS);
        if (stamps.length >= GESTURE_CLICKS) {
            stamps = [];
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            open();
            return;
        }
        // A single click on the version marker still opens the About page; from
        // the second click of a series the navigation is silenced so the
        // gesture cannot flip through pages five times.
        if (stamps.length > 1 && event) event.stopPropagation();
    }

    function armGesture(node, options) {
        if (!node || typeof node.addEventListener !== "function") return;
        node.addEventListener("click", onGestureClick, options || false);
    }

    function detectStartupFlag() {
        const tauri = (typeof window !== "undefined") ? window.__TAURI__ : null;
        if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
            return Promise.resolve(false);
        }
        return tauri.core.invoke("startup_flags").then((flags) => {
            return Array.isArray(flags) && flags.indexOf("--maintenance") !== -1;
        }).catch(() => false);
    }

    function wireUI() {
        if (typeof document === "undefined") return;
        const resetBtn = el("maintenance-reset");
        if (resetBtn) resetBtn.addEventListener("click", openDialog);
        const cancelBtn = el("maintenance-cancel");
        if (cancelBtn) cancelBtn.addEventListener("click", closeDialog);
        const okBtn = el("maintenance-confirm-ok");
        if (okBtn) okBtn.addEventListener("click", doReset);
        // Esc must always mean Cancel, whatever the engine does with a modal
        // <dialog>'s own cancel event (headless Chromium does not always route
        // the key through it).
        const confirm = el("maintenance-confirm");
        if (confirm) {
            confirm.addEventListener("keydown", (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeDialog();
                }
            });
        }
        const closeBtn = el("maintenance-close");
        if (closeBtn) closeBtn.addEventListener("click", doClose);

        const versionText = document.querySelector("#sidebar-version .sidebar-version-text");
        if (versionText && String(versionText.textContent || "").trim()) {
            armGesture(versionText);
        } else {
            // No version string (a trimmed build): arm the whole marker so the
            // gesture never disappears silently.
            armGesture(el("sidebar-version"));
        }
        armGesture(el("about-version"));
    }

    function init() {
        if (typeof document === "undefined") return;
        const start = () => {
            wireUI();
            if (hasParam(location.search, "maintenance")) {
                open();
                return;
            }
            detectStartupFlag().then((on) => { if (on) open(); });
        };
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", start);
        } else {
            start();
        }
    }

    const api = {
        // Constants and pure helpers (unit tests).
        GESTURE_CLICKS: GESTURE_CLICKS,
        GESTURE_WINDOW_MS: GESTURE_WINDOW_MS,
        REPORT_KEY: REPORT_KEY,
        LOCAL_KEYS: LOCAL_KEYS,
        SESSION_KEYS: SESSION_KEYS,
        isGesture: isGesture,
        hasParam: hasParam,
        paramValue: paramValue,
        stripParam: stripParam,
        withParam: withParam,
        resetSteps: resetSteps,
        runReset: runReset,
        reportLine: reportLine,
        // Page wiring (called from pdp11.html through DOMContentLoaded).
        init: init,
        open: open,
        closeDialog: closeDialog,
        _internal: { clearKeys: clearKeys, saveReport: saveReport, takeReport: takeReport }
    };

    return api;
})();

if (typeof window !== "undefined") window.Maintenance = Maintenance;
if (typeof module !== "undefined" && module.exports) module.exports = { Maintenance };

// Startup: init() wires the markup and opens the screen when the page was
// loaded in service mode. It defers to DOMContentLoaded itself, so being the
// last script in the body is enough (and a unit test that only requires the
// module never touches the DOM).
if (typeof document !== "undefined") Maintenance.init();
