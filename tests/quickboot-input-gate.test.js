#!/usr/bin/env node
/**
 * Quick-boot input gate tests.
 *
 * While the "Autoloading in progress" toast is up the wizard owns the
 * machine: the operator's own keyboard and pointer input must not reach the
 * console, the terminals or the front panel, or the two byte streams would
 * race inside the DL11 queue. The gate lives in src/quickboot.js — it
 * intercepts events in the CAPTURE phase on the document and drops them,
 * except for clicks on the toast itself (the "Take control!" button, the only
 * way out) and the F11 fullscreen toggle.
 *
 * The gate is DOM-bound, so the declarations are scraped out of the source
 * and driven from a VM sandbox with a recording stand-in for `document`
 * (same seam style as tests/quickboot-console.test.js). A few source-level
 * assertions pin the parts a sandbox cannot exercise: the toast markup.
 *
 * Run with:  node tests/quickboot-input-gate.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "src", "quickboot.js");
const CSS_PATH = path.join(ROOT, "css", "pdp11.css");

const src = fs.readFileSync(SOURCE_PATH, "utf8");
const css = fs.readFileSync(CSS_PATH, "utf8");

// ------------------------------------------------------------------
// Extract the gate declarations: from "var GATED_EVENTS" through the end of
// setInputGate(), brace-balanced so a reformat inside the block is fine.
// ------------------------------------------------------------------
function extractGate(source) {
    const start = source.indexOf("var GATED_EVENTS");
    assert.ok(start !== -1, "var GATED_EVENTS not found in src/quickboot.js");
    const fnStart = source.indexOf("function setInputGate", start);
    assert.ok(fnStart !== -1, "function setInputGate not found after GATED_EVENTS");
    const braceOpen = source.indexOf("{", fnStart);
    assert.ok(braceOpen !== -1, "setInputGate has no opening brace");
    let depth = 0;
    for (let i = braceOpen; i < source.length; i++) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced braces in setInputGate");
}

function loadGate() {
    // Recording document stand-in: every add/remove pair is kept so the test
    // can prove the gate opens and closes symmetrically, and in capture.
    const listeners = [];
    const doc = {
        addEventListener: function (type, fn, capture) {
            listeners.push({ type: type, fn: fn, capture: capture });
        },
        removeEventListener: function (type, fn, capture) {
            const i = listeners.findIndex(function (l) {
                return l.type === type && l.fn === fn && l.capture === capture;
            });
            if (i >= 0) listeners.splice(i, 1);
        },
        body: { classList: { toggle: function () { } } }
    };
    const sandbox = { document: doc };
    vm.createContext(sandbox);
    vm.runInContext(
        extractGate(src) +
        "\n; this.gateEvent = gateEvent;" +
        " this.setInputGate = setInputGate;" +
        " this.GATED_EVENTS = GATED_EVENTS;",
        sandbox);
    return {
        gateEvent: sandbox.gateEvent,
        setInputGate: sandbox.setInputGate,
        gated: sandbox.GATED_EVENTS,
        listeners: listeners
    };
}

// A minimal event stand-in: records whether the gate stopped it.
function fakeEvent(over) {
    const e = {
        type: "keydown",
        key: "a",
        target: { closest: function () { return null; } },
        defaultPrevented: false,
        stopped: false,
        preventDefault: function () { e.defaultPrevented = true; },
        stopImmediatePropagation: function () { e.stopped = true; }
    };
    if (over) Object.keys(over).forEach(function (k) { e[k] = over[k]; });
    return e;
}

function testGate() {
    const gate = loadGate();

    // The gate must cover keyboard AND pointer input: the console keyboard,
    // the mobile key strips and the front panel all listen for these.
    for (const type of ["keydown", "keypress", "keyup",
                        "mousedown", "mouseup", "click",
                        "pointerdown", "pointerup", "contextmenu"]) {
        assert.ok(gate.gated.indexOf(type) !== -1,
            "the gate must intercept '" + type + "'");
    }

    // Open: one capture-phase listener per gated event.
    gate.setInputGate(true);
    assert.strictEqual(gate.listeners.length, gate.gated.length,
        "opening the gate must register exactly one listener per gated event");
    for (const l of gate.listeners) {
        assert.strictEqual(l.capture, true,
            "'" + l.type + "' must be intercepted in the CAPTURE phase, " +
            "before the console/panel handlers see it");
    }

    // Idempotent: a second open must not stack duplicate listeners.
    gate.setInputGate(true);
    assert.strictEqual(gate.listeners.length, gate.gated.length,
        "opening the gate twice must not stack listeners");

    // A plain keystroke is dropped.
    const key = fakeEvent();
    gate.gateEvent(key);
    assert.ok(key.defaultPrevented && key.stopped,
        "a keystroke during the autoload must be dropped");

    // A pointer event aimed at the front panel is dropped too.
    const click = fakeEvent({ type: "click" });
    gate.gateEvent(click);
    assert.ok(click.defaultPrevented && click.stopped,
        "a click during the autoload must be dropped");

    // The toast is the ONLY way out: clicks inside it (the "Take control!"
    // button) pass through untouched.
    const inToast = fakeEvent({
        type: "click",
        target: { closest: function (sel) { return sel === "#quick-boot-balloon" ? {} : null; } }
    });
    gate.gateEvent(inToast);
    assert.ok(!inToast.defaultPrevented && !inToast.stopped,
        "a click on the autoload toast must reach its button");

    // A modal overlay is a question the SYSTEM is asking (a reboot
    // confirmation, a configuration-rollback offer): its buttons must work
    // during the autoload too, or the operator is stranded with a dead dialog.
    const inModal = fakeEvent({
        type: "click",
        target: { closest: function (sel) {
            return sel === ".modal-overlay"
                ? { classList: { contains: function (name) { return name === "visible"; } } }
                : null;
        } }
    });
    gate.gateEvent(inModal);
    assert.ok(!inModal.defaultPrevented && !inModal.stopped,
        "a click inside a visible modal must reach its button during the autoload");

    // QuickBoot hides its chooser overlay but leaves focus on the selected
    // option. Keyboard events targeted at that hidden modal must not bypass
    // the gate while the autoload toast is still visible.
    const hiddenModalKey = fakeEvent({
        target: { closest: function (sel) {
            return sel === ".modal-overlay"
                ? { classList: { contains: function () { return false; } } }
                : null;
        } }
    });
    gate.gateEvent(hiddenModalKey);
    assert.ok(hiddenModalKey.defaultPrevented && hiddenModalKey.stopped,
        "keyboard input focused inside a hidden modal must remain gated");

    // Host-level pause and reboot controls must remain available during
    // autoload, otherwise pausing can strand the operator behind the gate.
    for (const selector of ["#pause-btn", "#reboot-btn"]) {
        const hostControl = fakeEvent({
            type: "click",
            target: { closest: function (sel) { return sel === selector ? {} : null; } }
        });
        gate.gateEvent(hostControl);
        assert.ok(!hostControl.defaultPrevented && !hostControl.stopped,
            selector + " must remain operable during the autoload");
    }

    // A focused host control must not become a keyboard-input tunnel.
    // This is the exact Pause -> Resume regression: after clicking Pause the
    // button can retain focus, so ordinary keys must still be stopped.
    for (const selector of ["#pause-btn", "#reboot-btn", "#screenshot-btn"]) {
        const focusedKey = fakeEvent({
            type: "keydown",
            key: "a",
            target: { closest: function (sel) { return sel === selector ? {} : null; } }
        });
        gate.gateEvent(focusedKey);
        assert.ok(focusedKey.defaultPrevented && focusedKey.stopped,
            selector + " must not exempt ordinary keyboard input from the gate");
    }

    // Keyboard activation remains available for host controls, but only
    // the activation keys—not arbitrary typing—bypass the gate.
    for (const type of ["keydown", "keypress", "keyup"]) {
        for (const keyName of ["Enter", " "]) {
            const activationKey = fakeEvent({
                type: type,
                key: keyName,
                target: { closest: function (sel) { return sel === "#pause-btn" ? {} : null; } }
            });
            gate.gateEvent(activationKey);
            assert.ok(!activationKey.defaultPrevented && !activationKey.stopped,
                keyName + " " + type + " must still activate the focused Pause/Resume button");
        }
    }

    // Using Pause/Resume must not release the gate.
    const afterResume = fakeEvent();
    gate.gateEvent(afterResume);
    assert.ok(afterResume.defaultPrevented && afterResume.stopped,
        "console input must remain blocked after the operator resumes emulation");
    assert.strictEqual(gate.listeners.length, gate.gated.length,
        "Pause/Resume must not remove the autoload gate listeners");

    // F11 is the app's fullscreen toggle, not console input.
    const f11 = fakeEvent({ key: "F11" });
    gate.gateEvent(f11);
    assert.ok(!f11.defaultPrevented && !f11.stopped,
        "F11 must keep working while the autoload runs");

    // Regression: state-restore preparation may finish while autoload is
    // still active. Releasing one owner's claim must not open the shared gate.
    gate.setInputGate(true, "preparing");
    gate.setInputGate(false, "preparing");
    assert.strictEqual(gate.listeners.length, gate.gated.length,
        "ending preparation must not release an active autoload gate");
    const stillGated = fakeEvent();
    gate.gateEvent(stillGated);
    assert.ok(stillGated.defaultPrevented && stillGated.stopped,
        "console input remains blocked while autoload still owns the gate");

    // Close only after the final owner releases its claim.
    gate.setInputGate(false, "autoload");
    assert.strictEqual(gate.listeners.length, 0,
        "closing the final gate owner must remove every listener");
}

function testToastMarkup() {
    // The toast (built in ensureBalloon) must expose the way out and the
    // spinner. The class name is also pinned by tests/mobile-css.test.js.
    assert.ok(src.indexOf('balloon.className = "quickboot-balloon"') !== -1,
        "src/quickboot.js must build the toast with the .quickboot-balloon class");
    assert.ok(src.indexOf("Autoloading in progress") !== -1,
        "src/quickboot.js must keep the autoload wording");

    const take = src.indexOf('take.className = "quickboot-take-control"');
    assert.ok(take !== -1, "the toast must carry a Take control! button");
    assert.ok(src.indexOf('take.textContent = "Take control!"') !== -1,
        'the button must read "Take control!"');
    assert.ok(src.indexOf("abortAutoload(); });") !== -1,
        "the button must abort the autoload");

    assert.ok(src.indexOf('classList.add("visible")') !== -1 &&
        src.indexOf('setInputGate(true, "autoload")') !== -1,
        "showing the toast must open the input gate");
    assert.ok(src.indexOf('setInputGate(false, "autoload")') !== -1,
        "hiding the toast must close the input gate");
    assert.ok(src.indexOf('spin.className = "yapdp-spin quickboot-balloon-spin"') !== -1,
        "the toast must use the shared .yapdp-spin spinner");
}

function testGateStyle() {
    // The shared spinner mirrors the startup loading gate and must respect
    // prefers-reduced-motion, exactly like the gate's inline copy.
    assert.ok(/\.yapdp-spin\s*\{/.test(css),
        "css/pdp11.css must define the shared .yapdp-spin");
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.yapdp-spin\s*\{[\s\S]*?animation:\s*none/.test(css);
    assert.ok(reduced,
        "the shared spinner must be stilled under prefers-reduced-motion");

    // The toast lays out as a row (spinner + label + button).
    assert.ok(/\.quickboot-balloon\.visible\s*\{[^}]*display:\s*flex/.test(css),
        "the visible toast must lay out as a flex row");
    assert.ok(/\.quickboot-take-control\s*\{/.test(css),
        "the Take control! button needs a style of its own");

    // Status vs error: the toast wears the loading gate's status palette, and
    // the error red stays reserved for the image-load dialog. A future edit
    // that reaches for red must fail here.
    const toastRule = /\.quickboot-balloon\s*\{([^}]*)\}/.exec(css);
    assert.ok(toastRule, "the autoload toast needs a rule of its own");
    assert.ok(!/#d84a3f|#b5544a|#ff9b8a/.test(toastRule[1]),
        "the autoload toast must not use an error red");
    assert.ok(/#c8a860/.test(toastRule[1]),
        "the autoload toast must use the gold status accent");
    const errorRule = /\.modal-box\.error\s*\{([^}]*)\}/.exec(css);
    assert.ok(errorRule, "the image-load error dialog must keep its own rule");
    assert.ok(/#b5544a/.test(errorRule[1]),
        "error red stays reserved for .modal-box.error");
}

function main() {
    testGate();
    testToastMarkup();
    testGateStyle();
    console.log("OK  quickboot-input-gate: all tests passed");
}

main();
