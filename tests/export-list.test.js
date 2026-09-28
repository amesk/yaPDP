#!/usr/bin/env node
/**
 * "Export image" list guard — which images the Storage page offers.
 *
 * src/dragdrop.js is a page script: it has no module exports and it
 * self-initialises on DOMContentLoaded. The test therefore loads it into a VM
 * sandbox whose document is still "loading", so the module defines everything
 * without touching the DOM, and reaches the rule through the seam it publishes
 * for exactly this purpose — window.yapdpExportList (the same kind of seam
 * window.vt52MarkerVars is in src/terminal-core.js). refreshExportList() is
 * then called by the test itself, against a stub <select>.
 *
 * The rule (exportableUrls):
 *
 *   1. an image with guest writes is offered — saved in DiskStore, or still
 *      pending in the running machine;
 *   2. an image the OPERATOR mounted (drag & drop / restored) is offered even
 *      with no changes, because it is a file of theirs;
 *   3. an image that merely happens to be mounted — bundled media a running
 *      guest streams, with no changes of its own — is NOT offered.
 *
 * (3) is the one that matters in the UI: without it, "Persistent disk changes →
 * Reset all" could not fall back to "--none--", because the pristine bundled
 * image stayed in the list as an entry carrying nothing.
 *
 * Run with:  node tests/export-list.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "dragdrop.js");

/**
 * makePage(state) — a sandbox holding one copy of the page script.
 *
 * state = { mounted: [], changed: [], blocks: {} } — what DataLoader/DiskStore
 * report. Returns the export API, the stub <select> (its options and disabled
 * flag) and the stub Download button.
 */
function makePage(state) {
    const options = [];
    const select = {
        value: "",
        disabled: false,
        options: options,
        appendChild(opt) {
            options.push(opt);
            if (options.length === 1) select.value = opt.value; // the DOM does this
        }
    };
    // Assigning innerHTML rebuilds the option list, and the DOM also drops the
    // selection with it — refreshExportList() reads the old value first.
    Object.defineProperty(select, "innerHTML", {
        get() { return ""; },
        set(v) { if (v === "") { options.length = 0; select.value = ""; } }
    });
    const downloadBtn = { disabled: false };
    const document = {
        readyState: "loading",          // init() must NOT run
        addEventListener() {},
        getElementById(id) {
            if (id === "downLoadSelect") return select;
            if (id === "download-btn") return downloadBtn;
            return null;
        },
        createElement() { return { value: "", textContent: "" }; }
    };
    const window = {
        exportDiskImage() { return Promise.resolve(new Uint8Array(1)); }
    };
    window.window = window;
    window.document = document;

    const sandbox = {
        window: window,
        document: document,
        console: console,
        DataLoader: { list: () => state.mounted.slice() },
        DiskStore: {
            listDirty: () => state.changed.slice(),
            changedBlockCount: (url) => state.blocks[url] || 0
        },
        setInterval: () => 0,           // must not keep the process alive
        clearInterval: () => {},
        Promise: Promise, Uint8Array: Uint8Array,
        Object: Object, Array: Array, JSON: JSON, String: String, Number: Number,
        Math: Math, Error: Error
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox,
        { filename: "src/dragdrop.js" });

    return { api: sandbox.window.yapdpExportList, select: select,
        options: options, downloadBtn: downloadBtn, state: state };
}

function labels(page) {
    return page.options.map((o) => o.textContent);
}

function run() {
    // The sandbox has an Array realm of its own, and deepStrictEqual compares
    // prototypes — so the rule's result is copied into this realm first.
    const rule = (page, mounted, changed, user) =>
        Array.from(page.api.exportableUrls(mounted, changed, user));

    // ---- 1. the rule itself -------------------------------------------
    {
        const page = makePage({ mounted: [], changed: [], blocks: {} });
        assert.ok(page.api && typeof page.api.exportableUrls === "function",
            "src/dragdrop.js must publish the Export rule on window.yapdpExportList");

        assert.deepStrictEqual(rule(page, ["rp1.dsk"], [], {}), [],
            "bundled media with no changes is not offered: " +
            "a pristine image is one download away and is nothing the operator produced");
        assert.deepStrictEqual(rule(page, ["rp1.dsk"], ["rp1.dsk"], {}),
            ["rp1.dsk"], "an image with guest writes is offered");
        assert.deepStrictEqual(rule(page, [], ["rk0.dsk"], {}),
            ["rk0.dsk"],
            "a detached image keeps its saved writes and stays offered");
        assert.deepStrictEqual(rule(page, ["mine.dsk"], [], { "mine.dsk": true }),
            ["mine.dsk"], "an image the operator mounted is offered even with no changes");
        assert.deepStrictEqual(
            rule(page, ["rp1.dsk", "mine.dsk"], [], { "mine.dsk": true }),
            ["mine.dsk"],
            "bundled media stays out while the operator's own image stays in");
        assert.deepStrictEqual(rule(page, ["rp1.dsk", "rp1.dsk"], ["rp1.dsk"], {}),
            ["rp1.dsk"], "the list is deduplicated");
        console.log("PASS: export rule — guest writes or an operator-mounted image, " +
            "never pristine bundled media");
    }

    // ---- 2. the list the operator sees ---------------------------------
    {
        const page = makePage({ mounted: ["rp1.dsk"], changed: [], blocks: {} });

        // Nothing mounted by the operator, no writes: the list is empty even
        // though the bundled image is mounted and streaming.
        page.api.refreshExportList();
        assert.deepStrictEqual(labels(page), ["--none--"],
            "a bundled image with no changes leaves the list empty");
        assert.strictEqual(page.select.disabled, true, "the select is disabled");
        assert.strictEqual(page.downloadBtn.disabled, true, "Download is disabled");
        console.log("PASS: export list — a pristine bundled image shows as --none--");

        // The guest writes: the image appears, with the count.
        page.state.changed.push("rp1.dsk");
        page.state.blocks["rp1.dsk"] = 3;
        page.api.refreshExportList();
        assert.deepStrictEqual(labels(page), ["rp1.dsk  (3 blocks changed)"],
            "a guest write puts the image back in the list, with its count");
        assert.strictEqual(page.select.disabled, false, "the select is enabled");

        // "Reset all" clears saved AND pending writes → back to --none--.
        page.state.changed.length = 0;
        page.state.blocks = {};
        page.api.refreshExportList();
        assert.deepStrictEqual(labels(page), ["--none--"],
            "Reset all falls back to --none-- when the operator mounted nothing");
        assert.strictEqual(page.downloadBtn.disabled, true,
            "Download is disabled again after Reset all");

        // The operator's own image is offered even with no changes.
        page.state.mounted.push("mine.dsk");
        page.api.userImages["mine.dsk"] = true;
        page.api.refreshExportList();
        assert.deepStrictEqual(labels(page), ["mine.dsk  (no changes)"],
            "an operator-mounted image is offered with 'no changes'");
        assert.strictEqual(page.select.disabled, false,
            "the select is enabled by the operator's own image");
        console.log("PASS: export list — writes appear and disappear, " +
            "the operator's own file stays");
    }

    // ---- 3. a detached image with saved writes -------------------------
    {
        const page = makePage({ mounted: [], changed: ["rk0.dsk"], blocks: { "rk0.dsk": 2 } });
        page.api.refreshExportList();
        assert.deepStrictEqual(labels(page), ["rk0.dsk  (not mounted, 2 blocks changed)"],
            "an image that is not mounted says so and keeps its block count");
        console.log("PASS: export list — a detached image keeps its saved writes");
    }

    console.log("export-list: all checks passed");
}

run();
