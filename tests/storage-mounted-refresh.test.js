#!/usr/bin/env node
/**
 * Storage "mounted images" freshness guard.
 *
 * The list is built from DataLoader once, at page startup. Images can arrive
 * later — a restored state mounts the payload it carries inline, and QuickBoot
 * fetches its boot disk in the background — so the page used to show
 * "--mounted images--" while the guest was running from a disk (reported with
 * `states/rt-11-print-coguar.state.zst`: rk5.dsk was invisible on Storage).
 *
 * Two seams are pinned here:
 *
 *   1. opening Storage rebuilds the list (switchPage announces every page
 *      change as a `yapdp:pagechange` event);
 *   2. window.yapdpExportList.refreshMountedList exists, because snapshots.js
 *      calls it after a restore that recorded no page of its own.
 *
 * src/dragdrop.js is a page script with no exports, so it is loaded into a VM
 * whose document is already "complete" — init() runs, but every DOM lookup
 * except the mounted-image <select> returns null, and IndexedDB is absent.
 *
 * Run with:  node tests/storage-mounted-refresh.test.js
 * Exit code 0 = all checks passed, non-zero = failure.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "dragdrop.js");

function makeSelect() {
    const options = [];
    const select = {
        value: "",
        title: "",
        disabled: false,
        options: options,
        appendChild(opt) {
            options.push(opt);
            if (options.length === 1) select.value = opt.value; // the DOM does this
        },
        removeChild() {},
        addEventListener() {}   // init() wires a change handler on every list
    };
    Object.defineProperty(select, "innerHTML", {
        get() { return ""; },
        set(v) { if (v === "") { options.length = 0; select.value = ""; } }
    });
    return select;
}

/**
 * makePage(mounted) — one copy of the page script, DOM stubs captured.
 * `mounted` is the live array DataLoader.list() reports, so a test can add an
 * image after init() exactly the way a restore does.
 */
function makePage(mounted) {
    const select = makeSelect();
    const count = { textContent: "" };
    const listeners = {};
    const document = {
        readyState: "complete",        // init() runs
        getElementById(id) {
            if (id === "mounted-select") return select;
            if (id === "mounted-count") return count;
            return null;
        },
        createElement() { return { value: "", textContent: "", hidden: false }; },
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        }
    };
    const window = {
        addEventListener() {}
    };
    window.window = window;
    window.document = document;

    const sandbox = {
        window: window,
        document: document,
        console: console,
        DataLoader: { list: () => mounted.slice() },
        setInterval: () => 0,          // must not keep the process alive
        clearInterval: () => {},
        Promise: Promise, Uint8Array: Uint8Array,
        Object: Object, Array: Array, JSON: JSON, String: String, Number: Number,
        Math: Math, Error: Error
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox,
        { filename: "src/dragdrop.js" });

    return {
        select: select,
        options: select.options,
        count: count,
        api: sandbox.window.yapdpExportList,
        pageChange: listeners["yapdp:pagechange"] || []
    };
}

function labels(page) {
    return page.options.map((o) => String(o.textContent));
}

function fire(page, name) {
    page.pageChange.forEach((fn) => fn({ detail: { page: name } }));
}

// init() rebuilds the list from IndexedDB on a microtask; give it a turn.
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function run() {
    // ---- 1. the seam snapshots.js calls --------------------------------
    {
        const page = makePage([]);
        await settle();
        assert.ok(page.api && typeof page.api.refreshMountedList === "function",
            "src/dragdrop.js must publish refreshMountedList on " +
            "window.yapdpExportList: snapshots.js refreshes the list after a " +
            "restore that recorded no page of its own");
    }

    // ---- 2. an image mounted after startup is invisible until Storage ---
    {
        const mounted = [];
        const page = makePage(mounted);
        await settle();
        assert.deepStrictEqual(labels(page), ["--mounted images--"],
            "an empty loader renders the empty option");
        assert.strictEqual(page.count.textContent, "0 images",
            "the counter starts at zero, like the list");

        // A restore mounts its payload after init() has already run.
        mounted.push("rk5.dsk");
        assert.deepStrictEqual(labels(page), ["--mounted images--"],
            "without a refresh the list still claims the machine has no disks");

        fire(page, "panel");
        assert.deepStrictEqual(labels(page), ["--mounted images--"],
            "only the Storage page rebuilds the list");

        fire(page, "storage");
        // The "· nothing to export" suffix is the Export rule showing through
        // (a restored, write-free image has nothing of the operator's to save);
        // the rule itself is pinned in tests/export-list.test.js.
        assert.deepStrictEqual(labels(page), ["rk5.dsk  · nothing to export"],
            "opening Storage must show the disk the guest is running from");
        assert.strictEqual(page.select.disabled, false,
            "the Unmount control must be usable for a restored disk");
        assert.strictEqual(page.count.textContent, "1 image",
            "the counter counts the list beside it, not only the operator's " +
            "own drag & drop files (a state-embedded disk is not one of those)");
    }

    // ---- 3. a second image appears the same way (QuickBoot case) -------
    {
        const mounted = [];
        const page = makePage(mounted);
        await settle();
        mounted.push("rk1.dsk");
        mounted.push("rk5.dsk");
        fire(page, "storage");
        assert.deepStrictEqual(labels(page),
            ["rk1.dsk  · nothing to export", "rk5.dsk  · nothing to export"],
            "every image mounted since startup is listed, sorted by name");
        assert.strictEqual(page.count.textContent, "2 images",
            "the teleport case: two disks listed, two counted — never 0");
    }

    // ---- 4. the list still empties when the images are gone ------------
    {
        const mounted = ["rk5.dsk"];
        const page = makePage(mounted);
        await settle();
        mounted.length = 0;             // e.g. Unmount or a fresh page load
        fire(page, "storage");
        assert.deepStrictEqual(labels(page), ["--mounted images--"],
            "a rebuild must also drop images that are no longer mounted");
        assert.strictEqual(page.count.textContent, "0 images",
            "the counter follows the list down as well as up");
    }

    console.log("storage-mounted-refresh: all checks passed");
}

run().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
