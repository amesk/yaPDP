#!/usr/bin/env node
/**
 * Onboarding first-run logic modular tests.
 *
 * Loads the real production module (src/onboarding.js) in an isolated VM
 * context and exercises its DOM-free helpers: the localStorage flag
 * decision (shouldShowOnboarding / markSeen / clearFlag) and the boot-row
 * parsing/filtering (parseBootRow / loadBootTable / collectBootRows /
 * countBootable) which derive from the Info page "Guest Operating Systems"
 * table — the single source of truth for url -> OS -> boot mappings.
 *
 * Run with:  node tests/onboarding.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "src", "onboarding.js");

// `extra` lets tests provide a mock window (e.g. window.localStorage) so the
// isEnabled/setEnabled bridge, which reads the module's own storage, is testable.
function loadModule(extra) {
    const code = fs.readFileSync(SOURCE_PATH, "utf8");
    const sandbox = Object.assign({ console }, extra || {});
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    // `var Onboarding = ...` at top level becomes a property of the sandbox.
    return sandbox.Onboarding;
}

// Objects/arrays produced inside the VM context belong to a different
// realm, so deepStrictEqual on them fails on prototype identity. JSON
// round-trip gives plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// Minimal localStorage-like mock backed by a Map.
function makeStorage(init) {
    const map = new Map(Object.entries(init || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

// Build a fake Info-page table element. rowsData entries are
// rowsData entries are [diskText, systemText, rawText, codes[]] mirroring the
// real <td> cells of the "Guest Operating Systems" table.
function fakeTable(rowsData) {
    const rows = rowsData.map((d) => ({
        cells: [
            { className: "disk", textContent: d[0] },
            { className: "system", textContent: d[1] },
            {
                className: "",
                textContent: d[2],
                querySelectorAll: () => (d[3] || []).map((t) => ({ textContent: t })),
            },
        ],
    }));
    return {
        querySelector: (sel) =>
            sel === "tbody"
                ? { querySelectorAll: (s) => (s === "tr" ? rows : []) }
                : null,
    };
}

function run() {
    const On = loadModule();
    assert.ok(On, "module should expose Onboarding");

    // ---- shouldShowOnboarding --------------------------------------
    {
        assert.strictEqual(On.shouldShowOnboarding(makeStorage()), true,
            "no flag -> show");
        assert.strictEqual(
            On.shouldShowOnboarding(makeStorage({ [On.ONBOARDING_KEY]: "done" })),
            false, "flag set -> skip");
        assert.strictEqual(On.shouldShowOnboarding(null), false,
            "no storage -> skip");
        const broken = { getItem() { throw new Error("denied"); } };
        assert.strictEqual(On.shouldShowOnboarding(broken), false,
            "storage error -> skip");
    }

    // ---- markSeen / clearFlag --------------------------------------
    {
        const s = makeStorage();
        On.markSeen(s);
        assert.strictEqual(On.shouldShowOnboarding(s), false,
            "markSeen should set the flag");
        On.clearFlag(s);
        assert.strictEqual(On.shouldShowOnboarding(s), true,
            "clearFlag should reset the flag");
    }

    // ---- isEnabled / setEnabled (CONFIG|BEHAVIOUR checkbox bridge) -----
    {
        const storage = makeStorage();
        const On2 = loadModule({ window: { localStorage: storage } });
        assert.strictEqual(On2.isEnabled(), true, "no flag -> hint enabled");
        On2.setEnabled(false);
        assert.strictEqual(On2.isEnabled(), false, "setEnabled(false) marks seen");
        assert.strictEqual(On2.shouldShowOnboarding(storage), false,
            "setEnabled(false) should persist the seen flag");
        On2.setEnabled(true);
        assert.strictEqual(On2.isEnabled(), true, "setEnabled(true) clears the flag");
        assert.strictEqual(On2.shouldShowOnboarding(storage), true,
            "setEnabled(true) should persist the cleared flag");
        // Storage unavailable -> isEnabled falls back to false, setEnabled no-ops.
        const On3 = loadModule();
        assert.strictEqual(On3.isEnabled(), false, "no storage -> hint disabled");
        On3.setEnabled(true); // must not throw
    }

    // ---- parseBootRow ----------------------------------------------
    {
        // NOTE: objects returned from the VM context belong to a different
        // realm, so compare field-by-field instead of deepStrictEqual.
        const row = On.parseBootRow([
            { className: "disk", textContent: "RK0" },
            { className: "system", textContent: "Unix V5" },
            {
                textContent: "boot rk0 → unix → login as root",
                querySelectorAll: () => [
                    { textContent: "boot rk0" },
                    { textContent: "unix" },
                    { textContent: "root" },
                ],
            },
        ]);
        assert.ok(row, "disk row should parse");
        assert.strictEqual(row.url, "rk0.dsk", "disk row should map to .dsk url");
        assert.strictEqual(row.device, "rk0");
        assert.strictEqual(row.label, "Unix V5");
        assert.strictEqual(row.boot, "boot rk0");
        assert.strictEqual(row.next, "unix",
            "rk0 should expose the follow-up 'unix' input");
        assert.strictEqual(row.prompt, "@",
            "rk0 should hint at the '@' boot loader prompt");

        // Login credentials must NOT be reported as a boot-time next step.
        const rk2 = On.parseBootRow([
            { className: "disk", textContent: "RK2" },
            { className: "system", textContent: "RSTS V06C-03" },
            {
                textContent: "BOOT RK2 — login 11,70 password PDP",
                querySelectorAll: () => [
                    { textContent: "BOOT RK2" },
                    { textContent: "11,70" },
                    { textContent: "PDP" },
                ],
            },
        ]);
        assert.strictEqual(rk2.next, "",
            "login credentials should not be shown as a next step");

        const tape = On.parseBootRow([
            { className: "disk", textContent: "TM0" },
            { className: "system", textContent: "RSTS 4B-17 (tape)" },
            { textContent: "BOOT TM0", querySelectorAll: () => [{ textContent: "BOOT TM0" }] },
        ]);
        assert.strictEqual(tape.url, "tm0.tap", "tape row should map to .tap url");
        assert.strictEqual(tape.next, "", "no follow-up code -> empty next");

        assert.strictEqual(
            On.parseBootRow([
                { className: "disk", textContent: "RK0" },
                { className: "system", textContent: "Unix V5" },
                { textContent: "", querySelectorAll: () => [] },
            ]), null, "row without boot <code> should be skipped");

        assert.strictEqual(On.parseBootRow([{}, {}]), null,
            "short row should be skipped");
    }

    // ---- loadBootTable (parse the whole Info table) ----------------
    {
        const table = On.loadBootTable(fakeTable([
            ["RK0", "Unix V5", "boot rk0 → unix → login as root", ["boot rk0", "unix", "root"]],
            ["RK1", "RT-11 v4.0", "boot rk1", ["boot rk1"]],
            ["RP1", "BSD 2.11", "boot rp1 — autoboots, login root", ["boot rp1", "root"]],
        ]));
        assert.deepStrictEqual(plain(table.map((r) => r.boot)),
            ["boot rk0", "boot rk1", "boot rp1"],
            "loadBootTable should preserve table order");
        // rk0 exposes the boot-time follow-up; rp1's second code is a login.
        assert.strictEqual(table[0].next, "unix");
        assert.strictEqual(table[0].prompt, "@");
        assert.strictEqual(table[1].next, "");
        assert.strictEqual(table[2].next, "");
        assert.deepStrictEqual(plain(On.loadBootTable(null)), [],
            "null table -> empty rows");
    }

    // ---- collectBootRows (filter by mounted images, capped at 4) ---
    {
        const table = On.loadBootTable(fakeTable([
            ["RK0", "Unix V5", "boot rk0 → unix → login as root", ["boot rk0", "unix", "root"]],
            ["RK1", "RT-11 v4.0", "boot rk1", ["boot rk1"]],
            ["RP1", "BSD 2.11", "boot rp1 — autoboots, login root", ["boot rp1", "root"]],
            ["RP0", "ULTRIX-11 V3.1", "boot rp0 → CTRL/D → login root", ["boot rp0", "root"]],
            ["RL1", "RSX-11M v3.2", "boot rl1 — login 1,2 password SYSTEM", ["boot rl1", "1,2", "SYSTEM"]],
        ]));

        // Minimal build: only rk0/rk1 mounted.
        const minimal = On.collectBootRows(["rk0.dsk", "rk1.dsk"], table);
        assert.deepStrictEqual(plain(minimal.map((r) => r.boot)),
            ["boot rk0", "boot rk1"],
            "minimal build should only suggest mounted images");

        // Full build: all mounted, capped at MAX_SUGGESTIONS (4).
        const full = On.collectBootRows(
            ["rk0.dsk", "rk1.dsk", "rp1.dsk", "rp0.dsk", "rl1.dsk"], table);
        assert.strictEqual(full.length, 4, "suggestions should be capped at 4");
        assert.deepStrictEqual(plain(full.map((r) => r.boot)),
            ["boot rk0", "boot rk1", "boot rp1", "boot rp0"],
            "cap should keep table order (priority)");

        // Unknown mounted urls are ignored, missing table is safe.
        assert.deepStrictEqual(
            plain(On.collectBootRows(["nonsense.bin"], table)), [],
            "unknown urls should be ignored");
        assert.deepStrictEqual(plain(On.collectBootRows(["rk0.dsk"], null)), [],
            "missing table should be safe");
    }

    // ---- countBootable ----------------------------------------------
    {
        const table = On.loadBootTable(fakeTable([
            ["RK0", "Unix V5", "boot rk0 → unix → login as root", ["boot rk0", "unix", "root"]],
            ["RK1", "RT-11 v4.0", "boot rk1", ["boot rk1"]],
            ["RP1", "BSD 2.11", "boot rp1 — autoboots, login root", ["boot rp1", "root"]],
        ]));
        assert.strictEqual(
            On.countBootable(["rk0.dsk", "rp1.dsk"], table), 2,
            "countBootable should count mounted bootable OSes");
    }

    console.log("onboarding tests passed");
}

run();
