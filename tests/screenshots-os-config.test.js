#!/usr/bin/env node
/**
 * Screenshot-harness drift guard.
 *
 * tools/screenshots-os.js seeds a machine profile per shot (OS_CFG) so the
 * quick-boot wizard's hardwareDirty() check passes and the page is NOT
 * reloaded mid-run. A reload destroys the Puppeteer execution context and the
 * console hooks (installConsoleHooks() installs them per document), so the
 * shot dies with "Execution context was destroyed".
 *
 * That is exactly what happened when the terminal work moved BSD 2.11 and
 * RT-11 v4.0 onto a VT100 console while OS_CFG still seeded a VT52/teletype:
 * `npm run screenshots:os` failed on bsd.png and silently kept the stale
 * artefact. This test pins the table to src/osboot.js, the single source of
 * truth for what hardware each guest asks for.
 *
 * Run with:  node tests/screenshots-os-config.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const OSBOOT_PATH = path.join(ROOT, "src", "osboot.js");
const TOOL_PATH = path.join(ROOT, "tools", "screenshots-os.js");

// Slice one `const <NAME> = <literal>;` block out of the tool source and
// evaluate it in an isolated context. The tool is a script (it runs main() on
// load), so it cannot be require()d; the two tables are plain literals, which
// makes this both possible and honest — the test reads the real values.
function literalFrom(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `tools/screenshots-os.js: '${marker}' not found`);

    const eq = src.indexOf("=", start);
    const open = src.slice(eq).search(/[[{]/);
    assert.ok(eq !== -1 && open !== -1,
        `tools/screenshots-os.js: '${marker}' has no object/array literal`);
    const from = eq + open;

    let depth = 0;
    let quote = null;
    let end = -1;
    for (let i = from; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "/" && next === "/") {                    // line comment
            i = src.indexOf("\n", i);
            if (i === -1) break;
            continue;
        }
        if (ch === "/" && next === "*") {                    // block comment
            i = src.indexOf("*/", i);
            if (i === -1) break;
            i++;
            continue;
        }
        if (ch === "[" || ch === "{") depth++;
        else if (ch === "]" || ch === "}") {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    assert.ok(end > 0,
        `tools/screenshots-os.js: unbalanced literal after '${marker}'`);

    // The shot table references a few module-level constants; stub them.
    const sandbox = { WIDTH: 1280, HEIGHT: 800, BASIC_PROGRAM: [] };
    vm.createContext(sandbox);
    const value = vm.runInContext("(" + src.slice(from, end) + ")", sandbox);
    return JSON.parse(JSON.stringify(value));
}

function run() {
    // ---- the scenarios the shots boot -------------------------------
    const sandbox = { console, window: {}, setTimeout: setTimeout };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(OSBOOT_PATH, "utf8"), sandbox);
    const OSBoot = sandbox.OSBoot;
    assert.ok(OSBoot, "osboot should expose OSBoot");
    assert.strictEqual(typeof OSBoot.scenarioFor, "function",
        "osboot should expose scenarioFor");

    // ---- the harness tables -----------------------------------------
    const tool = fs.readFileSync(TOOL_PATH, "utf8");
    const shots = literalFrom(tool, "const OS_SHOTS =");
    const seeds = literalFrom(tool, "const OS_CFG =");
    assert.ok(Array.isArray(shots) && shots.length > 0,
        "OS_SHOTS should be a non-empty array");

    const devices = shots.map((s) => s.device);

    // ---- every shot seeds exactly what its scenario asks for ---------
    for (const device of devices) {
        const scenario = OSBoot.scenarioFor(device);
        assert.ok(scenario, `osboot.js has no scenario for shot device ` +
            `'${device}'`);
        const hw = scenario.hardware || {};
        const seed = seeds[device];
        assert.ok(seed, `tools/screenshots-os.js OS_CFG has no entry for ` +
            `'${device}' — the wizard would reload the page and the shot ` +
            "would die with 'Execution context was destroyed'");

        assert.strictEqual(seed.consoleType, hw.console,
            `OS_CFG['${device}'].consoleType must mirror the scenario's ` +
            `console ('${hw.console}')`);

        // A null/absent profile key means "leave the user's setting alone",
        // so seeding false is correct there; only `true` must be mirrored.
        assert.strictEqual(!!seed.printer, hw.printer === true,
            `OS_CFG['${device}'].printer must mirror the scenario's ` +
            `printer (${hw.printer})`);
        assert.strictEqual(!!seed.vt11, hw.vt11 === true,
            `OS_CFG['${device}'].vt11 must mirror the scenario's ` +
            `vt11 (${hw.vt11})`);
    }

    // ---- and no dead entries ----------------------------------------
    for (const key of Object.keys(seeds)) {
        assert.ok(devices.includes(key),
            `OS_CFG['${key}'] is not used by any shot in OS_SHOTS`);
    }

    console.log("screenshots-os config tests passed");
}

run();
