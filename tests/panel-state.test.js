#!/usr/bin/env node
/**
 * Front-panel state tests (POWER LOCK, rotary switches, toggles).
 *
 * A restored `.state` used to bring the CPU back but not the front panel: the
 * guest kept running with the POWER LOCK key reading OFF, and the address/data
 * rockers stood where the page left them. The panel block now travels with the
 * state, produced and consumed by the pure helpers in src/state-format.js:
 *
 *   capturePanel(panel)        the six INDEPENDENT panel positions
 *   applyPanelFields(panel, s) the same six back onto a live panel object
 *   panelPowerOn(...)          where the POWER LOCK stood, incl. states that
 *                              predate the block (every older exported file)
 *
 * Everything else on the panel is derived (lamp masks from updateLights(),
 * rockers from CPU.switchRegister) and must NOT be captured.
 *
 * Run with:  node tests/panel-state.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const { StateFormat } = require(path.join(ROOT, "src", "state-format.js"));

// CPU run states (mirror src/pdp11.js).
const STATE_RUN = 0;
const STATE_WAIT = 2;
const STATE_HALT = 3;

function run() {
    // ---- 1. capturePanel: whitelist only --------------------------------
    {
        const panel = {
            powerSwitch: 0,
            rotary0: 3,
            rotary1: 1,
            lampTest: 1,
            halt: 0,
            step: 1,
            // Runtime cache and DOM references — never machine state:
            autoIncr: 2,
            addressLights: 0x3fffff,
            displayLights: 0xf0f0,
            statusLights: 0x3000,
            addressId: [{}, {}, null],
            displayId: [],
            statusId: [],
            LIGHTS_MODE: [0x10, 0x20, 0, 0x40]
        };
        const saved = StateFormat.capturePanel(panel);
        assert.deepStrictEqual(Object.keys(saved).sort(),
            ["halt", "lampTest", "powerSwitch", "rotary0", "rotary1", "step"],
            "exactly the six independent panel positions are captured");
        assert.strictEqual(saved.autoIncr, undefined, "the EXAM auto-increment is transient");
        assert.strictEqual(saved.addressLights, undefined, "lamp masks are derived");
        assert.strictEqual(saved.addressId, undefined, "DOM references are not state");
        assert.strictEqual(StateFormat.capturePanel(null), null, "no panel -> no block");
        assert.strictEqual(StateFormat.capturePanel({}), null,
            "a panel with nothing recognisable records no block");
        console.log("PASS test 1: capturePanel whitelists the six panel positions");
    }

    // ---- 2. capturePanel: range checks ----------------------------------
    {
        const saved = StateFormat.capturePanel({
            powerSwitch: -1, rotary0: 7, rotary1: 3, lampTest: 0, halt: 1, step: 0
        });
        assert.deepStrictEqual(saved,
            { powerSwitch: -1, rotary0: 7, rotary1: 3, lampTest: 0, halt: 1, step: 0 },
            "the travel ends of every switch are legal positions");

        const bad = StateFormat.capturePanel({
            powerSwitch: 2,      // past LOCK
            rotary0: 9,          // past 7
            rotary1: -1,         // before 0
            lampTest: "1",       // a string is not a detent
            halt: NaN,
            step: 1
        });
        assert.deepStrictEqual(bad, { step: 1 },
            "only in-range numeric detents survive");

        assert.deepStrictEqual(StateFormat.capturePanel({ rotary0: 1.4 }),
            { rotary0: 1 }, "a detent is an integer: the value is rounded");
        console.log("PASS test 2: capturePanel clamps to each switch's travel");
    }

    // ---- 3. applyPanelFields: clamp on the way in ------------------------
    {
        const panel = { powerSwitch: 0, rotary0: 0, rotary1: 0, lampTest: 0, halt: 0, step: 0 };
        const applied = StateFormat.applyPanelFields(panel, {
            powerSwitch: 1, rotary0: 4, rotary1: 99, lampTest: 1, halt: "x", step: 1
        });
        assert.deepStrictEqual(applied, ["powerSwitch", "rotary0", "lampTest", "step"],
            "applied keys are the in-range ones only");
        assert.strictEqual(panel.powerSwitch, 1, "POWER LOCK comes back at LOCK");
        assert.strictEqual(panel.rotary0, 4, "the rotary switch comes back at its detent");
        assert.strictEqual(panel.rotary1, 0, "an impossible detent leaves the switch alone");
        assert.strictEqual(panel.halt, 0, "a non-numeric detent is ignored");
        assert.deepStrictEqual(StateFormat.applyPanelFields(panel, null), [],
            "no saved block applies nothing");
        assert.deepStrictEqual(StateFormat.applyPanelFields(null, { rotary0: 1 }), [],
            "no live panel applies nothing");
        console.log("PASS test 3: applyPanelFields restores the detents and refuses bad ones");
    }

    // ---- 4. panelPowerOn: the block decides ------------------------------
    {
        const paused = StateFormat.panelPowerOn({ powerSwitch: 0 }, STATE_HALT, STATE_HALT, false);
        assert.deepStrictEqual(paused, { powerOn: true, position: 0, legacy: false },
            "a captured POWER position wins over the Behaviour preference");

        const off = StateFormat.panelPowerOn({ powerSwitch: -1 }, STATE_RUN, STATE_HALT, true);
        assert.deepStrictEqual(off, { powerOn: false, position: -1, legacy: false },
            "a captured OFF position is restored as OFF");

        const locked = StateFormat.panelPowerOn({ powerSwitch: 1 }, STATE_RUN, STATE_HALT, true);
        assert.deepStrictEqual(locked, { powerOn: true, position: 1, legacy: false },
            "the LOCK position is preserved exactly");
        console.log("PASS test 4: a captured panel block decides the power condition");
    }

    // ---- 5. panelPowerOn: states that predate the block ------------------
    {
        // The reported defect: a working guest restored behind an OFF key.
        const running = StateFormat.panelPowerOn(null, STATE_RUN, STATE_HALT, false);
        assert.deepStrictEqual(running, { powerOn: true, position: 0, legacy: true },
            "a restored RUNNING machine is powered on (a switched-off 11/70 does not run)");

        const waiting = StateFormat.panelPowerOn(undefined, STATE_WAIT, STATE_HALT, false);
        assert.strictEqual(waiting.powerOn, true,
            "WAIT is a running machine too, so the panel must show POWER");

        const deliberatelyOff = StateFormat.panelPowerOn(null, STATE_HALT, STATE_HALT, false);
        assert.deepStrictEqual(deliberatelyOff, { powerOn: false, position: -1, legacy: true },
            "a halted browser snapshot keeps the recorded 'machine power' preference");

        const haltedExported = StateFormat.panelPowerOn({}, STATE_HALT, STATE_HALT, undefined);
        assert.deepStrictEqual(haltedExported, { powerOn: true, position: 0, legacy: true },
            "an exported state with no preference is a working machine about to power on");

        const unknownRunState = StateFormat.panelPowerOn(null, undefined, STATE_HALT, undefined);
        assert.strictEqual(unknownRunState.powerOn, true,
            "an unknown run state never leaves a state restored switched off");
        console.log("PASS test 5: legacy states resolve to the sane power condition");
    }

    // ---- 6. Container round trip ---------------------------------------
    {
        const manifest = {
            schemaVersion: StateFormat.SCHEMA_VERSION,
            label: "panel round trip",
            panel: { powerSwitch: 1, rotary0: 6, rotary1: 2, lampTest: 0, halt: 1, step: 0 }
        };
        const packed = StateFormat.pack(manifest, new Uint16Array(8));
        const parsed = StateFormat.unpack(Buffer.from(packed));
        assert.ok(parsed, "the container unpacks");
        assert.deepStrictEqual(parsed.manifest.panel, manifest.panel,
            "the panel block survives pack()/unpack() unchanged");

        const noPanel = StateFormat.unpack(Buffer.from(
            StateFormat.pack({ schemaVersion: StateFormat.SCHEMA_VERSION, label: "old" },
                new Uint16Array(8))));
        assert.strictEqual(noPanel.manifest.panel, undefined,
            "a state written without a panel block simply has none");
        console.log("PASS test 6: the panel block round-trips through the container");
    }

    // ---- 7. Wiring: the seam both layers need ---------------------------
    {
        const panelSrc = fs.readFileSync(path.join(ROOT, "src", "pdp11-panel.js"), "utf8");
        assert.ok(/window\.__yapdpPanelState\s*=\s*\{[\s\S]*capture:[\s\S]*restore:/.test(panelSrc),
            "pdp11-panel.js must expose window.__yapdpPanelState { capture, restore }");

        const snapSrc = fs.readFileSync(path.join(ROOT, "src", "snapshots.js"), "utf8");
        assert.ok(/panel:\s*capturePanelState\(\)/.test(snapSrc),
            "snapshots.js must capture the panel into the state");
        assert.ok(/__yapdpPanelState\.restore\(/.test(snapSrc),
            "snapshots.js must restore the panel after the CPU");

        const quickSrc = fs.readFileSync(path.join(ROOT, "src", "quickboot.js"), "utf8");
        assert.ok(/applyMachinePower\(true,\s*true\)/.test(quickSrc),
            "the Quick Boot wizard must power the machine on (and skip its own auto-boot)");
        console.log("PASS test 7: capture/restore seams and the wizard's power-on are wired");
    }

    console.log("\nAll panel-state tests passed.");
}

run();
