#!/usr/bin/env node
/**
 * Reboot dialog — Boot-device select visibility contract.
 *
 * The Reboot / Bootstrap now! dialog folds up to three parts into one modal
 * (src/pdp11-panel.js): the Boot-device three-way select, the "Don't show this
 * warning anymore" tick (the reboot confirmation) and the "Return my own
 * configuration" choice (the configuration-rollback offer). Only the parts
 * that apply are shown.
 *
 * Regression: the Boot-device select used to be tied to `confirm` (the reboot
 * confirmation). With confirmReboot off, the dialog is opened by the rollback
 * offer alone — and the select vanished, even though the dialog's own intro
 * text still described the three-way choice ("nothing, the interactive loader
 * (@), or reload the medium that was loaded last"). The same hid it in the
 * "Bootstrap now!" dialog, where `confirm` is always false. The select is now
 * part of EVERY machine-action dialog; only the confirmation tick is gated.
 *
 * What is pinned here, driving the REAL pdp11-panel.js in a VM sandbox (same
 * seam style as tests/overlay-during-autoload.test.js) with a recording
 * stand-in DOM:
 *
 *   1. confirmReboot OFF + a rollback offer available => the dialog appears
 *      with the Boot-device row VISIBLE (the offer is the only reason to ask);
 *   2. confirmReboot ON => the Boot-device row AND the "don't ask" tick are
 *      both visible, the rollback choice hidden;
 *   3. the rollback choice is shown exactly when a rollback is available.
 *
 * Run with:  node tests/reboot-dialog-bootdev.test.js
 *
 * Exit code 0 = pass, non-zero = failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const PANEL = path.join(__dirname, "..", "src", "pdp11-panel.js");
const panelSrc = fs.readFileSync(PANEL, "utf8");

// The registry of stand-in elements for the current sandbox, so a '#id'
// selector resolved from a created element reaches the same tracked node.
let REGISTRY = null;

// --- A recording stand-in DOM -------------------------------------------
// getElementById() hands back one stable element per id, so a part toggled by
// toggleDialogPart() can be inspected by its id afterwards. Every method the
// panel calls at load time (on its many panels) is a harmless no-op.
function makeEl(id) {
    return {
        id: id || "",
        style: {},
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        checked: false,
        selectedIndex: 0,
        options: [],
        dataset: {},
        scrollHeight: 0,
        clientHeight: 0,
        scrollTop: 0,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
        removeEventListener() {},
        dispatchEvent() { return true; },
        appendChild() {}, append() {}, removeChild() {}, remove() {},
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        // A '#id' selector resolves through the same registry, so the dialog's
        // internal querySelector('#machine-action-...') sees the tracked part.
        querySelector(sel) {
            return sel && sel[0] === "#" && REGISTRY ? REGISTRY.get(sel.slice(1)) || null : null;
        },
        querySelectorAll() { return []; },
        closest() { return null; },
        focus() {}, blur() {}, click() {},
        getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
        firstChild: null, children: [], parentNode: null,
    };
}

// --- Load the real panel in a sandbox -----------------------------------
// config = live Config.get() result; rollback = SnapshotStore availability.
function loadPanel(opts) {
    opts = opts || {};
    const registry = new Map();
    REGISTRY = registry; // makeEl()'s '#id' resolver reaches this map
    const getEl = (id) => {
        if (!registry.has(id)) registry.set(id, makeEl(id));
        return registry.get(id);
    };

    // The floating REBOOT button: querySelectorAll('[data-action="reboot"]')
    // returns it so the panel wires its click handler where we can press it.
    const rebootBtn = makeEl("reboot-btn");

    const document = {
        readyState: "complete",
        getElementById: (id) => getEl(id),
        createElement: () => makeEl(""),
        querySelector: (sel) => (sel && sel[0] === "#" ? getEl(sel.slice(1)) : null),
        querySelectorAll: (sel) =>
            (sel === '[data-action="reboot"]' ? [rebootBtn] : []),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        body: makeEl("body"),
        documentElement: makeEl("html"),
    };

    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: function CustomEvent() {},
        document,
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        // Globals the panel reads lazily; only what load/routing touches.
        CPU: { runState: 0, switchRegister: 0, displayAddress: 0 },
        STATE_HALT: 1,
        panel: { powerSwitch: 1 },
        Config: {
            get() { return opts.config; },
            set() {},
        },
        SnapshotStore: {
            configRollbackAvailable() { return !!opts.rollback; },
            rollbackToBaseline() { return "none"; },
            clearConfigBaseline() {},
            reloadForConfig() {},
        },
    };
    sandbox.window = sandbox;
    sandbox.window.getComputedStyle = () => ({ getPropertyValue: () => "" });
    sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {} });
    sandbox.window.location = { search: "", pathname: "/pdp11.html", hash: "", reload() {} };
    sandbox.location = sandbox.window.location;

    vm.createContext(sandbox);
    vm.runInContext(panelSrc, sandbox);
    return { registry, rebootBtn };
}

// Press the floating REBOOT button and return the tracked dialog parts.
function pressReboot(opts) {
    const { registry, rebootBtn } = loadPanel(opts);
    const clicks = rebootBtn._listeners.click || [];
    assert.ok(clicks.length > 0, "the panel wired no click handler on [data-action=reboot]");
    clicks[0]();
    const row = (id) => {
        const el = registry.get(id);
        assert.ok(el, "dialog part never created: " + id);
        // '' means "let the stylesheet decide" (visible); 'none' means hidden.
        return el.style.display !== "none";
    };
    return {
        bootDevice: row("machine-action-bootDevice-row"),
        dontAsk: row("machine-action-dontask-row"),
        returnRow: row("machine-action-return-row"),
    };
}

function run() {
    // 1. Confirm off, rollback available: the offer is the only reason the
    //    dialog is shown — the Boot-device select must still be there.
    {
        const d = pressReboot({
            config: { confirmReboot: false, bootDevice: "none", consoleType: "teletype" },
            rollback: true,
        });
        assert.strictEqual(d.bootDevice, true,
            "with confirmReboot off and a rollback offer, the Boot-device select must be visible");
        assert.strictEqual(d.returnRow, true,
            "the rollback choice must be visible when a rollback is available");
        assert.strictEqual(d.dontAsk, false,
            "the 'don't ask' tick belongs to the reboot confirmation and stays hidden");
        console.log("PASS: confirmReboot off + rollback => Boot-device select visible");
    }

    // 2. Confirm on: both the select and the confirmation tick are shown, the
    //    rollback choice is not.
    {
        const d = pressReboot({
            config: { confirmReboot: true, bootDevice: "interactive@", consoleType: "teletype" },
            rollback: false,
        });
        assert.strictEqual(d.bootDevice, true,
            "the Boot-device select must be visible with the reboot confirmation");
        assert.strictEqual(d.dontAsk, true,
            "the 'don't ask' tick must be visible with the reboot confirmation");
        assert.strictEqual(d.returnRow, false,
            "the rollback choice must be hidden when no rollback is available");
        console.log("PASS: confirmReboot on => select + confirmation tick visible, rollback hidden");
    }

    console.log("All reboot-dialog Boot-device tests passed.");
}

run();
