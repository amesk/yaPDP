#!/usr/bin/env node
/**
 * OSBoot scenarios + QuickBoot pure-helpers modular tests.
 *
 * Loads the real production modules (src/osboot.js, src/quickboot.js) in an
 * isolated VM context and exercises their DOM-free logic: scenario lookup,
 * media-url resolution, mounted-image filtering, string-to-console-bytes
 * encoding, and the QuickBoot pure helpers (console page, step delay, step
 * bytes).
 *
 * Run with:  node tests/osboot.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const OSBOOT_PATH = path.join(__dirname, "..", "src", "osboot.js");
const QUICKBOOT_PATH = path.join(__dirname, "..", "src", "quickboot.js");

// Objects/arrays produced inside the VM context belong to a different realm,
// so JSON round-trip gives plain main-realm values that compare reliably.
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadModules() {
    const sandbox = { console, window: {}, setTimeout: setTimeout };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(OSBOOT_PATH, "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(QUICKBOOT_PATH, "utf8"), sandbox);
    return { OSBoot: sandbox.OSBoot, QuickBoot: sandbox.QuickBoot };
}

function run() {
    const { OSBoot, QuickBoot } = loadModules();
    assert.ok(OSBoot, "osboot should expose OSBoot");
    assert.ok(QuickBoot, "quickboot should expose QuickBoot");

    // ---- stringToBytes (ASCII -> console bytes, no terminator) -------
    {
        assert.deepStrictEqual(plain(OSBoot.stringToBytes("ab")), [97, 98]);
        assert.deepStrictEqual(plain(OSBoot.stringToBytes("")), []);
        assert.deepStrictEqual(plain(OSBoot.stringToBytes("boot rk0")),
            [98, 111, 111, 116, 32, 114, 107, 48]);
    }

    // ---- urlFor (tape vs disk) --------------------------------------
    {
        assert.strictEqual(OSBoot.urlFor("tm0"), "tm0.tap");
        assert.strictEqual(OSBoot.urlFor("rk0"), "rk0.dsk");
        assert.strictEqual(OSBoot.urlFor("rp1"), "rp1.dsk");
    }

    // ---- scenarioFor -------------------------------------------------
    {
        const rk0 = OSBoot.scenarioFor("rk0");
        assert.ok(rk0, "rk0 scenario should exist");
        assert.strictEqual(rk0.boot, "boot rk0");
        assert.strictEqual(rk0.label, "Unix V5");
        assert.strictEqual(rk0.autoLogin, true);
        assert.deepStrictEqual(plain(rk0.steps),
            [{ send: "unix" }, { send: "root", waitFor: "login:" }]);

        const rl0 = OSBoot.scenarioFor("rl0");
        assert.deepStrictEqual(plain(rl0.steps),
            [{ send: "rl(0,0)rlunix" }, { ctrlD: true },
                { send: "root", waitFor: "login:" }],
            "BSD 2.9 should include a Ctrl-D step and wait for login");

        const rp1 = OSBoot.scenarioFor("rp1");
        assert.deepStrictEqual(plain(rp1.steps),
            [{ send: "", waitFor: "Press <CR> to boot, or any other key to abort:" },
                { send: "root", waitFor: "login:" }],
            "BSD 2.11 should press Enter at the boot prompt and wait for login");

        assert.strictEqual(OSBoot.scenarioFor("nope"), undefined,
            "unknown device should resolve to undefined");

        // Every scenario declares its hardware profile explicitly, with all
        // keys present (null = leave the user's current setting untouched).
        OSBoot.BOOT_SCENARIOS.forEach((s) => {
            assert.ok(s.hardware, s.device + " should declare a hardware profile");
            assert.ok("console" in s.hardware, s.device + " hardware.console");
            assert.ok("printer" in s.hardware, s.device + " hardware.printer");
            assert.ok("vt11" in s.hardware, s.device + " hardware.vt11");
        });
        assert.strictEqual(OSBoot.scenarioFor("rk0").hardware.console, "teletype",
            "Unix V5 should force a teletype console");
        assert.strictEqual(OSBoot.scenarioFor("rk1").hardware.printer, true,
            "RT-11 should enable the LP11 printer");
        const rk1v = OSBoot.scenarioFor("rk1vt52");
        assert.ok(rk1v, "rk1vt52 (VT52 console) scenario should exist");
        assert.strictEqual(rk1v.boot, "boot rk1", "variant should boot the same rk1 device");
        assert.strictEqual(rk1v.url, "rk1.dsk", "variant should reuse the rk1.dsk image");
        assert.strictEqual(rk1v.hardware.console, "vt52",
            "RT-11 VT52 variant should use a VT52 console");
        assert.strictEqual(rk1v.hardware.vt11, false);
        assert.strictEqual(OSBoot.scenarioFor("rp1").hardware.console, "vt52",
            "BSD 2.11 should use a VT52 console");
        assert.strictEqual(OSBoot.scenarioFor("rk3").hardware.console, null,
            "XXDP should not force a console");
        assert.strictEqual(OSBoot.scenarioFor("rk3").hardware.printer, null,
            "XXDP should not force a printer");
        assert.strictEqual(OSBoot.scenarioFor("rk3").hardware.vt11, false,
            "non-Lunar-Lander scenarios should turn the VT11 off");

        // Paper tapes: boot via "boot pr" and select the tape in "#ptr".
        assert.strictEqual(OSBoot.scenarioFor("basic").boot, "boot pr");
        assert.strictEqual(OSBoot.scenarioFor("basic").paperTape, "DEC-11-AJPB-PB");
        assert.deepStrictEqual(plain(OSBoot.scenarioFor("basic").steps),
            [{ send: "", waitFor: "*O " }],
            "BASIC-11 should send Enter once it prints '*O '");
        assert.strictEqual(OSBoot.scenarioFor("lander").paperTape, "lander");
        assert.strictEqual(OSBoot.scenarioFor("lander").page, "vt11",
            "Lunar Lander should switch to the VT11 Display page");
        assert.strictEqual(OSBoot.scenarioFor("lander").hardware.vt11, true,
            "Lunar Lander should enable the VT11 display");
    }

    // ---- filterMounted (desktop builds) ------------------------------
    // Paper tapes stay available (they are not mounted in DataLoader); only
    // disk/tape images are filtered by what is mounted.
    {
        const mounted = OSBoot.filterMounted(["rk0.dsk", "rp1.dsk"]);
        assert.deepStrictEqual(plain(mounted.map((s) => s.device).sort()),
            ["basic", "ed11", "lander", "odt11", "rk0", "rp1"],
            "mounted images + all paper tapes should survive the filter");

        // Both RT-11 variants share the same rk1.dsk image.
        const rt = OSBoot.filterMounted(["rk1.dsk"]);
        assert.deepStrictEqual(plain(rt.map((s) => s.device).sort()),
            ["basic", "ed11", "lander", "odt11", "rk1", "rk1vt52"],
            "RT-11 teletype and VT52 variants should share rk1.dsk");
    }

    // ---- scenario integrity ------------------------------------------
    {
        OSBoot.BOOT_SCENARIOS.forEach((s) => {
            if (s.paperTape) {
                // Paper tapes all boot through the "boot pr" loader command.
                assert.strictEqual(s.boot, "boot pr",
                    s.device + " paper tape should boot via 'boot pr'");
            } else {
                const dev = s.bootDev || s.device;
                assert.ok(s.boot.startsWith("boot " + dev),
                    s.device + " boot command should target " + dev);
                const media = s.url || OSBoot.urlFor(s.device);
                assert.ok(/\.(dsk|tap)$/.test(media),
                    media + " should be a media file name");
            }
        });
    }

    // ---- QuickBoot pure helpers -------------------------------------
    {
        assert.strictEqual(QuickBoot.consolePageFor({ consoleType: "vt52" }), "vt52-console");
        assert.strictEqual(QuickBoot.consolePageFor({ consoleType: "teletype" }), "teletype");
        assert.strictEqual(QuickBoot.consolePageFor(null), "teletype");
        assert.strictEqual(QuickBoot.consolePageFor(undefined), "teletype");

        assert.strictEqual(QuickBoot.stepDelayMs("authentic"), 1600);
        assert.strictEqual(QuickBoot.stepDelayMs("fast"), 800);
        assert.strictEqual(QuickBoot.stepDelayMs(undefined), 800);

        assert.deepStrictEqual(plain(QuickBoot.stepBytes({ send: "unix" })),
            [117, 110, 105, 120, 13], "text step should append Enter");
        assert.deepStrictEqual(plain(QuickBoot.stepBytes({ ctrlD: true })),
            [4], "ctrlD step should be ^D");
        assert.deepStrictEqual(plain(QuickBoot.stepBytes({})),
            [13], "empty step should just send Enter");

        // Prompt-waiting detection on the accumulated console output.
        assert.strictEqual(QuickBoot.bufferContains("login: ", "login:"), true,
            "console output containing the prompt should match");
        assert.strictEqual(QuickBoot.bufferContains("hello", "login:"), false,
            "console output without the prompt should not match");
        assert.strictEqual(QuickBoot.bufferContains("login:", ""), false,
            "an empty needle should never match");

        // Hardware profile merging / dirty detection / requirements text.
        const base = { consoleType: "vt52", printer: false, vt11: false, teletypeSpeed: "fast" };
        assert.deepStrictEqual(plain(QuickBoot.mergeHardware(base,
            { console: "teletype", printer: true, vt11: true })),
            { consoleType: "teletype", printer: true, vt11: true, teletypeSpeed: "fast" },
            "mergeHardware should override only non-null profile keys");
        assert.deepStrictEqual(plain(QuickBoot.mergeHardware(base,
            { console: null, printer: null, vt11: null })),
            base, "null profile keys should leave the config unchanged");

        assert.strictEqual(
            QuickBoot.hardwareDirty(base, { console: "teletype", printer: true, vt11: true }), true,
            "differing console/printer/vt11 should be dirty");
        assert.strictEqual(
            QuickBoot.hardwareDirty(base, { console: "vt52", printer: false, vt11: false }), false,
            "matching profile should not be dirty");
        assert.strictEqual(
            QuickBoot.hardwareDirty(base, { console: "vt52", printer: null, vt11: null }), false,
            "null keys should never count as dirty");
        assert.strictEqual(
            QuickBoot.hardwareDirty(base, { console: "vt52", printer: false, vt11: true }), true,
            "a differing vt11 alone should be dirty");

        assert.strictEqual(QuickBoot.requirementText(
            { console: "teletype", printer: true, vt11: true }),
            "teletype console · LP11 printer · VT11 display");
        assert.strictEqual(QuickBoot.requirementText(
            { console: "vt52", printer: false, vt11: false }),
            "VT52 console · no printer",
            "a disabled VT11 should not add a badge");
        // The description ALWAYS states the console type and the printer
        // state; null profile keys keep the user's current setting, and
        // without a config the fallback is a teletype console, no printer.
        assert.strictEqual(QuickBoot.requirementText(
            { console: null, printer: null, vt11: null }),
            "teletype console · no printer",
            "the description should always state the terminal and the printer");
        assert.strictEqual(QuickBoot.requirementText(
            { console: null, printer: null, vt11: null }, base),
            "VT52 console · no printer",
            "a null console should keep the user's VT52 console");
        assert.strictEqual(QuickBoot.requirementText(
            { console: null, printer: null, vt11: null },
            { consoleType: "teletype", printer: true }),
            "teletype console · LP11 printer",
            "a null printer should keep the user's enabled printer");
    }

    // ---- QuickBoot abortAutoload -------------------------------------
    // A failed image load (imgerror.js) calls window.__autoloadAbort(), which
    // must stop the typing chain: any already-scheduled step timer is
    // invalidated and nothing more is sent to the console. A capture setTimeout
    // is used so no real timers run.
    {
        const pendingTimers = [];
        const sent = [];
        const sandbox = {
            console,
            window: {
                dlReceiveQueue: (unit, bytes) => sent.push(bytes)
            },
            setTimeout: (fn, ms) => {
                pendingTimers.push({ fn, ms });
                return pendingTimers.length;
            },
            Date
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(OSBOOT_PATH, "utf8"), sandbox);
        vm.runInContext(fs.readFileSync(QUICKBOOT_PATH, "utf8"), sandbox);

        // A real launch schedules the first step timer (the boot command).
        sandbox.QuickBoot.launch("rk0", true);
        assert.ok(pendingTimers.length >= 1,
            "launch should schedule the first step timer");

        // Simulate the image-load failure the way imgerror.js does.
        assert.strictEqual(typeof sandbox.window.__autoloadAbort, "function",
            "quickboot should publish window.__autoloadAbort for imgerror.js");
        sandbox.window.__autoloadAbort();

        // Drain every pending timer: after the abort none may send bytes.
        while (pendingTimers.length) pendingTimers.shift().fn();
        assert.deepStrictEqual(plain(sent), [],
            "abort should stop all pending step timers from sending bytes");
    }

    console.log("osboot tests passed");
}

run();
